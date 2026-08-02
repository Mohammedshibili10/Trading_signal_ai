"""
Harmonic pattern detection.

Five-point XABCD structures whose legs sit at specific Fibonacci ratios of one
another. The pattern is only interesting because of where it *completes* — point
D is a defined entry with a defined invalidation just beyond X, which is what
makes these tradeable rather than decorative.

Two decisions shape this module:

**Tolerance is a band, not a point.** A Gartley wants B at 0.618 of XA. Real
swings land at 0.61 or 0.63, and demanding 0.618 exactly finds nothing on real
data. Each ratio therefore has a min/max window, and how *centred* the actual
ratio sits inside that window feeds the confidence score. A pattern hitting
every ratio dead-on scores materially higher than one scraping the edges.

**Confidence is capped well below certainty.** Published win rates for harmonic
patterns cluster in the 55–65% range under favourable conditions, and that is
before accounting for the discretion in picking which swings count. Scoring one
at 90 would be dishonest, so the cap here is 78 and most complete patterns land
in the 50s and 60s — consistent with how the rest of this engine treats
pattern evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .structure import SwingPoint

#: Minimum bars a pattern may span. Below this the "swings" are noise.
MIN_SPAN_BARS = 12
#: Maximum bars, so a five-point shape isn't stitched across unrelated regimes.
MAX_SPAN_BARS = 220


@dataclass(frozen=True)
class RatioSpec:
    """One Fibonacci constraint: a leg, measured against another leg."""

    label: str
    low: float
    high: float

    @property
    def ideal(self) -> float:
        return (self.low + self.high) / 2

    def score(self, actual: float) -> float | None:
        """
        0…1 for how well `actual` fits, or None if outside the window.

        1.0 is dead centre, falling linearly to 0.35 at either edge — the edge
        floor exists because a pattern at the boundary is still a pattern, just
        a weaker one.
        """
        if not (self.low <= actual <= self.high):
            return None
        half = (self.high - self.low) / 2
        if half <= 0:
            return 1.0
        offset = abs(actual - self.ideal) / half
        return float(1.0 - 0.65 * offset)


@dataclass(frozen=True)
class HarmonicSpec:
    """
    A named harmonic, defined by its four ratio constraints.

    Ratios are: AB as a retracement of XA, BC of AB, CD of BC, and AD of XA.
    The AD constraint is what actually separates the family members — Gartley
    completes inside XA at 0.786, while a Crab overshoots it to 1.618.
    """

    name: str
    kind: str
    ab_xa: RatioSpec
    bc_ab: RatioSpec
    cd_bc: RatioSpec
    ad_xa: RatioSpec
    note: str


#: Windows are drawn from the commonly published definitions, widened enough to
#: survive real swing data. Where sources disagree the wider reading is used —
#: a missed pattern is invisible, a slightly loose one is at least reviewable.
SPECS: tuple[HarmonicSpec, ...] = (
    HarmonicSpec(
        name="Gartley",
        kind="GARTLEY",
        ab_xa=RatioSpec("AB/XA", 0.55, 0.70),
        bc_ab=RatioSpec("BC/AB", 0.35, 0.90),
        cd_bc=RatioSpec("CD/BC", 1.10, 1.75),
        ad_xa=RatioSpec("AD/XA", 0.72, 0.85),
        note="Completes inside the XA leg — the most conservative of the family.",
    ),
    HarmonicSpec(
        name="Bat",
        kind="BAT",
        ab_xa=RatioSpec("AB/XA", 0.36, 0.55),
        bc_ab=RatioSpec("BC/AB", 0.35, 0.90),
        cd_bc=RatioSpec("CD/BC", 1.55, 2.80),
        ad_xa=RatioSpec("AD/XA", 0.84, 0.92),
        note="Deep completion at 0.886 of XA with a tight stop just beyond X.",
    ),
    HarmonicSpec(
        name="Butterfly",
        kind="BUTTERFLY",
        ab_xa=RatioSpec("AB/XA", 0.72, 0.85),
        bc_ab=RatioSpec("BC/AB", 0.35, 0.90),
        cd_bc=RatioSpec("CD/BC", 1.55, 2.30),
        ad_xa=RatioSpec("AD/XA", 1.20, 1.45),
        note="Extends beyond X — an exhaustion pattern, not a retracement.",
    ),
    HarmonicSpec(
        name="Crab",
        kind="CRAB",
        ab_xa=RatioSpec("AB/XA", 0.36, 0.65),
        bc_ab=RatioSpec("BC/AB", 0.35, 0.90),
        cd_bc=RatioSpec("CD/BC", 2.20, 3.90),
        ad_xa=RatioSpec("AD/XA", 1.55, 1.70),
        note="The deepest extension at 1.618 of XA — widest stop, largest target.",
    ),
    HarmonicSpec(
        name="Shark",
        kind="SHARK",
        ab_xa=RatioSpec("AB/XA", 0.38, 0.78),
        bc_ab=RatioSpec("BC/AB", 1.10, 1.65),
        cd_bc=RatioSpec("CD/BC", 1.55, 2.30),
        ad_xa=RatioSpec("AD/XA", 0.86, 1.14),
        note="BC overshoots B — the impulsive member of the family.",
    ),
    HarmonicSpec(
        name="Cypher",
        kind="CYPHER",
        ab_xa=RatioSpec("AB/XA", 0.36, 0.65),
        bc_ab=RatioSpec("BC/AB", 1.12, 1.45),
        cd_bc=RatioSpec("CD/BC", 0.70, 0.82),
        ad_xa=RatioSpec("AD/XA", 0.75, 0.82),
        note="CD measured against XC rather than BC — completes at 0.786.",
    ),
)


@dataclass
class HarmonicPattern:
    name: str
    kind: str
    stance: str  # BULLISH | BEARISH
    confidence: float
    status: str  # FORMING | COMPLETE | INVALIDATED
    start_time: int
    end_time: int
    #: Point D — where the pattern says to act.
    completion: float
    #: Just beyond X. Breaching it means the structure failed, not retraced.
    invalidation: float
    #: Retracements of the CD leg, the conventional harmonic targets.
    targets: list[float]
    points: list[dict[str, Any]]
    ratios: list[dict[str, Any]]
    note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "stance": self.stance,
            "confidence": round(self.confidence, 1),
            "status": self.status,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "completion": round(self.completion, 6),
            "invalidation": round(self.invalidation, 6),
            "targets": [round(t, 6) for t in self.targets],
            "points": self.points,
            "ratios": self.ratios,
            "note": self.note,
        }


def _leg(a: float, b: float) -> float:
    return abs(b - a)


def _alternating(points: list[SwingPoint]) -> bool:
    """XABCD must alternate high/low — anything else isn't a zigzag."""
    return all(points[i].kind != points[i + 1].kind for i in range(len(points) - 1))


