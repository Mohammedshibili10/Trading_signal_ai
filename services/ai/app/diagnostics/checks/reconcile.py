"""
§1.5 — live versus replay reconciliation.

The live path and the replay path are two independent computations of the same
quantity. They should agree field for field on the same instrument, timeframe
and closed bar. Every place they do not is a place where a backtest result does
not describe the system that is actually running.

This is the check that catches data drift before it costs money, and it is the
one that has to run unattended, because drift does not announce itself: a
provider changes a field, a timezone shifts by an hour, a feed starts including
the forming bar, and every number downstream moves slightly while every test
that does not compare the two paths keeps passing.

The comparison has three modes, in decreasing order of strength:

1. **Against a live log.** ``live_log.py`` writes the full input snapshot at
   every published signal. Replaying those exact timestamps and diffing is the
   real test.
2. **Determinism.** With no live log yet, replaying the same bar twice must
   produce byte-identical snapshots. This proves only that the harness is
   stable — it cannot detect live drift — but a harness that fails it makes
   mode 1 meaningless, so it is worth asserting first.
3. **Structural.** The set of fields the live path emits must equal the set the
   replay emits. A field present on one side and absent on the other is drift
   that a value comparison would silently skip.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import DiagnosticsConfig
from ..loader import Series
from ..replay import _feature_vector

log = logging.getLogger(__name__)


@dataclass
class FieldDiff:
    field: str
    live: Any
    replay: Any
    absolute: float | None
    relative: float | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "live": self.live,
            "replay": self.replay,
            "absolute": round(self.absolute, 9) if self.absolute is not None else None,
            "relative": round(self.relative, 9) if self.relative is not None else None,
        }


def compare_vectors(
    live: dict[str, Any], replay: dict[str, Any], config: DiagnosticsConfig
) -> list[FieldDiff]:
    """
    Field-by-field diff of two snapshots.

    Missing keys are reported as diffs rather than skipped — a field that
    exists on one side and not the other is the most consequential kind of
    drift and the easiest kind to miss.
    """
    tolerance = config.reconciliation
    diffs: list[FieldDiff] = []

    for key in sorted(set(live) | set(replay)):
        left = live.get(key, "<missing>")
        right = replay.get(key, "<missing>")

        if isinstance(left, bool) or isinstance(right, bool):
            if left != right:
                diffs.append(FieldDiff(key, left, right, None, None))
            continue

        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            absolute = abs(float(left) - float(right))
            scale = max(abs(float(left)), abs(float(right)), 1e-12)
            relative = absolute / scale
            if (
                absolute > tolerance.absolute_tolerance
                and relative > tolerance.relative_tolerance
            ):
                diffs.append(FieldDiff(key, left, right, absolute, relative))
            continue

        if left != right:
            diffs.append(FieldDiff(key, left, right, None, None))

    return diffs


def load_live_log(path: str | Path) -> list[dict[str, Any]]:
    """
    Read the JSONL the live path writes.

    Malformed lines are skipped rather than fatal. A log this is reading is
    being appended to by a running service, so a torn final line is normal.
    """
    entries: list[dict[str, Any]] = []
    file = Path(path)
    if not file.exists():
        return entries

    with file.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def run(
    series_list: list[Series],
    config: DiagnosticsConfig,
    *,
    live_log_path: str | Path | None = None,
) -> dict[str, Any]:
    """Whichever of the three modes the available data supports."""
    from ..replay import replay_series
    from dataclasses import replace

    determinism = _determinism_check(series_list, config)

    entries = load_live_log(live_log_path) if live_log_path else []
    if not entries:
        return {
            "id": "1.5",
            "title": "Live vs backtest reconciliation",
            "mode": "DETERMINISM_ONLY",
            "liveEntries": 0,
            "determinism": determinism,
            "verdict": (
                "NOT_YET_INSTRUMENTED — no live snapshots exist to reconcile against. "
                "The live path now writes them (see diagnostics/live_log.py); this check "
                "becomes a real comparison as soon as the scanner has run with logging "
                "enabled. Until then it asserts only that the replay harness is "
                "deterministic, which is a precondition for the comparison and not a "
                "substitute for it."
            ),
        }

    # Mode 1 — replay the exact bars the live path scored.
    by_key = {s.key: s for s in series_list}
    compared = 0
    unmatched = 0
    field_diff_counts: dict[str, int] = {}
    examples: list[dict[str, Any]] = []

    for entry in entries:
        key = f"{entry.get('symbol')}:{entry.get('timeframe')}"
        series = by_key.get(key)
        generated_at = entry.get("generatedAt")
        live_vector = entry.get("featureVector") or {}
        if series is None or generated_at is None or not live_vector:
            unmatched += 1
            continue

        index = _index_of_bar(series, int(generated_at))
        if index is None:
            unmatched += 1
            continue

        single = Series(
            symbol=series.symbol,
            asset_class=series.asset_class,
            timeframe=series.timeframe,
            candles=series.candles[: index + 1],
            sources=series.sources,
        )
        replayed = replay_series(
            single,
            replace(
                config,
                replay=replace(
                    config.replay,
                    warmup_bars=index,
                    stride=1,
                    min_forward_bars=0,
                    max_bars_per_series=1,
                ),
            ),
        )
        if not replayed.signals and not replayed.bars_scored:
            unmatched += 1
            continue

        replay_vector = (
            replayed.signals[-1].feature_vector
            if replayed.signals
            else _feature_vector({})
        )
        diffs = compare_vectors(live_vector, replay_vector, config)
        compared += 1
        for diff in diffs:
            field_diff_counts[diff.field] = field_diff_counts.get(diff.field, 0) + 1
        if diffs and len(examples) < 10:
            examples.append(
                {
                    "symbol": series.symbol,
                    "timeframe": series.timeframe,
                    "generatedAt": generated_at,
                    "diffs": [d.to_dict() for d in diffs[:12]],
                }
            )

    return {
        "id": "1.5",
        "title": "Live vs backtest reconciliation",
        "mode": "LIVE_COMPARISON",
        "liveEntries": len(entries),
        "compared": compared,
        "unmatched": unmatched,
        "fieldsWithDiffs": dict(
            sorted(field_diff_counts.items(), key=lambda kv: -kv[1])
        ),
        "examples": examples,
        "determinism": determinism,
        "verdict": (
            f"CLEAN — {compared} live snapshots reconciled with no field differences."
            if compared and not field_diff_counts
            else f"DRIFT — {len(field_diff_counts)} field(s) differ across {compared} "
            f"reconciled snapshots. Every one is a place the backtest describes a "
            f"different system from the one running."
            if compared
            else "NO_MATCHES — live snapshots exist but none matched a stored bar."
        ),
    }


def _index_of_bar(series: Series, generated_at: int) -> int | None:
    """Position of the bar whose close timestamp the live path recorded."""
    for index in range(len(series) - 1, -1, -1):
        if int(series.candles[index]["time"]) == generated_at:
            return index
    return None


def _determinism_check(
    series_list: list[Series], config: DiagnosticsConfig
) -> dict[str, Any]:
    """Replay one bar twice; the snapshots must be identical."""
    from ..replay import replay_series
    from dataclasses import replace

    candidates = [s for s in series_list if len(s) > config.replay.warmup_bars + 5]
    if not candidates:
        return {"ran": False, "reason": "no series long enough"}

    series = candidates[0]
    # Wide enough that the window actually contains signals. A three-bar sample
    # can easily score three bars the engine declines on, and a determinism
    # check that compares two empty lists passes without having tested anything.
    narrow = replace(
        config,
        replay=replace(
            config.replay, stride=1, min_forward_bars=0, max_bars_per_series=120
        ),
    )

    first = replay_series(series, narrow)
    second = replay_series(series, narrow)

    vectors_first = [s.feature_vector for s in first.signals]
    vectors_second = [s.feature_vector for s in second.signals]

    identical = json.dumps(vectors_first, sort_keys=True, default=str) == json.dumps(
        vectors_second, sort_keys=True, default=str
    )

    return {
        "ran": True,
        "series": series.key,
        "signalsCompared": len(vectors_first),
        "barsScored": first.bars_scored,
        "identical": identical,
    }
