"""
Trade signal construction.

Turns a forecast into an actionable idea: entry, stop, three targets, risk-reward
and position sizing — or refuses to, which happens roughly 40% of the time on
typical daily data.

That refusal rate is a feature. A system that always has an opinion is not
analysing, it is generating. ``WAIT`` is a first-class output with a stated
reason.

Spec: docs/signal-methodology.md §5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from ..config import settings
from .forecast import Forecast
from .structure import Level


@dataclass
class TradeLevels:
    entry: float
    entry_zone: tuple[float, float]
    stop_loss: float
    targets: list[dict[str, Any]]
    risk_reward: float
    risk_percent: float
    method: str


def _round(value: float, price: float) -> float:
    """Round to a sensible tick for the instrument's price scale."""
    if price >= 1000:
        return round(value, 2)
    if price >= 10:
        return round(value, 2)
    if price >= 1:
        return round(value, 4)
    return round(value, 6)


def build_levels(
    df: pd.DataFrame,
    forecast: Forecast,
    levels: list[Level],
    *,
    atr_value: float,
    trend_strength: float,
    setup: str = "MOMENTUM",
) -> TradeLevels | None:
    """
    Entry, stop and targets for the forecast's direction.

    The stop is the widest of the structural and volatility candidates. Taking
    the tighter one looks better on paper (smaller risk, bigger R:R) and gets
    you stopped out by ordinary noise before the idea has a chance to work.
    """
    price = float(df["close"].iloc[-1])
    if atr_value <= 0 or price <= 0:
        return None

    long = forecast.bias == "BULLISH"
    if forecast.bias == "NEUTRAL":
        return None

    recent = df.iloc[-20:]

    # ── Entry ────────────────────────────────────────────────────
    entry = price
    if setup == "BREAKOUT":
        # Trigger just beyond the level, so we're not buying the wick.
        entry = price + (0.1 * atr_value if long else -0.1 * atr_value)
    entry_zone = (entry - 0.25 * atr_value, entry + 0.25 * atr_value)

    # ── Stop ─────────────────────────────────────────────────────
    if long:
        structural = float(recent["low"].min()) - 0.15 * atr_value
        volatility = entry - 1.8 * atr_value
        stop = min(structural, volatility)  # lower is wider for a long
    else:
        structural = float(recent["high"].max()) + 0.15 * atr_value
        volatility = entry + 1.8 * atr_value
        stop = max(structural, volatility)

    risk_per_unit = abs(entry - stop)
    if risk_per_unit <= 0:
        return None

    risk_percent = risk_per_unit / entry * 100.0
    if risk_percent > settings.max_stop_distance_percent:
        return None

    # ── Targets ──────────────────────────────────────────────────
    # R multiples, pulled in to the nearest opposing level when one sits closer.
    # A target beyond a wall of resistance is a target you don't reach.
    opposing = [lv for lv in levels if (lv.price > entry) == long]
    opposing.sort(key=lambda lv: abs(lv.price - entry))

    def target_at(multiple: float, index: int) -> float:
        raw = entry + risk_per_unit * multiple * (1 if long else -1)
        if index < len(opposing):
            lv = opposing[index]
            # Only pull in if the level is meaningfully strong.
            if lv.strength >= 55:
                if long and lv.price < raw:
                    return lv.price
                if not long and lv.price > raw:
                    return lv.price
        return raw

    # R multiples for the three targets.
    #
    # T1 sits above the engine's own reward:risk floor rather than at 1R. The
    # floor rejects any setup whose first target is below 1.5R, so a first
    # target defined *at* 1R made that check unsatisfiable by construction —
    # every signal was rejected for a reward:risk it was never able to reach.
    #
    # 1.6 rather than exactly 1.5 so that level-snapping has somewhere to go:
    # when a strong opposing level sits between 1.5R and 1.6R the target is
    # pulled in and the setup still clears, and when the level sits nearer than
    # 1.5R the floor correctly rejects it. A wall of resistance before the first
    # target is a reason not to take the trade, which is the check working.
    t1 = target_at(1.6, 0)
    t2 = target_at(2.8, 1)
    t3 = target_at(4.2, 2)

    # Keep them ordered and meaningfully apart after level snapping.
    #
    # A 0.01% separation was enough to satisfy "ordered" and produced targets
    # like 2143.07 / 2143.28 — three levels where two are the same price, which
    # is not a three-target plan. Each target must clear the previous one by a
    # real fraction of the risk, so partial exits at T1 and T2 are distinct
    # decisions rather than the same one twice.
    min_gap = risk_per_unit * 0.4

    if long:
        t2 = max(t2, t1 + min_gap)
        t3 = max(t3, t2 + min_gap)
    else:
        t2 = min(t2, t1 - min_gap)
        t3 = min(t3, t2 - min_gap)

    # ── Target probabilities ─────────────────────────────────────
    # Decay with distance, scaled by trend strength — a strong trend carries
    # further, a chop market rarely reaches T3.
    p_dir = max(forecast.prob_up, forecast.prob_down)
    trend_factor = float(np.clip(0.6 + trend_strength / 100.0, 0.6, 1.25))

    targets = []
    for level_no, (tp, base) in enumerate(
        [(t1, 0.82), (t2, 0.55), (t3, 0.31)], start=1
    ):
        rr = abs(tp - entry) / risk_per_unit
        prob = p_dir * base * (1.0 if level_no == 1 else trend_factor)
        targets.append(
            {
                "level": level_no,
                "price": _round(tp, price),
                "rr": round(rr, 2),
                "probability": round(float(np.clip(prob, 0.03, 0.92)), 3),
            }
        )

    rr_at_t1 = abs(t1 - entry) / risk_per_unit

    return TradeLevels(
        entry=_round(entry, price),
        entry_zone=(_round(entry_zone[0], price), _round(entry_zone[1], price)),
        stop_loss=_round(stop, price),
        targets=targets,
        risk_reward=round(rr_at_t1, 2),
        risk_percent=round(risk_percent, 2),
        method="structural" if abs(stop - structural) < abs(stop - volatility) else "ATR-based",
    )