def _evaluate(
    spec: HarmonicSpec,
    x: SwingPoint,
    a: SwingPoint,
    b: SwingPoint,
    c: SwingPoint,
    d: SwingPoint,
) -> tuple[float, list[dict[str, Any]]] | None:
    """Score one candidate against one spec. None when any ratio is out of band."""
    xa = _leg(x.price, a.price)
    ab = _leg(a.price, b.price)
    bc = _leg(b.price, c.price)
    cd = _leg(c.price, d.price)
    ad = _leg(a.price, d.price)

    if min(xa, ab, bc, cd) <= 0:
        return None

    # The Cypher measures its final leg from X→C rather than B→C. Encoding that
    # as a special case is uglier than a general rule but honest — it is what
    # the pattern's definition actually says.
    cd_reference = _leg(x.price, c.price) if spec.kind == "CYPHER" else bc
    if cd_reference <= 0:
        return None

    measured = (
        (spec.ab_xa, ab / xa),
        (spec.bc_ab, bc / ab),
        (spec.cd_bc, cd / cd_reference),
        (spec.ad_xa, ad / xa),
    )

    scores: list[float] = []
    detail: list[dict[str, Any]] = []

    for constraint, actual in measured:
        score = constraint.score(actual)
        if score is None:
            return None
        scores.append(score)
        detail.append({
            "label": constraint.label,
            "actual": round(actual, 4),
            "ideal": round(constraint.ideal, 4),
            "window": [constraint.low, constraint.high],
        })

    return float(np.mean(scores)), detail


