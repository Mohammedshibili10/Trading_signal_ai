"""
Market structure primitives.

Swing points are the base primitive for everything downstream — trend
classification, support/resistance, trendlines, chart patterns, order blocks,
BOS/CHoCH. Getting the fractal window right matters more than any indicator
setting: too small and every wiggle is a swing, too large and you miss the turn.

Spec: docs/trading-concepts.md §1–2.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd


@dataclass
class SwingPoint:
    index: int
    time: int
    price: float
    kind: Literal["HIGH", "LOW"]

    def to_dict(self) -> dict[str, Any]:
        return {"time": self.time, "price": round(self.price, 6), "kind": self.kind}


@dataclass
class Level:
    price: float
    kind: str  # SUPPORT | RESISTANCE | PIVOT | FIBONACCI
    strength: float
    label: str
    touches: int
    distance_percent: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "price": round(self.price, 6),
            "kind": self.kind,
            "strength": round(self.strength, 1),
            "label": self.label,
            "touches": self.touches,
            "distancePercent": round(self.distance_percent, 2),
        }


@dataclass
class Trendline:
    kind: str  # SUPPORT | RESISTANCE
    from_point: tuple[int, float]
    to_point: tuple[int, float]
    slope: float
    touches: int
    intact: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "from": {"time": self.from_point[0], "price": round(self.from_point[1], 6)},
            "to": {"time": self.to_point[0], "price": round(self.to_point[1], 6)},
            "slope": round(self.slope, 8),
            "touches": self.touches,
            "intact": self.intact,
        }


def _ts(df: pd.DataFrame, i: int) -> int:
    if isinstance(df.index, pd.DatetimeIndex):
        return int(df.index[i].timestamp())
    return int(i)


# ─────────────────────────────────────────────────────────────────
#  Swings
# ─────────────────────────────────────────────────────────────────


def find_swings(df: pd.DataFrame, window: int = 3) -> list[SwingPoint]:
    """
    Fractal swing points: a high that exceeds ``window`` bars on both sides.

    Note the confirmation lag — a swing at bar *i* is only knowable at bar
    ``i + window``. Callers doing walk-forward work must respect that; the
    detectors here never return a swing whose right-hand side isn't complete.
    """
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    n = len(df)
    swings: list[SwingPoint] = []

    for i in range(window, n - window):
        left_h, right_h = highs[i - window : i], highs[i + 1 : i + 1 + window]
        if highs[i] > left_h.max() and highs[i] >= right_h.max():
            swings.append(SwingPoint(i, _ts(df, i), float(highs[i]), "HIGH"))
            continue

        left_l, right_l = lows[i - window : i], lows[i + 1 : i + 1 + window]
        if lows[i] < left_l.min() and lows[i] <= right_l.min():
            swings.append(SwingPoint(i, _ts(df, i), float(lows[i]), "LOW"))

    return swings


def swing_window_for(timeframe: str) -> int:
    """Intraday data is noisier and needs a tighter fractal than daily."""
    if timeframe in {"1m", "5m"}:
        return 2
    if timeframe in {"15m", "30m", "1h"}:
        return 3
    if timeframe in {"4h", "1D"}:
        return 4
    return 5


# ─────────────────────────────────────────────────────────────────
#  Trend classification
# ─────────────────────────────────────────────────────────────────


def classify_trend(swings: list[SwingPoint], adx_value: float | None = None) -> dict[str, Any]:
    """
    Trend from swing sequence — higher highs *and* higher lows, or the mirror.

    Deliberately structural rather than moving-average based: an MA cross tells
    you the average moved, a swing sequence tells you what buyers and sellers
    actually did.
    """
    highs = [s for s in swings if s.kind == "HIGH"][-3:]
    lows = [s for s in swings if s.kind == "LOW"][-3:]

    strength = float(adx_value) if adx_value is not None and np.isfinite(adx_value) else 0.0

    if len(highs) < 2 or len(lows) < 2:
        return {
            "direction": "SIDEWAYS",
            "strength": strength,
            "label": "Not enough structure to classify a trend",
            "higher_highs": False,
            "higher_lows": False,
        }

    hh = highs[-1].price > highs[-2].price
    hl = lows[-1].price > lows[-2].price
    lh = highs[-1].price < highs[-2].price
    ll = lows[-1].price < lows[-2].price

    if hh and hl:
        direction = "UPTREND"
    elif lh and ll:
        direction = "DOWNTREND"
    else:
        direction = "SIDEWAYS"

    # ADX qualifies the label. A structural uptrend with ADX 15 is drifting, not
    # trending, and sizing into it as though it were trending is how accounts
    # bleed in chop.
    if direction == "SIDEWAYS":
        label = "Range-bound — no consistent sequence of highs and lows"
    elif strength >= 40:
        label = f"Strong {direction.lower()} (ADX {strength:.0f})"
    elif strength >= 25:
        label = f"Established {direction.lower()} (ADX {strength:.0f})"
    elif strength >= 20:
        label = f"Developing {direction.lower()} (ADX {strength:.0f})"
    else:
        label = f"Weak {direction.lower()} — ADX {strength:.0f} suggests chop rather than trend"

    return {
        "direction": direction,
        "strength": strength,
        "label": label,
        "higher_highs": hh,
        "higher_lows": hl,
    }


# ─────────────────────────────────────────────────────────────────
#  Support & resistance
# ─────────────────────────────────────────────────────────────────


def find_levels(
    df: pd.DataFrame,
    swings: list[SwingPoint],
    *,
    atr_value: float,
    max_levels: int = 8,
) -> list[Level]:
    """
    Cluster swing points into support/resistance zones and score them.

    Strength (0–100) combines four things, per docs/trading-concepts.md §2.1:
    touch count, recency, reaction size, and volume at the level. A level nobody
    has traded against recently is not a level.
    """
    if not swings or atr_value <= 0:
        return []

    current_price = float(df["close"].iloc[-1])
    n = len(df)
    tolerance = atr_value * 0.6

    # Cluster by price proximity.
    clusters: list[list[SwingPoint]] = []
    for s in sorted(swings, key=lambda x: x.price):
        if clusters and abs(s.price - np.mean([c.price for c in clusters[-1]])) <= tolerance:
            clusters[-1].append(s)
        else:
            clusters.append([s])

    volumes = df["volume"].to_numpy(dtype=float)
    avg_volume = float(np.mean(volumes)) if volumes.size and np.mean(volumes) > 0 else 0.0

    levels: list[Level] = []
    for cluster in clusters:
        price = float(np.mean([c.price for c in cluster]))
        touches = len(cluster)

        # Recency — a level touched last week outranks one from years ago.
        newest = max(c.index for c in cluster)
        recency = newest / max(n - 1, 1)

        # Reaction — how far price travelled away after each touch.
        reactions = []
        for c in cluster:
            end = min(c.index + 10, n)
            if end > c.index + 1:
                seg = df.iloc[c.index : end]
                move = max(abs(seg["high"].max() - price), abs(price - seg["low"].min()))
                reactions.append(move / atr_value)
        reaction = float(np.mean(reactions)) if reactions else 0.0

        # Volume at the level relative to the series average.
        vol_at = (
            float(np.mean([volumes[c.index] for c in cluster])) / avg_volume
            if avg_volume > 0
            else 1.0
        )

        strength = (
            min(touches / 4.0, 1.0) * 40.0
            + recency * 25.0
            + min(reaction / 3.0, 1.0) * 20.0
            + min(vol_at / 2.0, 1.0) * 15.0
        )

        above = price > current_price
        kind = "RESISTANCE" if above else "SUPPORT"
        distance = (price - current_price) / current_price * 100.0

        # Polarity: a level that used to be resistance and has been broken now
        # acts as support (and vice versa). Worth saying out loud in the label.
        was_opposite = any(
            (c.kind == "HIGH" and not above) or (c.kind == "LOW" and above) for c in cluster
        )
        label = f"{kind.capitalize()} · {touches} touch{'es' if touches > 1 else ''}"
        if was_opposite:
            label += " · polarity flip"

        levels.append(
            Level(
                price=price,
                kind=kind,
                strength=float(np.clip(strength, 0, 100)),
                label=label,
                touches=touches,
                distance_percent=distance,
            )
        )

    # Keep the strongest levels nearest to price — a level 40% away is true but
    # useless.
    levels.sort(key=lambda lv: (abs(lv.distance_percent) / 5.0) - (lv.strength / 50.0))
    return levels[:max_levels]


def nearest_levels(levels: list[Level], price: float) -> tuple[Level | None, Level | None]:
    """Closest support below and resistance above."""
    below = [lv for lv in levels if lv.price < price]
    above = [lv for lv in levels if lv.price > price]
    support = max(below, key=lambda lv: lv.price) if below else None
    resistance = min(above, key=lambda lv: lv.price) if above else None
    return support, resistance


def level_proximity(levels: list[Level], price: float, atr_value: float) -> dict[str, Any]:
    """Is price sitting at a level right now, and which side?"""
    if not levels or atr_value <= 0:
        return {"near": False, "level": None, "side": None, "distance_atr": None}

    closest = min(levels, key=lambda lv: abs(lv.price - price))
    distance_atr = abs(closest.price - price) / atr_value
    near = distance_atr <= 0.5

    return {
        "near": near,
        "level": closest,
        "side": "ABOVE" if price > closest.price else "BELOW",
        "distance_atr": distance_atr,
    }


# ─────────────────────────────────────────────────────────────────
#  Trendlines & channels
# ─────────────────────────────────────────────────────────────────


def fit_trendlines(df: pd.DataFrame, swings: list[SwingPoint], *, atr_value: float) -> list[Trendline]:
    """
    Fit ascending support and descending resistance lines through swing points.

    Uses the two most recent qualifying swings and then counts how many other
    swings sit within a half-ATR of the projected line — a two-point line is a
    coincidence, a three-point line is a trendline.
    """
    out: list[Trendline] = []
    n = len(df)
    if atr_value <= 0 or n < 10:
        return out

    for kind, want in (("SUPPORT", "LOW"), ("RESISTANCE", "HIGH")):
        pts = [s for s in swings if s.kind == want][-5:]
        if len(pts) < 2:
            continue

        a, b = pts[-2], pts[-1]
        if b.index == a.index:
            continue

        slope = (b.price - a.price) / (b.index - a.index)

        # A support line should rise, a resistance line should fall. Anything
        # else is not the structure we're looking for.
        if kind == "SUPPORT" and slope < 0:
            continue
        if kind == "RESISTANCE" and slope > 0:
            continue

        touches = sum(
            1
            for s in pts
            if abs(s.price - (a.price + slope * (s.index - a.index))) <= atr_value * 0.5
        )

        # Intact until price closes decisively through it.
        projected_now = a.price + slope * (n - 1 - a.index)
        last_close = float(df["close"].iloc[-1])
        intact = (
            last_close > projected_now - atr_value * 0.3
            if kind == "SUPPORT"
            else last_close < projected_now + atr_value * 0.3
        )

        out.append(
            Trendline(
                kind=kind,
                from_point=(_ts(df, a.index), a.price),
                to_point=(_ts(df, n - 1), projected_now),
                slope=slope,
                touches=touches,
                intact=intact,
            )
        )

    return out


def detect_channel(df: pd.DataFrame, swings: list[SwingPoint], lookback: int = 60) -> dict[str, Any] | None:
    """
    Linear-regression channel over the recent window.

    Simpler and more robust than fitting parallel trendlines to swings: fit the
    closes, then set the bands at the largest residual either side.
    """
    if len(df) < 20:
        return None

    window = df.iloc[-min(lookback, len(df)) :]
    y = window["close"].to_numpy(dtype=float)
    x = np.arange(len(y), dtype=float)

    slope, intercept = np.polyfit(x, y, 1)
    fitted = slope * x + intercept
    residuals = y - fitted

    upper_offset = float(residuals.max())
    lower_offset = float(residuals.min())

    current_mid = float(fitted[-1])
    upper = current_mid + upper_offset
    lower = current_mid + lower_offset
    price = float(window["close"].iloc[-1])

    span = upper - lower
    if span <= 0:
        return None

    return {
        "upper": upper,
        "lower": lower,
        "midline": current_mid,
        "slope": float(slope),
        "positionPercent": float(np.clip((price - lower) / span * 100.0, 0, 100)),
    }


# ─────────────────────────────────────────────────────────────────
#  Break of structure / change of character
# ─────────────────────────────────────────────────────────────────


def detect_structure_breaks(
    df: pd.DataFrame, swings: list[SwingPoint], *, limit: int = 6
) -> list[dict[str, Any]]:
    """
    BOS and CHoCH events.

    The distinction is the most useful idea in modern price action and the most
    commonly muddled:

    * **BOS** — breaking the last swing high *while already in an uptrend*.
      Continuation.
    * **CHoCH** — breaking the last swing low *while in an uptrend*. The first
      structural evidence the trend is turning.

    Tracked as a running state machine over the swing sequence rather than
    pattern-matched on the last few bars, because the label depends entirely on
    what the trend was beforehand.
    """
    events: list[dict[str, Any]] = []
    if len(swings) < 4:
        return events

    ordered = sorted(swings, key=lambda s: s.index)
    closes = df["close"].to_numpy(dtype=float)

    trend: str | None = None
    last_high: SwingPoint | None = None
    last_low: SwingPoint | None = None

    for s in ordered:
        if s.kind == "HIGH":
            if last_high is not None and s.price > last_high.price:
                # Confirm with a close beyond, not just a wick.
                broke = closes[s.index] > last_high.price
                if broke:
                    kind = "BOS" if trend == "BULLISH" else "CHOCH"
                    events.append(
                        {
                            "type": kind,
                            "direction": "BULLISH",
                            "price": float(last_high.price),
                            "time": s.time,
                            "note": (
                                f"Price closed above the prior swing high at {last_high.price:.2f}"
                                + (
                                    " — continuation of the existing uptrend."
                                    if kind == "BOS"
                                    else " — first structural sign of a shift to the upside."
                                )
                            ),
                        }
                    )
                    trend = "BULLISH"
            last_high = s

        else:
            if last_low is not None and s.price < last_low.price:
                broke = closes[s.index] < last_low.price
                if broke:
                    kind = "BOS" if trend == "BEARISH" else "CHOCH"
                    events.append(
                        {
                            "type": kind,
                            "direction": "BEARISH",
                            "price": float(last_low.price),
                            "time": s.time,
                            "note": (
                                f"Price closed below the prior swing low at {last_low.price:.2f}"
                                + (
                                    " — continuation of the existing downtrend."
                                    if kind == "BOS"
                                    else " — first structural sign of a shift to the downside."
                                )
                            ),
                        }
                    )
                    trend = "BEARISH"
            last_low = s

    return events[-limit:]


def dealing_range(df: pd.DataFrame, lookback: int = 60) -> dict[str, float] | None:
    """The current range and its equilibrium — the basis of premium/discount."""
    if len(df) < 10:
        return None
    window = df.iloc[-min(lookback, len(df)) :]
    high = float(window["high"].max())
    low = float(window["low"].min())
    if high <= low:
        return None
    return {"high": high, "low": low, "equilibrium": (high + low) / 2.0}
