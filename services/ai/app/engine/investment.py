"""
Investment analysis — the long-horizon counterpart to the signal engine.

Deliberately separate from `signals.py`, because the two answer different
questions and conflating them is how people end up holding a day trade for a
year and calling it investing. A trade asks "where is price going over the next
few bars, and where is my stop?". An investment asks "is this a business worth
owning, at this price, for years?" — the stop has no meaning, the timeframe is
different by three orders of magnitude, and the evidence is mostly not on the
chart at all.

Three principles:

**Fundamentals lead, price confirms.** The recommendation is driven by business
quality and valuation. Technicals adjust *timing* — a good business at a fair
price in a downtrend becomes ACCUMULATE rather than BUY, because there is no
prize for catching the exact bottom and a falling knife is still a knife.

**Missing data is reported, never imputed.** Several inputs this module would
like — free cash flow, quarterly statements, insider transactions — are not in
this platform's data set. Every output carries a `dataQuality` block naming
what was unavailable. A conviction score computed from half the inputs, dressed
identically to one computed from all of them, is the single most dangerous
thing an analysis tool can produce.

**No target is a promise.** The target range is derived from earnings and a
justified multiple, and it is stated as a range with the assumptions attached.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: The five recommendations, strongest to weakest.
RECOMMENDATIONS = ("BUY", "ACCUMULATE", "HOLD", "REDUCE", "SELL")

#: Investment styles a holding can qualify for. A single name can match several.
STYLES = (
    "SHORT_TERM",
    "MEDIUM_TERM",
    "LONG_TERM",
    "DIVIDEND",
    "VALUE",
    "GROWTH",
    "QUALITY",
)

#: Sectors excluded outright under common Shariah business-activity screens.
#:
#: Conventional banking and insurance are excluded because their revenue is
#: interest, not because of any judgement about the businesses.
SHARIAH_EXCLUDED_SECTORS = {
    "Banking & Financial Services": "Revenue is predominantly interest-based",
    "Media & Entertainment": "May include prohibited content — requires case-by-case review",
}

#: Debt as a share of market capitalisation, above which a company fails the
#: AAOIFI-style financial screen.
SHARIAH_DEBT_LIMIT = 0.33


def _f(value: Any) -> float | None:
    """Coerce to float, treating anything non-finite as absent."""
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def peg_ratio(pe: float | None, earnings_growth: float | None) -> float | None:
    """
    Price/earnings to growth.

    Not stored anywhere, but derivable from two fields that are. Undefined when
    growth is zero or negative — a PEG computed against shrinking earnings is
    a number with no interpretation, and printing one would invite exactly the
    wrong conclusion.
    """
    if pe is None or earnings_growth is None:
        return None
    if earnings_growth <= 0 or pe <= 0:
        return None
    return round(pe / earnings_growth, 3)


def debt_to_market_cap(debt_to_equity: float | None, pb: float | None) -> float | None:
    """
    Debt as a share of market capitalisation.

    Derived rather than stored:

        debt/marketCap = (D/E × equity) / marketCap
                       = D/E ÷ (marketCap / equity)
                       = D/E ÷ P/B

    This is what the Shariah financial screen actually tests, and it is
    obtainable from two fields already on file.
    """
    if debt_to_equity is None or pb is None or pb <= 0:
        return None
    return round(debt_to_equity / pb, 4)


# ─────────────────────────────────────────────────────────────────
#  Shariah screening
# ─────────────────────────────────────────────────────────────────


def shariah_screen(data: dict[str, Any]) -> dict[str, Any]:
    """
    Ethical screening against AAOIFI-style criteria.

    Two of the four standard screens can be run from the data available:
    business activity (from sector) and leverage (derived above). The other two
    — interest-bearing cash and accounts receivable, each against market cap —
    need balance-sheet lines this platform does not carry.

    Those two are reported as `unverified`, not as passes. A screen that
    silently treats "cannot check" as "clean" would hand someone a compliance
    verdict the data never supported, which for a user screening on religious
    grounds is a serious thing to get wrong.
    """
    sector = data.get("sector")
    checks: list[dict[str, Any]] = []

    # ── Business activity ────────────────────────────────────────
    excluded_reason = SHARIAH_EXCLUDED_SECTORS.get(str(sector or ""))
    checks.append({
        "key": "business_activity",
        "label": "Business activity",
        "status": "FAIL" if excluded_reason else "PASS",
        "detail": (
            f"{sector}: {excluded_reason}."
            if excluded_reason
            else f"{sector or 'Sector unknown'} is not on the excluded-activity list."
        ),
    })

    # ── Leverage ─────────────────────────────────────────────────
    ratio = debt_to_market_cap(_f(data.get("debtToEquity")), _f(data.get("pb")))
    if ratio is None:
        checks.append({
            "key": "debt",
            "label": "Interest-bearing debt below one third of market cap",
            "status": "UNVERIFIED",
            "detail": "Debt-to-equity or price-to-book is unavailable, so leverage cannot be tested.",
        })
    else:
        passed = ratio < SHARIAH_DEBT_LIMIT
        checks.append({
            "key": "debt",
            "label": "Interest-bearing debt below one third of market cap",
            "status": "PASS" if passed else "FAIL",
            "detail": (
                f"Debt is {ratio * 100:.1f}% of market capitalisation "
                f"(limit {SHARIAH_DEBT_LIMIT * 100:.0f}%), derived from D/E ÷ P/B."
            ),
        })

    # ── The two that cannot be run ───────────────────────────────
    for key, label in (
        ("cash", "Interest-bearing cash and securities below one third of market cap"),
        ("receivables", "Accounts receivable below one third of market cap"),
    ):
        checks.append({
            "key": key,
            "label": label,
            "status": "UNVERIFIED",
            "detail": "The balance-sheet line this screen needs is not in the available data.",
        })

    failed = [c for c in checks if c["status"] == "FAIL"]
    unverified = [c for c in checks if c["status"] == "UNVERIFIED"]

    if failed:
        verdict = "FAIL"
        summary = (
            f"Fails {len(failed)} screen(s): {failed[0]['detail']} "
            "This company would be excluded under a standard Shariah screen."
        )
    elif unverified:
        verdict = "UNVERIFIED"
        summary = (
            f"Passes the {len(checks) - len(unverified)} screen(s) that can be run, but "
            f"{len(unverified)} could not be tested from the available data. "
            "This is not a compliance verdict — confirm against a certified screening service "
            "before relying on it."
        )
    else:
        verdict = "PASS"
        summary = "Passes every screen that was run."

    return {
        "verdict": verdict,
        "checks": checks,
        "passed": len([c for c in checks if c["status"] == "PASS"]),
        "failed": len(failed),
        "unverified": len(unverified),
        "summary": summary,
        "note": (
            "Screening follows AAOIFI-style criteria. It is an aid, not a fatwa, and the "
            "thresholds vary between standards."
        ),
    }


# ─────────────────────────────────────────────────────────────────
#  Style classification
# ─────────────────────────────────────────────────────────────────


def classify_styles(data: dict[str, Any], scores: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Which investment styles this name actually fits.

    Membership is earned against stated thresholds rather than assigned by
    sector or size. A name can qualify for several — a cheap, growing, dividend
    payer is genuinely all three, and forcing a single label would discard
    exactly the information that makes it interesting.
    """
    pe = _f(data.get("pe"))
    pb = _f(data.get("pb"))
    industry_pe = _f(data.get("industryPe"))
    dividend = _f(data.get("dividendYield"))
    revenue_growth = _f(data.get("revenueGrowth"))
    profit_growth = _f(data.get("profitGrowth"))
    roe = _f(data.get("roe"))
    debt = _f(data.get("debtToEquity"))
    peg = peg_ratio(pe, _f(data.get("epsGrowth")) or profit_growth)

    out: list[dict[str, Any]] = []

    def add(style: str, fits: bool, reason: str) -> None:
        if fits:
            out.append({"style": style, "reason": reason})

    # ── Value ────────────────────────────────────────────────────
    cheap_vs_industry = pe is not None and industry_pe is not None and pe < industry_pe * 0.85
    cheap_absolute = pe is not None and pe < 18 and (pb is None or pb < 3)
    add(
        "VALUE",
        bool(cheap_vs_industry or cheap_absolute),
        (
            f"P/E {pe:.1f} against an industry {industry_pe:.1f}"
            if cheap_vs_industry and pe and industry_pe
            else f"P/E {pe:.1f} with P/B {pb:.1f}" if pe and pb
            else "Trades below typical valuation multiples"
        ),
    )

    # ── Growth ───────────────────────────────────────────────────
    growing = (revenue_growth or 0) > 12 and (profit_growth or 0) > 12
    add(
        "GROWTH",
        growing,
        f"Revenue +{revenue_growth:.0f}% and profit +{profit_growth:.0f}% year on year"
        if revenue_growth and profit_growth
        else "Sustained double-digit growth",
    )

    # ── Dividend ─────────────────────────────────────────────────
    add(
        "DIVIDEND",
        (dividend or 0) >= 2.0,
        f"Yields {dividend:.2f}%" if dividend else "Pays a meaningful dividend",
    )

    # ── Quality ──────────────────────────────────────────────────
    quality = (roe or 0) >= 15 and (debt is None or debt < 1.0)
    add(
        "QUALITY",
        quality,
        f"ROE {roe:.0f}% with debt-to-equity {debt:.2f}" if roe and debt is not None
        else f"ROE {roe:.0f}%" if roe else "Strong returns on capital",
    )

    # ── Horizon ──────────────────────────────────────────────────
    #
    # Horizon follows from what the case rests on, not from a preference. A
    # thesis that needs years of compounding to pay off is a long-term holding
    # whether or not anyone wanted one.
    investment_score = float(scores.get("investment") or 50.0)
    health = float(scores.get("financialHealth") or scores.get("health") or 50.0)

    add(
        "LONG_TERM",
        investment_score >= 60 and health >= 55,
        "Business quality and balance sheet support a multi-year hold",
    )
    add(
        "MEDIUM_TERM",
        50 <= investment_score < 75 and (peg is None or peg < 2.5),
        "Reasonable quality at a price that needs one to three years to work through",
    )
    add(
        "SHORT_TERM",
        bool(cheap_vs_industry and (profit_growth or 0) > 0 and investment_score >= 55),
        "Valuation gap against peers that could close without waiting years",
    )

    return out