def _confidence(fit: float, span: int, d_index: int, bars: int) -> float:
    """
    Turn a ratio fit into a score.

    Two adjustments beyond the raw fit: patterns spanning very few bars are
    discounted because their swings are least reliable, and a completion that
    happened long ago is discounted because price has had time to move on
    without honouring it.
    """
    base = 34.0 + fit * 40.0  # 34…74 before adjustments

    if span < 25:
        base -= 6.0
    elif span > 140:
        base -= 3.0

    bars_since = bars - 1 - d_index
    if bars_since > 15:
        base -= min(12.0, (bars_since - 15) * 0.5)

    return float(np.clip(base, 0.0, 78.0))


def detect(
    df: pd.DataFrame,
    swings: list[SwingPoint],
    *,
    atr_value: float,
    limit: int = 3,
) -> list[HarmonicPattern]:
    """
    Every harmonic present in the recent swing sequence, best fit first.

    Only the most recent completions are considered — a Gartley that completed
    two hundred bars ago is history, not a setup. Candidates are taken from the
    tail of the swing list and scored against every spec; the best-scoring spec
    per candidate wins so a single shape cannot be reported as three patterns.
    """
    if len(swings) < 5 or len(df) < MIN_SPAN_BARS + 5:
        return []

    price = float(df["close"].iloc[-1])
    bars = len(df)
    found: list[HarmonicPattern] = []

    # Walk the most recent windows of five alternating swings.
    for end in range(len(swings), 4, -1):
        window = swings[end - 5 : end]
        if len(window) < 5 or not _alternating(window):
            continue

        x, a, b, c, d = window
        span = d.index - x.index
        if not (MIN_SPAN_BARS <= span <= MAX_SPAN_BARS):
            continue

        # A bullish harmonic completes at a low: X high → A low → … → D low.
        bullish = d.kind == "LOW"

        best: tuple[float, list[dict[str, Any]], HarmonicSpec] | None = None
        for spec in SPECS:
            result = _evaluate(spec, x, a, b, c, d)
            if result is None:
                continue
            fit, detail = result
            if best is None or fit > best[0]:
                best = (fit, detail, spec)

        if best is None:
            continue

        fit, detail, spec = best

        # Invalidation sits just beyond X — the structural claim of every
        # harmonic is that D holds and X is never revisited.
        buffer = max(atr_value * 0.35, abs(x.price) * 0.001)
        invalidation = x.price - buffer if bullish else x.price + buffer

        if bullish:
            status = "INVALIDATED" if price < invalidation else "COMPLETE"
        else:
            status = "INVALIDATED" if price > invalidation else "COMPLETE"

        # Still forming if price hasn't reached the D projection yet.
        if d.index >= bars - 2 and status == "COMPLETE":
            status = "FORMING"

        cd_leg = _leg(c.price, d.price)
        direction = 1.0 if bullish else -1.0
        targets = [d.price + direction * cd_leg * r for r in (0.382, 0.618, 1.0)]

        found.append(
            HarmonicPattern(
                name=f"{'Bullish' if bullish else 'Bearish'} {spec.name}",
                kind=spec.kind,
                stance="BULLISH" if bullish else "BEARISH",
                confidence=_confidence(fit, span, d.index, bars),
                status=status,
                start_time=x.time,
                end_time=d.time,
                completion=d.price,
                invalidation=invalidation,
                targets=targets,
                points=[
                    {"time": p.time, "price": round(p.price, 6), "label": label}
                    for p, label in zip(window, "XABCD")
                ],
                ratios=detail,
                note=spec.note,
            )
        )

        # Overlapping windows describe the same shape; two reports is plenty.
        if len(found) >= limit + 2:
            break

    found.sort(key=lambda p: (p.status == "INVALIDATED", -p.confidence))
    return found[:limit]


def harmonic_score(patterns: list[HarmonicPattern]) -> float:
    """
    Collapse to a −1…+1 evidence value for the factor blend.

    Forming patterns count for less than complete ones — the shape existing is
    not the same as price arriving at D. Invalidated patterns are dropped
    rather than inverted: unlike a failed head-and-shoulders, a broken harmonic
    says the measurement was wrong, not that the opposite is true.
    """
    live = [p for p in patterns if p.status != "INVALIDATED"]
    if not live:
        return 0.0

    total = 0.0
    weight = 0.0
    for p in live:
        direction = 1.0 if p.stance == "BULLISH" else -1.0
        mult = 1.0 if p.status == "COMPLETE" else 0.5
        total += (p.confidence / 78.0) * direction * mult
        weight += mult

    return float(np.clip(total / weight, -1.0, 1.0)) if weight else 0.0
