"""
Order flow, from real taker-side volume.

Every Binance kline carries the volume executed by aggressive buyers and the
number of trades that made up the bar. Those two fields answer a question OHLCV
cannot: *who was crossing the spread?*

A bar that closes green because buyers lifted offers and a bar that closes green
because sellers stopped pressing look identical on a chart. The first is demand,
the second is a vacuum, and they resolve differently. Delta separates them.

Four things are derived here:

**Delta** — `(takerBuy − takerSell) / volume`, per bar. Positive means aggressive
buying dominated. This is the raw signal and it is measured, not inferred.

**Cumulative delta** — delta summed over a window. Its *divergence* from price is
the useful part: price making higher highs while cumulative delta makes lower
highs means the advance is being sold into, which is the classic distribution
signature and is invisible on price alone.

**Average trade size** — `volume / trades`. A bar of 500 BTC in 200 trades is
very different from 500 BTC in 20,000 trades. The first is size participating;
the second is a retail flurry. Volume alone cannot tell them apart.

**Absorption** — large volume with a small resulting range. Someone is filling
against the move rather than chasing it, and the level tends to hold.

This module returns None-ish results for venues that publish no taker data, and
callers drop the factor rather than substituting an estimate. The whole reason
this is worth having is that it is real; a modelled version would carry the
authority of measurement with none of the substance.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

#: Bars used for the cumulative delta window.
CUMULATIVE_WINDOW = 20
#: Volume ratio above which a bar counts as a spike.
SPIKE_RATIO = 2.0
#: Delta magnitude above which one side is clearly dominant.
STRONG_DELTA = 0.20
#: Range-vs-ATR below which a high-volume bar reads as absorption.
ABSORPTION_RANGE = 0.7


def available(candles: list[dict[str, Any]]) -> bool:
    """Whether enough bars carry taker data for any of this to mean anything."""
    if not candles:
        return False
    with_taker = sum(
        1 for c in candles[-CUMULATIVE_WINDOW * 2 :]
        if c.get("takerBuyVolume") is not None and float(c.get("volume") or 0) > 0
    )
    return with_taker >= CUMULATIVE_WINDOW


def _delta(candle: dict[str, Any]) -> float | None:
    """Signed share of the bar executed by aggressive buyers, −1…+1."""
    volume = float(candle.get("volume") or 0.0)
    taker = candle.get("takerBuyVolume")
    if taker is None or volume <= 0:
        return None

    taker_buy = float(taker)
    # (buy − sell) / total, where sell is whatever was not taker-buy.
    return float(np.clip((2.0 * taker_buy - volume) / volume, -1.0, 1.0))


def analyse(
    candles: list[dict[str, Any]],
    *,
    atr_value: float = 0.0,
) -> dict[str, Any]:
    """
    Order flow read for the most recent bar, in the context of the window.

    Returns `available: False` when the venue publishes no taker data, which is
    every venue except Binance in this platform today.
    """
    if not available(candles):
        return {
            "available": False,
            "summary": (
                "This venue does not publish taker-side volume, so order flow cannot be "
                "measured. It is omitted rather than estimated."
            ),
            "score": 0.0,
        }

    recent = candles[-(CUMULATIVE_WINDOW * 2) :]
    deltas = [(c, _delta(c)) for c in recent]
    usable = [(c, d) for c, d in deltas if d is not None]
    if len(usable) < CUMULATIVE_WINDOW:
        return {"available": False, "summary": "Not enough bars with taker data.", "score": 0.0}

    last_candle, last_delta = usable[-1]
    window = usable[-CUMULATIVE_WINDOW:]

    volumes = np.array([float(c.get("volume") or 0.0) for c, _ in window])
    average_volume = float(volumes[:-1].mean()) if len(volumes) > 1 else float(volumes.mean())
    last_volume = float(last_candle.get("volume") or 0.0)
    volume_ratio = last_volume / average_volume if average_volume > 0 else 1.0

    # ── Cumulative delta and its divergence from price ───────────
    cumulative = float(sum(d * float(c.get("volume") or 0.0) for c, d in window))
    total_volume = float(sum(float(c.get("volume") or 0.0) for c, _ in window))
    cumulative_normalised = cumulative / total_volume if total_volume > 0 else 0.0

    closes = np.array([float(c["close"]) for c, _ in window])
    running = np.cumsum([d * float(c.get("volume") or 0.0) for c, d in window])

    divergence = None
    half = len(window) // 2
    if half >= 4:
        price_trend = float(closes[-1] - closes[half])
        delta_trend = float(running[-1] - running[half])
        # Opposite signs with meaningful magnitude on both sides.
        if price_trend > 0 and delta_trend < 0 and abs(delta_trend) > total_volume * 0.02:
            divergence = "BEARISH"
        elif price_trend < 0 and delta_trend > 0 and abs(delta_trend) > total_volume * 0.02:
            divergence = "BULLISH"

    # ── Trade size ───────────────────────────────────────────────
    trades = last_candle.get("trades")
    average_trade_size = None
    size_note = ""
    if trades and float(trades) > 0:
        average_trade_size = last_volume / float(trades)
        window_sizes = [
            float(c.get("volume") or 0.0) / float(c["trades"])
            for c, _ in window
            if c.get("trades") and float(c["trades"]) > 0
        ]
        if len(window_sizes) >= 5:
            median_size = float(np.median(window_sizes))
            if median_size > 0:
                size_ratio = average_trade_size / median_size
                if size_ratio > 1.6:
                    size_note = (
                        f"Average trade size {size_ratio:.1f}× the recent median — larger orders "
                        "than usual are participating."
                    )
                elif size_ratio < 0.6:
                    size_note = (
                        f"Average trade size {size_ratio:.1f}× the median — many small orders, "
                        "which is retail flow rather than size."
                    )

    # ── Absorption ───────────────────────────────────────────────
    absorption = None
    if atr_value > 0 and volume_ratio >= SPIKE_RATIO:
        bar_range = float(last_candle["high"]) - float(last_candle["low"])
        if bar_range / atr_value < ABSORPTION_RANGE:
            absorption = "BULLISH" if last_delta < 0 else "BEARISH"

    # ── Score ────────────────────────────────────────────────────
    # Current delta leads, cumulative provides context, divergence overrides
    # both — a divergence is the one configuration where recent flow is
    # actively misleading about what the larger flow has been doing.
    score = float(np.clip(last_delta * 0.55 + cumulative_normalised * 0.45, -1.0, 1.0))
    if divergence == "BEARISH":
        score = min(score, -0.25)
    elif divergence == "BULLISH":
        score = max(score, 0.25)
    if absorption == "BULLISH":
        score = max(score, 0.20)
    elif absorption == "BEARISH":
        score = min(score, -0.20)

    # Confirmation counts for more when volume was actually there.
    score *= float(np.clip(0.6 + volume_ratio * 0.25, 0.6, 1.15))
    score = float(np.clip(score, -1.0, 1.0))

    notes: list[str] = []
    notes.append(
        f"Bar delta {last_delta * 100:+.0f}% "
        f"({'buyers' if last_delta > 0 else 'sellers'} were the aggressors)"
    )
    notes.append(f"Cumulative delta over {CUMULATIVE_WINDOW} bars {cumulative_normalised * 100:+.0f}%")

    if volume_ratio >= SPIKE_RATIO:
        notes.append(f"Volume spike at {volume_ratio:.1f}× the {CUMULATIVE_WINDOW}-bar average")
    if divergence:
        notes.append(
            f"{divergence.title()} delta divergence — price and aggressive flow are moving apart"
        )
    if absorption:
        notes.append(
            f"Absorption: heavy volume with little range, "
            f"{'buyers absorbing the selling' if absorption == 'BULLISH' else 'sellers absorbing the buying'}"
        )
    if size_note:
        notes.append(size_note)

    return {
        "available": True,
        "delta": round(last_delta, 4),
        "cumulativeDelta": round(cumulative_normalised, 4),
        "volumeRatio": round(volume_ratio, 3),
        "trades": int(trades) if trades else None,
        "averageTradeSize": round(average_trade_size, 6) if average_trade_size else None,
        "divergence": divergence,
        "absorption": absorption,
        "spike": volume_ratio >= SPIKE_RATIO,
        "score": round(score, 4),
        "notes": notes,
        "summary": "; ".join(notes),
    }


def delta_series(candles: list[dict[str, Any]], limit: int = 60) -> list[dict[str, Any]]:
    """Per-bar delta, for plotting under the chart."""
    out: list[dict[str, Any]] = []
    running = 0.0

    for candle in candles[-limit:]:
        value = _delta(candle)
        if value is None:
            continue
        volume = float(candle.get("volume") or 0.0)
        running += value * volume
        out.append({
            "time": int(candle["time"]),
            "delta": round(value, 4),
            "volume": round(volume, 6),
            "cumulative": round(running, 6),
            "trades": int(candle["trades"]) if candle.get("trades") else None,
        })

    return out
