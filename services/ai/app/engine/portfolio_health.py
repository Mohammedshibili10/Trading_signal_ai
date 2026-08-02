"""
Portfolio health and rebalancing.

Answers a question the holdings table cannot: *is this collection of positions
a portfolio, or just a list of things that were bought?*

The distinction that drives everything here is **effective diversification**.
Ten positions is not ten bets if six of them are private banks — that is one
bet at six times the size, held by someone who believes they are diversified.
Position count is the number people look at; correlated concentration is the
number that decides what happens in a drawdown.

Rebalancing suggestions are framed as observations with reasoning attached
rather than instructions. The tool can see that a position has grown to 34% of
the book; it cannot see the tax position, the conviction, or the reason it was
bought, and any of those can be a perfectly good argument for leaving it alone.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: A single position above this share of the book is flagged.
CONCENTRATION_LIMIT = 25.0
#: A sector above this share is flagged.
SECTOR_LIMIT = 35.0
#: Below this many positions, concentration is structural rather than a choice.
MIN_POSITIONS = 5

#: Long-run nominal return assumptions, for the expected-return estimate.
#: Deliberately conservative and clearly labelled as assumptions.
ASSUMED_RETURN = {
    "EQUITY": 12.0,
    "INVESTMENT": 9.0,
    "CRYPTO": 15.0,
    "FOREX": 4.0,
}


def _share(value: float, total: float) -> float:
    return (value / total * 100.0) if total > 0 else 0.0


def analyse(
    holdings: list[dict[str, Any]],
    *,
    correlation_penalty: float | None = None,
) -> dict[str, Any]:
    """
    Portfolio-level read.

    `holdings` need symbol, currentValue, assetClass and — where known — sector,
    dividendYield and an unrealised return. Anything absent is reported rather
    than assumed.
    """
    live = [h for h in holdings if float(h.get("currentValue") or 0) > 0]
    if not live:
        return {
            "available": False,
            "summary": "No holdings with a market value to analyse.",
            "healthScore": None,
        }

    total = sum(float(h["currentValue"]) for h in live)

    # ── Allocation ───────────────────────────────────────────────
    positions = sorted(
        (
            {
                "symbol": h.get("symbol"),
                "value": round(float(h["currentValue"]), 2),
                "percent": round(_share(float(h["currentValue"]), total), 2),
                "assetClass": h.get("assetClass"),
                "sector": h.get("sector"),
            }
            for h in live
        ),
        key=lambda p: -p["percent"],
    )

    def group(field: str) -> list[dict[str, Any]]:
        buckets: dict[str, float] = {}
        for h in live:
            key = str(h.get(field) or "Unclassified")
            buckets[key] = buckets.get(key, 0.0) + float(h["currentValue"])
        return sorted(
            (
                {"name": name, "value": round(value, 2), "percent": round(_share(value, total), 2)}
                for name, value in buckets.items()
            ),
            key=lambda b: -b["percent"],
        )

    by_sector = group("sector")
    by_class = group("assetClass")
    by_country = group("country")

    # ── Concentration ────────────────────────────────────────────
    #
    # Herfindahl over the weights. Its reciprocal is the *effective* number of
    # positions: a book of ten where one is 60% behaves like about two and a
    # half, and that is the number worth knowing.
    weights = np.array([p["percent"] / 100.0 for p in positions])
    herfindahl = float((weights**2).sum())
    effective_positions = 1.0 / herfindahl if herfindahl > 0 else 0.0

    if correlation_penalty is not None:
        effective_positions *= max(0.2, 1.0 - correlation_penalty)

    # ── Expected return and income ───────────────────────────────
    weighted_return = 0.0
    dividend_income = 0.0
    yields_known = 0

    for h in live:
        value = float(h["currentValue"])
        weighted_return += ASSUMED_RETURN.get(str(h.get("assetClass")), 8.0) * (value / total)
        dy = h.get("dividendYield")
        if dy is not None:
            dividend_income += value * float(dy) / 100.0
            yields_known += 1

    # ── Health score ─────────────────────────────────────────────
    #
    # Four components. Diversification carries the most weight because it is
    # the one a portfolio cannot recover from being wrong about.
    diversification = float(np.clip(effective_positions / 12.0, 0.0, 1.0)) * 100
    largest = positions[0]["percent"] if positions else 0.0
    concentration = float(np.clip((CONCENTRATION_LIMIT * 2 - largest) / CONCENTRATION_LIMIT, 0.0, 1.0)) * 100
    top_sector = by_sector[0]["percent"] if by_sector else 0.0
    sector_balance = float(np.clip((SECTOR_LIMIT * 2 - top_sector) / SECTOR_LIMIT, 0.0, 1.0)) * 100
    breadth = float(np.clip(len(live) / MIN_POSITIONS, 0.0, 1.0)) * 100

    health = (
        diversification * 0.35 + concentration * 0.30 + sector_balance * 0.20 + breadth * 0.15
    )

    # ── Rebalancing observations ─────────────────────────────────
    suggestions: list[dict[str, Any]] = []

    for position in positions:
        if position["percent"] > CONCENTRATION_LIMIT:
            suggestions.append({
                "kind": "CONCENTRATION",
                "severity": "HIGH" if position["percent"] > CONCENTRATION_LIMIT * 1.6 else "MEDIUM",
                "subject": position["symbol"],
                "detail": (
                    f"{position['symbol']} is {position['percent']:.1f}% of the book. "
                    "A single position this size drives the portfolio more than the market does."
                ),
                "consideration": (
                    "Trimming to the limit would free capital without closing the position — "
                    "though tax, conviction and why it was bought are all reasons this might be "
                    "the right exposure to hold."
                ),
            })

    for sector in by_sector:
        if sector["name"] != "Unclassified" and sector["percent"] > SECTOR_LIMIT:
            suggestions.append({
                "kind": "SECTOR",
                "severity": "MEDIUM",
                "subject": sector["name"],
                "detail": (
                    f"{sector['name']} is {sector['percent']:.1f}% of the book. "
                    "Names in one sector fall together in a sector drawdown, whatever their "
                    "individual quality."
                ),
                "consideration": "New capital directed elsewhere reduces this without selling anything.",
            })

    if len(live) < MIN_POSITIONS:
        suggestions.append({
            "kind": "BREADTH",
            "severity": "MEDIUM",
            "subject": "Position count",
            "detail": (
                f"{len(live)} position(s). Below about five, one bad outcome is a large share of "
                "the whole result."
            ),
            "consideration": "More positions, or an index fund as a base holding, widens the base.",
        })

    if effective_positions < 3 and len(live) >= MIN_POSITIONS:
        suggestions.append({
            "kind": "EFFECTIVE_BREADTH",
            "severity": "HIGH",
            "subject": "Effective diversification",
            "detail": (
                f"{len(live)} positions, but weighted concentration makes it behave like "
                f"{effective_positions:.1f}. The count is not the exposure."
            ),
            "consideration": "Levelling the largest weights would close most of that gap.",
        })

    unclassified = next((s for s in by_sector if s["name"] == "Unclassified"), None)
    if unclassified and unclassified["percent"] > 20:
        suggestions.append({
            "kind": "DATA",
            "severity": "LOW",
            "subject": "Sector data",
            "detail": (
                f"{unclassified['percent']:.0f}% of the book has no sector on file, so the "
                "sector concentration figure understates whatever is actually there."
            ),
            "consideration": "Not a portfolio problem — a data one.",
        })

    suggestions.sort(key=lambda s: {"HIGH": 0, "MEDIUM": 1, "LOW": 2}[s["severity"]])

    grade = (
        "STRONG" if health >= 75
        else "SOUND" if health >= 60
        else "UNEVEN" if health >= 45
        else "CONCENTRATED"
    )

    summary = (
        f"{len(live)} positions worth {total:,.0f}, behaving like {effective_positions:.1f} "
        f"independent ones. Health {health:.0f}/100 ({grade.lower()}). "
        + (
            f"Largest position {positions[0]['symbol']} at {largest:.1f}%. "
            if positions
            else ""
        )
        + (
            f"{len(suggestions)} thing(s) worth looking at."
            if suggestions
            else "Nothing stands out as needing attention."
        )
    )

    return {
        "available": True,
        "totalValue": round(total, 2),
        "positionCount": len(live),
        "effectivePositions": round(effective_positions, 2),
        "concentrationIndex": round(herfindahl * 100, 2),
        "healthScore": round(health, 1),
        "grade": grade,
        "components": {
            "diversification": round(diversification, 1),
            "concentration": round(concentration, 1),
            "sectorBalance": round(sector_balance, 1),
            "breadth": round(breadth, 1),
        },
        "allocation": positions[:20],
        "bySector": by_sector,
        "byAssetClass": by_class,
        "byCountry": by_country,
        "expectedReturnPercent": round(weighted_return, 2),
        "expectedReturnNote": (
            "A weighted blend of long-run asset-class assumptions, not a forecast for this "
            "portfolio. Assumes 12% for equities, 9% for funds, 15% for crypto."
        ),
        "dividendIncome": round(dividend_income, 2) if yields_known else None,
        "dividendCoverage": (
            f"{yields_known} of {len(live)} holdings have a yield on file"
            if yields_known < len(live)
            else None
        ),
        "suggestions": suggestions,
        "summary": summary,
    }


def cagr(start_value: float, end_value: float, years: float) -> float | None:
    """
    Compound annual growth rate.

    None for windows under a quarter: annualising a six-week return produces a
    number that looks authoritative and means nothing.
    """
    if start_value <= 0 or end_value <= 0 or years < 0.25:
        return None
    return round(((end_value / start_value) ** (1 / years) - 1) * 100, 2)
