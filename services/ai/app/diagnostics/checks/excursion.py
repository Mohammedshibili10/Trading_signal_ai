"""
§1.6 — maximum adverse and favourable excursion.

For every trade, how far it went against itself before resolving (MAE) and how
far it went in its favour (MFE), both in R.

Two figures decide whether the trade geometry is wrong, and in which direction:

* **Losing trades whose MFE exceeded half the target distance.** These are
  trades that were most of the way to being right and were not allowed to
  finish. A high share means the target is beyond where the move actually goes,
  and the fix is to move the target in — which also lowers the reward:risk the
  system quotes, and that is the honest trade-off rather than a loss.
* **Winning trades whose MAE exceeded half the stop distance.** These are trades
  that were nearly stopped out before working. A high share means the stop sits
  inside the noise the setup has to trade through, and the fix is a wider stop
  with a smaller position, which changes nothing about the analysis.

Intraday systems are corrected here far more often than at entry, because entry
quality is the part everyone already spends their attention on and exit geometry
is the part that silently sets the win rate.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..config import DiagnosticsConfig
from ..simulate import SimulatedTrade


def run(
    trades: list[SimulatedTrade], config: DiagnosticsConfig
) -> dict[str, Any]:
    """Distributions, split by outcome, plus the two headline percentages."""
    if not trades:
        return {
            "id": "1.6",
            "title": "MAE / MFE distributions",
            "trades": 0,
            "verdict": "NO_POPULATION",
        }

    excursion_cfg = config.excursion
    winners = [t for t in trades if t.is_win]
    losers = [t for t in trades if not t.is_win]

    # Losing trades that were most of the way to the target before turning.
    losers_with_far_mfe = [
        t
        for t in losers
        if t.mfe_fraction_of_target > excursion_cfg.mfe_threshold_of_target
    ]
    # Winning trades that nearly hit the stop first.
    winners_with_deep_mae = [
        t for t in winners if t.mae_r > excursion_cfg.mae_threshold_of_stop
    ]

    losers_far_mfe_pct = len(losers_with_far_mfe) / len(losers) if losers else 0.0
    winners_deep_mae_pct = (
        len(winners_with_deep_mae) / len(winners) if winners else 0.0
    )

    return {
        "id": "1.6",
        "title": "MAE / MFE distributions",
        "trades": len(trades),
        "winners": len(winners),
        "losers": len(losers),
        "maeHistogram": {
            "winners": _histogram([t.mae_r for t in winners], excursion_cfg.bucket_r),
            "losers": _histogram([t.mae_r for t in losers], excursion_cfg.bucket_r),
        },
        "mfeHistogram": {
            "winners": _histogram([t.mfe_r for t in winners], excursion_cfg.bucket_r),
            "losers": _histogram([t.mfe_r for t in losers], excursion_cfg.bucket_r),
        },
        "summary": {
            "winners": _describe([t.mae_r for t in winners], [t.mfe_r for t in winners]),
            "losers": _describe([t.mae_r for t in losers], [t.mfe_r for t in losers]),
        },
        "losingTradesWithMfeOverHalfTargetPct": round(losers_far_mfe_pct * 100, 1),
        "winningTradesWithMaeOverHalfStopPct": round(winners_deep_mae_pct * 100, 1),
        "thresholds": {
            "mfeFractionOfTarget": excursion_cfg.mfe_threshold_of_target,
            "maeFractionOfStop": excursion_cfg.mae_threshold_of_stop,
        },
        #: What a tighter target would have produced on this exact population,
        #: without re-running anything. Each entry answers "if the target had
        #: been N × R, how many trades reach it before their MAE reaches 1R?"
        "targetSensitivity": _target_sweep(trades),
        "verdict": _verdict(losers_far_mfe_pct, winners_deep_mae_pct),
    }


def _histogram(values: list[float], bucket: float) -> dict[str, int]:
    if not values:
        return {}
    array = np.array(values, dtype=float)
    top = float(np.ceil(max(array.max(), bucket) / bucket) * bucket)
    edges = np.arange(0.0, top + bucket, bucket)
    counts, _ = np.histogram(array, bins=edges)
    return {
        f"{edges[i]:.2f}-{edges[i + 1]:.2f}R": int(counts[i])
        for i in range(len(counts))
        if counts[i] > 0
    }


def _describe(mae: list[float], mfe: list[float]) -> dict[str, float]:
    def stats(values: list[float]) -> dict[str, float]:
        if not values:
            return {}
        array = np.array(values, dtype=float)
        return {
            "median": round(float(np.median(array)), 3),
            "mean": round(float(array.mean()), 3),
            "p75": round(float(np.percentile(array, 75)), 3),
            "p90": round(float(np.percentile(array, 90)), 3),
            "max": round(float(array.max()), 3),
        }

    return {"maeR": stats(mae), "mfeR": stats(mfe)}


def _target_sweep(trades: list[SimulatedTrade]) -> list[dict[str, Any]]:
    """
    Reach rate at a range of target distances.

    Uses the excursions already measured, so it costs nothing to compute and
    needs no second simulation. It is a reach *rate*, not an expectancy: a trade
    whose MFE passed 1.0R may still have hit its stop first on the same bar, and
    that ordering is exactly what a bar cannot tell us. Read it as an upper
    bound on what moving the target in could achieve.
    """
    out = []
    for multiple in (0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0):
        reached = sum(1 for t in trades if t.mfe_r >= multiple)
        out.append(
            {
                "targetR": multiple,
                "reachedPct": round(reached / len(trades) * 100, 1),
                "trades": reached,
            }
        )
    return out


def _verdict(losers_far_mfe: float, winners_deep_mae: float) -> str:
    parts = []
    if losers_far_mfe > 0.4:
        parts.append(
            f"TARGETS_TOO_FAR — {losers_far_mfe * 100:.0f}% of losing trades got more "
            f"than halfway to their target before turning. The move the setup "
            f"identifies is real and is shorter than the target placed on it."
        )
    if winners_deep_mae > 0.4:
        parts.append(
            f"STOPS_TOO_TIGHT — {winners_deep_mae * 100:.0f}% of winning trades went "
            f"more than halfway to the stop first. The stop is inside the noise band "
            f"the setup has to trade through; widening it and sizing down leaves the "
            f"analysis untouched and changes the win rate."
        )
    if not parts:
        parts.append(
            f"GEOMETRY_REASONABLE — {losers_far_mfe * 100:.0f}% of losers reached half "
            f"their target and {winners_deep_mae * 100:.0f}% of winners reached half "
            f"their stop. Neither is the dominant failure."
        )
    return " ".join(parts)
