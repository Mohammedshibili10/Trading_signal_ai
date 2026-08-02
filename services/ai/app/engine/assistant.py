"""
The AI assistant.

Answers questions about a symbol, a signal or a risk decision — grounded in the
deterministic analysis, never independent of it.

The rule that governs this module: **the LLM rephrases, it does not decide.**
Every number, stance and level in an answer comes from the engine output passed
in as context. Gemini is given that context and explicitly forbidden from
introducing claims or figures of its own. When no API key is configured, the
templated path produces the same content in plainer language — the answers are
less fluent, never less correct.

A fluent explanation is not evidence. Letting a language model reason freely
about markets produces confident narrative that can contradict the arithmetic
sitting right next to it on screen, and users believe the prose.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import settings
from ..http import async_client

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the assistant inside an AI trading intelligence platform for Indian \
stocks (NSE/BSE), forex, crypto and long-term investment products.

You will be given ANALYSIS CONTEXT produced by a deterministic analysis engine. Your job is to \
explain that analysis clearly to a trader.

Hard rules:
1. Use ONLY facts present in the ANALYSIS CONTEXT. Never introduce prices, levels, indicator \
values, probabilities or company facts that are not in it.
2. Never change a number. If the context says confidence is 62, it is 62.
3. If the context does not contain what is needed to answer, say so plainly and state what \
would be needed.
4. Never promise profit, guarantee an outcome, or describe anything as certain, safe or a \
sure thing. Probabilities are historical frequencies and are often wrong.
5. Always mention the invalidation level or the main risk when discussing a trade idea.
6. If the engine returned WAIT, say that no trade qualifies and give the stated reason. Do not \
manufacture a setup.
7. You are not a SEBI-registered adviser. For direct "should I buy this" questions, explain what \
the analysis shows and what the risks are, then leave the decision with the user.

Style: direct and concise. 120-200 words. Plain language, no hype, no emoji, no bullet-point \
padding. Amounts in Indian format (₹1,23,456 / lakh / crore) where the context uses rupees."""


def _context_block(context: dict[str, Any] | None, symbol: str | None) -> str:
    """Flatten the analysis payload into a compact, readable context block."""
    if not context:
        return "ANALYSIS CONTEXT: none supplied."

    lines: list[str] = [f"ANALYSIS CONTEXT for {symbol or context.get('symbol', 'the instrument')}:"]

    if price := context.get("price"):
        lines.append(f"- Current price: {price}")
    if tf := context.get("timeframe"):
        lines.append(f"- Timeframe: {tf}")

    tech = context.get("technical") or {}
    if tech:
        trend = tech.get("trend") or {}
        vol = tech.get("volatility") or {}
        lines.append(
            f"- Technical score {tech.get('score')}/100 ({tech.get('stance')}). "
            f"Trend: {trend.get('label')}. Volatility regime: {vol.get('regime')} "
            f"(ATR {vol.get('atrPercent')}%)."
        )
        for indicator in (tech.get("indicators") or [])[:8]:
            lines.append(f"  · {indicator.get('label')}: {indicator.get('display')} — {indicator.get('note')}")

    fc = context.get("forecast") or {}
    if fc:
        anatomy = fc.get("anatomy") or {}
        lines.append(
            f"- Next-candle forecast: {fc.get('bias')}, probUp {fc.get('probUp')}, "
            f"probDown {fc.get('probDown')}, confidence {fc.get('confidence')}/100."
        )
        if anatomy.get("classification"):
            lines.append(f"- Current candle: {anatomy.get('classification')}, volume {anatomy.get('volumeRatio')}x average.")
        if verdict := fc.get("calibrationVerdict"):
            lines.append(f"- Calibration: {verdict}")
        for reason in (fc.get("reasons") or [])[:6]:
            lines.append(f"  · {reason}")

    signal = context.get("signal") or {}
    if signal:
        if signal.get("action") == "WAIT":
            lines.append(f"- Signal: WAIT. Reason: {signal.get('explanation')}")
        else:
            targets = ", ".join(
                f"T{t['level']} {t['price']} ({t['rr']}:1, p={t['probability']})"
                for t in (signal.get("targets") or [])
            )
            lines.append(
                f"- Signal: {signal.get('action')} at {signal.get('entry')}, "
                f"stop {signal.get('stopLoss')} ({signal.get('riskPercent')}% risk), "
                f"targets: {targets}. Risk level {signal.get('riskLevel')}, "
                f"R:R {signal.get('riskRewardRatio')}, confidence {signal.get('confidence')}/100. "
                f"Suggested allocation {signal.get('suggestedAllocationPercent')}% of capital."
            )

    pa = context.get("priceAction") or {}
    if pa.get("summary"):
        lines.append(f"- Price action: {pa['summary']}")

    smc = context.get("smc") or {}
    if smc.get("summary"):
        lines.append(f"- Market structure: {smc['summary']}")

    for pattern in (context.get("chartPatterns") or [])[:3]:
        lines.append(
            f"- Chart pattern: {pattern.get('name')} ({pattern.get('status')}, "
            f"{pattern.get('confidence')}/100) — {pattern.get('note')}"
        )

    for pattern in (context.get("candlestickPatterns") or [])[:3]:
        lines.append(
            f"- Candlestick: {pattern.get('name')}, reliability {pattern.get('reliability')}/100 "
            f"(base {pattern.get('baseReliability')}) — {pattern.get('note')}"
        )

    fundamentals = context.get("fundamentals") or {}
    if fundamentals:
        scores = fundamentals.get("scores") or {}
        lines.append(
            f"- Fundamentals: investment score {scores.get('investment')}/100, "
            f"rating {fundamentals.get('longTermRating')}. {fundamentals.get('summary', '')}"
        )

    risk = context.get("risk") or {}
    if risk:
        lines.append(
            f"- Portfolio risk: diversification {risk.get('diversificationScore')}/100, "
            f"max drawdown {risk.get('maxDrawdown')}%, beta {risk.get('beta')}."
        )

    return "\n".join(lines)


