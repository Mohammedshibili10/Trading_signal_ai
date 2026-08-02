"""
Candlestick pattern recognition.

Two things make this different from the usual implementation:

1. **Base reliabilities come from measurement, not folklore.** Bulkowski's
   testing across 103 patterns found most single-candle patterns resolve at
   52–56% — statistically indistinguishable from a coin flip — and that the
   hanging man resolves as a bullish *continuation* ~59% of the time, i.e. the
   opposite of what every textbook says. Where measurement and tradition
   disagree, measurement wins here.

2. **Context multiplies.** A hammer at tested support in a downtrend on 2×
   volume is evidence. The same hammer floating mid-range is noise. The raw
   pattern score is multiplied by trend, location, volume and range factors
   before it counts for anything.

See docs/trading-concepts.md §4.3.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
import pandas as pd

from .anatomy import CandleAnatomy

# ─────────────────────────────────────────────────────────────────
#  Measured base reliabilities
# ─────────────────────────────────────────────────────────────────
#  Percentage of the time the pattern resolved in the stated direction in
#  Bulkowski's testing. Anything at or below ~56 is close enough to random that
#  it must not carry a signal on its own — those entries are here so the UI can
#  *name* what it sees while the engine correctly refuses to act on it.

BASE_RELIABILITY: dict[str, float] = {
    # Strong, multi-bar, well-evidenced
    "THREE_WHITE_SOLDIERS": 82.0,
    "THREE_BLACK_CROWS": 78.0,
    "MORNING_STAR": 72.0,
    "EVENING_STAR": 71.0,
    "THREE_INSIDE_UP": 65.0,
    "THREE_INSIDE_DOWN": 64.0,
    "THREE_OUTSIDE_UP": 67.0,
    "THREE_OUTSIDE_DOWN": 66.0,
    # Two-bar reversals — real but context-dependent
    "BULLISH_ENGULFING": 63.0,
    "BEARISH_ENGULFING": 62.0,
    "PIERCING_LINE": 61.0,
    "DARK_CLOUD_COVER": 60.0,
    "TWEEZER_BOTTOM": 58.0,
    "TWEEZER_TOP": 57.0,
    "BULLISH_HARAMI": 56.0,
    "BEARISH_HARAMI": 55.0,
    # Single-bar — weak on their own
    "HAMMER": 59.0,
    "INVERTED_HAMMER": 57.0,
    "SHOOTING_STAR": 59.0,
    "MARUBOZU_BULL": 56.0,
    "MARUBOZU_BEAR": 55.0,
    "DRAGONFLY_DOJI": 54.0,
    "GRAVESTONE_DOJI": 54.0,
    "DOJI": 50.0,
    "LONG_LEGGED_DOJI": 51.0,
    "SPINNING_TOP": 50.0,
    # Measured behaviour contradicts the textbook. The hanging man is
    # traditionally taught as a bearish reversal; it tested as a bullish
    # continuation ~59% of the time. Recorded as measured, with the stance
    # below set to match.
    "HANGING_MAN": 59.0,
}

#: Direction the pattern actually resolved in, per the same testing.
#: HANGING_MAN is BULLISH here on purpose — see above.
BASE_STANCE: dict[str, str] = {
    "THREE_WHITE_SOLDIERS": "BULLISH",
    "THREE_BLACK_CROWS": "BEARISH",
    "MORNING_STAR": "BULLISH",
    "EVENING_STAR": "BEARISH",
    "THREE_INSIDE_UP": "BULLISH",
    "THREE_INSIDE_DOWN": "BEARISH",
    "THREE_OUTSIDE_UP": "BULLISH",
    "THREE_OUTSIDE_DOWN": "BEARISH",
    "BULLISH_ENGULFING": "BULLISH",
    "BEARISH_ENGULFING": "BEARISH",
    "PIERCING_LINE": "BULLISH",
    "DARK_CLOUD_COVER": "BEARISH",
    "TWEEZER_BOTTOM": "BULLISH",
    "TWEEZER_TOP": "BEARISH",
    "BULLISH_HARAMI": "BULLISH",
    "BEARISH_HARAMI": "BEARISH",
    "HAMMER": "BULLISH",
    "INVERTED_HAMMER": "BULLISH",
    "SHOOTING_STAR": "BEARISH",
    "HANGING_MAN": "BULLISH",
    "MARUBOZU_BULL": "BULLISH",
    "MARUBOZU_BEAR": "BEARISH",
    "DRAGONFLY_DOJI": "BULLISH",
    "GRAVESTONE_DOJI": "BEARISH",
    "DOJI": "NEUTRAL",
    "LONG_LEGGED_DOJI": "NEUTRAL",
    "SPINNING_TOP": "NEUTRAL",
}

DISPLAY_NAME: dict[str, str] = {
    "THREE_WHITE_SOLDIERS": "Three White Soldiers",
    "THREE_BLACK_CROWS": "Three Black Crows",
    "MORNING_STAR": "Morning Star",
    "EVENING_STAR": "Evening Star",
    "THREE_INSIDE_UP": "Three Inside Up",
    "THREE_INSIDE_DOWN": "Three Inside Down",
    "THREE_OUTSIDE_UP": "Three Outside Up",
    "THREE_OUTSIDE_DOWN": "Three Outside Down",
    "BULLISH_ENGULFING": "Bullish Engulfing",
    "BEARISH_ENGULFING": "Bearish Engulfing",
    "PIERCING_LINE": "Piercing Line",
    "DARK_CLOUD_COVER": "Dark Cloud Cover",
    "TWEEZER_BOTTOM": "Tweezer Bottom",
    "TWEEZER_TOP": "Tweezer Top",
    "BULLISH_HARAMI": "Bullish Harami",
    "BEARISH_HARAMI": "Bearish Harami",
    "HAMMER": "Hammer",
    "INVERTED_HAMMER": "Inverted Hammer",
    "SHOOTING_STAR": "Shooting Star",
    "HANGING_MAN": "Hanging Man",
    "MARUBOZU_BULL": "Bullish Marubozu",
    "MARUBOZU_BEAR": "Bearish Marubozu",
    "DRAGONFLY_DOJI": "Dragonfly Doji",
    "GRAVESTONE_DOJI": "Gravestone Doji",
    "DOJI": "Doji",
    "LONG_LEGGED_DOJI": "Long-Legged Doji",
    "SPINNING_TOP": "Spinning Top",
}

NOTES: dict[str, str] = {
    "HANGING_MAN": (
        "Traditionally read as a bearish reversal, but measured performance has it "
        "resolving upward about 59% of the time. Scored on the measured behaviour."
    ),
    "DOJI": "Indecision only. Carries no direction without confirmation from the next bar.",
    "SPINNING_TOP": "Balance between buyers and sellers. Informative only at an extreme.",
    "THREE_WHITE_SOLDIERS": "One of the most reliable patterns tested — ~82% bullish resolution.",
    "THREE_BLACK_CROWS": "Strong bearish reversal — ~78% in testing. Best after an extended advance.",
}


@dataclass
class DetectedPattern:
    kind: str
    name: str
    stance: str
    time: int
    bars: int
    base_reliability: float
    reliability: float
    note: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "stance": self.stance,
            "time": self.time,
            "bars": self.bars,
            "baseReliability": round(self.base_reliability, 1),
            "reliability": round(self.reliability, 1),
            "note": self.note,
        }


# ─────────────────────────────────────────────────────────────────
#  Shape predicates
# ─────────────────────────────────────────────────────────────────

Bar = pd.Series


def _o(b: Bar) -> float: return float(b["open"])
def _h(b: Bar) -> float: return float(b["high"])
def _l(b: Bar) -> float: return float(b["low"])
def _c(b: Bar) -> float: return float(b["close"])


def _rng(b: Bar) -> float:
    return max(_h(b) - _l(b), 1e-12)


def _body(b: Bar) -> float:
    return abs(_c(b) - _o(b))


def _body_pct(b: Bar) -> float:
    return _body(b) / _rng(b)


def _upper(b: Bar) -> float:
    return _h(b) - max(_o(b), _c(b))


def _lower(b: Bar) -> float:
    return min(_o(b), _c(b)) - _l(b)


def _bull(b: Bar) -> bool:
    return _c(b) > _o(b)


def _bear(b: Bar) -> bool:
    return _c(b) < _o(b)


def _mid(b: Bar) -> float:
    return (_o(b) + _c(b)) / 2.0


# Each detector receives the recent window (oldest→newest, current bar last).

def _hammer_family(w: list[Bar]) -> str | None:
    """Hammer / hanging man / inverted hammer / shooting star share a shape."""
    b = w[-1]
    body_pct = _body_pct(b)
    lower_pct = _lower(b) / _rng(b)
    upper_pct = _upper(b) / _rng(b)

    if body_pct > 0.35:
        return None

    # Long lower wick, minimal upper.
    if lower_pct >= 0.55 and upper_pct <= 0.15:
        # Prior direction decides which of the two names applies. Both are the
        # same shape; only the preceding trend differs.
        return "HAMMER" if _prior_down(w) else "HANGING_MAN"

    # Long upper wick, minimal lower.
    if upper_pct >= 0.55 and lower_pct <= 0.15:
        return "INVERTED_HAMMER" if _prior_down(w) else "SHOOTING_STAR"

    return None


def _prior_down(w: list[Bar]) -> bool:
    """Was the run into this bar downward? Uses the 3 bars before it."""
    if len(w) < 4:
        return False
    closes = [_c(b) for b in w[-4:-1]]
    return closes[-1] < closes[0]


def _doji_family(w: list[Bar]) -> str | None:
    b = w[-1]
    if _body_pct(b) > 0.08:
        return None
    upper_pct = _upper(b) / _rng(b)
    lower_pct = _lower(b) / _rng(b)
    if lower_pct >= 0.65:
        return "DRAGONFLY_DOJI"
    if upper_pct >= 0.65:
        return "GRAVESTONE_DOJI"
    if upper_pct >= 0.35 and lower_pct >= 0.35:
        return "LONG_LEGGED_DOJI"
    return "DOJI"


def _spinning_top(w: list[Bar]) -> str | None:
    b = w[-1]
    bp = _body_pct(b)
    if 0.08 < bp <= 0.3 and _upper(b) / _rng(b) >= 0.25 and _lower(b) / _rng(b) >= 0.25:
        return "SPINNING_TOP"
    return None


def _marubozu(w: list[Bar]) -> str | None:
    b = w[-1]
    if _body_pct(b) < 0.9:
        return None
    return "MARUBOZU_BULL" if _bull(b) else "MARUBOZU_BEAR"


def _engulfing(w: list[Bar]) -> str | None:
    if len(w) < 2:
        return None
    prev, cur = w[-2], w[-1]
    # Real-body engulfing; the prior body must be meaningful, otherwise every
    # doji followed by a normal bar registers as a reversal.
    if _body_pct(prev) < 0.1:
        return None
    if _bear(prev) and _bull(cur) and _c(cur) > _o(prev) and _o(cur) < _c(prev):
        return "BULLISH_ENGULFING"
    if _bull(prev) and _bear(cur) and _c(cur) < _o(prev) and _o(cur) > _c(prev):
        return "BEARISH_ENGULFING"
    return None


def _harami(w: list[Bar]) -> str | None:
    if len(w) < 2:
        return None
    prev, cur = w[-2], w[-1]
    if _body_pct(prev) < 0.5:
        return None
    prev_top, prev_bot = max(_o(prev), _c(prev)), min(_o(prev), _c(prev))
    cur_top, cur_bot = max(_o(cur), _c(cur)), min(_o(cur), _c(cur))
    if not (cur_top < prev_top and cur_bot > prev_bot):
        return None
    return "BULLISH_HARAMI" if _bear(prev) else "BEARISH_HARAMI"


def _piercing_dark_cloud(w: list[Bar]) -> str | None:
    if len(w) < 2:
        return None
    prev, cur = w[-2], w[-1]
    if _body_pct(prev) < 0.5:
        return None
    prev_mid = _mid(prev)
    # Piercing: gap down open, close back above the midpoint of the prior body.
    if _bear(prev) and _bull(cur) and _o(cur) < _l(prev) and _c(cur) > prev_mid and _c(cur) < _o(prev):
        return "PIERCING_LINE"
    if _bull(prev) and _bear(cur) and _o(cur) > _h(prev) and _c(cur) < prev_mid and _c(cur) > _o(prev):
        return "DARK_CLOUD_COVER"
    return None


def _star(w: list[Bar]) -> str | None:
    """Morning / evening star — three bars with a small-bodied middle."""
    if len(w) < 3:
        return None
    a, b, c = w[-3], w[-2], w[-1]
    if _body_pct(b) > 0.35:
        return None
    if _body_pct(a) < 0.45 or _body_pct(c) < 0.45:
        return None
    a_mid = _mid(a)
    if _bear(a) and _bull(c) and _c(c) > a_mid and max(_o(b), _c(b)) < _c(a) * 1.005:
        return "MORNING_STAR"
    if _bull(a) and _bear(c) and _c(c) < a_mid and min(_o(b), _c(b)) > _c(a) * 0.995:
        return "EVENING_STAR"
    return None


def _three_soldiers_crows(w: list[Bar]) -> str | None:
    if len(w) < 3:
        return None
    a, b, c = w[-3], w[-2], w[-1]
    bodies = [_body_pct(x) for x in (a, b, c)]
    if min(bodies) < 0.5:
        return None

    if all(_bull(x) for x in (a, b, c)):
        # Progressively higher closes, each opening inside the prior body —
        # without that constraint three unrelated green bars qualify.
        if _c(a) < _c(b) < _c(c) and _o(b) > _o(a) and _o(c) > _o(b):
            if _o(b) < _c(a) and _o(c) < _c(b):
                return "THREE_WHITE_SOLDIERS"

    if all(_bear(x) for x in (a, b, c)):
        if _c(a) > _c(b) > _c(c) and _o(b) < _o(a) and _o(c) < _o(b):
            if _o(b) > _c(a) and _o(c) > _c(b):
                return "THREE_BLACK_CROWS"

    return None


def _three_inside_outside(w: list[Bar]) -> str | None:
    if len(w) < 3:
        return None
    a, b, c = w[-3], w[-2], w[-1]

    inside = _harami([a, b])
    if inside == "BULLISH_HARAMI" and _bull(c) and _c(c) > _h(b):
        return "THREE_INSIDE_UP"
    if inside == "BEARISH_HARAMI" and _bear(c) and _c(c) < _l(b):
        return "THREE_INSIDE_DOWN"

    eng = _engulfing([a, b])
    if eng == "BULLISH_ENGULFING" and _bull(c) and _c(c) > _c(b):
        return "THREE_OUTSIDE_UP"
    if eng == "BEARISH_ENGULFING" and _bear(c) and _c(c) < _c(b):
        return "THREE_OUTSIDE_DOWN"

    return None


def _tweezer(w: list[Bar]) -> str | None:
    if len(w) < 2:
        return None
    prev, cur = w[-2], w[-1]
    tol = 0.0015  # 0.15% — tweezers are about matching extremes, not exactness
    if abs(_l(prev) - _l(cur)) / max(_l(cur), 1e-9) < tol and _bear(prev) and _bull(cur):
        return "TWEEZER_BOTTOM"
    if abs(_h(prev) - _h(cur)) / max(_h(cur), 1e-9) < tol and _bull(prev) and _bear(cur):
        return "TWEEZER_TOP"
    return None


#: Ordered most-specific first — a three-bar pattern should win over the
#: single-bar shape that forms its final candle.
DETECTORS: list[tuple[Callable[[list[Bar]], str | None], int]] = [
    (_three_soldiers_crows, 3),
    (_three_inside_outside, 3),
    (_star, 3),
    (_engulfing, 2),
    (_piercing_dark_cloud, 2),
    (_harami, 2),
    (_tweezer, 2),
    (_marubozu, 1),
    (_hammer_family, 1),
    (_doji_family, 1),
    (_spinning_top, 1),
]


# ─────────────────────────────────────────────────────────────────
#  Context adjustment
# ─────────────────────────────────────────────────────────────────


def context_multiplier(
    *,
    stance: str,
    trend_direction: str,
    near_level: bool,
    level_side_agrees: bool,
    volume_ratio: float,
    range_vs_atr: float,
) -> tuple[float, list[str]]:
    """
    Turn a raw pattern into contextual evidence.

    Returns the multiplier and the reasons it was applied, so the UI can show
    *why* the same pattern scored differently on two charts.
    """
    reasons: list[str] = []
    mult = 1.0

    # A reversal pattern matters when it appears against an established trend;
    # a continuation-shaped bar matters when it agrees with one.
    if stance == "BULLISH" and trend_direction == "DOWNTREND":
        mult *= 1.25
        reasons.append("appeared against a downtrend, where reversals carry more weight")
    elif stance == "BEARISH" and trend_direction == "UPTREND":
        mult *= 1.25
        reasons.append("appeared against an uptrend, where reversals carry more weight")
    elif stance == "BULLISH" and trend_direction == "UPTREND":
        mult *= 0.85
        reasons.append("continuation within an existing uptrend")
    elif stance == "BEARISH" and trend_direction == "DOWNTREND":
        mult *= 0.85
        reasons.append("continuation within an existing downtrend")
    else:
        mult *= 0.7
        reasons.append("formed in a sideways market, which weakens it")

    # Location does most of the work. A hammer at tested support is a different
    # object from a hammer in the middle of a range.
    if near_level and level_side_agrees:
        mult *= 1.35
        reasons.append("formed at a tested level in the direction it implies")
    elif near_level:
        mult *= 1.05
        reasons.append("formed near a tested level")
    else:
        mult *= 0.75
        reasons.append("formed away from any tested level")

    if volume_ratio >= 2.0:
        mult *= 1.25
        reasons.append(f"volume {volume_ratio:.1f}× average confirms participation")
    elif volume_ratio >= 1.3:
        mult *= 1.1
    elif volume_ratio <= 0.6:
        mult *= 0.8
        reasons.append("thin volume — little conviction behind it")

    if range_vs_atr >= 1.5:
        mult *= 1.15
        reasons.append("wide-range bar relative to recent volatility")
    elif range_vs_atr <= 0.5:
        mult *= 0.85

    return float(np.clip(mult, 0.35, 2.0)), reasons


def detect(
    df: pd.DataFrame,
    *,
    index: int | None = None,
    trend_direction: str = "SIDEWAYS",
    near_level: bool = False,
    level_side_agrees: bool = False,
    anatomy: CandleAnatomy | None = None,
) -> list[DetectedPattern]:
    """
    Patterns completing at ``index`` (default: the last bar).

    Returns at most one pattern per bar-count so a three-bar pattern and the
    one-bar shape inside it don't double-count. Ordered by adjusted reliability.
    """
    idx = len(df) - 1 if index is None else index
    if idx < 0 or idx >= len(df):
        return []

    window_start = max(0, idx - 4)
    window = [df.iloc[i] for i in range(window_start, idx + 1)]

    volume_ratio = anatomy.volume_ratio if anatomy else 1.0
    range_vs_atr = anatomy.range_vs_atr if anatomy else 1.0

    found: list[DetectedPattern] = []
    seen_bars: set[int] = set()

    for detector, bars in DETECTORS:
        if len(window) < bars or bars in seen_bars:
            continue
        kind = detector(window)
        if not kind:
            continue
        seen_bars.add(bars)

        stance = BASE_STANCE.get(kind, "NEUTRAL")
        base = BASE_RELIABILITY.get(kind, 50.0)

        mult, reasons = context_multiplier(
            stance=stance,
            trend_direction=trend_direction,
            near_level=near_level,
            level_side_agrees=level_side_agrees,
            volume_ratio=volume_ratio,
            range_vs_atr=range_vs_atr,
        )

        # Anchor the adjustment on the *edge* over random (base − 50) rather
        # than the raw percentage, so context can never manufacture an edge from
        # a pattern that has none. A 50% pattern stays 50% however good the
        # setup looks.
        edge = (base - 50.0) * mult
        adjusted = float(np.clip(50.0 + edge, 30.0, 92.0))

        note = NOTES.get(kind, "")
        context_note = "; ".join(reasons[:2])
        full_note = f"{note} {context_note.capitalize()}." if note else f"{context_note.capitalize()}."

        found.append(
            DetectedPattern(
                kind=kind,
                name=DISPLAY_NAME.get(kind, kind.replace("_", " ").title()),
                stance=stance,
                time=int(df.index[idx].timestamp()) if isinstance(df.index, pd.DatetimeIndex) else idx,
                bars=bars,
                base_reliability=base,
                reliability=adjusted,
                note=full_note.strip(),
            )
        )

    found.sort(key=lambda p: p.reliability, reverse=True)
    return found


def pattern_score(patterns: list[DetectedPattern]) -> float:
    """
    Collapse detected patterns into a single −1…+1 evidence value.

    Scaled from the edge over random, so a 50% pattern contributes exactly zero
    no matter how many of them stack up. Multi-bar patterns count more than the
    single-bar shapes inside them.
    """
    if not patterns:
        return 0.0

    total = 0.0
    weight_sum = 0.0
    for p in patterns:
        if p.stance == "NEUTRAL":
            continue
        edge = (p.reliability - 50.0) / 42.0  # 92 → ~1.0
        direction = 1.0 if p.stance == "BULLISH" else -1.0
        w = 1.0 + 0.4 * (p.bars - 1)  # 3-bar patterns weigh 1.8× a 1-bar
        total += edge * direction * w
        weight_sum += w

    if weight_sum == 0:
        return 0.0
    return float(np.clip(total / weight_sum, -1.0, 1.0))


def detect_recent(
    df: pd.DataFrame,
    indicators: dict[str, pd.Series],
    *,
    lookback: int = 40,
    trend_direction: str = "SIDEWAYS",
) -> list[DetectedPattern]:
    """Scan the last ``lookback`` bars, newest first. Used by the chart overlay."""
    from .anatomy import analyse_candle

    out: list[DetectedPattern] = []
    start = max(2, len(df) - lookback)
    for i in range(start, len(df)):
        a = analyse_candle(
            df,
            i,
            atr_series=indicators.get("atr"),
            volume_sma=indicators.get("volume_sma_20"),
            ema20=indicators.get("ema_20"),
            vwap_series=indicators.get("vwap"),
        )
        out.extend(
            detect(df, index=i, trend_direction=trend_direction, anatomy=a)
        )
    out.reverse()
    return out