# ─────────────────────────────────────────────────────────────────
#  Recommendation
# ─────────────────────────────────────────────────────────────────


def _target_range(data: dict[str, Any], price: float | None) -> dict[str, Any] | None:
    """
    Target range from earnings and a justified multiple.

    Anchored on the industry multiple where one exists, adjusted for how the
    company's returns compare. Deliberately a range: a single target price
    implies a precision that a forward multiple cannot support.
    """
    eps = _f(data.get("eps"))
    industry_pe = _f(data.get("industryPe"))
    pe = _f(data.get("pe"))
    roe = _f(data.get("roe"))
    growth = _f(data.get("epsGrowth")) or _f(data.get("profitGrowth"))

    anchor = industry_pe or pe
    if eps is None or eps <= 0 or anchor is None or anchor <= 0:
        return None

    # A business earning materially more on equity than its peers has earned a
    # premium multiple; one earning less has not.
    premium = 1.0
    if roe is not None:
        if roe >= 20:
            premium = 1.15
        elif roe >= 15:
            premium = 1.05
        elif roe < 10:
            premium = 0.85

    justified = anchor * premium
    # One forward year of earnings, when growth is known and positive.
    forward_eps = eps * (1 + min(max(growth or 0.0, 0.0), 30.0) / 100.0)

    low = eps * justified * 0.9
    high = forward_eps * justified * 1.1
    mid = (low + high) / 2

    upside = ((mid - price) / price * 100.0) if price and price > 0 else None

    return {
        "low": round(low, 2),
        "high": round(high, 2),
        "mid": round(mid, 2),
        "upsidePercent": round(upside, 1) if upside is not None else None,
        "basis": (
            f"{justified:.1f}× earnings "
            f"({'industry' if industry_pe else 'current'} multiple"
            f"{f', {premium:.2f}× for ROE {roe:.0f}%' if premium != 1.0 and roe else ''})"
            f" on EPS {eps:.2f}"
            + (f" growing to {forward_eps:.2f}" if forward_eps > eps else "")
        ),
        "caveat": (
            "A multiple-based range, not a forecast. It assumes the industry re-rates nothing "
            "and that earnings arrive as expected — both of which are assumptions, not facts."
        ),
    }