async def _ask_gemini(question: str, context_block: str, history: list[dict[str, str]] | None) -> str | None:
    """
    Call Gemini's generateContent endpoint.

    Returns None on any failure so the caller falls through to the templated
    answer — the assistant degrading to plainer language is far better than it
    returning an error.
    """
    if not settings.gemini_api_key:
        return None

    contents: list[dict[str, Any]] = []

    for turn in (history or [])[-6:]:
        role = "model" if turn.get("role") == "assistant" else "user"
        text = (turn.get("content") or "").strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})

    contents.append({
        "role": "user",
        "parts": [{"text": f"{context_block}\n\nQUESTION: {question}"}],
    })

    url = f"{settings.gemini_base_url}/models/{settings.assistant_model}:generateContent"

    generation_config: dict[str, Any] = {
        # Low temperature: this is an explanation task, not a creative one.
        "temperature": 0.25,
        "topP": 0.9,
        # Reasoning models spend this budget on thinking *before* emitting a
        # single visible token — measured at ~620 thought tokens for a
        # three-sentence answer. A budget sized only for the prose comes back
        # truncated mid-sentence with finishReason MAX_TOKENS, which looks like
        # a broken assistant rather than a misconfigured one.
        "maxOutputTokens": 2048,
        # Rephrasing pre-computed factors needs no deliberation. Keeping it low
        # cuts both latency and the share of the budget thinking consumes.
        "thinkingConfig": {"thinkingLevel": "low"},
    }

    headers = {"x-goog-api-key": settings.gemini_api_key, "Content-Type": "application/json"}

    def body(config: dict[str, Any]) -> dict[str, Any]:
        return {
            "contents": contents,
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "generationConfig": config,
            "safetySettings": [],
        }

    try:
        async with async_client(settings.assistant_timeout_seconds) as client:
            response = await client.post(url, json=body(generation_config), headers=headers)

            # thinkingConfig is a Gemini 3-era field. Older models reject the
            # whole request rather than ignoring it, so retry once without it —
            # otherwise picking an older ASSISTANT_MODEL silently downgrades
            # every answer to a template.
            if response.status_code == 400 and "thinking" in response.text.lower():
                log.info("Gemini rejected thinkingConfig — retrying without it")
                fallback = {k: v for k, v in generation_config.items() if k != "thinkingConfig"}
                response = await client.post(url, json=body(fallback), headers=headers)

            response.raise_for_status()
            data = response.json()

        candidates = data.get("candidates") or []
        if not candidates:
            log.warning("Gemini returned no candidates: %s", data.get("promptFeedback"))
            return None

        candidate = candidates[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts).strip()

        if not text:
            # Empty with MAX_TOKENS means the budget went entirely to thinking.
            # Say so — this is the one failure mode that is a config problem.
            log.warning(
                "Gemini produced no text (finishReason=%s, thoughts=%s tokens)",
                candidate.get("finishReason"),
                (data.get("usageMetadata") or {}).get("thoughtsTokenCount"),
            )
            return None

        return text

    except httpx.HTTPStatusError as exc:
        log.warning("Gemini HTTP %s: %s", exc.response.status_code, exc.response.text[:300])
        return None
    except Exception:  # noqa: BLE001
        log.warning("Gemini request failed", exc_info=True)
        return None


