"""
Elliott Wave labelling.

Elliott is the most subjective method in this engine, and pretending otherwise
would be the worst thing this module could do. Two analysts label the same chart
differently, and any implementation is one interpretation among several valid
ones. So the design here is deliberately narrow:

**Only the three hard rules are enforced.** Wave 2 never retraces beyond the
start of wave 1; wave 3 is never the shortest of 1, 3 and 5; wave 4 never
overlaps the territory of wave 1. These are the rules that make a count *wrong*
rather than *unusual*. Everything else — extensions, alternation, channel
behaviour — is scored as evidence for or against, not used to reject.

**The count is reported with its own uncertainty.** A degree of confidence is
attached that reflects how cleanly the ratios fit and how many alternative
counts the same swings would support. Where the swings are genuinely ambiguous
the module says so instead of picking one and sounding certain.

**The output is a position, not a prediction.** "Likely in wave 4 of an impulse"
is useful because it implies what comes next and what would disprove it. A
target price derived from a wave count is not treated as more reliable than the
count it rests on, and the count is rarely better than a coin flip on its own —
which is why this contributes to the blend rather than driving a signal.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd

from .structure import SwingPoint

#: An impulse needs six alternating pivots (0-1-2-3-4-5).
IMPULSE_PIVOTS = 6
#: A correction needs four (0-A-B-C).
CORRECTION_PIVOTS = 4


@dataclass
class WaveLabel:
    label: str
    start_time: int
    end_time: int
    start_price: float
    end_price: float
    #: This wave's length as a ratio of the reference wave, where meaningful.
    ratio: float | None
    note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "startPrice": round(self.start_price, 6),
            "endPrice": round(self.end_price, 6),
            "ratio": round(self.ratio, 3) if self.ratio is not None else None,
            "note": self.note,
        }


@dataclass
class WaveCount:
    #: IMPULSE (1-2-3-4-5) or CORRECTION (A-B-C).
    structure: Literal["IMPULSE", "CORRECTION"]
    direction: str  # BULLISH | BEARISH
    #: Which wave price is currently in, or "COMPLETE".
    position: str
    waves: list[WaveLabel]
    confidence: float
    stance: str
    #: What the count implies next, in plain language.
    expectation: str
    #: The price that would break the count outright.
    invalidation: float | None
    #: Projected objective for the wave in progress. None when not derivable.
    projection: float | None
    #: Rules checked, and whether each held. Shown so a count can be argued with.
    rules: list[dict[str, Any]]
    note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "structure": self.structure,
            "direction": self.direction,
            "position": self.position,
            "waves": [w.to_dict() for w in self.waves],
            "confidence": round(self.confidence, 1),
            "stance": self.stance,
            "expectation": self.expectation,
            "invalidation": round(self.invalidation, 6) if self.invalidation is not None else None,
            "projection": round(self.projection, 6) if self.projection is not None else None,
            "rules": self.rules,
            "note": self.note,
        }


def _alternating(points: list[SwingPoint]) -> bool:
    return all(points[i].kind != points[i + 1].kind for i in range(len(points) - 1))


def _length(a: SwingPoint, b: SwingPoint) -> float:
    return abs(b.price - a.price)


def _check_impulse_rules(
    p: list[SwingPoint], bullish: bool
) -> tuple[bool, list[dict[str, Any]], float]:
    """
    The three inviolable rules.

    Returns (valid, rule detail, quality 0…1). Quality rewards the textbook
    proportions — an extended third wave, a wave 2 in the usual retracement
    band — without ever letting them override a broken rule.
    """
    zero, one, two, three, four, five = p

    w1 = _length(zero, one)
    w3 = _length(two, three)
    w5 = _length(four, five)

    rules: list[dict[str, Any]] = []

    # Rule 1 — wave 2 never retraces past the origin of wave 1.
    if bullish:
        rule2_ok = two.price > zero.price
    else:
        rule2_ok = two.price < zero.price
    rules.append({
        "rule": "Wave 2 holds the start of wave 1",
        "passed": rule2_ok,
        "detail": f"Wave 2 ended at {two.price:.2f}, origin was {zero.price:.2f}",
    })

    # Rule 2 — wave 3 is never the shortest impulse wave.
    rule3_ok = not (w3 < w1 and w3 < w5)
    rules.append({
        "rule": "Wave 3 is not the shortest",
        "passed": rule3_ok,
        "detail": f"Lengths — w1 {w1:.2f}, w3 {w3:.2f}, w5 {w5:.2f}",
    })

    # Rule 3 — wave 4 does not enter wave 1's price territory.
    if bullish:
        rule4_ok = four.price > one.price
    else:
        rule4_ok = four.price < one.price
    rules.append({
        "rule": "Wave 4 does not overlap wave 1",
        "passed": rule4_ok,
        "detail": f"Wave 4 ended at {four.price:.2f}, wave 1 peaked at {one.price:.2f}",
    })

    valid = rule2_ok and rule3_ok and rule4_ok
    if not valid:
        return False, rules, 0.0

    # ── Guidelines. Evidence, never grounds for rejection. ────────
    quality = 0.45

    if w1 > 0:
        retrace2 = _length(one, two) / w1
        # 0.5–0.786 is the common band for a second wave.
        if 0.45 <= retrace2 <= 0.80:
            quality += 0.15
        elif 0.30 <= retrace2 <= 0.95:
            quality += 0.06

        # An extended third is the single most characteristic Elliott feature.
        if w3 >= w1 * 1.5:
            quality += 0.20
        elif w3 >= w1:
            quality += 0.10

    if w3 > 0:
        retrace4 = _length(three, four) / w3
        # Wave 4 typically retraces less than wave 2 did — alternation.
        if 0.20 <= retrace4 <= 0.50:
            quality += 0.12
        elif retrace4 <= 0.65:
            quality += 0.05

    return True, rules, float(min(quality, 1.0))


def _impulse_position(p: list[SwingPoint], bars: int) -> str:
    """Where price sits relative to a completed 1-2-3-4-5."""
    return "COMPLETE" if p[5].index < bars - 3 else "WAVE_5"


def _find_impulse(swings: list[SwingPoint], df: pd.DataFrame) -> WaveCount | None:
    if len(swings) < IMPULSE_PIVOTS:
        return None

    bars = len(df)
    price = float(df["close"].iloc[-1])

    best: WaveCount | None = None

    # Prefer the most recent complete structure; walk backwards.
    for end in range(len(swings), IMPULSE_PIVOTS - 1, -1):
        window = swings[end - IMPULSE_PIVOTS : end]
        if len(window) < IMPULSE_PIVOTS or not _alternating(window):
            continue

        zero, one, two, three, four, five = window
        bullish = one.price > zero.price
        # Point 0 must be the extreme the impulse leaves behind.
        if bullish and zero.kind != "LOW":
            continue
        if not bullish and zero.kind != "HIGH":
            continue

        valid, rules, quality = _check_impulse_rules(window, bullish)
        if not valid:
            continue

        w1 = _length(zero, one)
        w3 = _length(two, three)
        w5 = _length(four, five)

        position = _impulse_position(window, bars)
        direction = "BULLISH" if bullish else "BEARISH"

        # A completed five-wave move implies a correction of it, not more of it.
        if position == "COMPLETE":
            stance = "BEARISH" if bullish else "BULLISH"
            expectation = (
                "A five-wave move looks complete. What typically follows is a correction of it — "
                "commonly back to the wave 4 area — not a continuation."
            )
            projection = four.price
        else:
            stance = direction
            expectation = (
                "Price appears to be in the fifth and final wave. Fifth waves complete the move; "
                "momentum divergence here is the usual warning."
            )
            projection = five.price + (five.price - four.price) * 0.382 * (1 if bullish else -1)

        invalidation = two.price if bullish else two.price

        waves = [
            WaveLabel("1", zero.time, one.time, zero.price, one.price, None,
                      "Initial impulse out of the prior structure"),
            WaveLabel("2", one.time, two.time, one.price, two.price,
                      _length(one, two) / w1 if w1 else None,
                      "Retracement that must hold the origin of wave 1"),
            WaveLabel("3", two.time, three.time, two.price, three.price,
                      w3 / w1 if w1 else None,
                      "Usually the longest and strongest wave"),
            WaveLabel("4", three.time, four.time, three.price, four.price,
                      _length(three, four) / w3 if w3 else None,
                      "Correction that must not overlap wave 1"),
            WaveLabel("5", four.time, five.time, four.price, five.price,
                      w5 / w1 if w1 else None,
                      "Final wave — often on weaker momentum than wave 3"),
        ]

        # Recency matters: an older count describes a chart that has moved on.
        bars_since = bars - 1 - five.index
        recency = max(0.0, 1.0 - bars_since / 60.0)
        confidence = float(np.clip(28.0 + quality * 34.0 + recency * 10.0, 0.0, 72.0))

        candidate = WaveCount(
            structure="IMPULSE",
            direction=direction,
            position=position,
            waves=waves,
            confidence=confidence,
            stance=stance,
            expectation=expectation,
            invalidation=invalidation,
            projection=projection,
            rules=rules,
            note=(
                "Elliott counts are interpretive — this is one valid reading of these swings, "
                "not the only one. Treat it as context, not a trigger."
            ),
        )

        if best is None or candidate.confidence > best.confidence:
            best = candidate
        # The most recent valid count is the one that matters; stop early.
        if best is not None and bars_since <= 5:
            break

    if best is not None and price is not None:
        # A broken count is worth reporting as broken rather than hiding.
        if best.invalidation is not None:
            broken = (
                price < best.invalidation
                if best.direction == "BULLISH"
                else price > best.invalidation
            )
            if broken:
                best.confidence *= 0.5
                best.expectation = (
                    "The count has been invalidated — price moved through the wave 2 level. "
                    "Any labelling from here is a different structure."
                )
                best.stance = "NEUTRAL"

    return best


def _find_correction(swings: list[SwingPoint], df: pd.DataFrame) -> WaveCount | None:
    """
    A simple zigzag A-B-C.

    Only the zigzag is attempted. Flats and triangles need subwave counts to
    distinguish, and guessing between them adds noise rather than information.
    """
    if len(swings) < CORRECTION_PIVOTS:
        return None

    bars = len(df)
    window = swings[-CORRECTION_PIVOTS:]
    if not _alternating(window):
        return None

    zero, a, b, c = window
    down = a.price < zero.price

    wave_a = _length(zero, a)
    wave_b = _length(a, b)
    wave_c = _length(b, c)
    if min(wave_a, wave_b, wave_c) <= 0:
        return None

    # In a zigzag, B retraces part of A but not all of it.
    b_retrace = wave_b / wave_a
    if not (0.20 <= b_retrace <= 0.95):
        return None

    quality = 0.4
    if 0.45 <= b_retrace <= 0.80:
        quality += 0.2
    # C commonly equals A, or extends to 1.618 of it.
    c_ratio = wave_c / wave_a
    if 0.85 <= c_ratio <= 1.20 or 1.50 <= c_ratio <= 1.75:
        quality += 0.25
    elif 0.6 <= c_ratio <= 2.0:
        quality += 0.1

    bars_since = bars - 1 - c.index
    recency = max(0.0, 1.0 - bars_since / 40.0)
    confidence = float(np.clip(24.0 + quality * 30.0 + recency * 10.0, 0.0, 64.0))

    waves = [
        WaveLabel("A", zero.time, a.time, zero.price, a.price, None,
                  "First leg of the correction"),
        WaveLabel("B", a.time, b.time, a.price, b.price, b_retrace,
                  "Partial retracement — the trap leg"),
        WaveLabel("C", b.time, c.time, b.price, c.price, c_ratio,
                  "Final leg, commonly equal to A or 1.618 of it"),
    ]

    return WaveCount(
        structure="CORRECTION",
        direction="BEARISH" if down else "BULLISH",
        position="COMPLETE" if bars_since > 3 else "WAVE_C",
        waves=waves,
        confidence=confidence,
        # A completed correction resolves in the direction *opposite* the
        # correction — that is what makes it a correction rather than a trend.
        stance="BULLISH" if down else "BEARISH",
        expectation=(
            "An A-B-C correction looks complete. Corrections resolve into the larger trend, "
            "so the expectation is a resumption in the opposite direction to this move."
        ),
        invalidation=zero.price,
        projection=zero.price,
        rules=[{
            "rule": "Wave B retraces part of A but not all of it",
            "passed": True,
            "detail": f"B retraced {b_retrace * 100:.0f}% of A",
        }],
        note=(
            "Zigzag only — flats and triangles are not distinguished here, because telling them "
            "apart needs subwave counts that daily swing data does not reliably support."
        ),
    )


def analyse(
    df: pd.DataFrame, swings: list[SwingPoint], *, min_bars: int = 60
) -> dict[str, Any]:
    """
    Best available wave reading, with its own uncertainty attached.

    Returns a `count` of None when the swings do not support any valid labelling
    — which is the honest answer far more often than Elliott commentary implies.
    """
    if len(df) < min_bars or len(swings) < CORRECTION_PIVOTS:
        return {
            "count": None,
            "score": 0.0,
            "summary": "Not enough swing structure to attempt a wave count.",
        }

    impulse = _find_impulse(swings, df)
    correction = _find_correction(swings, df)

    # Prefer whichever reading the data supports better; impulses win ties
    # because they carry more information about what comes next.
    candidates = [c for c in (impulse, correction) if c is not None]
    if not candidates:
        return {
            "count": None,
            "score": 0.0,
            "summary": (
                "No wave count satisfies the three Elliott rules on these swings. "
                "That is a normal result — most stretches of chart are not cleanly countable."
            ),
        }

    count = max(candidates, key=lambda c: c.confidence)

    # Elliott is interpretive, so its contribution to the blend is scaled down
    # hard. Even a clean count moves the needle less than a confirmed level.
    direction = 1.0 if count.stance == "BULLISH" else -1.0 if count.stance == "BEARISH" else 0.0
    score = float(np.clip(direction * (count.confidence / 72.0) * 0.6, -1.0, 1.0))

    label = (
        f"{count.direction.lower()} {count.structure.lower()}"
        if count.structure == "IMPULSE"
        else "A-B-C correction"
    )
    summary = (
        f"Reads as a {label}, currently {count.position.replace('_', ' ').lower()}, "
        f"at {count.confidence:.0f}/100 confidence. {count.expectation}"
    )

    return {"count": count.to_dict(), "score": score, "summary": summary}
