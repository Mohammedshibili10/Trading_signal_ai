"""
ICT concepts that SMC does not already cover.

The overlap between "Smart Money Concepts" and ICT is large and already handled
in `smc.py` — order blocks, fair value gaps, liquidity sweeps, equal highs and
lows, premium/discount. Re-implementing those here would produce two modules
that disagree with each other at the edges. What is left, and what this module
adds, is the part of ICT that is genuinely its own:

* **Killzones.** ICT's claim is that displacement clusters in specific windows —
  the London and New York opens — and that a setup forming inside one carries
  more weight than the same shape at 03:00 in a dead tape. This is a *timing*
  filter, and nothing in the existing engine expresses it.

* **Optimal Trade Entry.** The 62–79% retracement of an impulse leg. Distinct
  from a generic Fibonacci level because it is a band with a defined
  invalidation, not a line to lean on.

* **Breaker blocks.** An order block that failed. When price closes decisively
  through a block and later returns, the level flips polarity — former demand
  becomes supply. `smc.py` marks such a block "mitigated" and stops caring; ICT
  says the interesting part starts there.

**Timing is stated in UTC.** ICT is taught in New York local time, which shifts
with US daylight saving. Rather than pretend to a precision the bar timestamps
do not support, the windows below are fixed UTC approximations of the EST
definitions and are described as such. During EDT they sit an hour off, which is
noted in the output rather than silently absorbed.

Killzones are meaningless on daily and higher bars — a daily candle spans every
session at once — so the whole timing read is reported unavailable above 4h
rather than computed from a bar that cannot express it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

from .structure import SwingPoint

#: ICT killzones as (start_hour, end_hour) in UTC, from the EST definitions.
KILLZONES: dict[str, tuple[int, int, str]] = {
    "ASIAN": (1, 5, "Asian range — the session whose high and low later get swept"),
    "LONDON": (7, 10, "London open — the first displacement of the day"),
    "NEW_YORK_AM": (12, 15, "New York AM — the highest-participation window"),
    "NEW_YORK_PM": (18, 21, "New York PM — the afternoon continuation window"),
}

#: Timeframes on which a killzone is a meaningful statement about one bar.
INTRADAY_TIMEFRAMES = {"1m", "3m", "5m", "15m", "30m", "1h", "4h"}

#: ICT's optimal trade entry band, as retracement fractions of an impulse leg.
OTE_LOW = 0.62
OTE_HIGH = 0.79


@dataclass
class Breaker:
    kind: str  # BULLISH | BEARISH — the polarity it has *now*, after flipping
    top: float
    bottom: float
    broken_at: int
    note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "top": round(self.top, 4),
            "bottom": round(self.bottom, 4),
            "brokenAt": self.broken_at,
            "note": self.note,
        }


def _clip(value: float) -> float:
    return max(-1.0, min(1.0, value))


def current_killzone(df: pd.DataFrame, timeframe: str) -> dict[str, Any]:
    """Which killzone the most recent bar opened in, if any."""
    if timeframe not in INTRADAY_TIMEFRAMES:
        return {
            "available": False,
            "reason": f"{timeframe} bars span every session — killzones need an intraday bar",
        }
    if not isinstance(df.index, pd.DatetimeIndex) or len(df) == 0:
        return {"available": False, "reason": "no timestamps on the series"}

    hour = int(df.index[-1].hour)
    for name, (start, end, description) in KILLZONES.items():
        if start <= hour < end:
            return {
                "available": True,
                "active": True,
                "zone": name,
                "description": description,
                "hourUtc": hour,
                "note": (
                    f"{name.replace('_', ' ').title()} killzone ({start:02d}:00–{end:02d}:00 UTC, "
                    "EST-derived — one hour off during US daylight saving)"
                ),
            }

    return {
        "available": True,
        "active": False,
        "zone": None,
        "hourUtc": hour,
        "note": f"{hour:02d}:00 UTC is outside every killzone — displacement here is less reliable",
    }


def optimal_trade_entry(swings: list[SwingPoint], price: float) -> dict[str, Any]:
    """
    The 62–79% retracement band of the most recent impulse leg.

    Direction comes from the leg itself: a low-to-high leg makes the band a
    place to buy a pullback, a high-to-low leg a place to sell a bounce.
    """
    if len(swings) < 2:
        return {"available": False}

    last, prior = swings[-1], swings[-2]
    if last.kind == prior.kind:
        return {"available": False}

    leg = abs(last.price - prior.price)
    if leg <= 0:
        return {"available": False}

    bullish = last.kind == "HIGH"  # impulse ran up; retracement is a buy zone
    if bullish:
        band_high = last.price - leg * OTE_LOW
        band_low = last.price - leg * OTE_HIGH
    else:
        band_low = last.price + leg * OTE_LOW
        band_high = last.price + leg * OTE_HIGH

    band_low, band_high = min(band_low, band_high), max(band_low, band_high)
    inside = band_low <= price <= band_high

    return {
        "available": True,
        "direction": "BULLISH" if bullish else "BEARISH",
        "low": round(band_low, 4),
        "high": round(band_high, 4),
        # Beyond the origin of the leg the setup is not a discounted entry, it
        # is a failed move — which is why the band has an invalidation at all.
        "invalidation": round(prior.price, 4),
        "inside": inside,
        "note": (
            f"Price is inside the {'bullish' if bullish else 'bearish'} OTE band "
            f"{band_low:.2f}–{band_high:.2f}, invalid beyond {prior.price:.2f}"
            if inside
            else f"OTE band {band_low:.2f}–{band_high:.2f} is not in play at {price:.2f}"
        ),
    }


def find_breakers(
    df: pd.DataFrame, order_blocks: list[Any], *, atr_value: float, limit: int = 3
) -> list[Breaker]:
    """
    Order blocks price closed decisively through — now flipped in polarity.

    "Decisively" means a close beyond the block by at least a quarter of ATR.
    Without that, a wick through a level would be enough to flip it, and every
    level would eventually be a breaker.
    """
    if len(df) == 0 or atr_value <= 0:
        return []

    closes = df["close"].to_numpy()
    margin = atr_value * 0.25
    breakers: list[Breaker] = []

    for block in order_blocks:
        kind = getattr(block, "kind", None)
        top = getattr(block, "top", None)
        bottom = getattr(block, "bottom", None)
        index = getattr(block, "index", None)
        if kind is None or top is None or bottom is None:
            continue

        start = int(index) + 1 if isinstance(index, (int, float)) else 0
        after = closes[start:] if 0 <= start < len(closes) else closes
        if len(after) == 0:
            continue

        if kind == "BULLISH" and float(after.min()) < bottom - margin:
            # Demand that failed becomes supply on the retest.
            breakers.append(
                Breaker(
                    kind="BEARISH",
                    top=float(top),
                    bottom=float(bottom),
                    broken_at=int(start),
                    note=(
                        f"Bullish order block {bottom:.2f}–{top:.2f} broke down — "
                        "now a bearish breaker on any retest"
                    ),
                )
            )
        elif kind == "BEARISH" and float(after.max()) > top + margin:
            breakers.append(
                Breaker(
                    kind="BULLISH",
                    top=float(top),
                    bottom=float(bottom),
                    broken_at=int(start),
                    note=(
                        f"Bearish order block {bottom:.2f}–{top:.2f} broke up — "
                        "now a bullish breaker on any retest"
                    ),
                )
            )

        if len(breakers) >= limit:
            break

    return breakers


def analyse(
    df: pd.DataFrame,
    swings: list[SwingPoint],
    order_blocks: list[Any],
    *,
    atr_value: float,
    timeframe: str = "1D",
) -> dict[str, Any]:
    """
    The ICT read: timing, entry band, and flipped levels.

    Scores modestly by design. These are refinements on a structural read that
    `smc.py` has already made — a killzone does not make a bad setup good, it
    makes a good setup slightly better timed, and the score reflects that.
    """
    if len(df) == 0:
        return {"available": False, "score": 0.0, "summary": "", "notes": []}

    price = float(df["close"].iloc[-1])
    killzone = current_killzone(df, timeframe)
    ote = optimal_trade_entry(swings, price)
    breakers = find_breakers(df, order_blocks, atr_value=atr_value)

    score = 0.0
    notes: list[str] = []

    if ote.get("available") and ote.get("inside"):
        score += 0.45 if ote["direction"] == "BULLISH" else -0.45
        notes.append(ote["note"])

    for breaker in breakers[:2]:
        near = breaker.bottom - atr_value <= price <= breaker.top + atr_value
        if near:
            score += 0.25 if breaker.kind == "BULLISH" else -0.25
            notes.append(breaker.note)

    # Timing scales conviction rather than adding to it: a killzone with no
    # setup in it is not evidence of anything, so it multiplies a score that
    # already exists instead of contributing one of its own.
    if killzone.get("available"):
        if killzone.get("active") and score != 0.0:
            score *= 1.2
            notes.append(killzone["note"])
        elif not killzone.get("active") and score != 0.0:
            score *= 0.8
            notes.append(killzone["note"])

    return {
        "available": True,
        "score": _clip(score),
        "killzone": killzone,
        "optimalTradeEntry": ote,
        "breakers": [b.to_dict() for b in breakers],
        "notes": notes,
        "summary": "; ".join(notes)[:400] or "No ICT setup in play.",
    }