def _templated_answer(question: str, context: dict[str, Any] | None, symbol: str | None) -> str:
    """
    Deterministic answer, assembled from the analysis.

    Not a degraded fallback in substance — it contains the same facts the LLM
    would be given. It just reads like a report rather than a conversation.
    """
    if not context:
        return (
            "I don't have any analysis loaded for that. Open a symbol and run the analysis, "
            "then ask again and I'll explain what the engine found."
        )

    name = symbol or context.get("symbol", "this instrument")
    lowered = question.lower()

    fc = context.get("forecast") or {}
    signal = context.get("signal") or {}
    tech = context.get("technical") or {}
    parts: list[str] = []

    wants_trade = any(w in lowered for w in ("buy", "sell", "enter", "trade", "position", "should i"))
    wants_risk = any(w in lowered for w in ("risk", "stop", "loss", "downside", "safe"))
    wants_why = any(w in lowered for w in ("why", "reason", "explain", "how come"))
    wants_long = any(w in lowered for w in ("long term", "long-term", "invest", "sip", "hold for"))

    if wants_long and (fundamentals := context.get("fundamentals")):
        scores = fundamentals.get("scores") or {}
        parts.append(
            f"On a long-term view, {name} scores {scores.get('investment')}/100 with a "
            f"{str(fundamentals.get('longTermRating', '')).replace('_', ' ').lower()} rating. "
            f"{fundamentals.get('summary', '')}"
        )
        if concerns := fundamentals.get("concerns"):
            parts.append(f"Main concern: {concerns[0]}")

    elif wants_trade or wants_risk:
        if signal.get("action") == "WAIT":
            parts.append(
                f"The engine is not offering a trade on {name} right now. {signal.get('explanation')}"
            )
            parts.append("Not trading is a position. Waiting for a qualifying setup costs nothing.")
        elif signal.get("action"):
            targets = signal.get("targets") or []
            t1 = targets[0] if targets else None
            parts.append(
                f"The engine has a {signal['action']} on {name}: entry {signal.get('entry')}, "
                f"stop {signal.get('stopLoss')}, which risks {signal.get('riskPercent')}% of the price."
            )
            if t1:
                parts.append(
                    f"First target {t1['price']} gives {t1['rr']}:1 with an estimated "
                    f"{t1['probability']:.0%} chance of being reached."
                )
            parts.append(
                f"Confidence is {signal.get('confidence')}/100 and the risk grade is "
                f"{str(signal.get('riskLevel', '')).replace('_', ' ').lower()}. "
                f"Suggested size is {signal.get('suggestedAllocationPercent')}% of capital."
            )
        else:
            parts.append(f"No signal has been generated for {name} on this timeframe.")

    elif wants_why and fc:
        parts.append(
            f"The engine reads {name} as {str(fc.get('bias', '')).lower()} for the next candle "
            f"at {fc.get('confidence')}/100 confidence. The factors driving that, in order of weight:"
        )
        for reason in (fc.get("reasons") or [])[:4]:
            parts.append(f"• {reason}")

    else:
        if tech:
            parts.append(f"{name}: {tech.get('summary', '')}")
        if fc:
            parts.append(fc.get("summary", ""))

    if fc.get("invalidation"):
        parts.append(fc["invalidation"].get("note", ""))
    if verdict := fc.get("calibrationVerdict"):
        parts.append(verdict)

    parts.append(
        "These are probabilities from historical patterns, not predictions. "
        "This is analysis, not investment advice."
    )

    return "\n\n".join(p for p in parts if p)


async def answer(
    question: str,
    *,
    context: dict[str, Any] | None = None,
    symbol: str | None = None,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Answer a question, grounded in the supplied analysis context."""
    block = _context_block(context, symbol)

    text = await _ask_gemini(question, block, history)
    source = "gemini" if text else "engine-template"

    if not text:
        text = _templated_answer(question, context, symbol)

    return {
        "answer": text,
        "model": settings.assistant_model if source == "gemini" else "deterministic-template",
        "source": source,
        "grounded": context is not None,
        "usedContext": sorted(
            k for k in (context or {})
            if k in {"technical", "forecast", "signal", "priceAction", "smc",
                     "chartPatterns", "candlestickPatterns", "fundamentals", "risk"}
        ),
    }
