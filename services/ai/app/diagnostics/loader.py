"""
Candle loading.

Reads a CSV export of the platform's candle store into per-series candle lists
in exactly the shape ``pipeline.analyse`` expects. CSV rather than a direct
database connection on purpose: the analysis service has no database driver and
adding one to run diagnostics would put a dependency into the runtime image for
the sake of an offline tool.

Produce the export with:

    psql -c "\\copy (select c.symbol, i.\\"assetClass\\", c.timeframe,
             extract(epoch from c.time)::bigint as time,
             c.open, c.high, c.low, c.close, c.volume, c.source
             from candles c join instruments i on i.id = c.\\"instrumentId\\"
             order by c.symbol, c.timeframe, c.time)
             to 'candles.csv' with (format csv, header)"

The export is treated as untrusted input. Rows that cannot form a valid bar are
dropped and counted rather than repaired, for the reason ``pipeline.to_frame``
gives: a synthesised price is indistinguishable from a real one by the time it
reaches a factor score.
"""

from __future__ import annotations

import csv
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

log = logging.getLogger(__name__)

#: Database timeframe codes to the engine's timeframe strings. The two
#: vocabularies differ, and every consumer of the store has to translate.
TIMEFRAME_MAP: dict[str, str] = {
    "M1": "1m", "M3": "3m", "M5": "5m", "M15": "15m", "M30": "30m",
    "H1": "1h", "H4": "4h", "D1": "1D", "W1": "1W", "MN1": "1M",
}

#: Bar length in seconds, used to detect gaps and to place a bar in a session.
TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800, "1M": 2592000,
}


@dataclass
class Series:
    """One instrument on one timeframe, sorted and de-duplicated."""

    symbol: str
    asset_class: str
    timeframe: str
    candles: list[dict[str, Any]]
    sources: set[str] = field(default_factory=set)

    def __len__(self) -> int:
        return len(self.candles)

    @property
    def key(self) -> str:
        return f"{self.symbol}:{self.timeframe}"

    @property
    def first_time(self) -> int:
        return int(self.candles[0]["time"]) if self.candles else 0

    @property
    def last_time(self) -> int:
        return int(self.candles[-1]["time"]) if self.candles else 0


@dataclass
class LoadReport:
    """What the export contained and what had to be discarded."""

    rows_read: int = 0
    rows_dropped_unparseable: int = 0
    rows_dropped_invalid_bar: int = 0
    rows_dropped_duplicate: int = 0
    series_built: int = 0
    #: Bars stamped after the load ran. Never legitimate, and the single most
    #: severe form of look-ahead a store can carry, so it is counted separately
    #: and surfaced rather than folded into the invalid-bar total.
    rows_future_dated: int = 0
    future_dated_examples: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.rows_read} rows read, {self.series_built} series built; "
            f"dropped {self.rows_dropped_unparseable} unparseable, "
            f"{self.rows_dropped_invalid_bar} invalid, "
            f"{self.rows_dropped_duplicate} duplicate; "
            f"{self.rows_future_dated} future-dated"
        )


