"""Backtesting, sentiment, fundamentals and investment calculators."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..engine import backtest as backtest_engine
from ..engine import fundamentals as fundamentals_engine
from ..engine import invest as invest_engine
from ..engine import sentiment as sentiment_engine
from ..schemas import (
    BacktestRequest,
    FundamentalsCompareRequest,
    FundamentalsRequest,
    GoalRequest,
    SentimentRequest,
    SipRequest,
)
from ..security import require_service_token

log = logging.getLogger(__name__)

router = APIRouter(tags=["tools"], dependencies=[Depends(require_service_token)])


# ── Backtest ─────────────────────────────────────────────────────


@router.post("/backtest")
async def run_backtest(request: BacktestRequest) -> dict[str, Any]:
    """Run a no-code strategy over historical candles."""
    try:
        return await asyncio.to_thread(
            backtest_engine.run,
            [c.model_dump() for c in request.candles],
            request.strategy,
            symbol=request.symbol,
            initial_capital=request.initialCapital,
            cost_bps=request.costBps,
            slippage_bps=request.slippageBps,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("backtest failed")
        raise HTTPException(status_code=500, detail=f"Backtest failed: {exc}") from exc


# ── Sentiment ────────────────────────────────────────────────────


@router.post("/sentiment")
async def analyse_sentiment(request: SentimentRequest) -> dict[str, Any]:
    """Classify a batch of news items and aggregate them into one reading."""
    scored: list[dict[str, Any]] = []

    for item in request.items:
        text = f"{item.headline}. {item.summary}".strip()
        result = sentiment_engine.analyse_text(text)
        impact = sentiment_engine.impact_of(text, result["score"])
        explanation = sentiment_engine.explain(text, result)

        scored.append({
            "headline": item.headline,
            "source": item.source,
            "ageHours": item.ageHours,
            "stance": result["stance"],
            "score": result["score"],
            "confidence": result["confidence"],
            "impact": impact,
            "model": result["model"],
            "matches": result.get("matches", []),
            **explanation,
        })

    aggregate = sentiment_engine.aggregate(scored)
    return {"symbol": request.symbol, "items": scored, "aggregate": aggregate}


# ── Fundamentals ─────────────────────────────────────────────────


@router.post("/fundamentals/score")
async def score_fundamentals(request: FundamentalsRequest) -> dict[str, Any]:
    """Quality / valuation / growth / health scores and a long-term rating."""
    try:
        return fundamentals_engine.score(request.data)
    except Exception as exc:  # noqa: BLE001
        log.exception("fundamentals scoring failed")
        raise HTTPException(status_code=500, detail=f"Scoring failed: {exc}") from exc


@router.post("/fundamentals/compare")
async def compare_fundamentals(request: FundamentalsCompareRequest) -> dict[str, Any]:
    """Rank a peer set. Backs the strong-fundamentals scanner."""
    return {"ranked": fundamentals_engine.compare(request.candidates)}


# ── Investment calculators ───────────────────────────────────────


@router.post("/invest/sip")
async def sip(request: SipRequest) -> dict[str, Any]:
    return invest_engine.sip_projection(
        monthly_amount=request.monthlyAmount,
        years=request.years,
        expected_return=request.expectedReturn,
        step_up_percent=request.stepUpPercent,
        inflation_rate=request.inflationRate,
    )


@router.post("/invest/goal")
async def goal(request: GoalRequest) -> dict[str, Any]:
    return invest_engine.goal_plan(
        name=request.name,
        target_amount=request.targetAmount,
        current_savings=request.currentSavings,
        years=request.years,
        expected_return=request.expectedReturn,
        inflation_rate=request.inflationRate,
    )


@router.post("/invest/retirement")
async def retirement(payload: dict[str, Any]) -> dict[str, Any]:
    """Corpus required at retirement and the SIP needed to reach it."""
    try:
        return invest_engine.retirement_plan(
            current_age=int(payload.get("currentAge", 30)),
            retirement_age=int(payload.get("retirementAge", 60)),
            monthly_expenses=float(payload.get("monthlyExpenses", 50_000)),
            current_corpus=float(payload.get("currentCorpus", 0)),
            inflation_rate=float(payload.get("inflationRate", 6)),
            pre_return=float(payload.get("preReturn", 12)),
            post_return=float(payload.get("postReturn", 8)),
            life_expectancy=int(payload.get("lifeExpectancy", 85)),
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid input: {exc}") from exc


@router.get("/invest/allocation/{years}")
async def allocation(years: int) -> dict[str, Any]:
    """Suggested asset allocation for a given horizon."""
    if years < 1 or years > 60:
        raise HTTPException(status_code=422, detail="Horizon must be between 1 and 60 years")
    return {"years": years, "allocation": invest_engine.suggest_allocation(years)}
