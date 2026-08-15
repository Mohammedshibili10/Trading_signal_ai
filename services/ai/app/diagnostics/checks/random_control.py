"""
§1.3 — random-direction control.

The whole system is kept: when it fires, how big the position is, where the stop
and target sit, what the round trip costs. Only the **direction** is replaced,
with a seeded coin flip.

This isolates the one claim the signal layer actually makes. Everything except
direction is exit geometry, and exit geometry alone produces a P&L distribution
— usually a negative one shaped by costs and by the stop-to-target ratio, but
occasionally a positive one when the geometry happens to suit the sample. If the
real system does not sit clearly above that distribution, then whatever it is
producing, it is not directional information, and every result attributed to the
analysis actually originates in the shape of the trade.

The percentile is the output that matters. A system at the 55th percentile of
its own coin-flip control has no measurable edge no matter how good its
expectancy looks in isolation, because the control achieved nearly the same
number with no analysis at all.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .. import metrics
from ..config import DiagnosticsConfig
from ..replay import ReplaySignal
from ..simulate import simulate_all


def run(
    signals: list[ReplaySignal],
    candles_by_series: dict[str, list[dict[str, Any]]],
    config: DiagnosticsConfig,
) -> dict[str, Any]:
    """The real system against `seeds` coin-flip replicas of itself."""
    control_cfg = config.random_control

    real = simulate_all(signals, candles_by_series, config)
    real_stats = metrics.compute(
        real.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )

    seed_results: list[dict[str, Any]] = []
    net_totals: list[float] = []
    expectancies: list[float] = []

    for index in range(control_cfg.seeds):
        seed = control_cfg.base_seed + index
        rng = np.random.default_rng(seed)
        directions = {
            position: ("BUY" if rng.random() < 0.5 else "SELL")
            for position in range(len(signals))
        }

        simulated = simulate_all(
            signals, candles_by_series, config, directions=directions
        )
        stats = metrics.compute(
            simulated.trades,
            min_trades_for_confidence=config.min_trades_for_confidence,
        )
        net_totals.append(stats.net_r)
        expectancies.append(stats.expectancy_r)
        seed_results.append(
            {
                "seed": seed,
                "trades": stats.trades,
                "netR": round(stats.net_r, 3),
                "expectancyR": round(stats.expectancy_r, 4),
                "hitRate": round(stats.hit_rate, 4),
            }
        )

    net_array = np.array(net_totals, dtype=float)
    expectancy_array = np.array(expectancies, dtype=float)

    percentile_net = _percentile_of(net_array, real_stats.net_r)
    percentile_expectancy = _percentile_of(expectancy_array, real_stats.expectancy_r)

    shortfall = max(0, control_cfg.target_trades_per_seed - real_stats.trades)

    return {
        "id": "1.3",
        "title": "Random-direction control",
        "seeds": control_cfg.seeds,
        "tradesPerSeed": real_stats.trades,
        "targetTradesPerSeed": control_cfg.target_trades_per_seed,
        "tradeCountShortfall": shortfall,
        "real": real_stats.to_dict(),
        "randomDistribution": {
            "netR": _describe(net_array),
            "expectancyR": _describe(expectancy_array),
        },
        "realPercentileOfRandom": {
            "netR": round(percentile_net, 1),
            "expectancyR": round(percentile_expectancy, 1),
        },
        "seedDetail": seed_results,
        "verdict": _verdict(real_stats, percentile_net, shortfall, control_cfg),
    }


def _describe(values: np.ndarray) -> dict[str, float]:
    if values.size == 0:
        return {}
    return {
        "min": round(float(values.min()), 3),
        "p05": round(float(np.percentile(values, 5)), 3),
        "p25": round(float(np.percentile(values, 25)), 3),
        "median": round(float(np.median(values)), 3),
        "p75": round(float(np.percentile(values, 75)), 3),
        "p95": round(float(np.percentile(values, 95)), 3),
        "max": round(float(values.max()), 3),
        "mean": round(float(values.mean()), 3),
        "stdev": round(float(values.std(ddof=1)), 3) if values.size > 1 else 0.0,
    }


def _percentile_of(distribution: np.ndarray, value: float) -> float:
    """Where `value` sits inside `distribution`, as a percentile."""
    if distribution.size == 0:
        return float("nan")
    return float((distribution < value).sum() / distribution.size * 100.0)


def _verdict(real, percentile: float, shortfall: int, control_cfg) -> str:
    caveat = ""
    if shortfall > 0:
        caveat = (
            f" Sample caveat: {real.trades} trades per seed against the "
            f"{control_cfg.target_trades_per_seed} the protocol asks for — the "
            f"distribution is correspondingly wide and the percentile correspondingly "
            f"imprecise."
        )

    if real.trades == 0:
        return "NO_POPULATION — nothing to compare against the control."
    if percentile != percentile:  # NaN
        return "INCONCLUSIVE"
    if percentile >= 95:
        return (
            f"ABOVE_CONTROL — the real system sits at the {percentile:.0f}th percentile "
            f"of its own coin-flip distribution. The direction call is carrying "
            f"information.{caveat}"
        )
    if percentile >= 80:
        return (
            f"WEAKLY_ABOVE_CONTROL — {percentile:.0f}th percentile. Suggestive, not "
            f"established; a system with no edge lands above the 80th percentile one "
            f"run in five.{caveat}"
        )
    return (
        f"INDISTINGUISHABLE_FROM_RANDOM — the real system sits at the "
        f"{percentile:.0f}th percentile of the coin-flip distribution. The signal "
        f"layer is not contributing measurable directional information; the observed "
        f"results originate in exit geometry and costs.{caveat}"
    )
