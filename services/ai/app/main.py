"""
FastAPI application.

The analysis service. Stateless by design — it holds no user data and no
database connection, it receives candles and returns analysis. That makes it
trivially horizontally scalable and keeps every piece of user state in the
NestJS API where the auth and audit trail live.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .routers import analysis, assistant, investment, review, risk, tools

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)
log = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("%s v%s starting", settings.app_name, settings.version)
    log.info("FinBERT: %s", "enabled" if settings.enable_finbert else "disabled (finance lexicon)")
    log.info("Assistant: %s", "Gemini" if settings.gemini_api_key else "deterministic templates")

    if settings.enable_finbert:
        # Warm the model at boot so the first user request isn't the one that
        # pays the ~30s download and load cost.
        from .engine.sentiment import _finbert

        try:
            _finbert()
        except Exception:  # noqa: BLE001
            log.warning("FinBERT warm-up failed; continuing with the lexicon", exc_info=True)

    yield
    log.info("shutting down")


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description=(
        "Technical, price-action and smart-money analysis, per-candle forecasting with "
        "walk-forward calibration, risk management, backtesting and sentiment for Indian "
        "equities, forex, crypto and investment products."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
)

# Only the NestJS API calls this service, and it does so server-side. CORS stays
# closed rather than being opened "just in case".
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def timing(request: Request, call_next):
    """Attach server timing so slow analyses are visible without a profiler."""
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.1f}"
    if elapsed_ms > 3000:
        log.warning("slow request %s %s took %.0fms", request.method, request.url.path, elapsed_ms)
    return response


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    """Domain validation errors are the caller's fault — 422, not 500."""
    return JSONResponse(status_code=422, content={"detail": str(exc)})


app.include_router(analysis.router)
app.include_router(review.router)
app.include_router(investment.router)
app.include_router(risk.router)
app.include_router(tools.router)
app.include_router(assistant.router)


@app.get("/health", tags=["meta"])
async def health() -> dict[str, object]:
    """Liveness probe. Unauthenticated so orchestrators can reach it."""
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": settings.version,
        "finbert": settings.enable_finbert,
        "assistant": "gemini" if settings.gemini_api_key else "template",
    }


@app.get("/config", tags=["meta"])
async def engine_config() -> dict[str, object]:
    """
    The engine's tuning constants.

    Exposed deliberately: every probability the platform reports depends on
    these, so they should be inspectable rather than buried. Shown in the admin
    panel.
    """
    from .engine.factors import BASE_WEIGHTS

    return {
        "factorWeights": BASE_WEIGHTS,
        "logisticK": settings.logistic_k,
        "maxConfidence": settings.max_confidence,
        "minSignalConfidence": settings.min_signal_confidence,
        "minRiskReward": settings.min_risk_reward,
        "maxStopDistancePercent": settings.max_stop_distance_percent,
        "minBars": settings.min_bars,
        "calibrationWindow": settings.calibration_window,
        "calibrationMinSamples": settings.calibration_min_samples,
        "highConfidenceThreshold": settings.high_confidence_threshold,
        "documentation": "docs/signal-methodology.md",
    }
