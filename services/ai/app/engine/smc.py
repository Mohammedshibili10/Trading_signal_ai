"""
Smart Money Concepts.

Order blocks, fair value gaps, liquidity sweeps and premium/discount zones.

These are a modern repackaging of Wyckoff and order-flow logic. The geometry is
objectively detectable, which is what makes it useful; the *narrative* attached
to it by its retail teachers ("this is where institutions placed orders") is
unfalsifiable, and the engine does not rely on it. Treated as one weighted
evidence group among nine, not as truth.

Spec: docs/trading-concepts.md §3.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .structure import SwingPoint, dealing_range, detect_structure_breaks


@dataclass
class OrderBlock:
    kind: str  # BULLISH | BEARISH
    top: float
    bottom: float
    time: int
    index: int
    mitigated: bool
    strength: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "top": round(self.top, 6),
            "bottom": round(self.bottom, 6),
            "time": self.time,
            "mitigated": self.mitigated,
            "strength": round(self.strength, 1),
        }


@dataclass
class FairValueGap:
    kind: str
    top: float
    bottom: float
    time: int
    index: int
    filled: bool
    size_percent: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "top": round(self.top, 6),
            "bottom": round(self.bottom, 6),
            "time": self.time,
            "filled": self.filled,
            "sizePercent": round(self.size_percent, 3),
        }


@dataclass
class LiquidityPool:
    kind: str  # BUY_SIDE | SELL_SIDE
    price: float
    time: int
    swept: bool
    label: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "price": round(self.price, 6),
            "time": self.time,
            "swept": self.swept,
            "label": self.label,
        }


def _ts(df: pd.DataFrame, i: int) -> int:
    if isinstance(df.index, pd.DatetimeIndex):
        return int(df.index[i].timestamp())
    return int(i)


# ─────────────────────────────────────────────────────────────────
#  Order blocks
# ─────────────────────────────────────────────────────────────────


def find_order_blocks(
    df: pd.DataFrame, *, atr_value: float, lookback: int = 120, limit: int = 6
) -> list[OrderBlock]:
    """
    The last opposing candle before an impulsive move that broke structure.

    Quality filters that separate this from "any red candle before a green one":

    * the following move must be ≥ 1.5 × ATR (a real impulse, not a bounce)
    * the move must actually break the prior swing — displacement without a
      structural break is just noise with conviction
    * unmitigated blocks (never revisited) score higher than used ones
    """
    if atr_value <= 0 or len(df) < 20:
        return []

    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    opens = df["open"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    n = len(df)
    start = max(1, n - lookback)

    blocks: list[OrderBlock] = []

    for i in range(start, n - 3):
        # Measure the impulse over the next 3 bars.
        forward_high = highs[i + 1 : i + 4].max()
        forward_low = lows[i + 1 : i + 4].min()

        bearish_candle = closes[i] < opens[i]
        bullish_candle = closes[i] > opens[i]

        # Bullish OB: last down-candle before an up-impulse.
        if bearish_candle:
            impulse = forward_high - closes[i]
            if impulse >= atr_value * 1.5 and forward_high > highs[max(0, i - 5) : i + 1].max():
                top, bottom = float(max(opens[i], closes[i])), float(lows[i])
                # Mitigated once price has traded back into the block.
                mitigated = bool(np.any(lows[i + 1 :] <= top))
                strength = min(100.0, (impulse / atr_value) * 22.0 + (0 if mitigated else 22.0))
                blocks.append(
                    OrderBlock("BULLISH", top, bottom, _ts(df, i), i, mitigated, strength)
                )

        # Bearish OB: last up-candle before a down-impulse.
        if bullish_candle:
            impulse = closes[i] - forward_low
            if impulse >= atr_value * 1.5 and forward_low < lows[max(0, i - 5) : i + 1].min():
                top, bottom = float(highs[i]), float(min(opens[i], closes[i]))
                mitigated = bool(np.any(highs[i + 1 :] >= bottom))
                strength = min(100.0, (impulse / atr_value) * 22.0 + (0 if mitigated else 22.0))
                blocks.append(
                    OrderBlock("BEARISH", top, bottom, _ts(df, i), i, mitigated, strength)
                )

    # Most recent and strongest first; unmitigated blocks are the tradeable ones.
    blocks.sort(key=lambda b: (not b.mitigated, b.index), reverse=True)
    return blocks[:limit]


# ─────────────────────────────────────────────────────────────────
#  Fair value gaps
# ─────────────────────────────────────────────────────────────────


def find_fair_value_gaps(
    df: pd.DataFrame, *, atr_value: float, lookback: int = 120, limit: int = 8
) -> list[FairValueGap]:
    """
    Three-candle imbalance where candle 1 and candle 3 do not overlap.

        Bullish FVG: low[i+1] > high[i-1]
        Bearish FVG: high[i+1] < low[i-1]

    The gap is a range that traded in one direction only, and tends to get
    revisited. Gaps smaller than a quarter-ATR are discarded — at that size
    they're rounding, not imbalance.
    """
    if atr_value <= 0 or len(df) < 5:
        return []

    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    n = len(df)
    start = max(1, n - lookback)
    min_size = atr_value * 0.25

    gaps: list[FairValueGap] = []

    for i in range(start, n - 1):
        prev_high, prev_low = highs[i - 1], lows[i - 1]
        next_high, next_low = highs[i + 1], lows[i + 1]

        if next_low > prev_high:
            size = next_low - prev_high
            if size >= min_size:
                # Filled once price trades back down through the gap.
                filled = bool(np.any(lows[i + 2 :] <= prev_high)) if i + 2 < n else False
                gaps.append(
                    FairValueGap(
                        "BULLISH", float(next_low), float(prev_high), _ts(df, i), i,
                        filled, float(size / closes[i] * 100.0),
                    )
                )

        elif next_high < prev_low:
            size = prev_low - next_high
            if size >= min_size:
                filled = bool(np.any(highs[i + 2 :] >= prev_low)) if i + 2 < n else False
                gaps.append(
                    FairValueGap(
                        "BEARISH", float(prev_low), float(next_high), _ts(df, i), i,
                        filled, float(size / closes[i] * 100.0),
                    )
                )

    gaps.sort(key=lambda g: (not g.filled, g.index), reverse=True)
    return gaps[:limit]


# ─────────────────────────────────────────────────────────────────
#  Liquidity
# ─────────────────────────────────────────────────────────────────


def find_liquidity(
    df: pd.DataFrame, swings: list[SwingPoint], *, atr_value: float, limit: int = 6
) -> list[LiquidityPool]:
    """
    Equal highs and lows — where stop orders cluster.

    The tradeable event isn't the pool itself but the **sweep**: a wick through
    the level that closes back inside. That is the objective footprint of a stop
    run, and it's the most defensible idea in the SMC toolkit because it makes a
    falsifiable claim about the next few bars.
    """
    if atr_value <= 0 or len(swings) < 2:
        return []

    tolerance = atr_value * 0.35
    highs = [s for s in swings if s.kind == "HIGH"]
    lows = [s for s in swings if s.kind == "LOW"]

    bar_highs = df["high"].to_numpy(dtype=float)
    bar_lows = df["low"].to_numpy(dtype=float)
    bar_closes = df["close"].to_numpy(dtype=float)
    n = len(df)

    pools: list[LiquidityPool] = []

    def scan(points: list[SwingPoint], kind: str) -> None:
        for a, b in zip(points, points[1:]):
            if abs(a.price - b.price) > tolerance:
                continue

            price = (a.price + b.price) / 2.0
            after = b.index + 1
            if after >= n:
                continue

            if kind == "BUY_SIDE":
                pierced = np.where(bar_highs[after:] > price)[0]
                swept = bool(
                    pierced.size and bar_closes[after + pierced[0]] < price
                )
            else:
                pierced = np.where(bar_lows[after:] < price)[0]
                swept = bool(
                    pierced.size and bar_closes[after + pierced[0]] > price
                )

            label = (
                f"Equal {'highs' if kind == 'BUY_SIDE' else 'lows'} at {price:.2f}"
                + (" — swept, stops taken and price rejected" if swept else " — untouched, stops resting above" if kind == "BUY_SIDE" else " — untouched, stops resting below")
            )
            pools.append(LiquidityPool(kind, price, b.time, swept, label))

    scan(highs, "BUY_SIDE")
    scan(lows, "SELL_SIDE")

    pools.sort(key=lambda p: p.time, reverse=True)
    return pools[:limit]


# ─────────────────────────────────────────────────────────────────
#  Premium / discount
# ─────────────────────────────────────────────────────────────────


def premium_discount(df: pd.DataFrame, lookback: int = 60) -> dict[str, Any] | None:
    """
    Where price sits in its dealing range.

    Simple, and a genuinely useful discipline — it stops you buying at the top
    of a range because a green candle looked exciting.
    """
    rng = dealing_range(df, lookback)
    if not rng:
        return None

    price = float(df["close"].iloc[-1])
    high, low, eq = rng["high"], rng["low"], rng["equilibrium"]
    span = high - low
    position = (price - low) / span * 100.0

    if position >= 60:
        zone = "PREMIUM"
    elif position <= 40:
        zone = "DISCOUNT"
    else:
        zone = "EQUILIBRIUM"

    return {
        "equilibrium": eq,
        "rangeHigh": high,
        "rangeLow": low,
        "zone": zone,
        "positionPercent": float(np.clip(position, 0, 100)),
    }


# ─────────────────────────────────────────────────────────────────
#  Roll-up
# ─────────────────────────────────────────────────────────────────


def analyse(
    df: pd.DataFrame,
    swings: list[SwingPoint],
    *,
    atr_value: float,
    timeframe: str = "1D",
) -> dict[str, Any]:
    """Full SMC read, plus a −1…+1 bias score for the factor engine."""
    order_blocks = find_order_blocks(df, atr_value=atr_value)
    fvgs = find_fair_value_gaps(df, atr_value=atr_value)
    liquidity = find_liquidity(df, swings, atr_value=atr_value)
    structure = detect_structure_breaks(df, swings)
    pd_zone = premium_discount(df)

    price = float(df["close"].iloc[-1])
    score = 0.0
    notes: list[str] = []

    # Most recent structure event dominates — it's the freshest statement about
    # who is in control.
    if structure:
        latest = structure[-1]
        weight = 0.45 if latest["type"] == "CHOCH" else 0.35
        score += weight * (1.0 if latest["direction"] == "BULLISH" else -1.0)
        notes.append(latest["note"])

    # Unmitigated order blocks price is approaching.
    for ob in order_blocks[:3]:
        if ob.mitigated:
            continue
        inside = ob.bottom <= price <= ob.top
        near = abs(price - (ob.top + ob.bottom) / 2) <= atr_value * 1.5
        if inside or near:
            direction = 1.0 if ob.kind == "BULLISH" else -1.0
            score += 0.2 * direction * (ob.strength / 100.0)
            notes.append(
                f"Price is {'inside' if inside else 'approaching'} an unmitigated "
                f"{ob.kind.lower()} order block at {ob.bottom:.2f}–{ob.top:.2f}"
            )

    # Unfilled gaps act as magnets.
    for gap in fvgs[:3]:
        if gap.filled:
            continue
        mid = (gap.top + gap.bottom) / 2
        if abs(price - mid) <= atr_value * 2.0:
            score += 0.12 * (1.0 if gap.kind == "BULLISH" else -1.0)
            notes.append(
                f"Unfilled {gap.kind.lower()} fair value gap at {gap.bottom:.2f}–{gap.top:.2f}"
            )

    # A recent sweep is a strong short-term reversal tell.
    for pool in liquidity[:3]:
        if not pool.swept:
            continue
        # Sweeping buy-side liquidity (highs) is bearish — stops above were
        # filled and price rejected. Sell-side sweep is bullish.
        score += 0.18 * (-1.0 if pool.kind == "BUY_SIDE" else 1.0)
        notes.append(pool.label)

    # Premium/discount nudges rather than decides.
    if pd_zone:
        if pd_zone["zone"] == "DISCOUNT":
            score += 0.12
            notes.append(f"Price is in the discount half of its range ({pd_zone['positionPercent']:.0f}%)")
        elif pd_zone["zone"] == "PREMIUM":
            score -= 0.12
            notes.append(f"Price is in the premium half of its range ({pd_zone['positionPercent']:.0f}%)")

    score = float(np.clip(score, -1.0, 1.0))
    bias = "BULLISH" if score > 0.15 else "BEARISH" if score < -0.15 else "NEUTRAL"

    summary = (
        " ".join(f"{n}." for n in notes[:3])
        if notes
        else "No significant smart-money structure on this timeframe."
    )

    return {
        "orderBlocks": [b.to_dict() for b in order_blocks],
        "fairValueGaps": [g.to_dict() for g in fvgs],
        "liquidity": [p.to_dict() for p in liquidity],
        "structure": structure,
        "premiumDiscount": pd_zone,
        "bias": bias,
        "score": score,
        "summary": summary,
        "notes": notes,
    }