def _to_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def load_csv(
    path: str | Path,
    *,
    now_epoch: int,
    timeframes: tuple[str, ...] | None = None,
    asset_classes: tuple[str, ...] | None = None,
    min_bars: int = 0,
) -> tuple[list[Series], LoadReport]:
    """
    Read the export into series.

    ``now_epoch`` is passed in rather than read from the clock so a run is
    reproducible: the same export plus the same reference instant always yields
    the same series and the same future-dated count.
    """
    report = LoadReport()
    grouped: dict[tuple[str, str, str], dict[int, dict[str, Any]]] = defaultdict(dict)
    source_map: dict[tuple[str, str, str], set[str]] = defaultdict(set)

    with Path(path).open("r", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            report.rows_read += 1

            symbol = (row.get("symbol") or "").strip()
            asset_class = (row.get("assetClass") or "").strip().upper()
            raw_tf = (row.get("timeframe") or "").strip().upper()
            timeframe = TIMEFRAME_MAP.get(raw_tf, raw_tf)

            if not symbol or not timeframe:
                report.rows_dropped_unparseable += 1
                continue
            if timeframes and timeframe not in timeframes:
                continue
            if asset_classes and asset_class not in asset_classes:
                continue

            try:
                stamp = int(float(row["time"]))
            except (TypeError, ValueError, KeyError):
                report.rows_dropped_unparseable += 1
                continue

            values = [_to_float(row.get(k)) for k in ("open", "high", "low", "close")]
            if any(v is None or v <= 0 for v in values):
                report.rows_dropped_invalid_bar += 1
                continue

            open_, high, low, close = values  # type: ignore[misc]
            if high < low:
                report.rows_dropped_invalid_bar += 1
                continue

            if stamp > now_epoch:
                report.rows_future_dated += 1
                if len(report.future_dated_examples) < 8:
                    report.future_dated_examples.append(
                        f"{symbol} {timeframe} stamped {stamp} "
                        f"({(stamp - now_epoch) / 86400:.0f} days ahead, "
                        f"source={row.get('source', '?')})"
                    )
                # Excluded from the replay population entirely. A bar the store
                # says has not happened yet cannot be a bar the engine was
                # entitled to see.
                continue

            key = (symbol, asset_class, timeframe)
            bucket = grouped[key]
            if stamp in bucket:
                report.rows_dropped_duplicate += 1
            bucket[stamp] = {
                "time": stamp,
                "open": open_,
                "high": max(open_, high, low, close),
                "low": min(open_, high, low, close),
                "close": close,
                "volume": _to_float(row.get("volume")) or 0.0,
            }
            source_map[key].add((row.get("source") or "?").strip())

    series: list[Series] = []
    for (symbol, asset_class, timeframe), bucket in grouped.items():
        candles = [bucket[stamp] for stamp in sorted(bucket)]
        if len(candles) < min_bars:
            continue
        series.append(
            Series(
                symbol=symbol,
                asset_class=asset_class or "EQUITY",
                timeframe=timeframe,
                candles=candles,
                sources=source_map[(symbol, asset_class, timeframe)],
            )
        )

    series.sort(key=lambda s: (-len(s.candles), s.symbol, s.timeframe))
    report.series_built = len(series)
    return series, report


def gap_profile(series: Series) -> dict[str, Any]:
    """
    How regular the series' spacing is.

    A store assembled from several providers over time is full of holes, and a
    hole matters here for a specific reason: the simulator counts *bars*, not
    wall-clock, so a gap silently stretches a time-based exit. Reported so the
    stretch is visible rather than assumed away.
    """
    expected = TIMEFRAME_SECONDS.get(series.timeframe, 0)
    if expected <= 0 or len(series) < 3:
        return {"available": False}

    deltas = [
        int(series.candles[i + 1]["time"]) - int(series.candles[i]["time"])
        for i in range(len(series) - 1)
    ]
    regular = sum(1 for d in deltas if d == expected)
    largest = max(deltas) if deltas else 0

    return {
        "available": True,
        "expectedSeconds": expected,
        "regularFraction": round(regular / len(deltas), 4) if deltas else 0.0,
        "largestGapBars": round(largest / expected, 1) if expected else 0.0,
        "gapsOverTwoBars": sum(1 for d in deltas if d > expected * 2),
    }


def iter_windows(series: Series, warmup: int, stride: int) -> Iterator[int]:
    """Indices of the bars a replay should score, oldest first."""
    for i in range(warmup, len(series), max(1, stride)):
        yield i


#: A bar-to-bar close ratio beyond this is not a market move on any instrument
#: this platform covers. It is a scale break: two price series with different
#: units concatenated into one.
SCALE_BREAK_RATIO = 3.0

#: Provider names whose output is synthetic. A synthetic bar is fine as a
#: fallback for a chart nobody trades from and is not fine in a series an
#: analysis reads, because nothing downstream can tell the two apart.
SYNTHETIC_SOURCES = frozenset({"simulated", "synthetic", "mock"})


def integrity_profile(series: Series) -> dict[str, Any]:
    """
    Whether this series is one price series or several glued together.

    Two failures are looked for, and they usually arrive together. **Mixed
    sources** — a fallback provider's output persisted into the same series as
    the real feed, which the store records in a `source` column that no reader
    filters on. **Scale breaks** — consecutive closes separated by a ratio no
    instrument produces, which is what a mixed series looks like from the
    inside once the source column has been dropped.

    Worth its own check rather than folding into the gap profile, because the
    consequence is different in kind. A gap stretches a time-based exit; a scale
    break manufactures a move of several thousand percent that every trend,
    range and volatility measure downstream then treats as real.
    """
    synthetic = sorted(s for s in series.sources if s.lower() in SYNTHETIC_SOURCES)
    genuine = sorted(s for s in series.sources if s.lower() not in SYNTHETIC_SOURCES)

    breaks: list[dict[str, Any]] = []
    closes = [float(c["close"]) for c in series.candles]
    for i in range(1, len(closes)):
        previous, current = closes[i - 1], closes[i]
        if previous <= 0 or current <= 0:
            continue
        ratio = max(current / previous, previous / current)
        if ratio >= SCALE_BREAK_RATIO:
            breaks.append(
                {
                    "index": i,
                    "time": int(series.candles[i]["time"]),
                    "from": round(previous, 6),
                    "to": round(current, 6),
                    "ratio": round(ratio, 1),
                }
            )

    return {
        "sources": sorted(series.sources),
        "syntheticSources": synthetic,
        "hasSynthetic": bool(synthetic),
        "mixedRealAndSynthetic": bool(synthetic and genuine),
        "scaleBreaks": len(breaks),
        "largestScaleBreak": max((b["ratio"] for b in breaks), default=0.0),
        "scaleBreakExamples": breaks[:3],
        "usable": not (synthetic and genuine) and not breaks,
    }


def integrity_summary(series_list: list[Series]) -> dict[str, Any]:
    """The same check rolled up across every loaded series."""
    profiles = {s.key: integrity_profile(s) for s in series_list}
    contaminated = {k: v for k, v in profiles.items() if not v["usable"]}
    return {
        "seriesChecked": len(profiles),
        "seriesContaminated": len(contaminated),
        "seriesWithSyntheticBars": sum(1 for v in profiles.values() if v["hasSynthetic"]),
        "seriesMixingRealAndSynthetic": sum(
            1 for v in profiles.values() if v["mixedRealAndSynthetic"]
        ),
        "seriesWithScaleBreaks": sum(1 for v in profiles.values() if v["scaleBreaks"]),
        "worst": dict(
            sorted(
                contaminated.items(),
                key=lambda kv: -kv[1]["largestScaleBreak"],
            )[:10]
        ),
    }
