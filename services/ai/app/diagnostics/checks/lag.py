"""
§1.2 — one-bar lag test.

Every signal is executed one bar later than the baseline, with nothing else
changed. If the result collapses, the system was reading information it could
not have had: a feature computed on the bar it fires on, a fill priced at that
bar's close, or a feed handing over a candle that has not finished forming.

The reasoning is worth stating precisely, because the test is often read
backwards. A genuine edge decays with delay — that is what makes it an edge in a
market with other participants — so *some* degradation is expected and is not by
itself evidence of a leak. What indicts the system is degradation out of
proportion to the delay: a full collapse from one bar, when one bar is a
rounding error against a multi-day holding period.

The written half of this diagnostic — the five data-path questions — is in
``diagnostics/audit.py``, because those are answered by reading the code, not by
running it. Both halves are required; the lag test detects the *symptom* and the
audit locates the *cause*, and a clean lag test with a dirty audit means only
that the leak has not yet been large enough to measure.
"""

from __future__ import annotations

from typing import Any

from .. import metrics
from ..config import DiagnosticsConfig
from ..replay import ReplaySignal
from ..simulate import simulate_all


def run(
    signals: list[ReplaySignal],
    candles_by_series: dict[str, list[dict[str, Any]]],
    config: DiagnosticsConfig,
) -> dict[str, Any]:
    """Baseline against lagged, with the deltas the spec asks for."""
    extra = config.execution.lag_test_extra_bars

    baseline = simulate_all(signals, candles_by_series, config)
    lagged = simulate_all(
        signals, candles_by_series, config.with_extra_entry_delay(extra)
    )

    base_stats = metrics.compute(
        baseline.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )
    lag_stats = metrics.compute(
        lagged.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )

    delta_expectancy = lag_stats.expectancy_r - base_stats.expectancy_r
    delta_hit = lag_stats.hit_rate - base_stats.hit_rate
    delta_net = lag_stats.net_r - base_stats.net_r

    retained = (
        lag_stats.expectancy_r / base_stats.expectancy_r
        if base_stats.expectancy_r > 0
        else None
    )

    return {
        "id": "1.2",
        "title": f"One-bar lag test (+{extra} bar)",
        "baseline": base_stats.to_dict(),
        "lagged": lag_stats.to_dict(),
        "delta": {
            "netR": round(delta_net, 3),
            "expectancyR": round(delta_expectancy, 4),
            "hitRate": round(delta_hit, 4),
        },
        "expectancyRetainedFraction": round(retained, 3) if retained is not None else None,
        "verdict": _verdict(base_stats, lag_stats, retained),
        "note": (
            "The lag test measures the symptom. The five data-path questions in "
            "the audit section locate the cause, and are answered from the source "
            "rather than from this run — a system can pass the lag test on stored "
            "candles and still leak live, because the stored series contains only "
            "closed bars and the live feed does not."
        ),
    }


def _verdict(base, lagged, retained: float | None) -> str:
    if base.trades == 0 or lagged.trades == 0:
        return "NO_POPULATION"
    if base.expectancy_r <= 0:
        return (
            "BASELINE_ALREADY_NEGATIVE — a lag test on a system with no positive "
            "baseline cannot distinguish leakage from noise. Resolve §1.1 first."
        )
    if retained is None:
        return "INCONCLUSIVE"
    if retained < 0.2:
        return (
            f"COLLAPSE — only {retained * 100:.0f}% of expectancy survives a single "
            "bar of delay. That is the signature of look-ahead, not of decay."
        )
    if retained < 0.6:
        return (
            f"HEAVY_DECAY — {retained * 100:.0f}% of expectancy survives one bar. "
            "Either the edge is extremely short-lived, in which case it is not "
            "reachable at this execution latency, or something smaller than a full "
            "leak is still bleeding through."
        )
    return (
        f"STABLE — {retained * 100:.0f}% of expectancy survives one bar of delay, "
        "which is consistent with a real edge rather than with leakage."
    )
