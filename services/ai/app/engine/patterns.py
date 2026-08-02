"""
Chart pattern detection.

Found geometrically from the fractal swing series, then filtered on symmetry,
duration and volume signature.

Two design choices worth stating, because they're what separate this from
pattern detectors that look prescient in backtests and useless live:

1. **Forming patterns are reported.** Most implementations only emit patterns
   after the neckline breaks, which is exactly when the information is already
   in the price. Status is one of FORMING / CONFIRMED / FAILED and all three are
   returned.
2. **Confidence is geometric fit, not probability of success.** A 90-confidence
   head & shoulders means "this is unambiguously the shape", not "this will work
   90% of the time". Probability comes from the calibration layer, which
   measures. Conflating the two is how pattern trading gets oversold.

Spec: docs/trading-concepts.md §5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .structure import SwingPoint

MIN_PATTERN_BARS = 12
MAX_PATTERN_BARS = 160


@dataclass
class ChartPattern:
    kind: str
    name: str
    stance: str
    confidence: float
    start_time: int
    end_time: int
    neckline: float | None
    target: float | None
    invalidation: float | None
    status: str
    note: str
    points: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "stance": self.stance,
            "confidence": round(self.confidence, 1),
            "startTime": self.start_time,
            "endTime": self.end_time,
            "neckline": round(self.neckline, 6) if self.neckline is not None else None,
            "target": round(self.target, 6) if self.target is not None else None,
            "invalidation": round(self.invalidation, 6) if self.invalidation is not None else None,
            "status": self.status,
            "note": self.note,
            "points": self.points,
        }


def _pct_diff(a: float, b: float) -> float:
    """Symmetric percentage difference between two prices."""
    denom = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denom * 100.0


def _point(sp: SwingPoint, label: str) -> dict[str, Any]:
    return {"time": sp.time, "price": round(sp.price, 6), "label": label}


def _status(price: float, neckline: float, bullish: bool, invalidation: float) -> str:
    if bullish:
        if price > neckline:
            return "CONFIRMED"
        if price < invalidation:
            return "FAILED"
    else:
        if price < neckline:
            return "CONFIRMED"
        if price > invalidation:
            return "FAILED"
    return "FORMING"


# ─────────────────────────────────────────────────────────────────
#  Double top / bottom
# ─────────────────────────────────────────────────────────────────


def _double_patterns(df: pd.DataFrame, swings: list[SwingPoint], price: float) -> list[ChartPattern]:
    out: list[ChartPattern] = []
    highs = [s for s in swings if s.kind == "HIGH"]
    lows = [s for s in swings if s.kind == "LOW"]

    # Double top: two highs within 3%, with a trough between them.
    for a, b in zip(highs, highs[1:]):
        span = b.index - a.index
        if not (MIN_PATTERN_BARS <= span <= MAX_PATTERN_BARS):
            continue
        symmetry = _pct_diff(a.price, b.price)
        if symmetry > 3.0:
            continue

        between = [lo for lo in lows if a.index < lo.index < b.index]
        if not between:
            continue
        trough = min(between, key=lambda s: s.price)

        # The dip between the peaks must be meaningful, else it's one broad top.
        depth = (a.price - trough.price) / a.price * 100.0
        if depth < 3.0:
            continue

        neckline = trough.price
        height = ((a.price + b.price) / 2.0) - neckline
        invalidation = max(a.price, b.price)

        out.append(
            ChartPattern(
                kind="DOUBLE_TOP",
                name="Double Top",
                stance="BEARISH",
                confidence=float(np.clip(88 - symmetry * 9 - max(0, 6 - depth) * 3, 40, 92)),
                start_time=a.time,
                end_time=b.time,
                neckline=neckline,
                target=neckline - height,
                invalidation=invalidation,
                status=_status(price, neckline, bullish=False, invalidation=invalidation),
                note=(
                    f"Two peaks within {symmetry:.1f}% of each other with a {depth:.1f}% trough between. "
                    f"A close below {neckline:.2f} confirms; measured move targets {neckline - height:.2f}."
                ),
                points=[_point(a, "First peak"), _point(trough, "Neckline"), _point(b, "Second peak")],
            )
        )

    # Double bottom — mirror.
    for a, b in zip(lows, lows[1:]):
        span = b.index - a.index
        if not (MIN_PATTERN_BARS <= span <= MAX_PATTERN_BARS):
            continue
        symmetry = _pct_diff(a.price, b.price)
        if symmetry > 3.0:
            continue

        between = [hi for hi in highs if a.index < hi.index < b.index]
        if not between:
            continue
        peak = max(between, key=lambda s: s.price)

        height_pct = (peak.price - a.price) / max(a.price, 1e-9) * 100.0
        if height_pct < 3.0:
            continue

        neckline = peak.price
        height = neckline - ((a.price + b.price) / 2.0)
        invalidation = min(a.price, b.price)

        out.append(
            ChartPattern(
                kind="DOUBLE_BOTTOM",
                name="Double Bottom",
                stance="BULLISH",
                confidence=float(np.clip(88 - symmetry * 9 - max(0, 6 - height_pct) * 3, 40, 92)),
                start_time=a.time,
                end_time=b.time,
                neckline=neckline,
                target=neckline + height,
                invalidation=invalidation,
                status=_status(price, neckline, bullish=True, invalidation=invalidation),
                note=(
                    f"Two troughs within {symmetry:.1f}% of each other. "
                    f"A close above {neckline:.2f} confirms; measured move targets {neckline + height:.2f}."
                ),
                points=[_point(a, "First trough"), _point(peak, "Neckline"), _point(b, "Second trough")],
            )
        )

    return out


# ─────────────────────────────────────────────────────────────────
#  Head & shoulders
# ─────────────────────────────────────────────────────────────────


def _head_shoulders(
    df: pd.DataFrame, swings: list[SwingPoint], price: float
) -> list[ChartPattern]:
    out: list[ChartPattern] = []
    highs = [s for s in swings if s.kind == "HIGH"]
    lows = [s for s in swings if s.kind == "LOW"]

    for i in range(len(highs) - 2):
        ls, head, rs = highs[i], highs[i + 1], highs[i + 2]
        if not (MIN_PATTERN_BARS <= rs.index - ls.index <= MAX_PATTERN_BARS):
            continue

        # Head must clear both shoulders by a real margin.
        if not (head.price > ls.price * 1.02 and head.price > rs.price * 1.02):
            continue
        shoulder_sym = _pct_diff(ls.price, rs.price)
        if shoulder_sym > 6.0:
            continue

        troughs = [lo for lo in lows if ls.index < lo.index < rs.index]
        if len(troughs) < 2:
            continue
        neckline = float(np.mean([t.price for t in troughs[:2]]))
        height = head.price - neckline
        if height <= 0:
            continue

        # Textbook H&S shows volume declining into the right shoulder.
        vol = df["volume"].to_numpy(dtype=float)
        volume_ok = True
        if vol.sum() > 0 and rs.index < len(vol):
            left_vol = vol[max(0, ls.index - 2) : ls.index + 3].mean()
            right_vol = vol[max(0, rs.index - 2) : rs.index + 3].mean()
            volume_ok = right_vol <= left_vol * 1.15

        confidence = 86 - shoulder_sym * 5 + (5 if volume_ok else -10)

        out.append(
            ChartPattern(
                kind="HEAD_SHOULDERS",
                name="Head & Shoulders",
                stance="BEARISH",
                confidence=float(np.clip(confidence, 40, 92)),
                start_time=ls.time,
                end_time=rs.time,
                neckline=neckline,
                target=neckline - height,
                invalidation=head.price,
                status=_status(price, neckline, bullish=False, invalidation=head.price),
                note=(
                    f"Shoulders within {shoulder_sym:.1f}%, head {(head.price / neckline - 1) * 100:.1f}% above the neckline. "
                    + ("Volume declined into the right shoulder, as expected. " if volume_ok else "Volume did not decline into the right shoulder, which weakens the pattern. ")
                    + f"Close below {neckline:.2f} confirms."
                ),
                points=[
                    _point(ls, "Left shoulder"),
                    _point(head, "Head"),
                    _point(rs, "Right shoulder"),
                ],
            )
        )

    # Inverse — mirror on lows.
    for i in range(len(lows) - 2):
        ls, head, rs = lows[i], lows[i + 1], lows[i + 2]
        if not (MIN_PATTERN_BARS <= rs.index - ls.index <= MAX_PATTERN_BARS):
            continue
        if not (head.price < ls.price * 0.98 and head.price < rs.price * 0.98):
            continue
        shoulder_sym = _pct_diff(ls.price, rs.price)
        if shoulder_sym > 6.0:
            continue

        peaks = [hi for hi in highs if ls.index < hi.index < rs.index]
        if len(peaks) < 2:
            continue
        neckline = float(np.mean([p.price for p in peaks[:2]]))
        height = neckline - head.price
        if height <= 0:
            continue

        out.append(
            ChartPattern(
                kind="INVERSE_HEAD_SHOULDERS",
                name="Inverse Head & Shoulders",
                stance="BULLISH",
                confidence=float(np.clip(86 - shoulder_sym * 5, 40, 92)),
                start_time=ls.time,
                end_time=rs.time,
                neckline=neckline,
                target=neckline + height,
                invalidation=head.price,
                status=_status(price, neckline, bullish=True, invalidation=head.price),
                note=(
                    f"Shoulders within {shoulder_sym:.1f}% of each other. "
                    f"Close above {neckline:.2f} confirms; measured move targets {neckline + height:.2f}."
                ),
                points=[
                    _point(ls, "Left shoulder"),
                    _point(head, "Head"),
                    _point(rs, "Right shoulder"),
                ],
            )
        )

    return out


# ─────────────────────────────────────────────────────────────────
#  Triangles, wedges, rectangles
# ─────────────────────────────────────────────────────────────────


def _converging(
    df: pd.DataFrame, swings: list[SwingPoint], price: float, atr_value: float
) -> list[ChartPattern]:
    """Triangles, wedges and rectangles — all read from two converging or parallel boundaries."""
    out: list[ChartPattern] = []
    highs = [s for s in swings if s.kind == "HIGH"][-4:]
    lows = [s for s in swings if s.kind == "LOW"][-4:]

    if len(highs) < 2 or len(lows) < 2:
        return out

    h1, h2 = highs[-2], highs[-1]
    l1, l2 = lows[-2], lows[-1]

    start_idx = min(h1.index, l1.index)
    end_idx = max(h2.index, l2.index)
    span = end_idx - start_idx
    if not (MIN_PATTERN_BARS <= span <= MAX_PATTERN_BARS):
        return out

    upper_slope = (h2.price - h1.price) / max(h2.index - h1.index, 1)
    lower_slope = (l2.price - l1.price) / max(l2.index - l1.index, 1)

    # Normalise slopes against ATR so "flat" means the same thing on any
    # instrument — a 5-rupee drift is flat for a ₹3,000 stock and a trend for a
    # ₹40 one.
    flat = atr_value * 0.06
    upper_flat = abs(upper_slope) < flat
    lower_flat = abs(lower_slope) < flat

    height = ((h1.price + h2.price) / 2.0) - ((l1.price + l2.price) / 2.0)
    if height <= 0:
        return out

    start_time, end_time = min(h1.time, l1.time), max(h2.time, l2.time)
    points = [
        _point(h1, "Upper 1"), _point(h2, "Upper 2"),
        _point(l1, "Lower 1"), _point(l2, "Lower 2"),
    ]

    def add(kind: str, name: str, stance: str, neckline: float, target: float, invalid: float, note: str, conf: float) -> None:
        out.append(
            ChartPattern(
                kind=kind, name=name, stance=stance, confidence=float(np.clip(conf, 40, 88)),
                start_time=start_time, end_time=end_time, neckline=neckline, target=target,
                invalidation=invalid,
                status=_status(price, neckline, bullish=(stance == "BULLISH"), invalidation=invalid),
                note=note, points=points,
            )
        )

    resistance = max(h1.price, h2.price)
    support = min(l1.price, l2.price)

    if upper_flat and lower_slope > flat:
        add(
            "ASCENDING_TRIANGLE", "Ascending Triangle", "BULLISH",
            resistance, resistance + height, support,
            f"Flat resistance near {resistance:.2f} with rising lows — buyers paying up. "
            f"Close above {resistance:.2f} targets {resistance + height:.2f}.", 78,
        )
    elif lower_flat and upper_slope < -flat:
        add(
            "DESCENDING_TRIANGLE", "Descending Triangle", "BEARISH",
            support, support - height, resistance,
            f"Flat support near {support:.2f} with falling highs — sellers accepting less. "
            f"Close below {support:.2f} targets {support - height:.2f}.", 78,
        )
    elif upper_slope < -flat and lower_slope > flat:
        # Symmetrical triangle — direction unknown until it breaks. Reported as
        # neutral rather than guessed, because guessing is where these go wrong.
        add(
            "SYMMETRICAL_TRIANGLE", "Symmetrical Triangle", "NEUTRAL",
            resistance, resistance + height, support,
            f"Converging boundaries between {support:.2f} and {resistance:.2f}. "
            "Direction is undecided — trade the break, not the anticipation.", 68,
        )
    elif upper_slope > flat and lower_slope > flat and upper_slope < lower_slope:
        add(
            "RISING_WEDGE", "Rising Wedge", "BEARISH",
            support, support - height, resistance,
            f"Both boundaries rising but converging — momentum fading into the advance. "
            f"Close below {support:.2f} targets {support - height:.2f}.", 72,
        )
    elif upper_slope < -flat and lower_slope < -flat and upper_slope > lower_slope:
        add(
            "FALLING_WEDGE", "Falling Wedge", "BULLISH",
            resistance, resistance + height, support,
            f"Both boundaries falling but converging — selling pressure easing. "
            f"Close above {resistance:.2f} targets {resistance + height:.2f}.", 72,
        )
    elif upper_flat and lower_flat:
        add(
            "RECTANGLE", "Rectangle", "NEUTRAL",
            resistance, resistance + height, support,
            f"Horizontal range between {support:.2f} and {resistance:.2f}. "
            "Range-trade the edges or wait for the break.", 70,
        )

    return out


# ─────────────────────────────────────────────────────────────────
#  Flags & pennants
# ─────────────────────────────────────────────────────────────────


def _flags(df: pd.DataFrame, price: float, atr_value: float) -> list[ChartPattern]:
    """
    A sharp impulse (the pole) followed by a shallow counter-trend drift.

    Detected on raw bars rather than swings — flags are short and often don't
    produce enough fractal points to be seen structurally.
    """
    out: list[ChartPattern] = []
    n = len(df)
    if n < 30 or atr_value <= 0:
        return out

    closes = df["close"].to_numpy(dtype=float)
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)

    for pole_len in (8, 12, 16):
        for flag_len in (5, 8, 12):
            total = pole_len + flag_len
            if n < total + 2:
                continue

            pole_start = n - total
            pole_end = pole_start + pole_len

            pole_move = closes[pole_end - 1] - closes[pole_start]
            if abs(pole_move) < atr_value * 3.0:
                continue

            flag = slice(pole_end, n)
            flag_high, flag_low = highs[flag].max(), lows[flag].min()
            flag_range = flag_high - flag_low

            # The consolidation must be shallow relative to the pole — a deep
            # retrace is a reversal, not a flag.
            if flag_range > abs(pole_move) * 0.5:
                continue

            retrace = abs(closes[-1] - closes[pole_end - 1]) / abs(pole_move)
            if retrace > 0.55:
                continue

            bullish = pole_move > 0
            neckline = flag_high if bullish else flag_low
            target = neckline + pole_move
            invalid = flag_low if bullish else flag_high

            # A pennant converges; a flag drifts in a channel.
            first_half = flag_range
            is_pennant = (
                highs[pole_end : pole_end + flag_len // 2].max()
                - lows[pole_end : pole_end + flag_len // 2].min()
            ) > first_half * 1.25

            kind = "PENNANT" if is_pennant else ("BULL_FLAG" if bullish else "BEAR_FLAG")
            name = "Pennant" if is_pennant else ("Bull Flag" if bullish else "Bear Flag")

            out.append(
                ChartPattern(
                    kind=kind,
                    name=name,
                    stance="BULLISH" if bullish else "BEARISH",
                    confidence=float(np.clip(74 - retrace * 30, 45, 84)),
                    start_time=int(df.index[pole_start].timestamp()) if isinstance(df.index, pd.DatetimeIndex) else pole_start,
                    end_time=int(df.index[-1].timestamp()) if isinstance(df.index, pd.DatetimeIndex) else n - 1,
                    neckline=float(neckline),
                    target=float(target),
                    invalidation=float(invalid),
                    status=_status(price, float(neckline), bullish, float(invalid)),
                    note=(
                        f"{abs(pole_move) / atr_value:.1f}× ATR pole followed by a {retrace:.0%} consolidation. "
                        f"Break of {neckline:.2f} projects {target:.2f}."
                    ),
                    points=[],
                )
            )
            return out  # one flag is enough; the tightest match wins

    return out


# ─────────────────────────────────────────────────────────────────
#  Cup & handle
# ─────────────────────────────────────────────────────────────────


def _cup_handle(df: pd.DataFrame, swings: list[SwingPoint], price: float) -> list[ChartPattern]:
    lows = [s for s in swings if s.kind == "LOW"]
    highs = [s for s in swings if s.kind == "HIGH"]
    if len(lows) < 1 or len(highs) < 2:
        return []

    left, right = highs[-2], highs[-1]
    if not (25 <= right.index - left.index <= MAX_PATTERN_BARS):
        return []
    if _pct_diff(left.price, right.price) > 5.0:
        return []

    cup_lows = [lo for lo in lows if left.index < lo.index < right.index]
    if not cup_lows:
        return []
    bottom = min(cup_lows, key=lambda s: s.price)

    depth = (left.price - bottom.price) / left.price
    # A proper cup is a rounded 12–50% base. Deeper is a crash, shallower is noise.
    if not (0.12 <= depth <= 0.50):
        return []

    # The bottom should sit near the middle — a V is not a cup.
    centre = (bottom.index - left.index) / max(right.index - left.index, 1)
    if not (0.3 <= centre <= 0.7):
        return []

    neckline = max(left.price, right.price)
    height = neckline - bottom.price

    return [
        ChartPattern(
            kind="CUP_HANDLE",
            name="Cup & Handle",
            stance="BULLISH",
            confidence=float(np.clip(76 - abs(centre - 0.5) * 60, 45, 86)),
            start_time=left.time,
            end_time=right.time,
            neckline=neckline,
            target=neckline + height,
            invalidation=bottom.price,
            status=_status(price, neckline, bullish=True, invalidation=bottom.price),
            note=(
                f"Rounded {depth:.0%} base with the low near the midpoint. "
                f"Close above {neckline:.2f} targets {neckline + height:.2f}."
            ),
            points=[_point(left, "Left rim"), _point(bottom, "Cup base"), _point(right, "Right rim")],
        )
    ]


# ─────────────────────────────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────────────────────────────


def detect(
    df: pd.DataFrame, swings: list[SwingPoint], *, atr_value: float, limit: int = 5
) -> list[ChartPattern]:
    """All chart patterns present, most confident first."""
    if len(df) < MIN_PATTERN_BARS + 5:
        return []

    price = float(df["close"].iloc[-1])
    found: list[ChartPattern] = []
    found += _double_patterns(df, swings, price)
    found += _head_shoulders(df, swings, price)
    found += _converging(df, swings, price, atr_value)
    found += _flags(df, price, atr_value)
    found += _cup_handle(df, swings, price)

    # Failed patterns are informative but shouldn't crowd out live ones.
    found.sort(key=lambda p: (p.status == "FAILED", -p.confidence, -p.end_time))
    return found[:limit]


def pattern_score(patterns: list[ChartPattern]) -> float:
    """
    Collapse to a −1…+1 evidence value.

    Confirmed patterns count fully, forming ones at 45% (the shape exists but the
    market hasn't agreed yet), failed ones invert — a failed bullish pattern is
    genuine bearish information.
    """
    if not patterns:
        return 0.0

    total = 0.0
    weight = 0.0
    for p in patterns:
        if p.stance == "NEUTRAL":
            continue
        direction = 1.0 if p.stance == "BULLISH" else -1.0
        if p.status == "CONFIRMED":
            mult = 1.0
        elif p.status == "FORMING":
            mult = 0.45
        else:
            mult, direction = 0.6, -direction
        contribution = (p.confidence / 92.0) * direction * mult
        total += contribution
        weight += mult

    if weight == 0:
        return 0.0
    return float(np.clip(total / weight, -1.0, 1.0))
