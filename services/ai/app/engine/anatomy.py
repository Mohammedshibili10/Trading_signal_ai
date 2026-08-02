"""
Per-candle anatomy.

Measures a bar before anything tries to name it. This ordering is deliberate:
the measurable properties of a candle (where it closed in its range, how wide it
was relative to normal, whether volume backed it) carry more information than the
label we attach afterwards, and they exist for every bar — not just the ~5% that
happen to match a named pattern.

Spec: docs/signal-methodology.md §2.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

# Anything narrower than this fraction of the range is treated as "no body".
DOJI_BODY = 0.10
SMALL_BODY = 0.30
LARGE_BODY = 0.70
MARUBOZU_BODY = 0.85
LONG_WICK = 0.40


@dataclass
class CandleAnatomy:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    direction: str  # UP | DOWN | FLAT
    range: float
    body: float
    upper_wick: float
    lower_wick: float
    body_percent: float
    upper_wick_percent: float
    lower_wick_percent: float
    close_location: float
    range_vs_atr: float
    volume_ratio: float
    gap_percent: float
    is_inside: bool
    is_outside: bool
    is_climactic: bool
    classification: str
    effort_vs_result: str
    position_vs_ema20: float
    position_vs_vwap: float | None

    def to_dict(self) -> dict[str, Any]:
        """
        Serialise to the wire contract.

        Keys are camelCase to match `CandleAnatomy` in
        apps/web/src/types/index.ts. Written out explicitly rather than via
        `asdict()` — that returns the snake_case field names and silently
        produces a payload the frontend cannot read.
        """
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "direction": self.direction,
            "range": round(self.range, 6),
            "body": round(self.body, 6),
            "upperWick": round(self.upper_wick, 6),
            "lowerWick": round(self.lower_wick, 6),
            "bodyPercent": self.body_percent,
            "upperWickPercent": self.upper_wick_percent,
            "lowerWickPercent": self.lower_wick_percent,
            "closeLocation": self.close_location,
            "rangeVsAtr": self.range_vs_atr,
            "volumeRatio": self.volume_ratio,
            "gapPercent": self.gap_percent,
            "isInside": self.is_inside,
            "isOutside": self.is_outside,
            "isClimactic": self.is_climactic,
            "classification": self.classification,
            "effortVsResult": self.effort_vs_result,
            "positionVsEma20": self.position_vs_ema20,
            "positionVsVwap": self.position_vs_vwap,
        }


def _safe(value: float, default: float = 0.0) -> float:
    return float(value) if value is not None and np.isfinite(value) else default


def classify(
    *,
    direction: str,
    body_pct: float,
    upper_pct: float,
    lower_pct: float,
    range_vs_atr: float,
    is_inside: bool,
    is_outside: bool,
) -> str:
    """
    Compositional description, built from measurements rather than looked up.

    Reads as "<size> <body-type> <shape>" — e.g. "Wide-range bullish marubozu",
    "Narrow-range inside bar", "Long-legged doji".
    """
    if range_vs_atr >= 1.8:
        size = "Very wide-range"
    elif range_vs_atr >= 1.35:
        size = "Wide-range"
    elif range_vs_atr <= 0.45:
        size = "Very narrow-range"
    elif range_vs_atr <= 0.7:
        size = "Narrow-range"
    else:
        size = ""

    bias = "bullish" if direction == "UP" else "bearish" if direction == "DOWN" else "neutral"

    # Doji family — body is negligible, so shape is defined by the wicks.
    if body_pct <= DOJI_BODY:
        if upper_pct >= 0.4 and lower_pct >= 0.4:
            shape = "long-legged doji"
        elif lower_pct >= 0.6:
            shape = "dragonfly doji"
        elif upper_pct >= 0.6:
            shape = "gravestone doji"
        else:
            shape = "doji"
        return f"{size} {shape}".strip().capitalize()

    if body_pct >= MARUBOZU_BODY:
        shape = f"{bias} marubozu"
    elif body_pct >= LARGE_BODY:
        shape = f"strong {bias} bar"
    elif body_pct <= SMALL_BODY:
        if lower_pct >= LONG_WICK and upper_pct < 0.2:
            shape = "hammer-shaped bar"
        elif upper_pct >= LONG_WICK and lower_pct < 0.2:
            shape = "shooting-star-shaped bar"
        else:
            shape = "spinning top"
    else:
        if lower_pct >= LONG_WICK:
            shape = f"{bias} bar with long lower wick"
        elif upper_pct >= LONG_WICK:
            shape = f"{bias} bar with long upper wick"
        else:
            shape = f"{bias} bar"

    if is_inside:
        shape = f"inside {shape}"
    elif is_outside:
        shape = f"outside {shape}"

    return f"{size} {shape}".strip().capitalize()


def effort_vs_result(volume_ratio: float, range_vs_atr: float) -> str:
    """
    Wyckoff's effort-vs-result read.

    High volume with a small range means effort that produced no result — supply
    absorbing demand (or vice versa), which is a warning. A large range on thin
    volume means the move has no participation behind it. Either way the bar is
    saying something the price alone doesn't.
    """
    if volume_ratio > 1.5 and range_vs_atr < 0.8:
        return "DIVERGENT"
    if volume_ratio < 0.7 and range_vs_atr > 1.5:
        return "DIVERGENT"
    if abs(volume_ratio - range_vs_atr) < 0.6:
        return "CONFIRMING"
    return "NEUTRAL"


def analyse_candle(
    df: pd.DataFrame,
    index: int,
    *,
    atr_series: pd.Series | None = None,
    volume_sma: pd.Series | None = None,
    ema20: pd.Series | None = None,
    vwap_series: pd.Series | None = None,
) -> CandleAnatomy:
    """
    Measure the bar at ``index``.

    Only bars at or before ``index`` are read, so this is safe to call inside the
    walk-forward calibration loop.
    """
    row = df.iloc[index]
    o, h, l, c = (float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]))
    vol = _safe(row.get("volume", 0.0))

    rng = max(h - l, 0.0)
    body = abs(c - o)
    upper = h - max(o, c)
    lower = min(o, c) - l

    # A zero-range bar (locked at a circuit limit, or an untraded fund NAV) has
    # no shape. Report the degenerate case honestly rather than dividing by zero.
    if rng <= 0:
        body_pct = upper_pct = lower_pct = 0.0
        clv = 0.0
    else:
        body_pct = body / rng
        upper_pct = upper / rng
        lower_pct = lower / rng
        clv = (2.0 * c - h - l) / rng

    direction = "UP" if c > o else "DOWN" if c < o else "FLAT"

    atr_val = _safe(atr_series.iloc[index], 0.0) if atr_series is not None else 0.0
    range_vs_atr = rng / atr_val if atr_val > 0 else 1.0

    avg_vol = _safe(volume_sma.iloc[index], 0.0) if volume_sma is not None else 0.0
    vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0

    if index > 0:
        prev = df.iloc[index - 1]
        prev_close = float(prev["close"])
        prev_high, prev_low = float(prev["high"]), float(prev["low"])
        gap_pct = (o - prev_close) / prev_close * 100.0 if prev_close else 0.0
        is_inside = h <= prev_high and l >= prev_low
        is_outside = h > prev_high and l < prev_low
    else:
        gap_pct, is_inside, is_outside = 0.0, False, False

    ema20_val = _safe(ema20.iloc[index], 0.0) if ema20 is not None else 0.0
    pos_ema = (c - ema20_val) / ema20_val * 100.0 if ema20_val > 0 else 0.0

    pos_vwap: float | None = None
    if vwap_series is not None:
        v = vwap_series.iloc[index]
        if v is not None and np.isfinite(v) and v > 0:
            pos_vwap = (c - float(v)) / float(v) * 100.0

    return CandleAnatomy(
        time=int(df.index[index].timestamp()) if isinstance(df.index, pd.DatetimeIndex) else int(index),
        open=o,
        high=h,
        low=l,
        close=c,
        volume=vol,
        direction=direction,
        range=rng,
        body=body,
        upper_wick=upper,
        lower_wick=lower,
        body_percent=round(body_pct, 4),
        upper_wick_percent=round(upper_pct, 4),
        lower_wick_percent=round(lower_pct, 4),
        close_location=round(clv, 4),
        range_vs_atr=round(range_vs_atr, 3),
        volume_ratio=round(vol_ratio, 3),
        gap_percent=round(gap_pct, 3),
        is_inside=bool(is_inside),
        is_outside=bool(is_outside),
        is_climactic=bool(range_vs_atr > 1.8 and vol_ratio > 2.0 and max(upper_pct, lower_pct) > 0.4),
        classification=classify(
            direction=direction,
            body_pct=body_pct,
            upper_pct=upper_pct,
            lower_pct=lower_pct,
            range_vs_atr=range_vs_atr,
            is_inside=is_inside,
            is_outside=is_outside,
        ),
        effort_vs_result=effort_vs_result(vol_ratio, range_vs_atr),
        position_vs_ema20=round(pos_ema, 3),
        position_vs_vwap=round(pos_vwap, 3) if pos_vwap is not None else None,
    )


def anatomy_score(a: CandleAnatomy) -> float:
    """
    Directional evidence from the bar's shape alone, −1 … +1.

    Deliberately conservative. A single candle is weak evidence; this feeds the
    CANDLESTICK factor group which carries only 10% of the blend, and it exists
    mainly to catch bars whose shape contradicts their direction (a green bar
    that closed on its low is not bullish).
    """
    score = 0.0

    # Where it closed in its range is the single most informative property.
    score += a.close_location * 0.45

    # Conviction: a wide body in the bar's direction is worth more than a wide
    # body on a bar that gave most of it back.
    directional_body = a.body_percent * (1.0 if a.direction == "UP" else -1.0 if a.direction == "DOWN" else 0.0)
    score += directional_body * 0.25

    # Rejection wicks. A long lower wick is buyers defending; upper is sellers.
    score += (a.lower_wick_percent - a.upper_wick_percent) * 0.30

    # Scale by participation and size — the same shape on 2× volume in a
    # wide-range bar means more than on a quiet narrow one.
    conviction = min(1.4, (0.5 + 0.5 * min(a.volume_ratio, 2.5)) * min(1.2, max(0.6, a.range_vs_atr)))
    score *= conviction

    # Climactic bars cut both ways — a huge volume spike with long wicks is as
    # often exhaustion as continuation. Damp rather than amplify.
    if a.is_climactic:
        score *= 0.6

    # Effort/result divergence means the tape disagrees with the print.
    if a.effort_vs_result == "DIVERGENT":
        score *= 0.5

    # Inside bars are compression, not direction.
    if a.is_inside:
        score *= 0.4

    return float(np.clip(score, -1.0, 1.0))


def describe(a: CandleAnatomy) -> str:
    """One-sentence plain-language read, shown under the candle in the UI."""
    parts: list[str] = [a.classification]

    if a.body_percent >= LARGE_BODY:
        parts.append(f"body {a.body_percent:.0%} of range — decisive")
    elif a.body_percent <= DOJI_BODY:
        parts.append("almost no body — indecision")

    if a.upper_wick_percent >= LONG_WICK:
        parts.append(f"upper wick {a.upper_wick_percent:.0%}, sellers rejected higher prices")
    if a.lower_wick_percent >= LONG_WICK:
        parts.append(f"lower wick {a.lower_wick_percent:.0%}, buyers defended lower prices")

    if a.volume_ratio >= 2.0:
        parts.append(f"volume {a.volume_ratio:.1f}× average")
    elif a.volume_ratio <= 0.6:
        parts.append(f"volume only {a.volume_ratio:.1f}× average — thin participation")

    if a.effort_vs_result == "DIVERGENT":
        parts.append("effort and result diverge, suggesting absorption")

    if a.is_climactic:
        parts.append("climactic bar — often exhaustion rather than continuation")

    if abs(a.gap_percent) >= 1.0:
        parts.append(f"gapped {a.gap_percent:+.1f}% at the open")

    return ". ".join(parts) + "."


def analyse_series(
    df: pd.DataFrame,
    indicators: dict[str, pd.Series],
    *,
    lookback: int = 60,
) -> list[CandleAnatomy]:
    """Anatomy for the most recent ``lookback`` bars, oldest first."""
    start = max(0, len(df) - lookback)
    return [
        analyse_candle(
            df,
            i,
            atr_series=indicators.get("atr"),
            volume_sma=indicators.get("volume_sma_20"),
            ema20=indicators.get("ema_20"),
            vwap_series=indicators.get("vwap"),
        )
        for i in range(start, len(df))
    ]
