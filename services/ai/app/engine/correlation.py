"""
Correlation check at signal time.

Portfolio risk already measures correlation across holdings. This is a different
question, asked earlier: *if I take this signal, am I adding a new position or
adding to one I already have?*

Three long positions in HDFCBANK, ICICIBANK and AXISBANK is not a diversified
book with 3% risk. It is one bet on Indian private banks with 9% risk, and the
person who took it almost certainly believes they are running three. That belief
is the failure — the risk was sized per trade, and the trades turned out to be
the same trade.

The module answers it two ways, because correlation has two sources and only one
of them needs price history:

**Measured** — Pearson correlation of aligned daily returns. Exact, but needs
overlapping history for both instruments.

**Structural** — same sector, same currency leg, same crypto beta. Available
instantly and often more honest about *why* two things move together, which is
what a trader can actually act on. USDINR and EURINR share the rupee whatever
the last sixty days happened to print.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Correlation above which two positions are treated as substantially the same.
HIGH_CORRELATION = 0.70
#: Correlation above which to warn but not block.
MODERATE_CORRELATION = 0.50
#: Minimum overlapping observations before a measured correlation is trusted.
MIN_OVERLAP = 30

#: Structural relationships that hold regardless of what recent prices did.
#:
#: Deliberately coarse. A finer taxonomy would be more accurate and far more
#: brittle — the point is to catch "these are the same bet", not to model
#: sector betas.
STRUCTURAL_GROUPS: dict[str, float] = {
    # Indian sectors that move as blocks.
    "Banking & Financial Services": 0.72,
    "Information Technology": 0.75,
    "Oil & Gas": 0.62,
    "Automobile": 0.58,
    "Pharmaceuticals": 0.55,
    "Metals & Mining": 0.68,
    "FMCG": 0.52,
    "Power & Utilities": 0.60,
    "Cement": 0.62,
    "Real Estate": 0.65,
}

#: Crypto majors move together far more than their narratives suggest.
CRYPTO_BASE_CORRELATION = 0.72


def _pearson(a: list[float], b: list[float]) -> float | None:
    """Correlation of two aligned return series, or None if not computable."""
    n = min(len(a), len(b))
    if n < MIN_OVERLAP:
        return None

    x = np.asarray(a[-n:], dtype=float)
    y = np.asarray(b[-n:], dtype=float)

    mask = np.isfinite(x) & np.isfinite(y)
    if int(mask.sum()) < MIN_OVERLAP:
        return None

    x, y = x[mask], y[mask]
    if x.std() == 0 or y.std() == 0:
        return None

    value = float(np.corrcoef(x, y)[0, 1])
    return value if np.isfinite(value) else None


def _structural(
    candidate: dict[str, Any], existing: dict[str, Any]
) -> tuple[float, str] | None:
    """Correlation implied by what the two instruments *are*."""
    c_class = candidate.get("assetClass")
    e_class = existing.get("assetClass")

    if c_class != e_class:
        return None

    if c_class == "CRYPTO":
        return CRYPTO_BASE_CORRELATION, "both crypto majors, which move as one risk asset"

    if c_class == "FOREX":
        c_symbol = str(candidate.get("symbol", ""))
        e_symbol = str(existing.get("symbol", ""))
        # Pairs sharing a leg are mechanically linked through that currency.
        c_legs = {c_symbol[:3], c_symbol[3:6]}
        e_legs = {e_symbol[:3], e_symbol[3:6]}
        shared = c_legs & e_legs
        if shared:
            leg = next(iter(shared))
            return 0.68, f"both quote {leg}, so they share that leg's moves"
        return None

    if c_class == "EQUITY":
        sector = candidate.get("sector")
        if sector and sector == existing.get("sector"):
            value = STRUCTURAL_GROUPS.get(sector, 0.55)
            return value, f"both in {sector}, which trades as a block"

    return None


def check(
    candidate: dict[str, Any],
    existing: list[dict[str, Any]],
    *,
    returns_by_symbol: dict[str, list[float]] | None = None,
    max_correlated_exposure: float = 4.0,
) -> dict[str, Any]:
    """
    Compare a candidate signal against positions and signals already live.

    `candidate` and each entry in `existing` need at minimum a symbol,
    assetClass, and (for equities) sector. `riskPercent` on the existing
    entries lets the check total the exposure that would actually be correlated.

    `blocked` is set when taking this trade would push correlated risk past
    `max_correlated_exposure` percent of capital — the number that matters, as
    opposed to the per-trade risk which looks fine by construction.
    """
    symbol = candidate.get("symbol")
    others = [e for e in existing if e.get("symbol") != symbol]

    if not others:
        return {
            "correlated": [],
            "blocked": False,
            "maxCorrelation": 0.0,
            "correlatedExposure": 0.0,
            "confidenceMultiplier": 1.0,
            "summary": "No open positions or live signals to correlate against.",
        }

    candidate_returns = (returns_by_symbol or {}).get(str(symbol))
    matches: list[dict[str, Any]] = []

    for other in others:
        measured: float | None = None
        if candidate_returns:
            other_returns = (returns_by_symbol or {}).get(str(other.get("symbol")))
            if other_returns:
                measured = _pearson(candidate_returns, other_returns)

        structural = _structural(candidate, other)

        # Prefer the measured value when it exists — it describes these two
        # instruments rather than their category. Structural is the fallback and
        # the explanation.
        if measured is not None:
            value = measured
            source = "measured"
            reason = f"{measured:.2f} correlation over the last {MIN_OVERLAP}+ sessions"
            if structural and abs(measured) < structural[0] - 0.15:
                # Worth saying when the recent window disagrees with the
                # structural link — that divergence is usually temporary.
                reason += f"; structurally {structural[1]}, which typically runs higher"
        elif structural is not None:
            value, reason = structural[0], structural[1]
            source = "structural"
        else:
            continue

        if abs(value) < MODERATE_CORRELATION:
            continue

        matches.append({
            "symbol": other.get("symbol"),
            "correlation": round(float(value), 3),
            "source": source,
            "reason": reason,
            "riskPercent": float(other.get("riskPercent") or 0.0),
            "direction": other.get("action") or other.get("side") or "LONG",
        })

    if not matches:
        return {
            "correlated": [],
            "blocked": False,
            "maxCorrelation": 0.0,
            "correlatedExposure": 0.0,
            "confidenceMultiplier": 1.0,
            "summary": f"No meaningful correlation with the {len(others)} position(s) already open.",
        }

    matches.sort(key=lambda m: -abs(m["correlation"]))
    max_correlation = abs(matches[0]["correlation"])

    candidate_risk = float(candidate.get("riskPercent") or 1.0)
    candidate_direction = candidate.get("action") or "BUY"

    # Only same-direction correlated exposure compounds. A long in one bank and
    # a short in another is a spread — a different trade with different risk,
    # not a doubled bet.
    same_direction = [
        m for m in matches
        if (m["direction"] in ("BUY", "LONG")) == (candidate_direction in ("BUY", "LONG"))
    ]
    correlated_exposure = candidate_risk + sum(
        m["riskPercent"] * abs(m["correlation"]) for m in same_direction
    )

    blocked = correlated_exposure > max_correlated_exposure and max_correlation >= HIGH_CORRELATION

    if blocked:
        multiplier = 0.0
        summary = (
            f"Correlated exposure would reach {correlated_exposure:.1f}% of capital, past the "
            f"{max_correlated_exposure:.0f}% limit. {matches[0]['symbol']} is already open and "
            f"{matches[0]['reason']} — sized as separate trades, these behave as one."
        )
    elif max_correlation >= HIGH_CORRELATION:
        multiplier = 0.80
        summary = (
            f"Highly correlated with {matches[0]['symbol']} ({matches[0]['reason']}). "
            f"Taking both means {correlated_exposure:.1f}% of capital on effectively one position."
        )
    else:
        multiplier = 0.92
        summary = (
            f"Moderately correlated with {len(matches)} open position(s), strongest "
            f"{matches[0]['symbol']} at {matches[0]['correlation']:.2f}. Worth halving the size."
        )

    return {
        "correlated": matches[:5],
        "blocked": blocked,
        "maxCorrelation": round(max_correlation, 3),
        "correlatedExposure": round(correlated_exposure, 2),
        "confidenceMultiplier": multiplier,
        "summary": summary,
    }
