"""
Multi-timeframe confluence.

A setup that looks clean on one chart and is fighting the timeframe above it is
the most common way a technically correct read loses money. This module reads
the same instrument across every timeframe that has usable data, and reports
whether they agree.

Three principles shape it:

**Higher timeframes carry more weight, but not veto power.** A weekly downtrend
matters more than a 5-minute one, so weights rise with timeframe. But an
intraday trader is not wrong to take a long inside a weekly downtrend — the
weighting expresses that the higher timeframe is the *context*, not that the
lower one is noise.

**Alignment is measured on two axes, not one.** Trend direction and market
structure are scored separately, because they disagree in an informative way:
price can print higher highs (bullish structure) while every moving average is
still stacked bearish (lagging trend), and that specific disagreement is what a
turning point looks like.

**The gate defaults to refusing.** When timeframes conflict, the answer is WAIT
with the conflict named. This is the whole point of the module — a system that
finds a reason to trade in every market state is not a filter.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .indicators import compute_all, last_valid
from .structure import classify_trend, detect_structure_breaks, find_swings, swing_window_for

#: Every timeframe the platform understands, from fastest to slowest.
ALL_TIMEFRAMES: tuple[str, ...] = (
    "1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M",
)

#: Relative influence of each timeframe on the confluence verdict.
#:
#: Roughly logarithmic in bar duration. The jump from 4h to 1D is the largest
#: because that is where "what is happening today" becomes "what this
#: instrument is doing" — the boundary intraday traders most often ignore.
TIMEFRAME_WEIGHTS: dict[str, float] = {
    "1m": 0.25,
    "3m": 0.35,
    "5m": 0.50,
    "15m": 0.70,
    "30m": 0.85,
    "1h": 1.10,
    "4h": 1.45,
    "1D": 2.00,
    "1W": 2.40,
    "1M": 2.60,
}

#: Which timeframes matter for a given trading horizon. A position trader does
#: not need the 1-minute chart, and including it only adds noise to the vote.
HORIZON_TIMEFRAMES: dict[str, tuple[str, ...]] = {
    "INTRADAY": ("1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"),
    "SWING": ("15m", "30m", "1h", "4h", "1D", "1W"),
    "POSITIONAL": ("1h", "4h", "1D", "1W", "1M"),
    "LONG_TERM": ("4h", "1D", "1W", "1M"),
}

#: Below this many bars a timeframe's read is not trustworthy enough to vote.
MIN_BARS_TO_VOTE = 40

#: Alignment below this is a conflict, and a conflict is a WAIT.
ALIGNMENT_FLOOR = 55.0
#: Above this the timeframes are in genuine agreement.
STRONG_ALIGNMENT = 72.0


@dataclass
class TimeframeRead:
    timeframe: str
    weight: float
    bars: int
    #: −1 (bearish) … +1 (bullish), from moving-average stack and swing sequence.
    trend_score: float
    trend_direction: str
    trend_strength: float
    #: −1 … +1, from the most recent break of structure or change of character.
    structure_score: float
    structure_event: str | None
    #: −1 … +1, RSI-derived, for the divergence check.
    momentum_score: float
    price: float
    note: str

    @property
    def stance(self) -> str:
        blended = self.trend_score * 0.6 + self.structure_score * 0.4
        if blended > 0.15:
            return "BULLISH"
        if blended < -0.15:
            return "BEARISH"
        return "NEUTRAL"

    def to_dict(self) -> dict[str, Any]:
        return {
            "timeframe": self.timeframe,
            "weight": round(self.weight, 2),
            "bars": self.bars,
            "stance": self.stance,
            "trendScore": round(self.trend_score, 3),
            "trendDirection": self.trend_direction,
            "trendStrength": round(self.trend_strength, 1),
            "structureScore": round(self.structure_score, 3),
            "structureEvent": self.structure_event,
            "momentumScore": round(self.momentum_score, 3),
            "price": round(self.price, 6),
            "note": self.note,
        }


def _trend_score(trend: dict[str, Any], ind: dict[str, pd.Series], price: float) -> float:
    """
    Direction and conviction as one number.

    Combines the swing-sequence classification with where price sits against
    its moving averages — the two disagree during transitions, and averaging
    them is what stops a single crossed EMA from flipping the whole read.
    """
    direction = trend.get("direction", "SIDEWAYS")
    base = 1.0 if direction == "UPTREND" else -1.0 if direction == "DOWNTREND" else 0.0

    # ADX-style strength scales conviction, it does not set direction.
    strength = float(trend.get("strength", 0.0)) / 100.0
    base *= 0.45 + 0.55 * min(1.0, strength * 1.6)

    stack = 0.0
    counted = 0
    for key in ("ema_20", "ema_50", "ema_200"):
        value = last_valid(ind.get(key))
        if value and value > 0:
            stack += 1.0 if price > value else -1.0
            counted += 1
    if counted:
        base = base * 0.65 + (stack / counted) * 0.35

    return float(np.clip(base, -1.0, 1.0))


def _structure_score(breaks: list[dict[str, Any]]) -> tuple[float, str | None]:
    """
    The most recent structural event, decayed by how long ago it happened.

    Only the last few matter: a break of structure from forty bars ago has been
    superseded by whatever came after it.
    """
    if not breaks:
        return 0.0, None

    recent = breaks[-3:]
    total = 0.0
    weight = 0.0
    for index, event in enumerate(recent):
        # Most recent event carries the most weight.
        decay = 0.5 + 0.5 * (index + 1) / len(recent)
        direction = 1.0 if event.get("direction") == "BULLISH" else -1.0
        # A change of character is a stronger statement than a continuation.
        magnitude = 1.0 if event.get("type") == "CHOCH" else 0.75
        total += direction * magnitude * decay
        weight += decay

    latest = recent[-1]
    label = f"{latest.get('type')} {latest.get('direction', '').lower()}"
    return float(np.clip(total / weight, -1.0, 1.0)) if weight else 0.0, label


def read_timeframe(timeframe: str, candles: list[dict[str, Any]]) -> TimeframeRead | None:
    """
    Score one timeframe. None when there isn't enough data to have a view.

    Returning None rather than a neutral read matters: a timeframe with 12 bars
    voting "neutral" would drag a genuinely aligned set toward conflict, which
    is exactly backwards.
    """
    if not candles or len(candles) < MIN_BARS_TO_VOTE:
        return None

    df = pd.DataFrame(candles)
    if df.empty or "close" not in df:
        return None

    df = df.copy()
    df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("time").sort_index()

    for column in ("open", "high", "low", "close", "volume"):
        if column not in df:
            return None
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df.dropna(subset=["open", "high", "low", "close"])
    if len(df) < MIN_BARS_TO_VOTE:
        return None

    ind = compute_all(df)
    price = float(df["close"].iloc[-1])
    atr_value = last_valid(ind.get("atr")) or 0.0

    window = swing_window_for(timeframe)
    swings = find_swings(df, window)
    trend = classify_trend(swings, last_valid(ind.get("adx")))

    breaks: list[dict[str, Any]] = []
    if atr_value > 0:
        try:
            breaks = detect_structure_breaks(df, swings, atr_value=atr_value)
        except Exception:  # noqa: BLE001 — one timeframe must not fail the set
            breaks = []

    structure_score, structure_event = _structure_score(breaks)

    rsi_value = last_valid(ind.get("rsi"))
    momentum = float(np.clip(((rsi_value or 50.0) - 50.0) / 30.0, -1.0, 1.0))

    trend_value = _trend_score(trend, ind, price)

    note = trend.get("label") or trend.get("direction", "Sideways")
    if structure_event:
        note = f"{note}; latest {structure_event}"

    return TimeframeRead(
        timeframe=timeframe,
        weight=TIMEFRAME_WEIGHTS.get(timeframe, 1.0),
        bars=len(df),
        trend_score=trend_value,
        trend_direction=trend.get("direction", "SIDEWAYS"),
        trend_strength=float(trend.get("strength", 0.0)),
        structure_score=structure_score,
        structure_event=structure_event,
        momentum_score=momentum,
        price=price,
        note=note[:200],
    )


def _weighted(reads: list[TimeframeRead], attribute: str) -> float:
    total = sum(getattr(r, attribute) * r.weight for r in reads)
    weight = sum(r.weight for r in reads)
    return float(total / weight) if weight else 0.0


def _agreement(reads: list[TimeframeRead], attribute: str) -> float:
    """
    0…100 for how much the timeframes agree on one axis.

    Measured as weighted directional consensus: the absolute value of the mean
    signed direction. All bullish scores 100, an even split scores 0. Neutral
    reads count as half-votes rather than being dropped — a timeframe with no
    view is genuine evidence against strong alignment.
    """
    if not reads:
        return 0.0

    total = 0.0
    weight = 0.0
    for read in reads:
        value = getattr(read, attribute)
        direction = 1.0 if value > 0.15 else -1.0 if value < -0.15 else 0.0
        total += direction * read.weight
        weight += read.weight

    return float(abs(total / weight) * 100.0) if weight else 0.0


def analyse(
    candles_by_timeframe: dict[str, list[dict[str, Any]]],
    *,
    horizon: str = "SWING",
    setup_timeframe: str = "1D",
) -> dict[str, Any]:
    """
    Confluence across every timeframe with usable data.

    Returns the per-timeframe reads, an alignment score, a verdict, and — the
    part that matters — whether a signal should be allowed through at all.
    """
    wanted = HORIZON_TIMEFRAMES.get(horizon, HORIZON_TIMEFRAMES["SWING"])

    reads: list[TimeframeRead] = []
    unavailable: list[str] = []

    for timeframe in ALL_TIMEFRAMES:
        if timeframe not in wanted:
            continue
        read = read_timeframe(timeframe, candles_by_timeframe.get(timeframe) or [])
        if read is None:
            unavailable.append(timeframe)
        else:
            reads.append(read)

    if len(reads) < 2:
        return {
            "verdict": "INSUFFICIENT_DATA",
            "aligned": False,
            "allowSignal": False,
            "alignmentScore": 0.0,
            "trendAgreement": 0.0,
            "structureAgreement": 0.0,
            "bias": "NEUTRAL",
            "timeframes": [r.to_dict() for r in reads],
            "unavailable": unavailable,
            "conflicts": [],
            "summary": (
                "Fewer than two timeframes have enough history to read. "
                "Multi-timeframe confirmation is unavailable, so no signal is issued on it."
            ),
            "reasons": [],
        }

    trend_agreement = _agreement(reads, "trend_score")
    structure_agreement = _agreement(reads, "structure_score")

    weighted_trend = _weighted(reads, "trend_score")
    weighted_structure = _weighted(reads, "structure_score")
    combined = weighted_trend * 0.6 + weighted_structure * 0.4

    # Trend agreement carries more of the alignment score than structure does,
    # because structure events are sparse — many timeframes legitimately have
    # no recent break, and that absence should not read as disagreement.
    alignment = trend_agreement * 0.65 + structure_agreement * 0.35

    bias = "BULLISH" if combined > 0.12 else "BEARISH" if combined < -0.12 else "NEUTRAL"

    # ── Name the conflicts explicitly ────────────────────────────
    conflicts: list[str] = []
    bullish = [r.timeframe for r in reads if r.stance == "BULLISH"]
    bearish = [r.timeframe for r in reads if r.stance == "BEARISH"]

    if bullish and bearish:
        conflicts.append(
            f"{', '.join(bullish)} read bullish while {', '.join(bearish)} read bearish."
        )

    # The specific conflict that matters most: the setup timeframe fighting the
    # timeframes above it.
    higher = [r for r in reads if TIMEFRAME_WEIGHTS.get(r.timeframe, 0) > TIMEFRAME_WEIGHTS.get(setup_timeframe, 0)]
    setup_read = next((r for r in reads if r.timeframe == setup_timeframe), None)
    if setup_read and higher:
        higher_bias = _weighted(higher, "trend_score")
        if setup_read.trend_score * higher_bias < -0.05:
            conflicts.append(
                f"The {setup_timeframe} setup is against the higher-timeframe trend "
                f"({', '.join(r.timeframe for r in higher)}) — the most common way a clean "
                "chart still loses."
            )

    # Momentum diverging from trend on the highest timeframe present.
    anchor = max(reads, key=lambda r: r.weight)
    if anchor.trend_score * anchor.momentum_score < -0.20:
        conflicts.append(
            f"On {anchor.timeframe}, momentum is turning against the established trend — "
            "either an early reversal or a pullback, and they look identical here."
        )

    aligned = alignment >= ALIGNMENT_FLOOR and bias != "NEUTRAL"
    strong = alignment >= STRONG_ALIGNMENT and not conflicts

    if bias == "NEUTRAL":
        verdict = "NO_DIRECTION"
    elif strong:
        verdict = f"STRONGLY_ALIGNED_{bias}"
    elif aligned:
        verdict = f"ALIGNED_{bias}"
    else:
        verdict = "CONFLICTED"

    # ── The gate ─────────────────────────────────────────────────
    # A signal is allowed through only when direction is clear, the timeframes
    # agree, and no named conflict is outstanding.
    allow = aligned and not conflicts

    reasons: list[str] = []
    for read in sorted(reads, key=lambda r: -r.weight):
        arrow = "▲" if read.stance == "BULLISH" else "▼" if read.stance == "BEARISH" else "•"
        reasons.append(f"{arrow} {read.timeframe}: {read.note}")

    if verdict == "NO_DIRECTION":
        summary = (
            f"{len(reads)} timeframes read, but they point in no consistent direction "
            f"(alignment {alignment:.0f}/100). No trade — a market without direction is not a "
            "setup waiting to be found."
        )
    elif verdict == "CONFLICTED":
        summary = (
            f"Timeframes conflict (alignment {alignment:.0f}/100). "
            + " ".join(conflicts)
            + " No signal is issued while they disagree."
        )
    elif strong:
        summary = (
            f"All {len(reads)} timeframes read {bias.lower()} with alignment {alignment:.0f}/100 — "
            f"trend agreement {trend_agreement:.0f}%, structure agreement {structure_agreement:.0f}%. "
            "This is the confirmation a signal needs."
        )
    else:
        summary = (
            f"Timeframes lean {bias.lower()} at alignment {alignment:.0f}/100. "
            + (" ".join(conflicts) if conflicts else "Agreement is adequate but not emphatic.")
        )

    return {
        "verdict": verdict,
        "aligned": aligned,
        "allowSignal": allow,
        "alignmentScore": round(alignment, 1),
        "trendAgreement": round(trend_agreement, 1),
        "structureAgreement": round(structure_agreement, 1),
        "weightedTrend": round(weighted_trend, 3),
        "weightedStructure": round(weighted_structure, 3),
        "bias": bias,
        "timeframes": [r.to_dict() for r in reads],
        "unavailable": unavailable,
        "conflicts": conflicts,
        "summary": summary,
        "reasons": reasons,
    }


def confidence_adjustment(confluence: dict[str, Any]) -> float:
    """
    Multiplier applied to a signal's confidence.

    Deliberately asymmetric: agreement raises confidence a little, conflict cuts
    it hard. Confluence is far better at telling you when *not* to trade than at
    telling you a trade is good — the downside case is the one it earns.
    """
    verdict = confluence.get("verdict", "CONFLICTED")

    if verdict.startswith("STRONGLY_ALIGNED"):
        return 1.15
    if verdict.startswith("ALIGNED"):
        return 1.05
    if verdict == "NO_DIRECTION":
        return 0.70
    if verdict == "INSUFFICIENT_DATA":
        return 0.85
    return 0.55  # CONFLICTED
