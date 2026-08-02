"""
Learning from realised outcomes.

Calibration already measures the engine against history by replaying it on past
bars. That answers "would this engine have been right?" — a simulation, however
carefully constructed.

This module answers a different and harder question: **of the signals actually
issued, which ones actually worked?** Those two numbers come apart, and where
they come apart is exactly where the engine is fooling itself. A walk-forward
pass assumes the entry filled at the close, the stop was honoured to the tick,
and no slippage occurred. Live signals fill late, gap through stops, and get
cancelled before triggering. The realised record is the only place that shows up.

The whole design problem here is **not overfitting to a handful of trades.**
Four wins out of five is a 80% win rate and means almost nothing; the same ratio
over two hundred trades is a real edge. So every estimate is shrunk toward the
prior in proportion to how little evidence supports it, using a Beta-Binomial
posterior. With three samples the adjustment is nearly invisible. With three
hundred it dominates. That is the correct behaviour and it is also the behaviour
that stops the engine chasing noise.

Nothing here ever raises confidence above the engine's hard cap, and the
adjustment is bounded in both directions — a learning loop that can move a
number arbitrarily far is a loop that will eventually move it somewhere absurd.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

#: Prior strength, in pseudo-observations.
#:
#: Set to 25 deliberately: it takes roughly that many real trades before the
#: evidence outweighs the assumption, which matches how long it takes a human to
#: stop believing a lucky streak.
PRIOR_STRENGTH = 25.0

#: The prior itself — what the engine claims before evidence. Its own stated
#: floor for issuing a signal, because that is the honest expectation.
PRIOR_WIN_RATE = 0.50

#: Hard bounds on the multiplier. Learning tunes, it does not override.
MIN_MULTIPLIER = 0.60
MAX_MULTIPLIER = 1.20

#: Below this many resolved signals the bucket reports itself as unlearned.
MIN_SAMPLES_TO_REPORT = 8


@dataclass
class Outcome:
    """One resolved signal, reduced to what learning needs."""

    symbol: str
    timeframe: str
    action: str
    #: Confidence at issue, 0…100.
    confidence: float
    #: HIT_T1 | HIT_T2 | HIT_T3 | STOPPED | EXPIRED
    status: str
    risk_reward: float

    @property
    def resolved(self) -> bool:
        return self.status in ("HIT_T1", "HIT_T2", "HIT_T3", "STOPPED")

    @property
    def won(self) -> bool:
        return self.status.startswith("HIT_")

    @property
    def r_multiple(self) -> float:
        """
        Realised R, approximated from which target was reached.

        A stop is −1R by construction. T1 is taken as 1R even when its nominal
        reward:risk is higher, because partial exits and slippage mean the full
        nominal is rarely realised — assuming otherwise is how a backtest
        flatters itself.
        """
        if self.status == "STOPPED":
            return -1.0
        if self.status == "HIT_T1":
            return 1.0
        if self.status == "HIT_T2":
            return min(2.0, max(1.0, self.risk_reward))
        if self.status == "HIT_T3":
            return min(3.0, max(1.5, self.risk_reward * 1.5))
        return 0.0


def _posterior(wins: int, total: int, prior: float = PRIOR_WIN_RATE) -> float:
    """
    Shrunk win-rate estimate.

    Beta-Binomial with the prior expressed as pseudo-observations. The estimate
    starts at the prior and migrates toward the observed rate at a speed set by
    how much evidence has accumulated.
    """
    if total <= 0:
        return prior
    alpha = prior * PRIOR_STRENGTH + wins
    beta = (1 - prior) * PRIOR_STRENGTH + (total - wins)
    return float(alpha / (alpha + beta))


def _credible_interval(wins: int, total: int) -> tuple[float, float]:
    """
    Rough 90% credible interval on the posterior.

    Normal approximation to the Beta — adequate at these sample sizes and far
    cheaper than the exact quantiles. Reported so the width of the uncertainty
    is visible rather than implied.
    """
    alpha = PRIOR_WIN_RATE * PRIOR_STRENGTH + wins
    beta = (1 - PRIOR_WIN_RATE) * PRIOR_STRENGTH + max(0, total - wins)
    mean = alpha / (alpha + beta)
    variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1))
    spread = 1.645 * float(np.sqrt(variance))
    return max(0.0, mean - spread), min(1.0, mean + spread)


def summarise(outcomes: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Aggregate a realised record into something the engine can act on.

    Buckets by symbol, by timeframe, and by the confidence band the signal was
    issued in. That last one is the most diagnostic: if signals issued at 70+
    resolve no better than those issued at 50, the confidence number is not
    measuring anything and should be trusted less across the board.
    """
    parsed = [
        Outcome(
            symbol=str(o.get("symbol", "")),
            timeframe=str(o.get("timeframe", "")),
            action=str(o.get("action", "")),
            confidence=float(o.get("confidence") or 0.0),
            status=str(o.get("status", "")),
            risk_reward=float(o.get("riskRewardRatio") or 0.0),
        )
        for o in outcomes
    ]
    resolved = [o for o in parsed if o.resolved]

    if not resolved:
        return {
            "samples": 0,
            "learned": False,
            "overall": None,
            "bySymbol": {},
            "byTimeframe": {},
            "byConfidenceBand": [],
            "summary": (
                "No signals have resolved yet. The engine is running on walk-forward "
                "calibration alone until live outcomes accumulate."
            ),
        }

    wins = sum(1 for o in resolved if o.won)
    total = len(resolved)
    expectancy = float(np.mean([o.r_multiple for o in resolved]))
    posterior = _posterior(wins, total)
    low, high = _credible_interval(wins, total)

    def bucket(keyfn) -> dict[str, Any]:
        groups: dict[str, list[Outcome]] = {}
        for outcome in resolved:
            groups.setdefault(keyfn(outcome), []).append(outcome)

        return {
            key: {
                "samples": len(items),
                "wins": sum(1 for i in items if i.won),
                "rawWinRate": round(sum(1 for i in items if i.won) / len(items), 4),
                "adjustedWinRate": round(
                    _posterior(sum(1 for i in items if i.won), len(items)), 4
                ),
                "expectancyR": round(float(np.mean([i.r_multiple for i in items])), 3),
                # Below the reporting floor the number exists but should not be
                # acted on, and saying so is more useful than hiding it.
                "reliable": len(items) >= MIN_SAMPLES_TO_REPORT,
            }
            for key, items in groups.items()
        }

    # Confidence bands, to test whether the confidence number means anything.
    bands = [(0, 50), (50, 60), (60, 70), (70, 85)]
    by_band = []
    for low_edge, high_edge in bands:
        items = [o for o in resolved if low_edge <= o.confidence < high_edge]
        if not items:
            continue
        band_wins = sum(1 for i in items if i.won)
        by_band.append({
            "band": f"{low_edge}–{high_edge}",
            "samples": len(items),
            "rawWinRate": round(band_wins / len(items), 4),
            "adjustedWinRate": round(_posterior(band_wins, len(items)), 4),
            "expectancyR": round(float(np.mean([i.r_multiple for i in items])), 3),
        })

    learned = total >= MIN_SAMPLES_TO_REPORT

    if not learned:
        summary = (
            f"{total} signal(s) resolved — too few to learn from. "
            f"At least {MIN_SAMPLES_TO_REPORT} are needed before live outcomes adjust anything."
        )
    else:
        direction = (
            "better than" if posterior > PRIOR_WIN_RATE + 0.03
            else "worse than" if posterior < PRIOR_WIN_RATE - 0.03
            else "in line with"
        )
        summary = (
            f"{wins} of {total} resolved signals hit a target — a raw win rate of "
            f"{wins / total * 100:.0f}%, shrunk to {posterior * 100:.0f}% "
            f"({low * 100:.0f}–{high * 100:.0f}% at 90% credibility). "
            f"That is {direction} the engine's own 50% baseline. "
            f"Realised expectancy {expectancy:+.2f}R per trade."
        )

    return {
        "samples": total,
        "learned": learned,
        "overall": {
            "wins": wins,
            "losses": total - wins,
            "rawWinRate": round(wins / total, 4),
            "adjustedWinRate": round(posterior, 4),
            "credibleInterval": [round(low, 4), round(high, 4)],
            "expectancyR": round(expectancy, 3),
        },
        "bySymbol": bucket(lambda o: o.symbol),
        "byTimeframe": bucket(lambda o: o.timeframe),
        "byConfidenceBand": by_band,
        "summary": summary,
    }


