"""
Bar-by-bar replay of the live signal path.

This is the piece the platform has never had. ``engine/backtest.py`` simulates
strategy-builder rules; nothing has ever simulated ``pipeline.analyse``, which
is the function that produces every signal the feed publishes. So the published
signal engine has no measured expectancy, and diagnostics 1.1, 1.3, 1.4 and 1.6
have nothing to run on until this module supplies it.

The replay is deliberately dumb. It slices the candle list at bar *i*, hands
``pipeline.analyse`` exactly the slice — never a bar beyond it — and records
whatever comes back. No gate is added, no threshold is changed, no field is
recomputed. If the engine says WAIT the reason is recorded and the bar produces
no trade. The point is to observe the live path, not to improve it.

Two properties are load-bearing:

**The slice ends at a closed bar.** ``candles[: i + 1]`` makes bar *i* the last
element, and the engine reads its close as the current price. That is only sound
if bar *i* is finished, which it is in a stored series and is *not* on one of
the two live providers — see ``audit.py``. The replay is therefore measuring the
engine under conditions strictly cleaner than the ones it runs in live.

**Nothing after bar *i* is visible.** Not to the analysis, and not to the
feature snapshot taken from it. Everything the simulator later uses to resolve
the trade is read from ``candles[i + 1 :]`` by a different module, so a leak
would have to cross a function boundary to happen at all.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field, asdict
from typing import Any

from ..engine import pipeline
from .config import DiagnosticsConfig, DEFAULT
from .loader import Series

log = logging.getLogger(__name__)


@dataclass
class ReplaySignal:
    """
    One signal the engine emitted, with the state it was emitted from.

    Carries no outcome. The simulator adds that, and keeping the two apart is
    what makes it impossible for an outcome to leak backwards into the record
    of what was known at issue.
    """

    symbol: str
    asset_class: str
    timeframe: str
    #: Index of the last closed bar the engine saw.
    bar_index: int
    #: Close timestamp of that bar, epoch seconds. This is the signal's
    #: ``generated_at``: the instant the information existed.
    generated_at: int
    action: str
    confidence: float
    entry: float | None
    entry_low: float | None
    entry_high: float | None
    stop_loss: float | None
    targets: list[dict[str, Any]]
    risk_reward: float
    net_risk_reward: float
    risk_percent: float
    round_trip_bps: float
    regime: str
    trend_direction: str
    rejection_reason: str | None
    #: Full input snapshot, for §1.5 reconciliation.
    feature_vector: dict[str, float | str | None] = field(default_factory=dict)

    @property
    def is_trade(self) -> bool:
        return self.action in ("BUY", "SELL") and self.entry is not None and self.stop_loss is not None

    @property
    def is_long(self) -> bool:
        return self.action == "BUY"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SeriesReplay:
    """Everything one series produced."""

    symbol: str
    asset_class: str
    timeframe: str
    bars_scored: int = 0
    signals: list[ReplaySignal] = field(default_factory=list)
    #: WAIT reasons, counted. The engine's own account of why it declined.
    wait_reasons: dict[str, int] = field(default_factory=dict)
    errors: int = 0
    error_examples: list[str] = field(default_factory=list)

    @property
    def trades(self) -> list[ReplaySignal]:
        return [s for s in self.signals if s.is_trade]


def _feature_vector(analysis: dict[str, Any]) -> dict[str, float | str | None]:
    """
    A flat, comparable snapshot of everything the signal was derived from.

    Flat because §1.5 diffs it field by field against the live path, and a
    nested structure turns that diff into a tree walk whose output nobody
    reads. Scalars only, in a fixed key order, so two snapshots taken months
    apart line up positionally as well as by name.

    Every field here is an *input* to the signal decision or a direct summary of
    one. Outcome fields are excluded by construction.
    """
    technical = analysis.get("technical") or {}
    trend = technical.get("trend") or {}
    momentum = technical.get("momentum") or {}
    volatility = technical.get("volatility") or {}
    volume = technical.get("volume") or {}
    forecast = analysis.get("forecast") or {}
    signal = analysis.get("signal") or {}
    smc = analysis.get("smc") or {}
    meta = analysis.get("meta") or {}
    flow = analysis.get("orderFlow") or {}
    book = analysis.get("orderBook") or {}
    derivatives = analysis.get("derivatives") or {}

    out: dict[str, float | str | None] = {
        "asOf": analysis.get("asOf"),
        "price": analysis.get("price"),
        "bars": meta.get("bars"),
        "swingWindow": meta.get("swingWindow"),
        "higherTimeframeTrend": meta.get("higherTimeframeTrend"),
        "technicalScore": technical.get("score"),
        "technicalStance": technical.get("stance"),
        "trendDirection": trend.get("direction"),
        "trendStrength": trend.get("strength"),
        "maStack": trend.get("maStack"),
        "momentumValue": momentum.get("value"),
        "momentumDivergence": momentum.get("divergence"),
        "atr": volatility.get("atr"),
        "atrPercent": volatility.get("atrPercent"),
        "volatilityRegime": volatility.get("regime"),
        "volatilityPercentile": volatility.get("percentile"),
        "volumeRatio": volume.get("ratio"),
        "volumeTrend": volume.get("trend"),
        "smcBias": smc.get("bias"),
        "orderFlowAvailable": bool(flow.get("available")),
        "orderFlowDelta": flow.get("cumulativeDelta"),
        "orderBookAvailable": bool(book.get("available")),
        "derivativesAvailable": bool(derivatives.get("available")),
        "probUp": forecast.get("probUp"),
        "probDown": forecast.get("probDown"),
        "forecastBias": forecast.get("bias"),
        "forecastConfidence": forecast.get("confidence"),
        "signalAction": signal.get("action"),
        "signalConfidence": signal.get("confidence"),
        "signalEntry": signal.get("entry"),
        "signalStop": signal.get("stopLoss"),
        "signalRR": signal.get("riskRewardRatio"),
        "signalNetRR": signal.get("netRiskRewardRatio"),
    }

    # Per-group factor scores, in a stable order. These are the actual evidence
    # weights; a live/replay divergence in any one of them is the difference
    # between two systems that agree on price and disagree on everything else.
    for factor in signal.get("factors") or []:
        group = str(factor.get("group", "")).upper()
        if group:
            out[f"factor.{group}.score"] = factor.get("score")
            out[f"factor.{group}.weight"] = factor.get("weight")

    return out


def _price_readings(analysis: dict[str, Any]) -> tuple[str, str]:
    technical = analysis.get("technical") or {}
    volatility = technical.get("volatility") or {}
    trend = technical.get("trend") or {}
    return (
        str(volatility.get("regime", "UNKNOWN")),
        str(trend.get("direction", "UNKNOWN")),
    )


def replay_series(
    series: Series, config: DiagnosticsConfig = DEFAULT
) -> SeriesReplay:
    """
    Re-run the live signal path across one series.

    Every call sees ``candles[: i + 1]`` and nothing else.
    """
    out = SeriesReplay(
        symbol=series.symbol,
        asset_class=series.asset_class,
        timeframe=series.timeframe,
    )

    replay_cfg = config.replay
    last_scorable = len(series) - replay_cfg.min_forward_bars
    if last_scorable <= replay_cfg.warmup_bars:
        return out

    indices = list(range(replay_cfg.warmup_bars, last_scorable, max(1, replay_cfg.stride)))
    if len(indices) > replay_cfg.max_bars_per_series:
        indices = indices[-replay_cfg.max_bars_per_series :]

    for i in indices:
        window = series.candles[: i + 1]
        try:
            analysis = pipeline.analyse(
                window,
                symbol=series.symbol,
                asset_class=series.asset_class,
                timeframe=series.timeframe,
                with_calibration=replay_cfg.with_calibration,
            )
        except Exception as error:  # noqa: BLE001 — a bad bar must not end the series
            out.errors += 1
            if len(out.error_examples) < 3:
                out.error_examples.append(f"bar {i}: {error}")
            continue

        out.bars_scored += 1
        signal = analysis.get("signal") or {}
        action = str(signal.get("action", "WAIT"))
        regime, trend_direction = _price_readings(analysis)

        if action not in ("BUY", "SELL"):
            reason = str(signal.get("rejectionReason") or "unspecified")
            out.wait_reasons[_reason_key(reason)] = (
                out.wait_reasons.get(_reason_key(reason), 0) + 1
            )
            continue

        costs = signal.get("costs") or {}
        entry_zone = signal.get("entryZone") or {}

        out.signals.append(
            ReplaySignal(
                symbol=series.symbol,
                asset_class=series.asset_class,
                timeframe=series.timeframe,
                bar_index=i,
                generated_at=int(series.candles[i]["time"]),
                action=action,
                confidence=float(signal.get("confidence") or 0.0),
                entry=_maybe_float(signal.get("entry")),
                entry_low=_maybe_float(entry_zone.get("low")),
                entry_high=_maybe_float(entry_zone.get("high")),
                stop_loss=_maybe_float(signal.get("stopLoss")),
                targets=list(signal.get("targets") or []),
                risk_reward=float(signal.get("riskRewardRatio") or 0.0),
                net_risk_reward=float(signal.get("netRiskRewardRatio") or 0.0),
                risk_percent=float(signal.get("riskPercent") or 0.0),
                round_trip_bps=float(costs.get("roundTripBps") or 0.0),
                regime=regime,
                trend_direction=trend_direction,
                rejection_reason=None,
                feature_vector=_feature_vector(analysis),
            )
        )

    return out


#: Every live number stripped out of a rejection reason, so the reasons group.
#: Without this, "Confidence 47 is below the 45 floor" and "Confidence 48 is
#: below the 45 floor" are two distinct reasons and the tally is a list of
#: sentences rather than a distribution.
_NUMBERS = re.compile(r"[-+]?\d[\d,]*\.?\d*")


def _reason_key(reason: str) -> str:
    """Collapse a rejection reason to its type."""
    leading = reason.split("—")[0].split(".")[0].strip()
    return _NUMBERS.sub("N", leading)[:90] or "unspecified"


def _maybe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ─────────────────────────────────────────────────────────────────
#  Parallel driver
# ─────────────────────────────────────────────────────────────────


def _worker(payload: tuple[Series, DiagnosticsConfig]) -> SeriesReplay:
    series, config = payload
    return replay_series(series, config)


def replay_all(
    series_list: list[Series],
    config: DiagnosticsConfig = DEFAULT,
    *,
    progress: bool = True,
) -> list[SeriesReplay]:
    """
    Replay every series, one process per series.

    One full analysis measured at ~140 ms uncalibrated, so an exhaustive replay
    of a few thousand bars is minutes of CPU rather than seconds. Series are
    independent by construction — no shared state, no ordering between them —
    which makes process-level fan-out both safe and the only parallelism worth
    having, given the engine is numpy-bound and holds the GIL for most of it.
    """
    workers = config.replay.workers or max(1, (os.cpu_count() or 2) - 2)

    if workers <= 1 or len(series_list) <= 1:
        results = []
        for index, series in enumerate(series_list, start=1):
            if progress:
                log.info("replay %d/%d %s", index, len(series_list), series.key)
            results.append(replay_series(series, config))
        return results

    from multiprocessing import Pool

    payloads = [(s, config) for s in series_list]
    results = []
    with Pool(processes=workers) as pool:
        for index, result in enumerate(
            pool.imap_unordered(_worker, payloads, chunksize=1), start=1
        ):
            if progress:
                log.info(
                    "replay %d/%d %s:%s — %d bars, %d signals",
                    index, len(series_list), result.symbol, result.timeframe,
                    result.bars_scored, len(result.signals),
                )
            results.append(result)

    return results


def collect_signals(replays: list[SeriesReplay]) -> list[ReplaySignal]:
    """Every tradeable signal from every series, in time order."""
    signals = [s for r in replays for s in r.trades]
    signals.sort(key=lambda s: (s.generated_at, s.symbol, s.timeframe))
    return signals
