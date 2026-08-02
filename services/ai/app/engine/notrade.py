"""
No-trade zones.

Market states where the honest answer is "not here" regardless of how good the
setup looks. These are distinct from the signal engine's existing WAIT rules,
which reject on the *quality of the setup*; this module rejects on the *state of
the market* — conditions where any setup, however clean, has a materially worse
expectancy than the same setup elsewhere.

The distinction matters because these two failure modes look identical from
inside a scoring function. A textbook flag in dead chop scores exactly like a
textbook flag in a trending market. The pattern is real either way; what changes
is whether the market is in a condition to honour it.

Six zones, each with the reasoning stated:

1. **Chop** — no trend, compressed range. Where accounts bleed by a thousand cuts.
2. **Squeeze** — volatility compressed and about to expand, direction unknown.
   Entering before the expansion is guessing which way the coil unwinds.
3. **Mid-range** — price at the equilibrium of its range, equidistant from both
   boundaries. Nothing to lean on and nowhere sensible to put a stop.
4. **Extreme volatility** — ATR far above normal. Stops must be so wide the
   position size becomes meaningless, or so tight they are noise.
5. **Illiquid** — volume far below normal. Fills are poor and levels are
   unreliable because too few participants set them.
6. **Post-gap uncertainty** — a large unresolved gap. Until it fills or holds,
   prior levels are not levels.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: ADX below this is not a trend, whatever the moving averages suggest.
CHOP_ADX = 18.0
#: Range as a share of ATR below which the market is compressed.
CHOP_RANGE_RATIO = 0.8
#: ATR percentile above which volatility is extreme.
EXTREME_VOL_PERCENTILE = 92.0
#: Volume ratio below which participation is too thin to trust levels.
ILLIQUID_RATIO = 0.45
#: Gap size, in ATR, that leaves prior structure unreliable until resolved.
GAP_ATR = 1.2
#: How close to the middle of the range counts as "no man's land", 0…1.
MIDRANGE_BAND = 0.12


def _zone(key: str, label: str, severity: str, detail: str, guidance: str) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        # BLOCKING stops a signal outright; CAUTION reduces confidence.
        "severity": severity,
        "detail": detail,
        "guidance": guidance,
    }


def _indicator(analysis: dict[str, Any], key: str) -> dict[str, Any] | None:
    """Pull one indicator reading out of the analysis payload."""
    for reading in (analysis.get("technical") or {}).get("indicators") or []:
        if reading.get("key") == key:
            return reading
    return None


def detect(analysis: dict[str, Any]) -> dict[str, Any]:
    """
    Every no-trade condition currently present.

    Takes the completed analysis rather than raw frames — everything needed is
    already in it, and recomputing indicators here would mean two code paths
    that could disagree about the same bar.

    Returns `blocked` when at least one BLOCKING zone is active. Callers should
    treat that as a hard WAIT — not as a confidence reduction, because the whole
    point is that no confidence level makes these conditions tradeable.
    """
    technical = analysis.get("technical") or {}
    regime = technical.get("volatility") or {}
    trend = technical.get("trend") or {}
    volume = technical.get("volume") or {}
    anatomy = analysis.get("candleAnatomy") or {}
    dealing_range = (analysis.get("smc") or {}).get("premiumDiscount") or {}

    price = float(analysis.get("price") or 0.0)
    atr = float(regime.get("atr") or 0.0)
    if price <= 0:
        return {
            "zones": [],
            "blocked": False,
            "confidenceMultiplier": 1.0,
            "summary": "Too little data to assess market state.",
        }

    zones: list[dict[str, Any]] = []

    adx_reading = _indicator(analysis, "adx")
    adx = adx_reading.get("value") if adx_reading else None
    if adx is None:
        # trend.strength is ADX-derived, so it is a faithful stand-in.
        adx = trend.get("strength")

    bollinger = _indicator(analysis, "bollinger")
    squeeze = (bollinger or {}).get("extra", {}).get("squeeze") if bollinger else None

    # ── 1. Chop ──────────────────────────────────────────────────
    range_vs_atr = abs(float(anatomy.get("rangeVsAtr") or 0.0)) if anatomy else 0.0
    direction = trend.get("direction", "SIDEWAYS")

    if adx is not None and adx < CHOP_ADX and direction == "SIDEWAYS":
        # Two independent confirmations of the same thing. ADX alone flags
        # every pullback in a healthy trend; requiring the swing structure to
        # agree keeps this to genuine chop.
        narrow = (
            f" The current bar spans {range_vs_atr:.1f}× ATR."
            if 0 < range_vs_atr < CHOP_RANGE_RATIO
            else ""
        )
        zones.append(_zone(
            "CHOP",
            "Choppy, directionless market",
            "BLOCKING",
            f"ADX {adx:.0f} with no consistent sequence of highs and lows.{narrow}",
            "Trend-following entries fail repeatedly here. Wait for ADX above 20 with a "
            "confirmed swing structure, or trade the range boundaries rather than the middle.",
        ))

    # ── 2. Volatility squeeze ────────────────────────────────────
    if squeeze is not None and squeeze > 0 and (adx is None or adx < 25):
        zones.append(_zone(
            "SQUEEZE",
            "Volatility squeeze",
            "CAUTION",
            "Bollinger Bands are inside the Keltner Channels — volatility is compressed and "
            "an expansion is likely, but the direction of that expansion is not yet set.",
            "The edge is in trading the expansion, not predicting it. Wait for the break and "
            "take the retest.",
        ))

    # ── 3. Mid-range ─────────────────────────────────────────────
    if dealing_range:
        high = float(dealing_range.get("rangeHigh") or 0)
        low = float(dealing_range.get("rangeLow") or 0)
        if high > low > 0:
            position = (price - low) / (high - low)
            if abs(position - 0.5) < MIDRANGE_BAND:
                zones.append(_zone(
                    "MID_RANGE",
                    "No man's land",
                    "BLOCKING",
                    f"Price sits at {position * 100:.0f}% of the dealing range "
                    f"({low:.2f}–{high:.2f}) — equidistant from both boundaries.",
                    "There is no level to lean on and nowhere sensible to put a stop. Wait for "
                    "price to reach a boundary where risk can actually be defined.",
                ))

    # ── 4. Extreme volatility ────────────────────────────────────
    percentile = float(regime.get("percentile") or 50.0)
    atr_percent = float(regime.get("atrPercent") or 0.0)

    if percentile >= EXTREME_VOL_PERCENTILE:
        zones.append(_zone(
            "EXTREME_VOLATILITY",
            "Extreme volatility",
            "CAUTION",
            f"ATR is at the {percentile:.0f}th percentile of its own history "
            f"({atr_percent:.2f}% of price).",
            "A correctly-sized position becomes tiny and a normally-sized one becomes "
            "reckless. If you trade this, size from the stop distance and accept the smaller "
            "position — do not tighten the stop to keep the size.",
        ))

    # ── 5. Illiquidity ───────────────────────────────────────────
    volume_ratio = volume.get("ratio")
    if volume_ratio is not None:
        volume_ratio = float(volume_ratio)
        # A zero-volume series (spot forex quotes ticks, not volume) reports no
        # ratio at all and must not be read as illiquid.
        if volume_ratio > 0 and volume_ratio < ILLIQUID_RATIO:
            zones.append(_zone(
                "ILLIQUID",
                "Thin participation",
                "CAUTION",
                f"Volume is {volume_ratio:.2f}× its 20-bar average.",
                "Levels set on this little participation are unreliable, and fills will be "
                "worse than the chart suggests.",
            ))

    # ── 6. Unresolved gap ────────────────────────────────────────
    if anatomy and atr > 0:
        gap_percent = float(anatomy.get("gapPercent", 0.0) or 0.0)
        gap_size = abs(gap_percent) / 100.0 * price
        if gap_size > atr * GAP_ATR:
            zones.append(_zone(
                "UNRESOLVED_GAP",
                "Unresolved gap",
                "CAUTION",
                f"The current bar gapped {gap_percent:+.2f}% — {gap_size / atr:.1f}× ATR — "
                "and the gap has not yet filled or been confirmed.",
                "Levels from before the gap describe a market that repriced overnight. Let the "
                "gap resolve before treating them as support or resistance.",
            ))

    blocking = [z for z in zones if z["severity"] == "BLOCKING"]
    caution = [z for z in zones if z["severity"] == "CAUTION"]

    # Each caution compounds, with a floor — three simultaneous cautions should
    # hurt, but not multiply down to a meaningless number.
    multiplier = 1.0
    for _ in caution:
        multiplier *= 0.85
    multiplier = max(0.55, multiplier)

    if blocking:
        multiplier = 0.0
        summary = (
            f"No-trade zone: {blocking[0]['label'].lower()}. {blocking[0]['detail']} "
            "No signal is issued in this state."
        )
    elif caution:
        summary = (
            f"{len(caution)} caution{'s' if len(caution) != 1 else ''} active "
            f"({', '.join(z['label'].lower() for z in caution)}). "
            "Tradeable, but confidence is reduced accordingly."
        )
    else:
        summary = "No no-trade condition detected — market state is workable."

    return {
        "zones": zones,
        "blocked": bool(blocking),
        "confidenceMultiplier": round(multiplier, 3),
        "summary": summary,
    }
