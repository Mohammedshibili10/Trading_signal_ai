"""
Factor groups — the evidence layer.

Nine groups, each producing a score in [-1, +1] and carrying a weight. Scores are
the evidence; weights are how much that evidence is trusted.

Two rules do most of the work here:

**Correlation is handled by grouping.** RSI, Stochastic, CCI and Williams %R are
all derived from recent price extremes. Averaging their four "votes" doesn't give
four independent opinions, it gives one opinion counted four times with false
confidence attached. They are normalised *inside* the INDICATORS group, so adding
a fifth oscillator changes the group's internal balance, not its influence on the
result.

**Unavailable groups are dropped, not zeroed.** Scoring a missing group as
neutral drags the blend toward zero and fakes a balanced read. Its weight is
redistributed across the groups that did contribute.

Spec: docs/signal-methodology.md §3.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from . import candlesticks
from .anatomy import CandleAnatomy, anatomy_score
from .indicators import last_valid

#: Base weights. Must sum to 1.0.
BASE_WEIGHTS: dict[str, float] = {
    "TREND": 0.20,
    "INDICATORS": 0.16,
    "PRICE_ACTION": 0.15,
    "MARKET_STRUCTURE": 0.13,
    "CANDLESTICK": 0.10,
    "VOLUME": 0.10,
    "VOLATILITY": 0.06,
    "NEWS": 0.06,
    "FUNDAMENTALS": 0.04,
    # Crypto only. Sized just above FUNDAMENTALS, which crypto does not have —
    # funding and positioning are the nearest thing that market offers to a
    # read on what holders are actually doing, and like fundamentals they set
    # context rather than time an entry. Dropped and redistributed for every
    # other asset class, so this weight never dilutes an equity blend.
    "DERIVATIVES": 0.08,
}


@dataclass
class Factor:
    group: str
    label: str
    score: float
    weight: float
    detail: str

    @property
    def stance(self) -> str:
        if self.score > 0.15:
            return "BULLISH"
        if self.score < -0.15:
            return "BEARISH"
        return "NEUTRAL"

    def to_dict(self) -> dict[str, Any]:
        return {
            "group": self.group,
            "label": self.label,
            "score": round(self.score, 4),
            "weight": round(self.weight, 4),
            "stance": self.stance,
            "detail": self.detail,
        }


def _clip(x: float) -> float:
    return float(np.clip(x, -1.0, 1.0))


def _fmt(value: float | None, decimals: int = 2) -> str:
    return f"{value:.{decimals}f}" if value is not None and np.isfinite(value) else "n/a"


# ─────────────────────────────────────────────────────────────────
#  TREND
# ─────────────────────────────────────────────────────────────────


def trend_factor(
    df: pd.DataFrame,
    ind: dict[str, pd.Series],
    trend: dict[str, Any],
    higher_tf_trend: str | None = None,
) -> Factor:
    price = float(df["close"].iloc[-1])
    parts: list[float] = []
    notes: list[str] = []

    ema20 = last_valid(ind.get("ema_20"))
    ema50 = last_valid(ind.get("ema_50"))
    ema200 = last_valid(ind.get("ema_200"))

    # Moving-average stack. Full alignment is the classic trend template.
    stack = "MIXED"
    if ema20 and ema50 and ema200:
        if price > ema20 > ema50 > ema200:
            parts.append(1.0)
            stack = "BULLISH"
            notes.append(f"Price above a rising 20/50/200 EMA stack ({_fmt(ema20)} / {_fmt(ema50)} / {_fmt(ema200)})")
        elif price < ema20 < ema50 < ema200:
            parts.append(-1.0)
            stack = "BEARISH"
            notes.append(f"Price below a falling 20/50/200 EMA stack ({_fmt(ema20)} / {_fmt(ema50)} / {_fmt(ema200)})")
        else:
            above = sum(1 for m in (ema20, ema50, ema200) if price > m)
            partial = (above - 1.5) / 1.5
            parts.append(partial * 0.5)
            notes.append(f"Price above {above} of 3 key EMAs — stack not aligned")
    elif ema20:
        parts.append(0.4 if price > ema20 else -0.4)
        notes.append(f"Price {'above' if price > ema20 else 'below'} the 20 EMA — limited history for longer averages")

    # Structural direction from the swing sequence, scaled by ADX. A structural
    # uptrend with ADX 15 is drifting, and sizing into it like a trend is how
    # accounts bleed in chop.
    adx_v = last_valid(ind.get("adx")) or 0.0
    direction = trend.get("direction", "SIDEWAYS")
    strength_scale = float(np.clip(adx_v / 35.0, 0.25, 1.0))
    if direction == "UPTREND":
        parts.append(1.0 * strength_scale)
    elif direction == "DOWNTREND":
        parts.append(-1.0 * strength_scale)
    else:
        parts.append(0.0)
    notes.append(trend.get("label", ""))

    # Directional index.
    plus_di, minus_di = last_valid(ind.get("plus_di")), last_valid(ind.get("minus_di"))
    if plus_di is not None and minus_di is not None and (plus_di + minus_di) > 0:
        di_score = (plus_di - minus_di) / (plus_di + minus_di)
        parts.append(di_score * strength_scale)
        if abs(di_score) > 0.25:
            notes.append(f"+DI {_fmt(plus_di, 0)} vs −DI {_fmt(minus_di, 0)}")

    # SuperTrend is a clean binary trend state.
    st_dir = last_valid(ind.get("supertrend_dir"))
    st_line = last_valid(ind.get("supertrend"))
    if st_dir is not None:
        parts.append(float(np.sign(st_dir)) * 0.8)
        notes.append(f"SuperTrend {'bullish' if st_dir > 0 else 'bearish'}, line at {_fmt(st_line)}")

    # Ichimoku cloud — compared against the *already visible* cloud, never the
    # forward-plotted values.
    sen_a, sen_b = ind.get("ichimoku_senkou_a"), ind.get("ichimoku_senkou_b")
    if sen_a is not None and sen_b is not None:
        a, b = last_valid(sen_a), last_valid(sen_b)
        if a is not None and b is not None:
            top, bottom = max(a, b), min(a, b)
            if price > top:
                parts.append(0.7)
                notes.append(f"Price above the Ichimoku cloud ({_fmt(bottom)}–{_fmt(top)})")
            elif price < bottom:
                parts.append(-0.7)
                notes.append(f"Price below the Ichimoku cloud ({_fmt(bottom)}–{_fmt(top)})")
            else:
                parts.append(0.0)
                notes.append("Price inside the Ichimoku cloud — no directional edge")

    score = _clip(float(np.mean(parts))) if parts else 0.0

    # Higher-timeframe conflict is called out explicitly rather than averaged
    # away — trading against the bias timeframe is a real cost.
    if higher_tf_trend and higher_tf_trend != "SIDEWAYS":
        htf_dir = 1.0 if higher_tf_trend == "UPTREND" else -1.0
        if np.sign(score) != 0 and np.sign(score) != htf_dir:
            notes.append(f"Conflicts with the higher-timeframe {higher_tf_trend.lower()}")

    return Factor(
        group="TREND",
        label="Trend",
        score=score,
        weight=BASE_WEIGHTS["TREND"],
        detail="; ".join(n for n in notes if n)[:400] or "No clear trend structure.",
    )


# ─────────────────────────────────────────────────────────────────
#  INDICATORS  (oscillators, normalised as one group)
# ─────────────────────────────────────────────────────────────────


def indicator_factor(df: pd.DataFrame, ind: dict[str, pd.Series]) -> Factor:
    parts: list[float] = []
    notes: list[str] = []

    rsi_v = last_valid(ind.get("rsi"))
    if rsi_v is not None:
        # Centre on 50 and scale so 30/70 map to roughly ∓0.7.
        parts.append(_clip((rsi_v - 50.0) / 28.0))
        if rsi_v >= 70:
            notes.append(f"RSI {rsi_v:.0f} — overbought, extended")
        elif rsi_v <= 30:
            notes.append(f"RSI {rsi_v:.0f} — oversold")
        else:
            notes.append(f"RSI {rsi_v:.0f}")

    macd_v, macd_sig, macd_hist = (
        last_valid(ind.get("macd")),
        last_valid(ind.get("macd_signal")),
        last_valid(ind.get("macd_hist")),
    )
    if macd_v is not None and macd_sig is not None:
        price = float(df["close"].iloc[-1])
        # Normalise by price so the score is comparable across instruments —
        # a raw MACD of 12 means nothing without knowing the price scale.
        spread = (macd_v - macd_sig) / max(price * 0.01, 1e-9)
        parts.append(_clip(spread))
        above = macd_v > macd_sig
        notes.append(f"MACD {'above' if above else 'below'} signal" + (f", histogram {macd_hist:+.3f}" if macd_hist is not None else ""))

        # A histogram turning while still on the other side of zero is the
        # earliest momentum tell.
        hist_series = ind.get("macd_hist")
        if hist_series is not None and len(hist_series.dropna()) >= 3:
            h = hist_series.dropna().iloc[-3:]
            if h.iloc[-1] > h.iloc[-2] > h.iloc[-3]:
                parts.append(0.3)
                notes.append("MACD histogram rising three bars")
            elif h.iloc[-1] < h.iloc[-2] < h.iloc[-3]:
                parts.append(-0.3)
                notes.append("MACD histogram falling three bars")

    stoch_k, stoch_d = last_valid(ind.get("stoch_k")), last_valid(ind.get("stoch_d"))
    if stoch_k is not None:
        parts.append(_clip((stoch_k - 50.0) / 32.0))
        if stoch_d is not None and stoch_k > stoch_d and stoch_k < 30:
            notes.append(f"Stochastic {stoch_k:.0f} turning up from oversold")
        elif stoch_d is not None and stoch_k < stoch_d and stoch_k > 70:
            notes.append(f"Stochastic {stoch_k:.0f} rolling over from overbought")

    cci_v = last_valid(ind.get("cci"))
    if cci_v is not None:
        parts.append(_clip(cci_v / 150.0))

    willr = last_valid(ind.get("williams_r"))
    if willr is not None:
        parts.append(_clip((willr + 50.0) / 32.0))

    bb_pct = last_valid(ind.get("bb_percent_b"))
    if bb_pct is not None:
        parts.append(_clip((bb_pct - 0.5) * 1.6))
        if bb_pct > 1.0:
            notes.append("Trading above the upper Bollinger band")
        elif bb_pct < 0.0:
            notes.append("Trading below the lower Bollinger band")

    # Divergence — informative at extremes, unreliable in strong trends.
    div = detect_divergence(df, ind)
    if div:
        adx_v = last_valid(ind.get("adx")) or 0.0
        # Momentum divergence can persist for months in a strong trend.
        damp = 0.4 if adx_v > 30 else 1.0
        parts.append((0.5 if div == "BULLISH" else -0.5) * damp)
        notes.append(
            f"{div.capitalize()} RSI divergence"
            + (" (damped — trend is strong, divergence often persists)" if damp < 1 else "")
        )

    score = _clip(float(np.mean(parts))) if parts else 0.0

    return Factor(
        group="INDICATORS",
        label="Momentum & oscillators",
        score=score,
        weight=BASE_WEIGHTS["INDICATORS"],
        detail="; ".join(notes)[:400] or "Oscillators are mid-range.",
    )


def detect_divergence(df: pd.DataFrame, ind: dict[str, pd.Series], lookback: int = 40) -> str | None:
    """
    RSI divergence against price, measured between confirmed swing extremes.

    Uses a coarse two-window comparison rather than exact fractals: divergence
    is a slow phenomenon and precise swing matching produces more false
    positives than it removes.
    """
    rsi_series = ind.get("rsi")
    if rsi_series is None or len(df) < lookback:
        return None

    rsi_clean = rsi_series.dropna()
    if len(rsi_clean) < lookback:
        return None

    window = min(lookback, len(rsi_clean))
    price = df["close"].iloc[-window:]
    rsi_w = rsi_clean.iloc[-window:]
    half = window // 2

    p_first, p_second = price.iloc[:half], price.iloc[half:]
    r_first, r_second = rsi_w.iloc[:half], rsi_w.iloc[half:]

    # Bearish: price makes a higher high, RSI a lower high.
    if p_second.max() > p_first.max() * 1.005 and r_second.max() < r_first.max() - 3:
        return "BEARISH"
    # Bullish: price makes a lower low, RSI a higher low.
    if p_second.min() < p_first.min() * 0.995 and r_second.min() > r_first.min() + 3:
        return "BULLISH"
    return None


# ─────────────────────────────────────────────────────────────────
#  VOLUME
# ─────────────────────────────────────────────────────────────────


def volume_factor(df: pd.DataFrame, ind: dict[str, pd.Series], anatomy: CandleAnatomy) -> Factor | None:
    """
    None when the instrument has no meaningful volume.

    Spot forex reports tick counts, not traded size. A tick-count proxy looks
    like volume and misleads, so the group is dropped and its weight
    redistributed rather than filled with a plausible number.
    """
    if df["volume"].fillna(0).sum() <= 0:
        return None

    parts: list[float] = []
    notes: list[str] = []

    direction = 1.0 if anatomy.direction == "UP" else -1.0 if anatomy.direction == "DOWN" else 0.0

    # Volume confirms whatever the bar did — it has no direction of its own.
    vr = anatomy.volume_ratio
    if vr >= 2.0:
        parts.append(direction * 0.9)
        notes.append(f"Volume {vr:.1f}× the 20-bar average confirms the move")
    elif vr >= 1.3:
        parts.append(direction * 0.5)
        notes.append(f"Volume {vr:.1f}× average — above normal participation")
    elif vr <= 0.6:
        parts.append(direction * -0.3)
        notes.append(f"Volume only {vr:.1f}× average — the move lacks participation")
    else:
        parts.append(0.0)
        notes.append(f"Volume {vr:.1f}× average — unremarkable")

    # OBV slope over the recent window.
    obv = ind.get("obv")
    if obv is not None and len(obv.dropna()) >= 20:
        o = obv.dropna().iloc[-20:]
        slope = np.polyfit(np.arange(len(o)), o.to_numpy(dtype=float), 1)[0]
        scale = max(abs(float(o.mean())), 1e-9)
        parts.append(_clip(slope / scale * 30.0))
        notes.append(f"OBV {'rising' if slope > 0 else 'falling'} over 20 bars")

    mfi = last_valid(ind.get("mfi"))
    if mfi is not None:
        parts.append(_clip((mfi - 50.0) / 30.0))
        if mfi >= 80:
            notes.append(f"MFI {mfi:.0f} — money flow overbought")
        elif mfi <= 20:
            notes.append(f"MFI {mfi:.0f} — money flow oversold")

    cmf = last_valid(ind.get("cmf"))
    if cmf is not None:
        parts.append(_clip(cmf * 4.0))

    # Effort vs result. The tape disagreeing with the print is a real warning.
    if anatomy.effort_vs_result == "DIVERGENT":
        parts.append(-direction * 0.4)
        notes.append("Effort and result diverge — high volume without matching range suggests absorption")

    score = _clip(float(np.mean(parts))) if parts else 0.0

    return Factor(
        group="VOLUME",
        label="Volume",
        score=score,
        weight=BASE_WEIGHTS["VOLUME"],
        detail="; ".join(notes)[:400],
    )


# ─────────────────────────────────────────────────────────────────
#  VOLATILITY
# ─────────────────────────────────────────────────────────────────


def volatility_regime(ind: dict[str, pd.Series]) -> dict[str, Any]:
    """ATR percentile against its own history — regime, not absolute level."""
    atr_pct_series = ind.get("atr_percent")
    atr_v = last_valid(ind.get("atr")) or 0.0
    atr_pct = last_valid(atr_pct_series) or 0.0

    percentile = 50.0
    if atr_pct_series is not None:
        clean = atr_pct_series.dropna()
        if len(clean) >= 30:
            percentile = float((clean < clean.iloc[-1]).mean() * 100.0)

    if percentile >= 90:
        regime = "EXTREME"
    elif percentile >= 70:
        regime = "HIGH"
    elif percentile <= 25:
        regime = "LOW"
    else:
        regime = "NORMAL"

    return {"atr": atr_v, "atrPercent": atr_pct, "regime": regime, "percentile": percentile}


def volatility_factor(ind: dict[str, pd.Series], regime: dict[str, Any], trend_score: float) -> Factor:
    """
    Volatility has no direction — it qualifies whatever direction exists.

    A squeeze in an uptrend is bullish (compression before expansion, resolving
    with the trend); the same squeeze in a downtrend is bearish. Extreme
    volatility damps everything.
    """
    parts: list[float] = []
    notes: list[str] = []

    squeeze = last_valid(ind.get("squeeze"))
    bandwidth = last_valid(ind.get("bb_bandwidth"))

    if squeeze is not None and squeeze > 0:
        parts.append(np.sign(trend_score) * 0.5 if trend_score != 0 else 0.0)
        notes.append("Bollinger bands inside Keltner channels — volatility compressed, expansion likely")
    elif bandwidth is not None:
        bw_series = ind.get("bb_bandwidth")
        if bw_series is not None and len(bw_series.dropna()) >= 30:
            clean = bw_series.dropna()
            bw_pct = float((clean < clean.iloc[-1]).mean() * 100.0)
            if bw_pct > 85:
                parts.append(-abs(trend_score) * 0.3)
                notes.append("Bands unusually wide — moves this stretched tend to mean-revert")
            elif bw_pct < 15:
                parts.append(np.sign(trend_score) * 0.3 if trend_score != 0 else 0.0)
                notes.append("Bands unusually narrow — a range expansion is due")

    r = regime["regime"]
    if r == "EXTREME":
        notes.append(f"ATR at the {regime['percentile']:.0f}th percentile — extreme volatility, everything is less predictable")
    elif r == "HIGH":
        notes.append(f"Elevated volatility ({regime['atrPercent']:.2f}% ATR)")
    elif r == "LOW":
        notes.append(f"Quiet market ({regime['atrPercent']:.2f}% ATR)")

    score = _clip(float(np.mean(parts))) if parts else 0.0

    return Factor(
        group="VOLATILITY",
        label="Volatility",
        score=score,
        weight=BASE_WEIGHTS["VOLATILITY"],
        detail="; ".join(notes)[:400] or f"{r.capitalize()} volatility regime.",
    )


# ─────────────────────────────────────────────────────────────────
#  CANDLESTICK
# ─────────────────────────────────────────────────────────────────


def candlestick_factor(
    anatomy: CandleAnatomy, patterns: list[candlesticks.DetectedPattern]
) -> Factor:
    """
    Anatomy carries more weight than the pattern name.

    Most single-candle patterns test at 52–56% — a coin flip. The measurable
    shape of the bar (where it closed in its range, whether volume backed it) is
    available on every bar and is the more honest signal.
    """
    shape = anatomy_score(anatomy)
    named = candlesticks.pattern_score(patterns)

    score = _clip(shape * 0.55 + named * 0.45)

    notes: list[str] = [anatomy.classification]
    if patterns:
        top = patterns[0]
        notes.append(
            f"{top.name} detected ({top.reliability:.0f}/100 in context, "
            f"{top.base_reliability:.0f} base)"
        )
        if top.base_reliability <= 56:
            notes.append("this pattern tests close to random on its own, so it carries little weight")
    else:
        notes.append("no named pattern on the latest bar")

    if abs(anatomy.close_location) > 0.5:
        notes.append(
            f"closed {'near the high' if anatomy.close_location > 0 else 'near the low'} of its range"
        )

    return Factor(
        group="CANDLESTICK",
        label="Candlestick",
        score=score,
        weight=BASE_WEIGHTS["CANDLESTICK"],
        detail="; ".join(notes)[:400],
    )


# ─────────────────────────────────────────────────────────────────
#  Pass-through groups
# ─────────────────────────────────────────────────────────────────


def price_action_factor(
    pa: dict[str, Any], harmonic: float = 0.0, harmonic_note: str = ""
) -> Factor:
    """
    Price action, with harmonic completion folded in.

    Harmonics are a sub-component here rather than a tenth weighted group. A
    completed Gartley is a statement about *where price sits relative to prior
    swings* — which is what price action already measures — and adding a group
    would rebalance every other weight in the engine to accommodate a method
    whose published edge is thinner than the ones already in the blend. A
    quarter of the group lets it tilt the read without carrying it.
    """
    base = _clip(pa.get("score", 0.0))
    score = _clip(base * 0.75 + harmonic * 0.25) if harmonic else base

    notes = list(pa.get("notes", []))
    if harmonic_note:
        notes.append(harmonic_note)

    return Factor(
        group="PRICE_ACTION",
        label="Price action",
        score=score,
        weight=BASE_WEIGHTS["PRICE_ACTION"],
        detail="; ".join(notes)[:400] or "No active breakout, retest or pullback.",
    )


def structure_factor(
    smc: dict[str, Any], elliott: float = 0.0, elliott_note: str = ""
) -> Factor:
    """
    Market structure, with the Elliott reading folded in.

    Elliott gets the smallest share of any sub-component in the engine — 15% of
    this group — because it is the most interpretive method here. Two analysts
    label the same swings differently, so it earns a voice, not a vote.
    """
    base = _clip(smc.get("score", 0.0))
    score = _clip(base * 0.85 + elliott * 0.15) if elliott else base

    notes = list(smc.get("notes", []))
    if elliott_note:
        notes.append(elliott_note)

    return Factor(
        group="MARKET_STRUCTURE",
        label="Market structure",
        score=score,
        weight=BASE_WEIGHTS["MARKET_STRUCTURE"],
        detail="; ".join(notes)[:400] or "No significant structural events.",
    )


def news_factor(sentiment: dict[str, Any] | None) -> Factor | None:
    """
    News sentiment, age-decayed.

    Capped deliberately. Sentiment is good at *confirming* price action and poor
    at leading it — by publication, most news is priced. It must never override
    structure, so its weight stays at 6% and its score is bounded.
    """
    if not sentiment or sentiment.get("count", 0) == 0:
        return None

    raw = float(sentiment.get("score", 0.0)) / 100.0
    count = int(sentiment.get("count", 0))
    # Confidence in the aggregate grows with volume of coverage, up to a point.
    coverage = min(1.0, count / 6.0)
    score = _clip(raw * coverage * 0.8)

    detail = sentiment.get("summary") or (
        f"{count} recent item{'s' if count != 1 else ''}, net sentiment {raw * 100:+.0f}"
    )

    return Factor(
        group="NEWS",
        label="News sentiment",
        score=score,
        weight=BASE_WEIGHTS["NEWS"],
        detail=detail[:400],
    )


def fundamentals_factor(fundamentals: dict[str, Any] | None) -> Factor | None:
    """Equity only — meaningless for a currency pair or a token."""
    if not fundamentals:
        return None

    scores = fundamentals.get("scores") or {}
    investment = scores.get("investment")
    if investment is None:
        return None

    # 50 is neutral; map 0…100 onto −1…+1.
    score = _clip((float(investment) - 50.0) / 40.0)

    quality = scores.get("quality")
    valuation = scores.get("valuation")
    detail = (
        f"Investment score {investment:.0f}/100"
        + (f", quality {quality:.0f}" if quality is not None else "")
        + (f", valuation {valuation:.0f}" if valuation is not None else "")
        + ". Fundamentals move slowly and matter far more to a positional view than an intraday one."
    )

    return Factor(
        group="FUNDAMENTALS",
        label="Fundamentals",
        score=score,
        weight=BASE_WEIGHTS["FUNDAMENTALS"],
        detail=detail[:400],
    )


# ─────────────────────────────────────────────────────────────────
#  Assembly
# ─────────────────────────────────────────────────────────────────


def redistribute(factors: list[Factor]) -> list[Factor]:
    """
    Renormalise weights over the groups that actually contributed.

    Missing groups are dropped upstream; this makes the survivors' weights sum
    back to 1.0 so the blend isn't quietly diluted toward zero.
    """
    total = sum(f.weight for f in factors)
    if total <= 0:
        return factors
    for f in factors:
        f.weight = f.weight / total
    return factors


def build(
    df: pd.DataFrame,
    ind: dict[str, pd.Series],
    *,
    anatomy: CandleAnatomy,
    trend: dict[str, Any],
    candle_patterns: list[candlesticks.DetectedPattern],
    price_action: dict[str, Any],
    smc: dict[str, Any],
    regime: dict[str, Any],
    sentiment: dict[str, Any] | None = None,
    fundamentals: dict[str, Any] | None = None,
    higher_tf_trend: str | None = None,
    asset_class: str = "EQUITY",
    harmonic: float = 0.0,
    harmonic_note: str = "",
    elliott: float = 0.0,
    elliott_note: str = "",
    weights: dict[str, float] | None = None,
    order_flow: dict | None = None,
    order_book: dict | None = None,
    derivatives: dict | None = None,
    ict: dict | None = None,
) -> list[Factor]:
    """
    Assemble every applicable factor group, with weights renormalised.

    `weights` overrides BASE_WEIGHTS when the review loop has produced a
    validated set. Passed in rather than read from module state so a backtest
    can score history under the weights that were live at the time instead of
    whatever is live now — scoring the past with today's weights is how a
    learning loop convinces itself it was always right.
    """
    active = {**BASE_WEIGHTS, **(weights or {})}
    trend_f = trend_factor(df, ind, trend, higher_tf_trend)

    factors: list[Factor] = [
        trend_f,
        indicator_factor(df, ind),
        price_action_factor(price_action, harmonic, harmonic_note),
        structure_factor(smc, elliott, elliott_note),
        candlestick_factor(anatomy, candle_patterns),
        volatility_factor(ind, regime, trend_f.score),
    ]

    vol_f = volume_factor(df, ind, anatomy)
    if vol_f is not None:
        # Measured order flow supersedes the inferred read.
        #
        # The volume factor infers pressure from where the bar closed in its
        # range. Binance publishes which side actually crossed the spread, and
        # the two disagree precisely on the bars that matter — a green bar sold
        # into looks bullish by close location and bearish by delta. When the
        # measurement exists it takes most of the weight; the inference keeps a
        # minority share because close location still carries information the
        # taker split does not.
        if order_flow and order_flow.get("available"):
            measured = _clip(float(order_flow.get("score", 0.0)))
            vol_f = Factor(
                group=vol_f.group,
                label="Volume & order flow",
                score=_clip(measured * 0.7 + vol_f.score * 0.3),
                weight=vol_f.weight,
                detail=(order_flow.get("summary") or vol_f.detail)[:400],
            )
        factors.append(vol_f)

    # ICT refines market structure rather than standing beside it.
    #
    # A killzone, an OTE band and a breaker are statements about the same levels
    # SMC already found — they are not independent evidence, so they adjust that
    # group instead of forming one of their own. Given a group of its own they
    # would double-count the structural read they are derived from.
    if ict and ict.get("available") and ict.get("score"):
        for index, factor in enumerate(factors):
            if factor.group != "MARKET_STRUCTURE":
                continue
            ict_score = _clip(float(ict.get("score", 0.0)))
            factors[index] = Factor(
                group=factor.group,
                label=factor.label,
                score=_clip(factor.score * 0.75 + ict_score * 0.25),
                weight=factor.weight,
                detail=f"{factor.detail}; {ict.get('summary', '')}"[:400],
            )
            break

    # Live depth adjusts market structure — resting size is the measured form of
    # the liquidity that structure otherwise infers from where price once turned.
    if order_book and order_book.get("available"):
        for index, factor in enumerate(factors):
            if factor.group != "MARKET_STRUCTURE":
                continue
            book_score = _clip(float(order_book.get("score", 0.0)))
            factors[index] = Factor(
                group=factor.group,
                label=factor.label,
                score=_clip(factor.score * 0.8 + book_score * 0.2),
                weight=factor.weight,
                detail=f"{factor.detail}; {order_book.get('summary', '')}"[:400],
            )
            break

    news_f = news_factor(sentiment)
    if news_f is not None:
        factors.append(news_f)

    # Perpetual funding and positioning. Crypto-only in practice — no other
    # class supplies it — and dropped entirely when the venue returned nothing,
    # so a pair without a listed perpetual is not scored as neutral.
    if derivatives and derivatives.get("available"):
        factors.append(
            Factor(
                group="DERIVATIVES",
                label="Funding & positioning",
                score=_clip(float(derivatives.get("score", 0.0))),
                weight=BASE_WEIGHTS["DERIVATIVES"],
                detail=(derivatives.get("summary") or "")[:400],
            )
        )

    # Fundamentals only make sense for equities and investment products.
    if asset_class in {"EQUITY", "INVESTMENT"}:
        fund_f = fundamentals_factor(fundamentals)
        if fund_f is not None:
            factors.append(fund_f)

    # Mutual fund NAV series have no intrabar shape or volume — drop the groups
    # that would otherwise score noise.
    if asset_class == "INVESTMENT":
        factors = [f for f in factors if f.group not in {"CANDLESTICK", "MARKET_STRUCTURE"}]

    # Thin history makes structural reads unreliable.
    if len(df) < 50:
        factors = [f for f in factors if f.group not in {"MARKET_STRUCTURE", "PRICE_ACTION"}]

    # Learned weights are applied here, after assembly, rather than threaded
    # through every builder. Each builder's job is to produce a *score*; how much
    # that score is trusted is a separate decision and belongs in one place.
    if weights:
        for factor in factors:
            override = active.get(factor.group)
            if override is not None:
                factor.weight = float(override)

    return redistribute(factors)
