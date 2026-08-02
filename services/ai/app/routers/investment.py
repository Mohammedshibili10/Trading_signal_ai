"""
Investment analysis endpoints.

Separate from the trading routes on purpose. These answer a different question
on a different horizon, and keeping the surfaces apart is what stops a
long-term recommendation being read as a trade signal.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..engine import fundamentals as fundamentals_engine
from ..engine import investment as investment_engine
from ..engine import portfolio_health
from ..schemas import InvestmentRequest, InvestmentScreenRequest, PortfolioHealthRequest
from ..security import require_service_token

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/investment", tags=["investment"], dependencies=[Depends(require_service_token)]
)


@router.post("")
async def analyse(request: InvestmentRequest) -> dict[str, Any]:
    """
    Full investment view: recommendation, scores, styles, targets, screening.

    Fundamentals are scored first and that result is reused, so this view and
    the fundamentals tab cannot report different numbers for the same company.
    """
    try:
        scores = await asyncio.to_thread(fundamentals_engine.score, request.data)
        return await asyncio.to_thread(
            investment_engine.analyse,
            request.data,
            scores.get("scores", scores),
            price=request.price,
            technical=request.technical,
            peers=request.peers,
            ethical_mode=request.ethicalMode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("investment analysis failed")
        raise HTTPException(status_code=500, detail=f"Investment analysis failed: {exc}") from exc


@router.post("/screen")
async def screen(request: InvestmentScreenRequest) -> dict[str, Any]:
    """
    Rank a universe by investment merit.

    Filtering by style narrows to names that actually qualify for it rather
    than sorting everything and relabelling the top of the list.
    """
    try:
        results: list[dict[str, Any]] = []
        excluded = 0

        for candidate in request.candidates:
            try:
                scores = fundamentals_engine.score(candidate)
                view = investment_engine.analyse(
                    candidate,
                    scores.get("scores", scores),
                    price=candidate.get("price"),
                    ethical_mode=request.ethicalMode,
                )
            except Exception:  # noqa: BLE001 — one bad row must not fail the screen
                continue

            if request.ethicalMode and view["ethicalBlocked"]:
                excluded += 1
                continue

            if request.style:
                styles = {s["style"] for s in view["styles"]}
                if request.style.upper() not in styles:
                    continue

            results.append({
                "symbol": view["symbol"],
                "recommendation": view["recommendation"],
                "investmentScore": view["investmentScore"],
                "confidence": view["confidence"],
                "riskLevel": view["riskLevel"],
                "horizon": view["horizon"],
                "styles": [s["style"] for s in view["styles"]],
                "metrics": view["metrics"],
                "targetRange": view["targetRange"],
                "shariahVerdict": view["shariah"]["verdict"],
                "dataCompleteness": view["dataQuality"]["completeness"],
                "summary": view["summary"],
            })

        results.sort(key=lambda r: -r["investmentScore"])

        return {
            "results": results[: request.limit],
            "scanned": len(request.candidates),
            "matched": len(results),
            "excludedByEthicalScreen": excluded,
            "style": request.style,
        }
    except Exception as exc:  # noqa: BLE001
        log.exception("investment screen failed")
        raise HTTPException(status_code=500, detail=f"Screen failed: {exc}") from exc


@router.post("/portfolio")
async def portfolio(request: PortfolioHealthRequest) -> dict[str, Any]:
    """Portfolio health, diversification and rebalancing observations."""
    try:
        return await asyncio.to_thread(
            portfolio_health.analyse,
            request.holdings,
            correlation_penalty=request.correlationPenalty,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("portfolio health failed")
        raise HTTPException(status_code=500, detail=f"Portfolio health failed: {exc}") from exc
