"""Risk management endpoints."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends

from ..engine import risk as risk_engine
from ..schemas import (
    AtrStopRequest,
    KellyRequest,
    MonteCarloRequest,
    PortfolioRiskRequest,
    PositionSizeRequest,
    TrailingStopRequest,
)
from ..security import require_service_token

router = APIRouter(prefix="/risk", tags=["risk"], dependencies=[Depends(require_service_token)])


@router.post("/position-size")
async def position_size(request: PositionSizeRequest) -> dict[str, Any]:
    """Size a position from the stop distance and risk budget."""
    return risk_engine.position_size(
        capital=request.capital,
        risk_percent=request.riskPercent,
        entry=request.entry,
        stop_loss=request.stopLoss,
        target=request.target,
        lot_size=request.lotSize,
    )


@router.post("/kelly")
async def kelly(request: KellyRequest) -> dict[str, Any]:
    return risk_engine.kelly_fraction(request.winRate, request.averageWin, request.averageLoss)


@router.post("/monte-carlo")
async def monte_carlo(request: MonteCarloRequest) -> dict[str, Any]:
    """Bootstrap the distribution of outcomes from historical trades."""
    return await asyncio.to_thread(
        risk_engine.monte_carlo,
        trade_returns=request.tradeReturns,
        starting_capital=request.startingCapital,
        simulations=request.simulations,
        horizon=request.horizon,
    )


@router.post("/portfolio")
async def portfolio(request: PortfolioRiskRequest) -> dict[str, Any]:
    return await asyncio.to_thread(
        risk_engine.portfolio_risk,
        holdings=request.holdings,
        returns_by_symbol=request.returnsBySymbol,
        benchmark_returns=request.benchmarkReturns,
        risk_free_rate=request.riskFreeRate,
    )


@router.post("/atr-stop")
async def atr_stop(request: AtrStopRequest) -> dict[str, Any]:
    return risk_engine.atr_stop(
        request.entry, request.atr, multiplier=request.multiplier, long=request.long
    )


@router.post("/trailing-stop")
async def trailing_stop(request: TrailingStopRequest) -> dict[str, Any]:
    return risk_engine.trailing_stop(
        entry=request.entry,
        current_price=request.currentPrice,
        highest=request.highest,
        atr=request.atr,
        multiplier=request.multiplier,
        long=request.long,
    )
