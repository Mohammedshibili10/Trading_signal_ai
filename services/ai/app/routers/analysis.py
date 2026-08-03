"""Analysis, forecast and signal endpoints."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..engine import (
    checklist,
    confluence_score,
    correlation as correlation_engine,
    learning,
    mtf,
    notrade,
    pipeline,
    sentiment as sentiment_engine,
    sessions,
)
from ..schemas import (
    AnalysisRequest,
    BatchSignalRequest,
    ConfluenceRequest,
    ConfluenceSignalRequest,
    ForecastHistoryRequest,
)
from ..security import require_service_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/analysis", tags=["analysis"], dependencies=[Depends(require_service_token)])


def _sentiment_from(request: AnalysisRequest) -> dict[str, Any] | None:
    """Score and aggregate any news attached to the request."""
    if not request.news:
        return None

    scored = []
    for item in request.news:
        text = f"{item.headline}. {item.summary}".strip()
        result = sentiment_engine.analyse_text(text)
        scored.append({
            "score": result["score"],
            "confidence": result["confidence"],
            "impact": sentiment_engine.impact_of(text, result["score"]),
            "ageHours": item.ageHours,
        })

    aggregated = sentiment_engine.aggregate(scored)
    # The factor engine expects a −1…+1 style score; aggregate returns −100…100.
    return {**aggregated, "score": aggregated["score"]}


def _run(request: AnalysisRequest) -> dict[str, Any]:
    return pipeline.analyse(
        [c.model_dump() for c in request.candles],
        symbol=request.symbol,
        name=request.name,
        asset_class=request.assetClass,
        timeframe=request.timeframe,
        higher_tf_candles=(
            [c.model_dump() for c in request.higherTimeframeCandles]
            if request.higherTimeframeCandles
            else None
        ),
        sentiment=_sentiment_from(request),
        fundamentals=request.fundamentals,
        risk_per_trade=request.riskPerTradePercent,
        with_calibration=request.withCalibration,
        precomputed_calibration=request.calibration,
        factor_weights=request.factorWeights,
        # Passed separately because `to_frame` keeps only OHLCV — the taker-side
        # fields would be dropped on the way in otherwise.
        raw_candles=[c.model_dump() for c in request.candles],
        order_book=request.orderBook.model_dump() if request.orderBook else None,
        derivatives=request.derivatives.model_dump() if request.derivatives else None,
    )


@router.post("")
async def analyse(request: AnalysisRequest) -> dict[str, Any]:
    """
    Full analysis: technical, price action, SMC, patterns, candle anatomy,
    next-candle forecast, calibration and the trade signal.

    Runs in a worker thread — the pipeline is CPU-bound numpy work and would
    otherwise block the event loop for every other request.
    """
    try:
        return await asyncio.to_thread(_run, request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("analysis failed for %s %s", request.symbol, request.timeframe)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


@router.post("/forecast")
async def forecast_only(request: AnalysisRequest) -> dict[str, Any]:
    """Just the next-candle forecast — lighter payload for the dashboard."""
    try:
        result = await asyncio.to_thread(_run, request)
        return {
            "symbol": result["symbol"],
            "timeframe": result["timeframe"],
            "price": result["price"],
            "forecast": result["forecast"],
            "candleAnatomy": result["candleAnatomy"],
            "candleDescription": result["candleDescription"],
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("forecast failed for %s", request.symbol)
        raise HTTPException(status_code=500, detail=f"Forecast failed: {exc}") from exc


@router.post("/forecast/history")
async def forecast_history(request: ForecastHistoryRequest) -> dict[str, Any]:
    """
    Per-candle anatomy, the forecast the engine would have made at each bar, and
    what actually happened next.

    Powers the candle-by-candle view. The misses are shown alongside the hits —
    a prediction log you can only see the wins in is worthless.
    """
    try:
        history = await asyncio.to_thread(
            pipeline.forecast_history,
            [c.model_dump() for c in request.candles],
            symbol=request.symbol,
            asset_class=request.assetClass,
            timeframe=request.timeframe,
            lookback=request.lookback,
        )

        graded = [h for h in history if h.get("correct") is not None]
        hits = sum(1 for h in graded if h["correct"])

        return {
            "symbol": request.symbol,
            "timeframe": request.timeframe,
            "candles": history,
            "summary": {
                "scored": len(graded),
                "correct": hits,
                "hitRate": round(hits / len(graded), 4) if graded else None,
                "note": (
                    f"{hits} of {len(graded)} directional calls resolved correctly over this window."
                    if graded
                    else "Not enough resolved bars to report a hit-rate."
                ),
            },
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("forecast history failed for %s", request.symbol)
        raise HTTPException(status_code=500, detail=f"Forecast history failed: {exc}") from exc


@router.post("/confluence")
async def confluence(request: ConfluenceRequest) -> dict[str, Any]:
    """
    Read every supplied timeframe and report whether they agree.

    Standalone — no signal, no trade plan. Useful on its own for answering
    "is this instrument's structure consistent right now?" before looking at a
    setup at all.
    """
    try:
        candles = {
            timeframe: [c.model_dump() for c in series]
            for timeframe, series in request.candlesByTimeframe.items()
        }
        return await asyncio.to_thread(
            mtf.analyse,
            candles,
            horizon=request.horizon,
            setup_timeframe=request.setupTimeframe,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("confluence failed for %s", request.symbol)
        raise HTTPException(status_code=500, detail=f"Confluence failed: {exc}") from exc


@router.post("/signal/confluence")
async def confluence_signal(request: ConfluenceSignalRequest) -> dict[str, Any]:
    """
    Full analysis, gated on multi-timeframe agreement.

    This is the strict path: the setup is analysed normally, then every other
    timeframe is read, and the signal only survives if they agree. When they
    conflict the action is forced to WAIT with the conflict stated — not
    softened into a low-confidence BUY, which is how a filter gets ignored.

    Confidence is adjusted either way, so an aligned setup is also *reported* as
    better than an isolated one rather than merely being allowed through.
    """
    try:
        result = await asyncio.to_thread(_run, request)

        candles = {
            timeframe: [c.model_dump() for c in series]
            for timeframe, series in request.candlesByTimeframe.items()
        }
        # The setup's own timeframe is part of the vote; the caller need not
        # send it twice.
        candles.setdefault(request.timeframe, [c.model_dump() for c in request.candles])

        agreement = await asyncio.to_thread(
            mtf.analyse,
            candles,
            horizon=request.horizon,
            setup_timeframe=request.timeframe,
        )

        signal = result.get("signal") or {}
        original_action = signal.get("action")
        original_confidence = float(signal.get("confidence") or 0.0)

        # The six-condition pre-trade checklist, evaluated against this exact
        # analysis. Separate from the weighted blend on purpose: the blend says
        # how bullish it looks, the checklist says whether anything confirms it.
        review = checklist.evaluate(
            result,
            action=original_action or "WAIT",
            confluence=agreement,
            economic_events=request.economicEvents,
        )

        # ── The four state gates ─────────────────────────────────
        # Each answers a question the chart cannot: is the clock helping, is the
        # market in a workable state, is this a new bet, and has this engine
        # actually performed on this instrument?
        if request.applySessionFilter:
            session = sessions.filter_result(request.assetClass)
            if not session["allowed"]:
                session["nextWindow"] = sessions.next_good_window(request.assetClass)
        else:
            session = {
                "allowed": True,
                "confidenceMultiplier": 1.0,
                "reason": "Session filter disabled for this request.",
                "session": None,
                "label": "Not applied",
            }

        market_state = notrade.detect(result)

        knowledge = learning.summarise([o.model_dump() for o in request.outcomes])
        learned = learning.adjustment(
            knowledge, symbol=request.symbol, timeframe=request.timeframe
        )

        related = correlation_engine.check(
            {
                "symbol": request.symbol,
                "assetClass": request.assetClass,
                "sector": (request.fundamentals or {}).get("sector"),
                "action": original_action,
                "riskPercent": float(signal.get("riskPercent") or 1.0),
            },
            [item.model_dump() for item in request.openPositions],
            returns_by_symbol=request.returnsBySymbol,
        )

        # ── One score over everything ────────────────────────────
        score = confluence_score.compute(
            action=original_action or "WAIT",
            confluence=agreement,
            checklist=review,
            factors=(result.get("forecast") or {}).get("factors"),
            calibration=(result.get("forecast") or {}).get("calibration"),
            learning=knowledge,
            session=session,
            no_trade=market_state,
            correlation=related,
        )

        # Every gate scales confidence. Multiplicative rather than averaged: a
        # dead session and a choppy market are two independent reasons to
        # believe the number less, and averaging would let one cancel the other.
        multiplier = (
            mtf.confidence_adjustment(agreement)
            * float(session["confidenceMultiplier"])
            * float(market_state["confidenceMultiplier"])
            * float(related["confidenceMultiplier"])
            * float(learned["multiplier"])
        )
        adjusted = min(settings.max_confidence, original_confidence * multiplier)
        signal["confidence"] = round(adjusted, 1)

        gated = False
        gate_reason = ""
        gate_source = ""
        if request.enforceConfluence and original_action in ("BUY", "SELL"):
            direction_ok = (
                (original_action == "BUY" and agreement["bias"] == "BULLISH")
                or (original_action == "SELL" and agreement["bias"] == "BEARISH")
            )
            # Ordered by how absolute the veto is. A closed market or a
            # no-trade zone is not a weak signal — it is not a signal at all,
            # and reporting it as "checklist failed" would name the wrong cause.
            if request.applySessionFilter and not session["allowed"]:
                gated = True
                gate_reason = session["reason"]
                gate_source = "SESSION"
            elif market_state["blocked"]:
                gated = True
                gate_reason = market_state["summary"]
                gate_source = "NO_TRADE_ZONE"
            elif related["blocked"]:
                gated = True
                gate_reason = related["summary"]
                gate_source = "CORRELATION"
            elif not review["clears"]:
                gated = True
                gate_reason = review["summary"]
                gate_source = "CHECKLIST"
            elif not agreement["allowSignal"] or not direction_ok:
                gated = True
                gate_source = "MULTI_TIMEFRAME"
            if gated:
                signal["action"] = "WAIT"
                signal["gatedBy"] = gate_source or "MULTI_TIMEFRAME"
                reason = gate_reason or (
                    agreement["summary"]
                    if not agreement["allowSignal"]
                    else (
                        f"The {original_action} setup points against the multi-timeframe bias "
                        f"({agreement['bias'].lower()}). A trade taken against agreed higher-"
                        "timeframe direction needs a reason this engine does not have."
                    )
                )
                signal["explanation"] = (
                    f"Setup rejected before issue. {reason} "
                    f"The underlying {original_action} read scored "
                    f"{original_confidence:.0f}/100 before gating."
                )
                failed = [
                    f"✗ {c['label']}: {c['detail']}"
                    for c in review["checks"]
                    if not c["passed"] and not c["unavailable"]
                ]
                signal["reasons"] = [reason, *failed, *agreement["reasons"]][:8]

        result["signal"] = signal
        result["confluence"] = agreement
        result["checklist"] = review
        result["session"] = session
        result["noTradeZone"] = market_state
        result["correlation"] = related
        result["learning"] = {**knowledge, "adjustment": learned}
        result["confluenceScore"] = score
        result["confluenceGate"] = {
            "enforced": request.enforceConfluence,
            "gated": gated,
            "originalAction": original_action,
            "originalConfidence": round(original_confidence, 1),
            "confidenceMultiplier": round(multiplier, 3),
            "multipliers": {
                "timeframe": mtf.confidence_adjustment(agreement),
                "session": session["confidenceMultiplier"],
                "marketState": market_state["confidenceMultiplier"],
                "correlation": related["confidenceMultiplier"],
                "learning": learned["multiplier"],
            },
        }
        return result

    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("confluence signal failed for %s", request.symbol)
        raise HTTPException(status_code=500, detail=f"Confluence signal failed: {exc}") from exc


@router.post("/signals/batch")
async def batch_signals(request: BatchSignalRequest) -> dict[str, Any]:
    """
    Score many instruments at once — scanners, dashboard signal feed.

    Calibration is forced off here regardless of what each item asks for. It
    re-runs the pipeline hundreds of times per instrument, which is fine for one
    symbol and catastrophic for fifty.
    """
    async def score(item: AnalysisRequest) -> dict[str, Any] | None:
        try:
            item.withCalibration = False
            result = await asyncio.to_thread(_run, item)
            return result["signal"]
        except Exception:  # noqa: BLE001 — one bad symbol must not fail the scan
            log.warning("batch signal failed for %s", item.symbol, exc_info=True)
            return None

    results = await asyncio.gather(*(score(item) for item in request.items))

    signals = [s for s in results if s is not None]
    if not request.includeWait:
        signals = [s for s in signals if s["action"] != "WAIT"]
    signals = [s for s in signals if s["confidence"] >= request.minConfidence]
    signals.sort(key=lambda s: -s["confidence"])

    return {
        "signals": signals,
        "requested": len(request.items),
        "scored": len([r for r in results if r is not None]),
        "failed": len([r for r in results if r is None]),
    }