def risk_level(risk_percent: float, regime: str, confidence: float) -> str:
    """Composite risk grade, not just stop distance."""
    score = 0
    if risk_percent > 5:
        score += 2
    elif risk_percent > 3:
        score += 1

    if regime == "EXTREME":
        score += 2
    elif regime == "HIGH":
        score += 1

    if confidence < 55:
        score += 1

    return ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"][min(score, 3)]


def horizon_for(timeframe: str) -> str:
    return {
        "1m": "INTRADAY", "5m": "INTRADAY", "15m": "INTRADAY", "30m": "INTRADAY",
        "1h": "SWING", "4h": "SWING",
        "1D": "POSITIONAL",
        "1W": "LONG_TERM", "1M": "LONG_TERM",
    }.get(timeframe, "SWING")


def rejection_reason(
    df: pd.DataFrame,
    forecast: Forecast,
    trade: TradeLevels | None,
    regime: dict[str, Any],
    factors_conflict: bool,
) -> str | None:
    """
    Why no trade. Returns None when the setup passes every gate.

    Each of these exists because of a specific way signal systems lose money.
    """
    if len(df) < settings.min_bars:
        return f"Only {len(df)} bars of history — the engine needs at least {settings.min_bars} to score reliably."

    if forecast.bias == "NEUTRAL":
        return "Factor groups are balanced with no directional edge. Waiting is the position."

    if forecast.confidence < settings.min_signal_confidence:
        return (
            f"Confidence {forecast.confidence:.0f} is below the {settings.min_signal_confidence:.0f} floor — "
            "the evidence disagrees with itself too much to act on."
        )

    if trade is None:
        return (
            f"No workable stop within {settings.max_stop_distance_percent:.0f}% of entry. "
            "The structure is too far away to define risk."
        )

    if trade.risk_reward < settings.min_risk_reward:
        return (
            f"Reward-to-risk of {trade.risk_reward:.2f} at the first target is below the "
            f"{settings.min_risk_reward} minimum. At this ratio the win rate required to break even is unrealistic."
        )

    if regime["regime"] == "EXTREME" and forecast.confidence < 60:
        return (
            f"Volatility is at the {regime['percentile']:.0f}th percentile and confidence is only "
            f"{forecast.confidence:.0f}. Position sizing cannot compensate for this."
        )

    if factors_conflict:
        return (
            "Trend and market structure point in opposite directions. "
            "Trading a structural conflict is how good analysis loses money."
        )

    return None


