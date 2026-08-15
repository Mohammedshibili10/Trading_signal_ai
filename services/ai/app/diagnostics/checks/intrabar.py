"""
§1.4 — intrabar path audit.

For every closed trade, did the exit bar's high–low range contain **both** the
stop and the target? On those bars, OHLC cannot say which was touched first, and
the simulator has to choose. That choice is worth however much of the reported
result rests on it.

Two numbers come out of this. The **ambiguity rate** says how often the question
arises — on fast bars with wicks it is routinely 10–20%, and a system whose rate
is far above that is not being resolved by price so much as by the resolution
policy. The **pessimistic-versus-optimistic spread** says what the answer is
worth: it is the full range of results the same trades can be made to produce
without changing a single line of signal logic.

Only the pessimistic number is trustworthy. A live fill has no obligation to
give you the good side of an ambiguous bar, and assuming it does is the single
easiest way to publish a backtest that cannot be reproduced with money.
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
    """Ambiguity rate, and the spread between the two resolution policies."""
    pessimistic = simulate_all(
        signals, candles_by_series, config.with_intrabar_policy("pessimistic")
    )
    optimistic = simulate_all(
        signals, candles_by_series, config.with_intrabar_policy("optimistic")
    )

    pess_stats = metrics.compute(
        pessimistic.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )
    opt_stats = metrics.compute(
        optimistic.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )

    ambiguous = [t for t in pessimistic.trades if t.ambiguous_exit]
    total = len(pessimistic.trades)
    rate = len(ambiguous) / total if total else 0.0

    # Where the ambiguity concentrates. A rate that is uniform across timeframes
    # is a data-resolution problem; one that spikes on the fastest bars is the
    # stop and target simply being too close together to separate at that bar
    # size, which is a geometry problem and fixable.
    by_timeframe: dict[str, dict[str, Any]] = {}
    for trade in pessimistic.trades:
        bucket = by_timeframe.setdefault(
            trade.timeframe, {"trades": 0, "ambiguous": 0}
        )
        bucket["trades"] += 1
        if trade.ambiguous_exit:
            bucket["ambiguous"] += 1
    for bucket in by_timeframe.values():
        bucket["rate"] = round(bucket["ambiguous"] / bucket["trades"], 4)

    return {
        "id": "1.4",
        "title": "Intrabar path audit",
        "closedTrades": total,
        "ambiguousTrades": len(ambiguous),
        "ambiguityRate": round(rate, 4),
        "ambiguityByTimeframe": dict(
            sorted(by_timeframe.items(), key=lambda kv: -kv[1]["trades"])
        ),
        "pessimistic": pess_stats.to_dict(),
        "optimistic": opt_stats.to_dict(),
        "policySpread": {
            "netR": round(opt_stats.net_r - pess_stats.net_r, 3),
            "expectancyR": round(
                opt_stats.expectancy_r - pess_stats.expectancy_r, 4
            ),
            "hitRate": round(opt_stats.hit_rate - pess_stats.hit_rate, 4),
        },
        "verdict": _verdict(rate, pess_stats, opt_stats),
        "note": (
            "Only the pessimistic column is a result. The optimistic column is the "
            "size of the assumption, shown so it cannot be mistaken for a finding."
        ),
    }


def _verdict(rate: float, pessimistic, optimistic) -> str:
    if pessimistic.trades == 0:
        return "NO_POPULATION"

    swing = optimistic.expectancy_r - pessimistic.expectancy_r
    sign_flips = pessimistic.expectancy_r <= 0 < optimistic.expectancy_r

    if sign_flips:
        return (
            f"POLICY_DECIDES_THE_VERDICT — {rate * 100:.1f}% of exits are ambiguous, and "
            f"the system is negative under adverse resolution ({pessimistic.expectancy_r:+.4f}R) "
            f"and positive under favourable resolution ({optimistic.expectancy_r:+.4f}R). "
            f"The reported result is a property of the resolution assumption, not of the "
            f"strategy. Nothing here can be trusted without tick or sub-bar data."
        )
    if rate > 0.2:
        return (
            f"HIGH_AMBIGUITY — {rate * 100:.1f}% of exits are ambiguous, above the 10–20% "
            f"band typical of fast crypto bars. Expectancy moves {swing:+.4f}R between "
            f"policies. Stop and target are close enough together relative to bar range "
            f"that price frequently reaches both within one bar."
        )
    return (
        f"ACCEPTABLE_AMBIGUITY — {rate * 100:.1f}% of exits are ambiguous and expectancy "
        f"moves {swing:+.4f}R between resolution policies. The pessimistic result stands "
        f"as the honest one."
    )
