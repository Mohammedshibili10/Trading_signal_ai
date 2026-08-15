"""
§1.1 — zero-cost ablation.

The same trades, resolved twice: once with the engine's cost model charged, once
with it switched off entirely. This is the only place in the codebase permitted
to disable costs, and it is disabled here for one bar of the analysis and no
longer.

The test bisects the whole problem space in a single run:

* **Profitable gross, negative net** — the signal layer finds something, and
  friction is larger than what it finds. The lever is horizon and selectivity:
  fewer trades, further targets, cheaper venues. Nothing about the analysis
  needs to change, and changing it is the expensive way to fail.
* **Negative gross** — there is no edge to protect. No cost model, gate,
  ranking layer or execution improvement downstream can rescue it, because the
  quantity they would all be operating on is already below zero.

Running anything else before this one is how a rebuild spends three weeks
improving the second case as though it were the first.
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
    """Both arms, plus the interpretation the result implies."""
    with_costs = simulate_all(signals, candles_by_series, config)
    zero_costs = simulate_all(signals, candles_by_series, config.with_costs_disabled())

    net_stats = metrics.compute(
        with_costs.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )
    gross_stats = metrics.compute(
        zero_costs.trades, min_trades_for_confidence=config.min_trades_for_confidence
    )

    verdict, interpretation = _interpret(gross_stats, net_stats)

    # How much friction actually took, as a share of what the signal produced.
    # Reported because "costs are 40% of gross" and "costs are 400% of gross"
    # are the same sign and completely different problems.
    drag = 0.0
    if gross_stats.trades and gross_stats.net_r != 0:
        drag = (gross_stats.net_r - net_stats.net_r) / abs(gross_stats.net_r)

    return {
        "id": "1.1",
        "title": "Zero-cost ablation",
        "withCosts": net_stats.to_dict(),
        "zeroCost": gross_stats.to_dict(),
        "costDragFractionOfGross": round(drag, 4),
        "averageCostR": round(
            sum(t.cost_r for t in with_costs.trades) / len(with_costs.trades), 4
        )
        if with_costs.trades
        else 0.0,
        "breakEvenHitRateAtQuotedRR": round(
            metrics.required_hit_rate(
                sum(t.quoted_rr for t in with_costs.trades) / len(with_costs.trades),
                sum(t.cost_r for t in with_costs.trades) / len(with_costs.trades),
            ),
            4,
        )
        if with_costs.trades
        else None,
        "unresolved": {
            "neverFilled": with_costs.never_filled,
            "insufficientForwardBars": with_costs.insufficient_forward_bars,
            "malformed": with_costs.malformed,
        },
        "verdict": verdict,
        "interpretation": interpretation,
    }


def _interpret(gross, net) -> tuple[str, str]:
    if gross.trades == 0:
        return (
            "NO_POPULATION",
            "The replay produced no resolvable trades, so this test has nothing to "
            "measure. Every other diagnostic that depends on a trade population is "
            "equally unanswerable until that is fixed.",
        )

    if gross.expectancy_r <= 0:
        return (
            "NO_EDGE_AT_ZERO_COST",
            f"Expectancy is {gross.expectancy_r:+.4f}R per trade with every fee, spread "
            f"and slippage set to zero. There is no edge in the signal layer to protect. "
            f"No cost model, gate, ranking layer or execution change can rescue this, "
            f"because all of them operate on a quantity that is already negative. The "
            f"work belongs in the signal hypothesis, not downstream of it.",
        )

    if net.expectancy_r <= 0:
        return (
            "EDGE_SMALLER_THAN_FRICTION",
            f"Expectancy is {gross.expectancy_r:+.4f}R gross and {net.expectancy_r:+.4f}R "
            f"after costs. The signal layer finds something real; friction is larger than "
            f"what it finds. The fix is horizon and selectivity — fewer, longer-held, "
            f"larger-move trades — not more analysis. Adding conditions here would shrink "
            f"the sample without touching the ratio that is actually wrong.",
        )

    return (
        "EDGE_SURVIVES_COSTS",
        f"Expectancy is {net.expectancy_r:+.4f}R per trade after costs on "
        f"{net.trades} trades (t = {net.t_stat:+.2f}). The edge survives the friction "
        f"the engine models. Whether it survives the friction the market charges is a "
        f"question for the paper-forward test, not for this one.",
    )
