"""
Price action analysis.

Breakouts, breakdowns, pullbacks, retests and range behaviour — read from the
relationship between price, the level structure and volume, rather than from
indicators.

Spec: docs/trading-concepts.md §2, §7.1.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from .structure import (
    Level,
    SwingPoint,
    detect_channel,
    fit_trendlines,
    level_proximity,
    nearest_levels,
)


def _ts(df: pd.DataFrame, i: int) -> int:
    if isinstance(df.index, pd.DatetimeIndex):
        return int(df.index[i].timestamp())
    return int(i)


def detect_events(
    df: pd.DataFrame,
    levels: list[Level],
    *,
    atr_value: float,
    lookback: int = 20,
) -> list[dict[str, Any]]:
    """
    Recent structural events.

    A breakout requires a **close** beyond the level, not a wick — the single
    most important filter here. Wick-based detection produces a stream of
    breakouts that immediately fail, which is how price-action systems earn
    their reputation for whipsaw.
    """
    events: list[dict[str, Any]] = []
    if not levels or atr_value <= 0 or len(df) < 5:
        return events

    n = len(df)
    start = max(1, n - lookback)
    closes = df["close"].to_numpy(dtype=float)
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    volumes = df["volume"].to_numpy(dtype=float)
    avg_vol = float(np.mean(volumes[-20:])) if volumes.size >= 20 and np.mean(volumes[-20:]) > 0 else 0.0

    for lv in levels:
        for i in range(start, n):
            prev_close, close = closes[i - 1], closes[i]
            vol_ratio = volumes[i] / avg_vol if avg_vol > 0 else 1.0

            crossed_up = prev_close <= lv.price < close
            crossed_down = prev_close >= lv.price > close

            if not (crossed_up or crossed_down):
                continue

            # Require the close to clear the level by a margin, so a level
            # brushed by a fraction of a tick doesn't register.
            margin = abs(close - lv.price) / atr_value
            if margin < 0.1:
                continue

            bullish = crossed_up
            kind = "BREAKOUT" if bullish else "BREAKDOWN"

            # Volume is what separates a real break from a drift through.
            confidence = float(np.clip(
                45 + lv.strength * 0.3 + min(vol_ratio, 3.0) * 12 + min(margin, 1.5) * 8,
                30, 95,
            ))

            note = (
                f"Closed {'above' if bullish else 'below'} {lv.kind.lower()} at {lv.price:.2f} "
                f"on {vol_ratio:.1f}× average volume."
            )
            if vol_ratio < 1.0:
                note += " Volume did not expand, which weakens the break."

            events.append({
                "type": kind,
                "stance": "BULLISH" if bullish else "BEARISH",
                "price": float(lv.price),
                "time": _ts(df, i),
                "confidence": confidence,
                "note": note,
            })

            # A retest is the strongest confirmation available: break, come
            # back, hold. Look for it in the bars after the break.
            for j in range(i + 1, min(i + 8, n)):
                touched = lows[j] <= lv.price <= highs[j]
                held = closes[j] > lv.price if bullish else closes[j] < lv.price
                if touched and held:
                    events.append({
                        "type": "RETEST",
                        "stance": "BULLISH" if bullish else "BEARISH",
                        "price": float(lv.price),
                        "time": _ts(df, j),
                        "confidence": float(np.clip(confidence + 10, 30, 96)),
                        "note": (
                            f"Retested {lv.price:.2f} from {'above' if bullish else 'below'} and held — "
                            "polarity flip confirmed."
                        ),
                    })
                    break

    events.sort(key=lambda e: e["time"], reverse=True)
    return events[:8]


def detect_pullback(
    df: pd.DataFrame,
    indicators: dict[str, pd.Series],
    trend_direction: str,
    *,
    atr_value: float,
) -> dict[str, Any] | None:
    """
    Is price pulling back into a moving average inside an established trend?

    The highest-quality entry in trend-following, because risk is defined by the
    structure being pulled back into. Only meaningful when a trend actually
    exists — in a range this is just noise around the mean.
    """
    if trend_direction == "SIDEWAYS" or atr_value <= 0 or len(df) < 25:
        return None

    close = float(df["close"].iloc[-1])
    ema20 = indicators.get("ema_20")
    ema50 = indicators.get("ema_50")
    if ema20 is None or ema20.dropna().empty:
        return None

    ema20_v = float(ema20.dropna().iloc[-1])
    ema50_v = float(ema50.dropna().iloc[-1]) if ema50 is not None and not ema50.dropna().empty else ema20_v

    recent = df.iloc[-12:]
    swing_high = float(recent["high"].max())
    swing_low = float(recent["low"].min())
    leg = swing_high - swing_low
    if leg <= 0:
        return None

    if trend_direction == "UPTREND":
        distance = (close - ema20_v) / atr_value
        retrace = (swing_high - close) / leg
        # Near or just below the 20 EMA, having given back a healthy but not
        # excessive share of the leg.
        if -0.4 <= distance <= 0.8 and 0.2 <= retrace <= 0.65:
            return {
                "type": "PULLBACK",
                "stance": "BULLISH",
                "price": close,
                "time": _ts(df, len(df) - 1),
                "confidence": float(np.clip(70 - abs(retrace - 0.45) * 60, 40, 85)),
                "note": (
                    f"Pullback into the 20 EMA ({ema20_v:.2f}) within an uptrend, "
                    f"retracing {retrace:.0%} of the last leg. 50 EMA support sits at {ema50_v:.2f}."
                ),
            }

    if trend_direction == "DOWNTREND":
        distance = (ema20_v - close) / atr_value
        retrace = (close - swing_low) / leg
        if -0.4 <= distance <= 0.8 and 0.2 <= retrace <= 0.65:
            return {
                "type": "PULLBACK",
                "stance": "BEARISH",
                "price": close,
                "time": _ts(df, len(df) - 1),
                "confidence": float(np.clip(70 - abs(retrace - 0.45) * 60, 40, 85)),
                "note": (
                    f"Rally into the 20 EMA ({ema20_v:.2f}) within a downtrend, "
                    f"retracing {retrace:.0%} of the last leg."
                ),
            }

    return None


def analyse(
    df: pd.DataFrame,
    swings: list[SwingPoint],
    levels: list[Level],
    indicators: dict[str, pd.Series],
    *,
    atr_value: float,
    trend_direction: str,
    timeframe: str = "1D",
) -> dict[str, Any]:
    """Full price-action read, plus a −1…+1 score for the factor engine."""
    price = float(df["close"].iloc[-1])

    events = detect_events(df, levels, atr_value=atr_value)
    pullback = detect_pullback(df, indicators, trend_direction, atr_value=atr_value)
    if pullback:
        events.insert(0, pullback)

    trendlines = fit_trendlines(df, swings, atr_value=atr_value)
    channel = detect_channel(df, swings)
    support, resistance = nearest_levels(levels, price)
    proximity = level_proximity(levels, price, atr_value)

    # ── Score ────────────────────────────────────────────────────
    score = 0.0
    notes: list[str] = []

    # Recent events decay — a breakout 15 bars ago is history, not a signal.
    now_time = _ts(df, len(df) - 1)
    bar_seconds = max(1, (now_time - _ts(df, max(0, len(df) - 2))) or 1)

    for ev in events[:4]:
        age_bars = max(0, (now_time - ev["time"]) / bar_seconds)
        decay = float(np.exp(-age_bars / 6.0))
        direction = 1.0 if ev["stance"] == "BULLISH" else -1.0
        weight = {"RETEST": 0.4, "BREAKOUT": 0.35, "BREAKDOWN": 0.35, "PULLBACK": 0.3}.get(ev["type"], 0.2)
        score += direction * weight * (ev["confidence"] / 100.0) * decay
        if decay > 0.4:
            notes.append(ev["note"])

    # Room to run. Price pinned under strong resistance is a poor long even if
    # everything else agrees.
    if resistance and support:
        to_res = (resistance.price - price) / price * 100.0
        to_sup = (price - support.price) / price * 100.0
        if to_res + to_sup > 0:
            # Positive when there's more room above than below.
            balance = (to_res - to_sup) / (to_res + to_sup)
            score += balance * 0.22
            notes.append(
                f"Nearest resistance {resistance.price:.2f} ({to_res:+.1f}%), "
                f"nearest support {support.price:.2f} (−{to_sup:.1f}%)."
            )

    if proximity["near"] and proximity["level"] is not None:
        lv: Level = proximity["level"]
        if lv.kind == "SUPPORT" and proximity["side"] == "ABOVE":
            score += 0.15
            notes.append(f"Sitting on support at {lv.price:.2f} (strength {lv.strength:.0f}/100).")
        elif lv.kind == "RESISTANCE" and proximity["side"] == "BELOW":
            score -= 0.15
            notes.append(f"Capped by resistance at {lv.price:.2f} (strength {lv.strength:.0f}/100).")

    for tl in trendlines:
        if not tl.intact:
            direction = -1.0 if tl.kind == "SUPPORT" else 1.0
            score += direction * 0.18
            notes.append(f"{tl.kind.capitalize()} trendline has been broken.")

    if channel:
        pos = channel["positionPercent"]
        if pos > 85:
            score -= 0.1
            notes.append(f"At the top of its regression channel ({pos:.0f}%).")
        elif pos < 15:
            score += 0.1
            notes.append(f"At the bottom of its regression channel ({pos:.0f}%).")

    score = float(np.clip(score, -1.0, 1.0))

    return {
        "levels": [lv.to_dict() for lv in levels],
        "events": events,
        "trendlines": [t.to_dict() for t in trendlines],
        "channel": channel,
        "score": score,
        "notes": notes,
        "nearestSupport": support.to_dict() if support else None,
        "nearestResistance": resistance.to_dict() if resistance else None,
        "summary": (
            " ".join(f"{n}" for n in notes[:3])
            if notes
            else "Price is mid-structure with no active breakout or pullback."
        ),
    }
