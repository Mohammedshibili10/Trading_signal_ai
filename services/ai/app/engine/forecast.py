"""
The forecast engine.

Blends the nine factor groups into a directional probability for the *next*
candle, with a confidence that reflects how much the read should be trusted.

The distinction between the two numbers matters and is easy to lose:

* **Probability** answers "which way?" — 0.62 means that in setups scoring like
  this one, the next bar closed higher about 62% of the time.
* **Confidence** answers "how much do we trust that?" — it falls when factors
  disagree, when data is thin, and when volatility is extreme.

A 55% probability at 80 confidence and a 75% probability at 40 confidence are
very different objects, and collapsing them into one number is how prediction
systems end up sounding certain about nothing.

Spec: docs/signal-methodology.md §4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from ..config import settings
from .anatomy import CandleAnatomy, describe
from .factors import Factor

#: Flat band by volatility regime. A 0.3% move is flat for BTC and decisive for
#: a gilt fund, so the "no meaningful change" window has to scale.
FLAT_BAND: dict[str, float] = {
    "EXTREME": 0.06,
    "HIGH": 0.10,
    "NORMAL": 0.15,
    "LOW": 0.22,
}

#: Confidence multiplier applied per regime.
REGIME_PENALTY: dict[str, float] = {
    "EXTREME": 0.70,
    "HIGH": 0.85,
    "NORMAL": 1.00,
    "LOW": 0.95,
}


@dataclass
class Forecast:
    prob_up: float
    prob_down: float
    prob_flat: float
    expected_move_percent: float
    expected_range: tuple[float, float]
    bias: str
    confidence: float
    raw_score: float
    agreement: float
    factors: list[Factor]
    reasons: list[str]
    invalidation: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "probUp": round(self.prob_up, 4),
            "probDown": round(self.prob_down, 4),
            "probFlat": round(self.prob_flat, 4),
            "expectedMovePercent": round(self.expected_move_percent, 3),
            "expectedRange": {
                "low": round(self.expected_range[0], 6),
                "high": round(self.expected_range[1], 6),
            },
            "bias": self.bias,
            "confidence": round(self.confidence, 1),
            "rawScore": round(self.raw_score, 4),
            "agreement": round(self.agreement, 3),
            "factors": [f.to_dict() for f in self.factors],
            "reasons": self.reasons,
            "invalidation": self.invalidation,
        }


def blend(factors: list[Factor]) -> float:
    """Weighted mean of factor scores. Weights already sum to 1 after redistribution."""
    if not factors:
        return 0.0
    total_weight = sum(f.weight for f in factors)
    if total_weight <= 0:
        return 0.0
    return float(np.clip(sum(f.score * f.weight for f in factors) / total_weight, -1.0, 1.0))


def agreement_of(factors: list[Factor]) -> float:
    """
    How much the evidence agrees with itself.

    Consensus is more trustworthy than one loud factor drowning out five quiet
    dissenters, and a plain weighted mean can't tell those apart.

    Measured as *directional* consensus: the share of factor weight pointing the
    same way as the blend, less the share pointing against it. Groups with no
    real opinion are excluded from both sides rather than counted as dissent —
    a factor that correctly has nothing to say is not disagreeing.

    This deliberately does not penalise factors for differing in *magnitude*.
    An earlier version measured the standard deviation of the raw scores, which
    conflated the two: a set of six bullish factors at +0.12 to +0.77 is a
    near-unanimous read, but scored 0.62 for the spread in conviction alone.
    Because agreement multiplies into confidence, that made the confidence floor
    effectively unreachable — across a 61-series sample, agreement never once
    exceeded 0.79 and the engine issued no signal at all.
    """
    if len(factors) < 2:
        return 0.6

    weights = np.array([max(f.weight, 0.0) for f in factors], dtype=float)
    scores = np.array([f.score for f in factors], dtype=float)
    total_weight = float(weights.sum())
    if total_weight <= 0:
        return 0.6

    blended = float((scores * weights).sum() / total_weight)
    if abs(blended) < 1e-9:
        # Perfectly balanced evidence is not agreement, it is a coin flip.
        return 0.35

    direction = 1.0 if blended > 0 else -1.0
    signed = scores * direction

    # A group needs a real opinion to vote either way.
    agreeing = float(weights[signed > 0.08].sum()) / total_weight
    opposing = float(weights[signed < -0.08].sum()) / total_weight

    consensus = agreeing - opposing

    # Dispersion still matters, but as a light secondary term: one factor
    # carrying the entire read is weaker evidence than several converging on it.
    concentration = float(np.max(np.abs(scores * weights)) / max(abs(blended) * total_weight, 1e-9))
    breadth_penalty = 0.10 if concentration > 0.75 else 0.0

    return float(np.clip(consensus - breadth_penalty, 0.35, 1.0))


def data_quality(df: pd.DataFrame, factors: list[Factor]) -> float:
    """0…1 — how much of the picture we actually have."""
    bars = len(df)
    bar_score = float(np.clip(bars / 250.0, 0.4, 1.0))
    # Six or more contributing groups is a full read.
    group_score = float(np.clip(len(factors) / 7.0, 0.5, 1.0))

    # Gaps in the series (halted sessions, missing bars) reduce reliability.
    gap_penalty = 1.0
    if isinstance(df.index, pd.DatetimeIndex) and bars > 10:
        # `.asi8` rather than `.view("int64")` — Index.view was removed in
        # pandas 3.0, and asi8 is the supported way to get the underlying
        # nanosecond integers on both 2.x and 3.x.
        deltas = np.diff(df.index.asi8)
        if deltas.size:
            median = float(np.median(deltas))
            if median > 0:
                irregular = float(np.mean(deltas > median * 3))
                gap_penalty = float(np.clip(1.0 - irregular, 0.7, 1.0))

    return float(bar_score * group_score * gap_penalty)


def rank_reasons(factors: list[Factor], limit: int = 6) -> list[str]:
    """
    Ranked by |score × weight| — literally the arithmetic that drove the number.

    Contradicting factors are included by the same rule. A signal that lists only
    supporting evidence is a sales pitch, not an analysis.
    """
    ranked = sorted(factors, key=lambda f: abs(f.score * f.weight), reverse=True)
    out: list[str] = []
    for f in ranked[:limit]:
        if abs(f.score) < 0.05:
            continue
        arrow = "▲" if f.score > 0 else "▼"
        out.append(f"{arrow} {f.label}: {f.detail}")
    return out


def generate(
    df: pd.DataFrame,
    factors: list[Factor],
    *,
    anatomy: CandleAnatomy,
    regime: dict[str, Any],
    atr_value: float,
    higher_tf_trend: str | None = None,
    calibrator: Any | None = None,
) -> Forecast:
    """
    Produce the next-candle forecast.

    ``calibrator`` is an optional fitted mapping from
    :mod:`~app.engine.calibration` that pulls raw probabilities toward measured
    frequencies for this symbol and timeframe.
    """
    price = float(df["close"].iloc[-1])
    raw = blend(factors)

    # ── Adjustments, in order ────────────────────────────────────
    # 1. Higher-timeframe conflict.
    if higher_tf_trend and higher_tf_trend != "SIDEWAYS":
        htf = 1.0 if higher_tf_trend == "UPTREND" else -1.0
        if raw != 0 and np.sign(raw) != htf:
            raw *= 0.65

    # 2. Extreme volatility damps everything.
    if regime["regime"] == "EXTREME":
        raw *= 0.8

    raw = float(np.clip(raw, -1.0, 1.0))

    # ── Score → probability ──────────────────────────────────────
    p_up_raw = 1.0 / (1.0 + np.exp(-settings.logistic_k * raw))
    p_flat = FLAT_BAND.get(regime["regime"], 0.15)

    prob_up = float(p_up_raw * (1.0 - p_flat))
    prob_down = float((1.0 - p_up_raw) * (1.0 - p_flat))

    if calibrator is not None:
        prob_up, prob_down, p_flat = calibrator.apply(prob_up, prob_down, p_flat)

    # ── Confidence ───────────────────────────────────────────────
    agreement = agreement_of(factors)
    quality = data_quality(df, factors)
    strength = float(np.clip(abs(raw) / 0.55, 0.0, 1.0))
    penalty = REGIME_PENALTY.get(regime["regime"], 1.0)

    confidence = 100.0 * strength * agreement * quality * penalty
    confidence = float(np.clip(confidence, 0.0, settings.max_confidence))

    # ── Expected move ────────────────────────────────────────────
    # Scaled from ATR: the typical bar moves about one ATR, and the directional
    # edge shifts the centre of that distribution rather than replacing it.
    atr_pct = (atr_value / price * 100.0) if price > 0 else 0.0
    expected_move = raw * atr_pct * 0.6
    sigma = atr_pct * 0.85
    expected_range = (
        price * (1.0 + (expected_move - sigma) / 100.0),
        price * (1.0 + (expected_move + sigma) / 100.0),
    )

    bias = "BULLISH" if prob_up > prob_down + 0.06 else "BEARISH" if prob_down > prob_up + 0.06 else "NEUTRAL"

    # ── Invalidation ─────────────────────────────────────────────
    # What would prove this read wrong. Every forecast ships with one.
    recent = df.iloc[-10:]
    if bias == "BULLISH":
        level = float(recent["low"].min())
        note = f"A close below {level:.2f} (the 10-bar low) invalidates the bullish read."
    elif bias == "BEARISH":
        level = float(recent["high"].max())
        note = f"A close above {level:.2f} (the 10-bar high) invalidates the bearish read."
    else:
        level = price
        note = "No directional bias to invalidate — the evidence is balanced."

    reasons = rank_reasons(factors)
    reasons.insert(0, f"Candle read: {describe(anatomy)}")

    return Forecast(
        prob_up=prob_up,
        prob_down=prob_down,
        prob_flat=float(1.0 - prob_up - prob_down),
        expected_move_percent=expected_move,
        expected_range=expected_range,
        bias=bias,
        confidence=confidence,
        raw_score=raw,
        agreement=agreement,
        factors=factors,
        reasons=reasons,
        invalidation={"price": round(level, 6), "note": note},
    )


def summarise(forecast: Forecast, anatomy: CandleAnatomy, symbol: str, timeframe: str) -> str:
    """
    Plain-language summary, generated from the factor scores.

    Never written independently of the arithmetic — the story cannot disagree
    with the model, which is the whole point.
    """
    direction = {
        "BULLISH": "leans higher",
        "BEARISH": "leans lower",
        "NEUTRAL": "has no clear direction",
    }[forecast.bias]

    prob = max(forecast.prob_up, forecast.prob_down) * 100.0
    lead = (
        f"The next {timeframe} candle on {symbol} {direction}"
        + (f" with about {prob:.0f}% probability" if forecast.bias != "NEUTRAL" else "")
        + f", at {forecast.confidence:.0f}/100 confidence."
    )

    supporting = [f for f in forecast.factors if np.sign(f.score) == np.sign(forecast.raw_score) and abs(f.score) > 0.2]
    opposing = [f for f in forecast.factors if np.sign(f.score) == -np.sign(forecast.raw_score) and abs(f.score) > 0.2]

    body = f" The current bar is a {anatomy.classification.lower()}."

    if supporting:
        names = ", ".join(f.label.lower() for f in supporting[:3])
        body += f" Supporting: {names}."
    if opposing:
        names = ", ".join(f.label.lower() for f in opposing[:2])
        body += f" Arguing against: {names}."
    if not opposing and forecast.bias != "NEUTRAL":
        body += " No factor group currently argues the other way."

    tail = f" {forecast.invalidation['note']}"

    return lead + body + tail