def _data_quality(data: dict[str, Any]) -> dict[str, Any]:
    """What was available, and what was not."""
    expected = {
        "pe": "P/E ratio",
        "pb": "P/B ratio",
        "roe": "Return on equity",
        "debtToEquity": "Debt-to-equity",
        "revenueGrowth": "Revenue growth",
        "profitGrowth": "Profit growth",
        "dividendYield": "Dividend yield",
        "marketCap": "Market capitalisation",
        "eps": "Earnings per share",
        "freeCashFlow": "Free cash flow",
        "operatingCashFlow": "Operating cash flow",
        "quarterly": "Quarterly statements",
        "annual": "Annual statements",
    }

    missing = [label for key, label in expected.items() if data.get(key) in (None, [], {})]
    present = len(expected) - len(missing)

    return {
        "fieldsPresent": present,
        "fieldsExpected": len(expected),
        "completeness": round(present / len(expected), 3),
        "missing": missing,
        # Named explicitly because their absence changes what can be concluded,
        # not merely how confident the conclusion is.
        "unavailableAnalyses": [
            item
            for item, needed in (
                ("Free cash flow quality", "freeCashFlow"),
                ("Earnings trend across quarters", "quarterly"),
                ("Multi-year track record", "annual"),
            )
            if data.get(needed) in (None, [], {})
        ],
        "note": (
            "Insider transactions, economic moat and management quality are not assessed — "
            "this platform carries no data source for them, and inferring them from financials "
            "would be presenting an opinion as a measurement."
        ),
    }


