"""
Performance statistics over a population of resolved trades.

Everything is expressed in **R** — multiples of the trade's own risk distance —
rather than in currency. A crypto 15m setup risking 0.3% and an equity daily
setup risking 4% produce currency numbers that cannot be added together and R
numbers that can. It also removes position sizing from the measurement
entirely, which matters because sizing is a separate decision that would
otherwise be silently folded into the verdict on the signal.

Every statistic here is computed from ``realised_r``, which is already net of
costs. The gross equivalents are computed from ``gross_r`` and reported beside
them, never instead of them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

import numpy as np

from .simulate import SimulatedTrade


@dataclass
class Stats:
    """The headline numbers for one population."""

    trades: int = 0
    net_r: float = 0.0
    gross_r: float = 0.0
    cost_r: float = 0.0
    expectancy_r: float = 0.0
    gross_expectancy_r: float = 0.0
    profit_factor: float = 0.0
    hit_rate: float = 0.0
    average_win_r: float = 0.0
    average_loss_r: float = 0.0
    largest_win_r: float = 0.0
    largest_loss_r: float = 0.0
    sharpe: float = 0.0
    sortino: float = 0.0
    max_drawdown_r: float = 0.0
    calmar: float = 0.0
    average_bars_held: float = 0.0
    #: Standard error of the mean R, and the resulting t-statistic against zero.
    #: A positive expectancy with |t| below 2 is a number, not a finding.
    expectancy_stderr: float = 0.0
    t_stat: float = 0.0
    exit_mix: dict[str, int] = field(default_factory=dict)
    underpowered: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "trades": self.trades,
            "netR": round(self.net_r, 3),
            "grossR": round(self.gross_r, 3),
            "costR": round(self.cost_r, 3),
            "expectancyR": round(self.expectancy_r, 4),
            "grossExpectancyR": round(self.gross_expectancy_r, 4),
            "profitFactor": round(self.profit_factor, 3),
            "hitRate": round(self.hit_rate, 4),
            "averageWinR": round(self.average_win_r, 3),
            "averageLossR": round(self.average_loss_r, 3),
            "largestWinR": round(self.largest_win_r, 3),
            "largestLossR": round(self.largest_loss_r, 3),
            "sharpe": round(self.sharpe, 3),
            "sortino": round(self.sortino, 3),
            "maxDrawdownR": round(self.max_drawdown_r, 3),
            "calmar": round(self.calmar, 3),
            "averageBarsHeld": round(self.average_bars_held, 1),
            "expectancyStderr": round(self.expectancy_stderr, 4),
            "tStat": round(self.t_stat, 2),
            "exitMix": self.exit_mix,
            "underpowered": self.underpowered,
        }


def compute(
    trades: Iterable[SimulatedTrade], *, min_trades_for_confidence: int = 200
) -> Stats:
    """Roll a trade population up into one set of figures."""
    population = list(trades)
    stats = Stats(trades=len(population))
    if not population:
        return stats

    r = np.array([t.realised_r for t in population], dtype=float)
    gross = np.array([t.gross_r for t in population], dtype=float)
    cost = np.array([t.cost_r for t in population], dtype=float)

    wins = r[r > 0]
    losses = r[r < 0]

    stats.net_r = float(r.sum())
    stats.gross_r = float(gross.sum())
    stats.cost_r = float(cost.sum())
    stats.expectancy_r = float(r.mean())
    stats.gross_expectancy_r = float(gross.mean())
    stats.hit_rate = float(len(wins) / len(r))
    stats.average_win_r = float(wins.mean()) if wins.size else 0.0
    stats.average_loss_r = float(abs(losses.mean())) if losses.size else 0.0
    stats.largest_win_r = float(wins.max()) if wins.size else 0.0
    stats.largest_loss_r = float(losses.min()) if losses.size else 0.0

    gross_profit = float(wins.sum()) if wins.size else 0.0
    gross_loss = float(abs(losses.sum())) if losses.size else 0.0
    stats.profit_factor = (
        gross_profit / gross_loss
        if gross_loss > 0
        else (float("inf") if gross_profit > 0 else 0.0)
    )

    # Per-trade Sharpe, deliberately not annualised. Annualising requires a
    # trades-per-year figure, and this population spans several timeframes whose
    # trade frequencies differ by two orders of magnitude — one multiplier
    # applied across all of them would be arithmetic dressed as a statistic.
    if r.size > 1:
        deviation = float(r.std(ddof=1))
        if deviation > 0:
            stats.sharpe = stats.expectancy_r / deviation
            stats.expectancy_stderr = deviation / float(np.sqrt(r.size))
            stats.t_stat = (
                stats.expectancy_r / stats.expectancy_stderr
                if stats.expectancy_stderr > 0
                else 0.0
            )
        downside = r[r < 0]
        if downside.size > 1:
            downside_dev = float(downside.std(ddof=1))
            if downside_dev > 0:
                stats.sortino = stats.expectancy_r / downside_dev

    equity = np.cumsum(r)
    peak = np.maximum.accumulate(np.concatenate([[0.0], equity]))[1:]
    drawdown = peak - equity
    stats.max_drawdown_r = float(drawdown.max()) if drawdown.size else 0.0
    stats.calmar = (
        stats.net_r / stats.max_drawdown_r if stats.max_drawdown_r > 0 else 0.0
    )

    stats.average_bars_held = float(np.mean([t.bars_held for t in population]))

    mix: dict[str, int] = {}
    for trade in population:
        mix[trade.exit_reason] = mix.get(trade.exit_reason, 0) + 1
    stats.exit_mix = dict(sorted(mix.items(), key=lambda kv: -kv[1]))

    stats.underpowered = len(population) < min_trades_for_confidence
    return stats


def equity_curve(trades: Iterable[SimulatedTrade]) -> list[dict[str, float]]:
    """Cumulative R by trade, with the underwater series beside it."""
    population = sorted(trades, key=lambda t: t.exit_time)
    out: list[dict[str, float]] = []
    total = 0.0
    peak = 0.0
    for index, trade in enumerate(population, start=1):
        total += trade.realised_r
        peak = max(peak, total)
        out.append(
            {
                "trade": index,
                "time": trade.exit_time,
                "cumulativeR": round(total, 4),
                "drawdownR": round(peak - total, 4),
            }
        )
    return out


def breakdown(
    trades: Iterable[SimulatedTrade],
    key: Callable[[SimulatedTrade], str],
    *,
    min_trades_for_confidence: int = 200,
) -> dict[str, Stats]:
    """Split a population by any attribute and roll each slice up separately."""
    buckets: dict[str, list[SimulatedTrade]] = {}
    for trade in trades:
        buckets.setdefault(key(trade), []).append(trade)
    return {
        name: compute(bucket, min_trades_for_confidence=min_trades_for_confidence)
        for name, bucket in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    }


def required_hit_rate(reward_risk: float, cost_r: float) -> float:
    """
    The hit rate a setup needs merely to break even, once cost is charged.

    A win pays ``reward_risk − cost_r`` and a loss costs ``1 + cost_r``, so
    break-even sits where ``p(reward − cost) = (1 − p)(1 + cost)``. This is the
    arithmetic behind the §3 sanity benchmark, and it is the number that decides
    whether a horizon is viable before any analysis quality is considered.
    """
    win = reward_risk - cost_r
    loss = 1.0 + cost_r
    if win <= 0:
        return 1.0
    return float(loss / (win + loss))
