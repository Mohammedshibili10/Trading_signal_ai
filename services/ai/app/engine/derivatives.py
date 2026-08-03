"""
Perpetual-futures funding, open interest and positioning.

Crypto's leverage lives in perpetual futures, and the venue publishes what that
leverage costs and how it is distributed. Those are facts spot candles cannot
carry: price tells you where the market is, funding tells you what it costs to
stay there, and the long/short split tells you how many people are already
positioned for the move you are considering.

**Crowding is the signal, not direction.** A market that is 80% long and paying
to stay long is not bullish evidence — it is a market where the marginal buyer
has already bought and where a move down finds stops rather than bids. So the
readings here are scored *against* the crowd, which is the opposite of how they
are usually quoted. Extreme positive funding is bearish, extreme negative
funding is bullish, and a balanced book scores nothing at all.

The one exception is open interest, which is directionless on its own: rising
OI says conviction is building behind whatever the trend already is, and falling
OI says positions are being closed. It is read as a confirmation of the existing
move rather than a signal in its own right, so it only ever scales what the
other readings say.

**This is exchange data, not chain data.** Active addresses, exchange netflows,
whale transfers and realised cap require a licensed on-chain provider. Nothing
here should be described as an on-chain metric.

Spec: docs/signal-methodology.md
"""

from __future__ import annotations

from typing import Any

#: Funding above/below this (annualised %) counts as crowded rather than normal.
#:
#: Binance perpetuals sit near 10.95% annualised (0.01% per 8h) in a balanced
#: market — that is the venue's own baseline, not a neutral zero. Crowding is
#: measured as the distance from there, so ordinary carry is not read as
#: euphoria.
FUNDING_BASELINE = 10.95
FUNDING_EXTREME = 50.0

#: Long-account share beyond which positioning counts as one-sided. Retail books
#: sit structurally long, so the neutral point is above 50%.
CROWD_NEUTRAL = 0.55
CROWD_EXTREME = 0.80

#: Open-interest change (%) over the observed window that counts as meaningful.
OI_MEANINGFUL = 3.0


def _clip(value: float) -> float:
    return max(-1.0, min(1.0, value))


def _scaled(value: float, neutral: float, extreme: float) -> float:
    """Distance past `neutral`, as a 0…1 fraction of the way to `extreme`."""
    span = extreme - neutral
    if span <= 0:
        return 0.0
    return _clip((value - neutral) / span)


def available(derivatives: dict[str, Any] | None) -> bool:
    """True when at least one reading arrived. Absence drops the group."""
    if not derivatives:
        return False
    return any(
        derivatives.get(key) is not None
        for key in (
            "fundingRate",
            "openInterest",
            "longAccountRatio",
            "topTraderLongRatio",
        )
    )


def analyse(derivatives: dict[str, Any] | None, *, trend_score: float = 0.0) -> dict[str, Any]:
    """
    Score positioning and funding as a contrarian read.

    ``trend_score`` is the blended trend factor, used only to decide what rising
    open interest is confirming. Without it OI cannot be interpreted at all, so
    it contributes nothing rather than guessing a direction.
    """
    if not available(derivatives):
        return {"available": False, "score": 0.0, "summary": "", "readings": []}

    data = derivatives or {}
    parts: list[float] = []
    notes: list[str] = []
    readings: list[dict[str, Any]] = []

    # ── Funding ──────────────────────────────────────────────────
    annualised = data.get("fundingRateAnnualisedPercent")
    if annualised is not None:
        annualised = float(annualised)
        if annualised >= FUNDING_BASELINE:
            crowding = _scaled(annualised, FUNDING_BASELINE, FUNDING_EXTREME)
            score = -crowding  # longs paying — crowded long, scored against
        else:
            crowding = _scaled(-annualised, -FUNDING_BASELINE, FUNDING_EXTREME)
            score = crowding  # shorts paying — crowded short

        if abs(score) > 0.05:
            parts.append(score)
            side = "Longs" if annualised >= FUNDING_BASELINE else "Shorts"
            notes.append(
                f"Funding {annualised:+.1f}% annualised — {side.lower()} are paying to hold, "
                f"{'crowded long' if score < 0 else 'crowded short'}"
            )
        else:
            notes.append(f"Funding {annualised:+.1f}% annualised — near neutral carry")
        readings.append({"label": "Funding rate", "value": f"{annualised:+.1f}% p.a.", "score": round(score, 3)})

    # ── Positioning ──────────────────────────────────────────────
    #
    # Both books are read the same way and averaged. They are quoted separately
    # because they disagree in the interesting cases: when the crowd is long and
    # the largest accounts are not, that divergence is the whole message.
    crowd_scores: list[float] = []
    for key, label in (
        ("longAccountRatio", "All accounts"),
        ("topTraderLongRatio", "Top traders"),
    ):
        ratio = data.get(key)
        if ratio is None:
            continue
        ratio = float(ratio)
        if ratio >= CROWD_NEUTRAL:
            score = -_scaled(ratio, CROWD_NEUTRAL, CROWD_EXTREME)
        else:
            score = _scaled(1.0 - ratio, CROWD_NEUTRAL, CROWD_EXTREME)
        crowd_scores.append(score)
        readings.append(
            {"label": f"{label} long", "value": f"{ratio * 100:.0f}%", "score": round(score, 3)}
        )

    if crowd_scores:
        crowd = float(sum(crowd_scores) / len(crowd_scores))
        if abs(crowd) > 0.05:
            parts.append(crowd)
            notes.append(
                f"Positioning is {'one-sided long' if crowd < 0 else 'one-sided short'} "
                "— the crowd is already in the trade"
            )
        else:
            notes.append("Positioning is balanced between longs and shorts")

    # A divergence between the crowd and the largest accounts is worth naming on
    # its own: it is the one configuration where "everyone is long" has a
    # counterparty worth knowing about.
    retail = data.get("longAccountRatio")
    whales = data.get("topTraderLongRatio")
    if retail is not None and whales is not None:
        gap = float(retail) - float(whales)
        if abs(gap) >= 0.10:
            side = "less" if gap > 0 else "more"
            notes.append(
                f"Largest accounts are {side} long than the wider book "
                f"({float(whales) * 100:.0f}% vs {float(retail) * 100:.0f}%)"
            )

    # ── Open interest ────────────────────────────────────────────
    oi_change = data.get("openInterestChangePercent")
    if oi_change is not None:
        oi_change = float(oi_change)
        if abs(oi_change) >= OI_MEANINGFUL:
            building = oi_change > 0
            notes.append(
                f"Open interest {'rising' if building else 'falling'} {abs(oi_change):.1f}% — "
                f"{'leverage building behind the move' if building else 'positions being closed'}"
            )
            # Only ever a confirmation: it scales the existing trend rather than
            # voting for a direction of its own.
            if building and abs(trend_score) > 0.1:
                parts.append(_clip(trend_score * 0.3))
        readings.append(
            {"label": "Open interest", "value": f"{oi_change:+.1f}%", "score": 0.0}
        )

    score = _clip(sum(parts) / len(parts)) if parts else 0.0

    return {
        "available": True,
        "score": score,
        "summary": "; ".join(notes)[:400] or "Derivatives positioning is unremarkable.",
        "readings": readings,
        "source": data.get("source", ""),
    }