def analyse(
    data: dict[str, Any],
    scores: dict[str, Any],
    *,
    price: float | None = None,
    technical: dict[str, Any] | None = None,
    peers: list[dict[str, Any]] | None = None,
    ethical_mode: bool = False,
) -> dict[str, Any]:
    """
    Full investment view for one instrument.

    `scores` is the output of `fundamentals.score`, reused rather than
    recomputed so the investment view and the fundamentals tab can never
    disagree about the same company.
    """
    investment_score = float(scores.get("investment") or 50.0)
    quality = float(scores.get("quality") or 50.0)
    valuation = float(scores.get("valuation") or 50.0)
    growth = float(scores.get("growth") or 50.0)
    health = float(scores.get("financialHealth") or scores.get("health") or 50.0)

    quality_report = _data_quality(data)
    styles = classify_styles(data, scores)
    shariah = shariah_screen(data)
    targets = _target_range(data, price)

    # ── Technical timing overlay ─────────────────────────────────
    #
    # Fundamentals decide *whether*, technicals decide *when*. A good business
    # in a downtrend is still a good business, but buying it today and buying
    # it after the trend turns are different decisions with the same thesis.
    trend = (technical or {}).get("trend", {}).get("direction") if technical else None
    timing_adjustment = 0
    timing_note = "No technical read available; the recommendation rests on fundamentals alone."

    if trend == "UPTREND":
        timing_adjustment = 1
        timing_note = "Price trend is constructive, so a position can be built without waiting."
    elif trend == "DOWNTREND":
        timing_adjustment = -1
        timing_note = (
            "Price is in a downtrend. The thesis is unaffected, but staging entries beats "
            "committing in full into falling prices."
        )
    elif trend == "SIDEWAYS":
        timing_note = "Price is range-bound — no timing signal either way."

    # ── Recommendation ───────────────────────────────────────────
    if investment_score >= 72:
        base = "BUY"
    elif investment_score >= 60:
        base = "ACCUMULATE"
    elif investment_score >= 45:
        base = "HOLD"
    elif investment_score >= 32:
        base = "REDUCE"
    else:
        base = "SELL"

    index = RECOMMENDATIONS.index(base)
    # A downtrend can only soften a buy to an accumulate; it never turns a good
    # business into a sell, and an uptrend never turns a poor one into a buy.
    if timing_adjustment < 0 and index == 0:
        index = 1
    elif timing_adjustment > 0 and index == 1 and investment_score >= 68:
        index = 0
    recommendation = RECOMMENDATIONS[index]

    # Ethical mode is a filter, not a score adjustment. A company that fails a
    # screen the user asked for is not a weaker buy, it is not a candidate.
    ethical_blocked = ethical_mode and shariah["verdict"] == "FAIL"
    if ethical_blocked:
        recommendation = "SELL" if base in ("BUY", "ACCUMULATE", "HOLD") else base

    # ── Risk ─────────────────────────────────────────────────────
    pledge = _f(data.get("promoterPledge")) or 0.0
    debt = _f(data.get("debtToEquity"))
    risk_points = 0
    risk_reasons: list[str] = []

    if health < 45:
        risk_points += 2
        risk_reasons.append("Balance sheet scores below average")
    if debt is not None and debt > 1.5:
        risk_points += 2
        risk_reasons.append(f"Debt-to-equity of {debt:.2f} is high")
    if pledge > 25:
        risk_points += 2
        risk_reasons.append(f"{pledge:.0f}% of promoter holding is pledged")
    elif pledge > 10:
        risk_points += 1
        risk_reasons.append(f"{pledge:.0f}% promoter pledge")
    if valuation < 35:
        risk_points += 1
        risk_reasons.append("Valuation is demanding relative to peers")
    if quality_report["completeness"] < 0.6:
        risk_points += 1
        risk_reasons.append("A material share of the usual inputs is unavailable")

    risk_level = "LOW" if risk_points <= 1 else "MEDIUM" if risk_points <= 3 else "HIGH"

    # ── Confidence ───────────────────────────────────────────────
    #
    # Distinct from the investment score. The score says how good the case is;
    # confidence says how much the data supports saying anything at all. A
    # brilliant score on 40% of the inputs deserves less weight than a middling
    # one on all of them.
    conviction = abs(investment_score - 50.0) / 50.0
    confidence = float(
        np.clip(
            (0.45 + conviction * 0.35) * (0.5 + quality_report["completeness"] * 0.5) * 100,
            0.0,
            85.0,
        )
    )

    horizon = (
        "3+ years"
        if any(s["style"] == "LONG_TERM" for s in styles)
        else "1–3 years"
        if any(s["style"] == "MEDIUM_TERM" for s in styles)
        else "6–18 months"
    )

    strengths = list(data.get("strengths") or scores.get("strengths") or [])
    concerns = list(data.get("concerns") or scores.get("concerns") or [])
    for reason in risk_reasons:
        if reason not in concerns:
            concerns.append(reason)

    summary = _summarise(
        recommendation=recommendation,
        symbol=str(data.get("symbol", "")),
        investment_score=investment_score,
        risk_level=risk_level,
        horizon=horizon,
        targets=targets,
        timing_note=timing_note,
        styles=styles,
        ethical_blocked=ethical_blocked,
        shariah=shariah,
        quality_report=quality_report,
    )

    return {
        "symbol": data.get("symbol"),
        "recommendation": recommendation,
        "baseRecommendation": base,
        "investmentScore": round(investment_score, 1),
        "confidence": round(confidence, 1),
        "riskLevel": risk_level,
        "riskReasons": risk_reasons,
        "horizon": horizon,
        "styles": styles,
        "scores": {
            "quality": round(quality, 1),
            "valuation": round(valuation, 1),
            "growth": round(growth, 1),
            "financialHealth": round(health, 1),
            "investment": round(investment_score, 1),
        },
        "metrics": {
            "pe": _f(data.get("pe")),
            "pb": _f(data.get("pb")),
            "industryPe": _f(data.get("industryPe")),
            "peg": peg_ratio(_f(data.get("pe")), _f(data.get("epsGrowth")) or _f(data.get("profitGrowth"))),
            "roe": _f(data.get("roe")),
            "roce": _f(data.get("roce")),
            "debtToEquity": _f(data.get("debtToEquity")),
            "debtToMarketCap": debt_to_market_cap(_f(data.get("debtToEquity")), _f(data.get("pb"))),
            "dividendYield": _f(data.get("dividendYield")),
            "netMargin": _f(data.get("netMargin")),
            "operatingMargin": _f(data.get("operatingMargin")),
            "revenueGrowth": _f(data.get("revenueGrowth")),
            "profitGrowth": _f(data.get("profitGrowth")),
            "marketCap": _f(data.get("marketCap")),
            "promoterHolding": _f(data.get("promoterHolding")),
            "promoterPledge": _f(data.get("promoterPledge")),
            "fiiHolding": _f(data.get("fiiHolding")),
            "diiHolding": _f(data.get("diiHolding")),
        },
        "targetRange": targets,
        "timing": {"trend": trend, "note": timing_note},
        "shariah": shariah,
        "ethicalBlocked": ethical_blocked,
        "peers": _peer_context(data, peers),
        "strengths": strengths[:6],
        "risks": concerns[:6],
        "dataQuality": quality_report,
        "summary": summary,
        "disclaimer": (
            "Long-term investment analysis, not a trading signal and not investment advice. "
            "Scores are derived from reported financials, which are historical."
        ),
    }


