"""
Post-trade review: post-mortems, factor attribution, adaptive weights.

Separated from the analysis router because the lifecycle is different. Analysis
is per-request and latency-sensitive; this runs after the fact, on a schedule,
over the accumulated record — and is allowed to be slow because nobody is
waiting on it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..engine import attribution, learning, postmortem, precedent, revalidation
from ..engine.factors import BASE_WEIGHTS
from ..schemas import (
    AttributionRequest,
    PostMortemRequest,
    PrecedentRequest,
    RevalidationRequest,
)
from ..security import require_service_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/review", tags=["review"], dependencies=[Depends(require_service_token)])


@router.post("/postmortem")
async def post_mortem(request: PostMortemRequest) -> dict[str, Any]:
    """Diagnose one resolved trade — what happened, and why."""
    try:
        return await asyncio.to_thread(
            postmortem.analyse,
            request.signal,
            [c.model_dump() for c in request.candlesAfterEntry],
            volatility_percentile=request.volatilityPercentile,
            volume_ratio=request.volumeRatio,
            had_news=request.hadNews,
            candles_after_exit=[c.model_dump() for c in request.candlesAfterExit],
            health_findings=request.healthFindings,
            invalidation_reason=request.invalidationReason,
            confidence_at_end=request.confidenceAtEnd,
            entry_filled=request.entryFilled,
            target=request.target,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("post-mortem failed")
        raise HTTPException(status_code=500, detail=f"Post-mortem failed: {exc}") from exc


@router.post("/attribution")
async def attribute(request: AttributionRequest) -> dict[str, Any]:
    """
    Measure factor performance, propose weights, and validate them.

    The proposal is only marked applied when it beats the current weights on
    holdout trades it was not fitted to. Everything needed to disagree with that
    verdict is returned alongside it.
    """
    try:
        base = request.baseWeights or dict(BASE_WEIGHTS)

        performance = await asyncio.to_thread(attribution.measure, request.trades)
        proposal = attribution.propose(base, performance, total_trades=len(request.trades))

        # Only validate a proposal that actually changes something.
        if proposal["changes"]:
            proposal = await asyncio.to_thread(
                attribution.validate, proposal, request.holdout, base
            )

        failures = attribution.failure_breakdown(request.postMortems)
        knowledge = learning.summarise(request.trades)

        return {
            "performance": performance,
            "weights": proposal,
            "failures": failures,
            "learning": knowledge,
            "baseWeights": base,
        }
    except Exception as exc:  # noqa: BLE001
        log.exception("attribution failed")
        raise HTTPException(status_code=500, detail=f"Attribution failed: {exc}") from exc


@router.post("/revalidate")
async def revalidate(request: RevalidationRequest) -> dict[str, Any]:
    """
    Is a live signal's reasoning still true?

    Compares a fresh analysis against the one recorded at issue. Deliberately
    not a fresh opinion in isolation — the question is whether anything has
    *changed*, and that needs both sides.
    """
    try:
        return await asyncio.to_thread(
            revalidation.revalidate,
            request.signal,
            request.current,
            price=request.price,
            economic_events=[e.model_dump() for e in (request.economicEvents or [])],
            news=request.news,
            market_open=request.marketOpen,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("revalidation failed")
        raise HTTPException(status_code=500, detail=f"Revalidation failed: {exc}") from exc


@router.post("/precedent")
async def check_precedent(request: PrecedentRequest) -> dict[str, Any]:
    """
    Has this setup been tried before, and did it work?

    Runs before a signal is issued. Two questions, of which the second matters
    more: what is the base rate for setups like this, and are the specific
    conditions that broke the previous ones present right now?
    """
    try:
        return await asyncio.to_thread(
            precedent.evaluate,
            request.candidate,
            request.history,
            request.context,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("precedent check failed")
        raise HTTPException(status_code=500, detail=f"Precedent check failed: {exc}") from exc