def adjustment(
    knowledge: dict[str, Any],
    *,
    symbol: str,
    timeframe: str,
) -> dict[str, Any]:
    """
    The confidence multiplier this instrument's realised record justifies.

    Prefers the symbol-specific record when it is large enough to be reliable,
    otherwise the timeframe record, otherwise the overall one. Each falls back
    rather than blending, because blending three noisy estimates produces a
    fourth noisy estimate that is harder to reason about.
    """
    if not knowledge or not knowledge.get("learned"):
        return {
            "multiplier": 1.0,
            "basis": "none",
            "samples": 0,
            "note": (
                "No realised record yet — confidence rests on walk-forward calibration alone."
            ),
        }

    by_symbol = (knowledge.get("bySymbol") or {}).get(symbol)
    by_timeframe = (knowledge.get("byTimeframe") or {}).get(timeframe)
    overall = knowledge.get("overall") or {}

    if by_symbol and by_symbol.get("reliable"):
        rate, samples, basis = by_symbol["adjustedWinRate"], by_symbol["samples"], f"{symbol} record"
    elif by_timeframe and by_timeframe.get("reliable"):
        rate, samples, basis = (
            by_timeframe["adjustedWinRate"],
            by_timeframe["samples"],
            f"{timeframe} record",
        )
    else:
        rate, samples, basis = (
            overall.get("adjustedWinRate", PRIOR_WIN_RATE),
            knowledge.get("samples", 0),
            "overall record",
        )

    # Map the shrunk win rate onto a multiplier around the baseline. A realised
    # 60% against a 50% prior earns +20%; a realised 40% costs 20%.
    ratio = float(rate) / PRIOR_WIN_RATE
    multiplier = float(np.clip(ratio, MIN_MULTIPLIER, MAX_MULTIPLIER))

    return {
        "multiplier": round(multiplier, 3),
        "basis": basis,
        "samples": int(samples),
        "adjustedWinRate": round(float(rate), 4),
        "note": (
            f"Adjusted by the {basis} — {samples} resolved signals at a shrunk "
            f"{float(rate) * 100:.0f}% win rate, giving a ×{multiplier:.2f} confidence factor."
        ),
    }