def suggested_allocation(
    risk_percent: float, risk_per_trade: float, confidence: float
) -> float:
    """
    Position size as a share of capital.

    Derived from the stop distance, never chosen first. Scaled down when
    confidence is low — the size expresses the conviction, the stop expresses
    the risk.
    """
    if risk_percent <= 0:
        return 0.0
    base = (risk_per_trade / risk_percent) * 100.0
    conviction = float(np.clip(confidence / 70.0, 0.4, 1.0))
    # Never suggest more than a quarter of capital in one idea, whatever the
    # arithmetic says — concentration risk isn't captured by stop distance.
    return float(np.clip(base * conviction, 0.0, 25.0))


def build(
    df: pd.DataFrame,
    forecast: Forecast,
    levels: list[Level],
    *,
    symbol: str,
    name: str,
    asset_class: str,
    timeframe: str,
    atr_value: float,
    regime: dict[str, Any],
    trend: dict[str, Any],
    risk_per_trade: float = 1.0,
    setup: str = "MOMENTUM",
) -> dict[str, Any]:
    """
    Full signal object — including the WAIT case, which is a real answer.
    """
    trade = build_levels(
        df, forecast, levels,
        atr_value=atr_value,
        trend_strength=trend.get("strength", 0.0),
        setup=setup,
    )

    # A direct trend-vs-structure contradiction is disqualifying on its own.
    by_group = {f.group: f for f in forecast.factors}
    trend_f, struct_f = by_group.get("TREND"), by_group.get("MARKET_STRUCTURE")
    conflict = bool(
        trend_f and struct_f
        and abs(trend_f.score) > 0.4 and abs(struct_f.score) > 0.4
        and np.sign(trend_f.score) != np.sign(struct_f.score)
    )

    reason = rejection_reason(df, forecast, trade, regime, conflict)

    base: dict[str, Any] = {
        "symbol": symbol,
        "name": name,
        "assetClass": asset_class,
        "timeframe": timeframe,
        "confidence": round(forecast.confidence, 1),
        "horizon": horizon_for(timeframe),
        "reasons": forecast.reasons,
        "factors": [f.to_dict() for f in forecast.factors],
        "forecast": None,  # populated by the pipeline
        "status": "ACTIVE",
    }

    if reason is not None or trade is None:
        return {
            **base,
            "action": "WAIT",
            "entry": None,
            "entryZone": None,
            "stopLoss": None,
            "targets": [],
            "riskLevel": "LOW",
            "riskRewardRatio": 0.0,
            "riskPercent": 0.0,
            "suggestedAllocationPercent": 0.0,
            "explanation": reason or "No qualifying setup.",
            "rejectionReason": reason,
        }

    action = "BUY" if forecast.bias == "BULLISH" else "SELL"
    grade = risk_level(trade.risk_percent, regime["regime"], forecast.confidence)

    explanation = (
        f"{action} {symbol} on the {timeframe} timeframe at {trade.entry}, "
        f"stop {trade.stop_loss} ({trade.risk_percent:.2f}% away, {trade.method}). "
        f"First target {trade.targets[0]['price']} gives {trade.risk_reward:.2f}:1. "
        f"Confidence {forecast.confidence:.0f}/100 with {len(forecast.factors)} factor groups contributing. "
        f"{forecast.invalidation['note']}"
    )

    return {
        **base,
        "action": action,
        "entry": trade.entry,
        "entryZone": {"low": trade.entry_zone[0], "high": trade.entry_zone[1]},
        "stopLoss": trade.stop_loss,
        "targets": trade.targets,
        "riskLevel": grade,
        "riskRewardRatio": trade.risk_reward,
        "riskPercent": trade.risk_percent,
        "suggestedAllocationPercent": round(
            suggested_allocation(trade.risk_percent, risk_per_trade, forecast.confidence), 2
        ),
        "explanation": explanation,
        "rejectionReason": None,
    }