def _peer_context(data: dict[str, Any], peers: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Where this name sits against its sector, when a peer set was supplied."""
    if not peers:
        return {
            "available": False,
            "note": "No peer set supplied, so no industry comparison was made.",
        }

    symbol = data.get("symbol")
    others = [p for p in peers if p.get("symbol") != symbol]
    if not others:
        return {"available": False, "note": "No peers found in this sector."}

    def rank(field: str, higher_better: bool) -> dict[str, Any] | None:
        value = _f(data.get(field))
        values = [_f(p.get(field)) for p in others]
        values = [v for v in values if v is not None]
        if value is None or not values:
            return None
        better = sum(1 for v in values if (value > v) == higher_better)
        return {
            "field": field,
            "value": round(value, 3),
            "peerMedian": round(float(np.median(values)), 3),
            "percentile": round(better / len(values) * 100, 0),
        }

    comparisons = [
        c
        for c in (
            rank("roe", True),
            rank("pe", False),
            rank("debtToEquity", False),
            rank("netMargin", True),
            rank("revenueGrowth", True),
        )
        if c is not None
    ]

    return {
        "available": True,
        "peerCount": len(others),
        "sector": data.get("sector"),
        "comparisons": comparisons,
        "note": f"Compared against {len(others)} names in {data.get('sector') or 'the same sector'}.",
    }


def _summarise(**kwargs: Any) -> str:
    recommendation = kwargs["recommendation"]
    symbol = kwargs["symbol"]
    score = kwargs["investment_score"]
    risk = kwargs["risk_level"]
    horizon = kwargs["horizon"]
    targets = kwargs["targets"]
    styles = kwargs["styles"]
    quality_report = kwargs["quality_report"]

    if kwargs["ethical_blocked"]:
        return (
            f"{symbol} fails the ethical screen you enabled, so it is excluded regardless of its "
            f"financials — which score {score:.0f}/100. {kwargs['shariah']['summary']}"
        )

    parts = [
        f"{recommendation.title()} — {symbol} scores {score:.0f}/100 on the investment blend, "
        f"{risk.lower()} risk, suited to a {horizon} horizon."
    ]

    if styles:
        labels = ", ".join(s["style"].replace("_", " ").lower() for s in styles[:3])
        parts.append(f"Fits {labels}.")

    if targets and targets.get("upsidePercent") is not None:
        parts.append(
            f"A {targets['basis']} implies {targets['low']:.0f}–{targets['high']:.0f}, "
            f"{targets['upsidePercent']:+.0f}% from here."
        )

    parts.append(kwargs["timing_note"])

    if quality_report["unavailableAnalyses"]:
        parts.append(
            f"Not assessed for lack of data: {', '.join(quality_report['unavailableAnalyses']).lower()}."
        )

    return " ".join(parts)
