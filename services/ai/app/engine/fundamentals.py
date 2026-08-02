"""
Fundamental analysis and scoring for Indian equities.

What separates this from a generic international model is the Indian lens:
promoter holding and — especially — **promoter pledging**, which has preceded
several Indian corporate collapses and appears in no standard ratio set. ROCE is
weighted above ROE because it is unaffected by leverage; a high ROE built on debt
is fragile.

Scores are percentile-style within sector where a benchmark is supplied.
Comparing an IT company's margins to a bank's is meaningless.

Spec: docs/trading-concepts.md §9.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Rough sector medians for the Indian market, used when no peer set is passed.
#: Approximations for scoring context, not published statistics.
SECTOR_BENCHMARKS: dict[str, dict[str, float]] = {
    "Information Technology": {"pe": 26, "roe": 24, "roce": 30, "debtToEquity": 0.1, "netMargin": 18},
    "Banking & Financial Services": {"pe": 18, "roe": 15, "roce": 12, "debtToEquity": 6.0, "netMargin": 22},
    "FMCG": {"pe": 45, "roe": 30, "roce": 35, "debtToEquity": 0.2, "netMargin": 14},
    "Pharmaceuticals": {"pe": 30, "roe": 16, "roce": 18, "debtToEquity": 0.3, "netMargin": 15},
    "Automobile": {"pe": 24, "roe": 14, "roce": 16, "debtToEquity": 0.5, "netMargin": 8},
    "Oil & Gas": {"pe": 14, "roe": 13, "roce": 14, "debtToEquity": 0.6, "netMargin": 7},
    "Metals & Mining": {"pe": 12, "roe": 12, "roce": 14, "debtToEquity": 0.7, "netMargin": 9},
    "Infrastructure": {"pe": 20, "roe": 11, "roce": 13, "debtToEquity": 1.0, "netMargin": 6},
    "Power & Utilities": {"pe": 15, "roe": 12, "roce": 11, "debtToEquity": 1.2, "netMargin": 12},
    "Cement": {"pe": 28, "roe": 12, "roce": 14, "debtToEquity": 0.4, "netMargin": 10},
    "Telecom": {"pe": 35, "roe": 8, "roce": 9, "debtToEquity": 1.8, "netMargin": 5},
    "Chemicals": {"pe": 28, "roe": 16, "roce": 19, "debtToEquity": 0.4, "netMargin": 11},
    "Consumer Durables": {"pe": 40, "roe": 18, "roce": 22, "debtToEquity": 0.3, "netMargin": 8},
    "Real Estate": {"pe": 30, "roe": 10, "roce": 11, "debtToEquity": 0.8, "netMargin": 12},
    "Media & Entertainment": {"pe": 25, "roe": 10, "roce": 12, "debtToEquity": 0.4, "netMargin": 8},
}

DEFAULT_BENCHMARK = {"pe": 24, "roe": 15, "roce": 17, "debtToEquity": 0.6, "netMargin": 11}


def _score_higher_better(value: float | None, benchmark: float, *, spread: float = 0.6) -> float:
    """0–100 where beating the sector median scores above 50."""
    if value is None or not np.isfinite(value) or benchmark <= 0:
        return 50.0
    ratio = value / benchmark
    return float(np.clip(50 + (ratio - 1) / spread * 50, 0, 100))


def _score_lower_better(value: float | None, benchmark: float, *, spread: float = 0.6) -> float:
    if value is None or not np.isfinite(value):
        return 50.0
    if value <= 0:
        return 90.0  # net cash / no debt
    if benchmark <= 0:
        benchmark = 0.5
    ratio = value / benchmark
    return float(np.clip(50 - (ratio - 1) / spread * 50, 0, 100))


def _band(value: float | None, thresholds: list[tuple[float, float]], default: float = 50.0) -> float:
    """Map a value onto a score using ordered (threshold, score) bands."""
    if value is None or not np.isfinite(value):
        return default
    for threshold, score in thresholds:
        if value >= threshold:
            return score
    return thresholds[-1][1] if thresholds else default


def score(data: dict[str, Any]) -> dict[str, Any]:
    """
    Produce quality / valuation / growth / health sub-scores and a composite.

    Every sub-score returns 50 (neutral) for missing inputs rather than pulling
    the composite down — absence of data is not evidence of weakness.
    """
    sector = data.get("sector") or "Unclassified"
    benchmark = SECTOR_BENCHMARKS.get(sector, DEFAULT_BENCHMARK)

    strengths: list[str] = []
    concerns: list[str] = []

    roe = data.get("roe")
    roce = data.get("roce")
    net_margin = data.get("netMargin")
    operating_margin = data.get("operatingMargin")

    # ── Quality ──────────────────────────────────────────────────
    # ROCE weighted above ROE: it is leverage-neutral, so it measures the
    # business rather than the balance sheet.
    quality_parts = [
        (_score_higher_better(roce, benchmark["roce"]), 0.35),
        (_score_higher_better(roe, benchmark["roe"]), 0.25),
        (_score_higher_better(net_margin, benchmark["netMargin"]), 0.20),
        (_score_higher_better(operating_margin, benchmark["netMargin"] * 1.5), 0.20),
    ]
    quality = sum(s * w for s, w in quality_parts)

    if roce is not None and roce >= 20:
        strengths.append(f"ROCE of {roce:.1f}% — capital is being deployed efficiently, and it is not a leverage artefact")
    elif roce is not None and roce < 10:
        concerns.append(f"ROCE of {roce:.1f}% is below the cost of capital for most Indian businesses")

    if roe is not None and roce is not None and roe > roce * 1.6 and roe > 18:
        concerns.append(
            f"ROE ({roe:.1f}%) far exceeds ROCE ({roce:.1f}%) — the returns are leverage-driven, which is fragile"
        )

    # ── Valuation ────────────────────────────────────────────────
    pe = data.get("pe")
    pb = data.get("pb")
    industry_pe = data.get("industryPe") or benchmark["pe"]

    valuation_parts = [
        (_score_lower_better(pe, industry_pe), 0.45),
        (_score_lower_better(pb, 3.5), 0.25),
        (_score_lower_better(data.get("evEbitda"), 14.0), 0.20),
        (_score_higher_better(data.get("dividendYield"), 1.5, spread=1.2), 0.10),
    ]
    valuation = sum(s * w for s, w in valuation_parts)

    if pe is not None and pe > 0:
        if pe < industry_pe * 0.7:
            strengths.append(f"P/E of {pe:.1f} is well below the sector's {industry_pe:.0f} — cheap relative to peers")
        elif pe > industry_pe * 1.5:
            concerns.append(
                f"P/E of {pe:.1f} against a sector {industry_pe:.0f} prices in a lot of future growth"
            )
    elif pe is not None and pe < 0:
        concerns.append("Negative earnings — P/E is not meaningful")

    # ── Growth ───────────────────────────────────────────────────
    revenue_growth = data.get("revenueGrowth")
    profit_growth = data.get("profitGrowth")
    eps_growth = data.get("epsGrowth")

    growth_parts = [
        (_band(revenue_growth, [(25, 92), (15, 78), (10, 65), (5, 52), (0, 40), (-100, 20)]), 0.35),
        (_band(profit_growth, [(25, 92), (15, 78), (10, 65), (5, 52), (0, 40), (-100, 18)]), 0.40),
        (_band(eps_growth, [(20, 88), (12, 74), (6, 60), (0, 45), (-100, 25)]), 0.25),
    ]
    growth = sum(s * w for s, w in growth_parts)

    if profit_growth is not None and profit_growth > 20:
        strengths.append(f"Profit growing {profit_growth:.1f}% year-on-year")
    elif profit_growth is not None and profit_growth < 0:
        concerns.append(f"Profit declined {abs(profit_growth):.1f}% year-on-year")

    # Growth without cash is the classic accounting warning sign.
    ocf = data.get("operatingCashFlow")
    if ocf is not None and profit_growth is not None and profit_growth > 15 and ocf <= 0:
        concerns.append(
            "Profit is growing but operating cash flow is negative — earnings are not converting to cash"
        )

    # ── Financial health ─────────────────────────────────────────
    debt_equity = data.get("debtToEquity")
    interest_cover = data.get("interestCoverage")
    fcf = data.get("freeCashFlow")

    is_financial = sector == "Banking & Financial Services"
    health_parts = [
        # Leverage is meaningless for banks — it is their business model.
        (50.0 if is_financial else _score_lower_better(debt_equity, benchmark["debtToEquity"]), 0.30),
        (_band(interest_cover, [(8, 92), (5, 80), (3, 65), (2, 48), (1, 30), (-1000, 12)]), 0.30),
        (_band(data.get("currentRatio"), [(2, 85), (1.5, 75), (1.2, 62), (1, 50), (-1000, 28)]), 0.15),
        (75.0 if (fcf or 0) > 0 else 35.0, 0.25),
    ]
    health = sum(s * w for s, w in health_parts)

    if debt_equity is not None and not is_financial:
        if debt_equity < 0.3:
            strengths.append(f"Debt-to-equity of {debt_equity:.2f} — a conservative balance sheet")
        elif debt_equity > 1.5:
            concerns.append(f"Debt-to-equity of {debt_equity:.2f} leaves little room if earnings fall")

    if interest_cover is not None and interest_cover < 2:
        concerns.append(
            f"Interest coverage of {interest_cover:.1f}× — earnings barely cover the interest bill"
        )

    if fcf is not None and fcf > 0:
        strengths.append("Free cash flow positive — the business funds itself")

    # ── The Indian ownership lens ────────────────────────────────
    promoter = data.get("promoterHolding")
    pledge = data.get("promoterPledge")
    fii = data.get("fiiHolding")
    dii = data.get("diiHolding")

    governance_adjustment = 0.0

    if promoter is not None:
        if promoter >= 50:
            strengths.append(f"Promoters hold {promoter:.1f}% — interests are aligned with minority shareholders")
            governance_adjustment += 3
        elif promoter < 25:
            concerns.append(f"Promoter holding of {promoter:.1f}% is low")
            governance_adjustment -= 3

    # Pledging is the single most important Indian-specific red flag.
    if pledge is not None and pledge > 0:
        if pledge > 25:
            concerns.append(
                f"{pledge:.1f}% of promoter holding is pledged. Heavy pledging has preceded several "
                "Indian corporate collapses — if the share price falls, lenders can force sales, which "
                "drives it lower still."
            )
            governance_adjustment -= 12
        elif pledge > 10:
            concerns.append(f"{pledge:.1f}% of promoter holding is pledged — worth monitoring each quarter")
            governance_adjustment -= 6
        else:
            concerns.append(f"{pledge:.1f}% promoter pledge — small, but any pledging deserves attention")
            governance_adjustment -= 2

    institutional = (fii or 0) + (dii or 0)
    if institutional >= 25:
        strengths.append(f"Institutions hold {institutional:.1f}% — the name has passed professional diligence")
        governance_adjustment += 2

    # ── Composite ────────────────────────────────────────────────
    investment = (
        quality * 0.32 + valuation * 0.22 + growth * 0.24 + health * 0.22
    ) + governance_adjustment
    investment = float(np.clip(investment, 0, 100))

    if investment >= 78:
        rating = "STRONG_BUY"
    elif investment >= 64:
        rating = "BUY"
    elif investment >= 46:
        rating = "HOLD"
    elif investment >= 32:
        rating = "REDUCE"
    else:
        rating = "AVOID"

    # A pledge above 25% caps the rating regardless of how good the numbers look.
    if pledge is not None and pledge > 25 and rating in {"STRONG_BUY", "BUY"}:
        rating = "HOLD"
        concerns.append("Rating capped at HOLD because of the promoter pledge, despite otherwise strong metrics.")

    summary = _summarise(data, quality, valuation, growth, health, investment, rating, sector)

    return {
        "scores": {
            "quality": round(quality, 1),
            "valuation": round(valuation, 1),
            "growth": round(growth, 1),
            "financialHealth": round(health, 1),
            "investment": round(investment, 1),
        },
        "longTermRating": rating,
        "strengths": strengths[:6],
        "concerns": concerns[:6],
        "summary": summary,
        "benchmark": {"sector": sector, **benchmark},
    }


def _summarise(
    data: dict[str, Any],
    quality: float, valuation: float, growth: float, health: float,
    investment: float, rating: str, sector: str,
) -> str:
    name = data.get("name") or data.get("symbol") or "The company"

    best = max(
        [("business quality", quality), ("valuation", valuation), ("growth", growth), ("balance sheet", health)],
        key=lambda x: x[1],
    )
    worst = min(
        [("business quality", quality), ("valuation", valuation), ("growth", growth), ("balance sheet", health)],
        key=lambda x: x[1],
    )

    readable = rating.replace("_", " ").title()

    lead = f"{name} scores {investment:.0f}/100 overall against {sector} peers — a {readable} on a long-term view."
    body = f" Strongest on {best[0]} ({best[1]:.0f}/100), weakest on {worst[0]} ({worst[1]:.0f}/100)."

    pledge = data.get("promoterPledge")
    tail = ""
    if pledge and pledge > 10:
        tail = f" The {pledge:.1f}% promoter pledge is the dominant risk here and overrides the ratio picture."
    elif investment >= 70:
        tail = " Fundamentals support a positional or long-term position; entry timing is still a technical question."
    elif investment < 40:
        tail = " The fundamental picture argues against holding this for the long term regardless of the chart."

    return lead + body + tail


def compare(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank a set of scored companies. Used by the fundamentals scanner."""
    scored = []
    for item in candidates:
        result = score(item)
        scored.append({
            "symbol": item.get("symbol"),
            "name": item.get("name"),
            "sector": item.get("sector"),
            **result["scores"],
            "longTermRating": result["longTermRating"],
        })
    return sorted(scored, key=lambda x: -x["investment"])
