"""AI assistant endpoint."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..engine import assistant as assistant_engine
from ..schemas import AssistantRequest
from ..security import require_service_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/assistant", tags=["assistant"], dependencies=[Depends(require_service_token)])


@router.post("")
async def ask(request: AssistantRequest) -> dict[str, Any]:
    """
    Answer a question about a symbol, signal or risk decision.

    The answer is grounded in the analysis context supplied by the API. Without
    a Gemini key the endpoint still works — it returns the same facts in
    templated form rather than prose.
    """
    try:
        return await assistant_engine.answer(
            request.question,
            context=request.context,
            symbol=request.symbol,
            history=request.history,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("assistant failed")
        raise HTTPException(status_code=500, detail=f"Assistant failed: {exc}") from exc


@router.get("/status")
async def status() -> dict[str, Any]:
    """Which assistant backend is live — surfaced in the admin panel."""
    configured = bool(settings.gemini_api_key)
    return {
        "provider": "google-gemini",
        "model": settings.assistant_model if configured else "deterministic-template",
        "llmConfigured": configured,
        "note": (
            "Gemini is configured; answers are rephrased from engine output."
            if configured
            else "No GEMINI_API_KEY set. Answers come from the deterministic engine as templates — "
                 "same facts, plainer language."
        ),
    }
