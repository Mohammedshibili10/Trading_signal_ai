"""
Financial sentiment analysis.

FinBERT when enabled, a finance-tuned lexicon otherwise.

General-purpose sentiment models misread finance badly. "Company beats estimates
but cuts guidance" is negative; a general model sees "beats" and says positive.
"Stock plunges on profit booking after 40% rally" is not the disaster the word
"plunges" suggests. The lexicon below encodes those distinctions explicitly, and
FinBERT is trained on exactly this domain.

The honest limitation, stated in the product too: sentiment is good at
*confirming* price action and poor at leading it. By the time news is published
it is usually priced. It carries 6% weight in the signal engine and is capped so
it can never override structure.
"""

from __future__ import annotations

import logging
import math
import re
from functools import lru_cache
from typing import Any

from ..config import settings

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────
#  Finance lexicon
# ─────────────────────────────────────────────────────────────────
#  Weights are −1 … +1. Chosen from how the term actually moves prices in
#  Indian market reporting, not from general sentiment intensity.

BULLISH_TERMS: dict[str, float] = {
    "beats estimates": 0.85, "beat estimates": 0.85, "above estimates": 0.7,
    "record profit": 0.9, "record high": 0.75, "all-time high": 0.75,
    "profit rises": 0.7, "profit jumps": 0.8, "profit surges": 0.85,
    "revenue growth": 0.6, "margin expansion": 0.75, "order book": 0.5,
    "upgrade": 0.8, "upgraded": 0.8, "raises target": 0.75, "target price raised": 0.75,
    "outperform": 0.7, "overweight": 0.6, "buy rating": 0.7, "accumulate": 0.5,
    "dividend": 0.45, "bonus issue": 0.6, "buyback": 0.7, "stock split": 0.4,
    "expansion": 0.5, "new contract": 0.6, "wins order": 0.7, "bags order": 0.7,
    "acquisition": 0.4, "merger": 0.35, "stake purchase": 0.5,
    "fii inflow": 0.6, "dii buying": 0.55, "institutional buying": 0.6,
    "breakout": 0.55, "rally": 0.6, "surges": 0.7, "jumps": 0.6, "soars": 0.75,
    "gains": 0.45, "advances": 0.4, "recovers": 0.4, "rebound": 0.5,
    "rate cut": 0.65, "stimulus": 0.6, "capex": 0.45, "gst collection": 0.35,
    "strong demand": 0.65, "guidance raised": 0.85, "turnaround": 0.6,
    "debt reduction": 0.6, "deleveraging": 0.55, "cash flow positive": 0.65,
}

BEARISH_TERMS: dict[str, float] = {
    "misses estimates": -0.85, "miss estimates": -0.85, "below estimates": -0.7,
    "profit falls": -0.7, "profit declines": -0.7, "profit drops": -0.75,
    "loss widens": -0.85, "posts loss": -0.8, "net loss": -0.75,
    "margin contraction": -0.75, "margin pressure": -0.65,
    "downgrade": -0.8, "downgraded": -0.8, "cuts target": -0.75, "target price cut": -0.75,
    "underperform": -0.7, "underweight": -0.6, "sell rating": -0.7, "reduce": -0.5,
    "guidance cut": -0.9, "lowers guidance": -0.9, "warns": -0.7, "profit warning": -0.9,
    "resignation": -0.55, "ceo resigns": -0.7, "cfo resigns": -0.75,
    "auditor resigns": -0.95, "auditor quits": -0.95,
    "sebi probe": -0.85, "investigation": -0.7, "raid": -0.85, "fraud": -0.95,
    "penalty": -0.6, "fine": -0.5, "notice": -0.4, "default": -0.9,
    "pledge": -0.6, "promoter pledge": -0.75, "stake sale": -0.5, "promoter selling": -0.8,
    "downgrade rating": -0.7, "credit rating cut": -0.8, "insolvency": -0.95, "nclt": -0.8,
    "fii outflow": -0.6, "dii selling": -0.55, "institutional selling": -0.6,
    "plunges": -0.75, "slumps": -0.7, "crashes": -0.85, "tumbles": -0.7,
    "declines": -0.45, "slips": -0.4, "falls": -0.45, "drops": -0.5,
    "breakdown": -0.6, "selloff": -0.7, "correction": -0.5,
    "rate hike": -0.55, "inflation rises": -0.5, "recession": -0.8, "slowdown": -0.6,
    "weak demand": -0.65, "layoffs": -0.5, "shutdown": -0.7, "recall": -0.6,
}

#: Phrases that flip or blunt the sentiment of what follows.
NEGATIONS = {"not", "no", "never", "without", "despite", "although", "however", "but"}

#: Contexts where a scary-sounding word is routine.
DAMPENERS = {
    "profit booking": 0.4,   # a fall after gains, not a collapse
    "technical correction": 0.5,
    "in line with": 0.3,
    "as expected": 0.3,
    "largely unchanged": 0.2,
}

HIGH_IMPACT = {
    "rbi", "monetary policy", "budget", "fomc", "fed", "interest rate", "repo rate",
    "quarterly results", "q1", "q2", "q3", "q4", "earnings", "guidance",
    "merger", "acquisition", "sebi", "circuit", "ban", "default", "fraud",
}


@lru_cache(maxsize=1)
def _finbert():
    """
    Load FinBERT once. Returns None when disabled or unavailable.

    Deliberately lazy — importing transformers costs seconds and ~1 GB of RSS,
    and most deployments run with the lexicon.
    """
    if not settings.enable_finbert:
        return None
    try:
        from transformers import pipeline  # type: ignore[import-not-found]

        log.info("loading FinBERT (%s)…", settings.finbert_model)
        return pipeline(
            "sentiment-analysis",
            model=settings.finbert_model,
            tokenizer=settings.finbert_model,
            model_kwargs={"cache_dir": settings.model_cache_dir},
            truncation=True,
            max_length=512,
        )
    except Exception:  # noqa: BLE001
        log.warning("FinBERT unavailable — falling back to the lexicon model", exc_info=True)
        return None


def _lexicon_score(text: str) -> tuple[float, list[str]]:
    """Score with the finance lexicon. Returns (−1…+1, matched terms)."""
    lowered = f" {text.lower()} "
    lowered = re.sub(r"\s+", " ", lowered)

    score = 0.0
    matches: list[str] = []

    for table in (BULLISH_TERMS, BEARISH_TERMS):
        for term, weight in table.items():
            index = lowered.find(f" {term}")
            if index < 0:
                continue

            # Negation window: the four words before the match.
            preceding = lowered[max(0, index - 40) : index].split()[-4:]
            multiplier = -0.7 if any(word in NEGATIONS for word in preceding) else 1.0

            for phrase, damp in DAMPENERS.items():
                if phrase in lowered:
                    multiplier *= damp
                    break

            score += weight * multiplier
            matches.append(term)

    # Squash so a headline stuffed with terms doesn't run away.
    return math.tanh(score * 0.8), matches


def analyse_text(text: str) -> dict[str, Any]:
    """Classify a single headline or summary."""
    if not text or not text.strip():
        return {"stance": "NEUTRAL", "score": 0.0, "confidence": 0.0, "model": "none", "matches": []}

    classifier = _finbert()
    if classifier is not None:
        try:
            result = classifier(text[:512])[0]
            label = str(result["label"]).upper()
            confidence = float(result["score"])
            score = confidence if label == "POSITIVE" else -confidence if label == "NEGATIVE" else 0.0
            return {
                "stance": "BULLISH" if score > 0.15 else "BEARISH" if score < -0.15 else "NEUTRAL",
                "score": round(score, 4),
                "confidence": round(confidence, 4),
                "model": f"finbert:{settings.finbert_model}",
                "matches": [],
            }
        except Exception:  # noqa: BLE001
            log.warning("FinBERT inference failed, using lexicon", exc_info=True)

    score, matches = _lexicon_score(text)
    # Confidence grows with the number of recognised signals, capped well below
    # 1 — a lexicon should never claim certainty.
    confidence = min(0.85, 0.35 + 0.12 * len(matches)) if matches else 0.2

    return {
        "stance": "BULLISH" if score > 0.15 else "BEARISH" if score < -0.15 else "NEUTRAL",
        "score": round(score, 4),
        "confidence": round(confidence, 4),
        "model": "finance-lexicon",
        "matches": matches[:6],
    }


def impact_of(text: str, score: float) -> str:
    lowered = text.lower()
    if any(term in lowered for term in HIGH_IMPACT) or abs(score) > 0.7:
        return "HIGH"
    if abs(score) > 0.35:
        return "MEDIUM"
    return "LOW"


def explain(text: str, result: dict[str, Any]) -> dict[str, str]:
    """Why a trader should care, and what to expect."""
    stance, score = result["stance"], result["score"]
    matches = result.get("matches") or []

    if stance == "NEUTRAL":
        return {
            "whyItMatters": "Informational rather than directional — nothing here changes the setup.",
            "expectedImpact": "Little to no price reaction expected.",
        }

    driver = f" Driven by: {', '.join(matches[:3])}." if matches else ""
    direction = "buying" if stance == "BULLISH" else "selling"
    magnitude = "a strong" if abs(score) > 0.6 else "a moderate" if abs(score) > 0.35 else "a mild"

    return {
        "whyItMatters": (
            f"Classified {stance.lower()} with {result['confidence']:.0%} confidence.{driver} "
            "News tends to confirm what price is already doing rather than lead it, so treat this as "
            "supporting evidence, not a trigger."
        ),
        "expectedImpact": (
            f"{magnitude.capitalize()} {direction} bias in the near term. "
            "If price does not respond, the story was already discounted."
        ),
    }


def aggregate(items: list[dict[str, Any]], *, half_life_hours: float = 18.0) -> dict[str, Any]:
    """
    Aggregate scored items into one sentiment reading, decayed by age.

    A headline from three days ago should not carry the same weight as one from
    this morning — exponential decay with an 18-hour half-life is roughly how
    fast news stops mattering intraday.
    """
    if not items:
        return {"stance": "NEUTRAL", "score": 0.0, "confidence": 0.0, "count": 0, "summary": "No recent coverage."}

    weighted = 0.0
    total_weight = 0.0
    bullish = bearish = 0

    for item in items:
        score = float(item.get("score", 0.0))
        confidence = float(item.get("confidence", 0.5))
        age_hours = float(item.get("ageHours", 0.0))

        decay = 0.5 ** (age_hours / half_life_hours)
        impact_weight = {"HIGH": 1.5, "MEDIUM": 1.0, "LOW": 0.6}.get(item.get("impact", "MEDIUM"), 1.0)
        weight = confidence * decay * impact_weight

        weighted += score * weight
        total_weight += weight

        if score > 0.15:
            bullish += 1
        elif score < -0.15:
            bearish += 1

    net = weighted / total_weight if total_weight > 0 else 0.0
    stance = "BULLISH" if net > 0.15 else "BEARISH" if net < -0.15 else "NEUTRAL"

    # Confidence reflects both coverage volume and how much the items agree.
    agreement = abs(bullish - bearish) / max(len(items), 1)
    confidence = min(0.9, (0.3 + 0.1 * min(len(items), 6)) * (0.5 + 0.5 * agreement))

    summary = (
        f"{len(items)} item{'s' if len(items) != 1 else ''} in the window — "
        f"{bullish} bullish, {bearish} bearish, {len(items) - bullish - bearish} neutral. "
        f"Age-weighted net sentiment {net * 100:+.0f}."
    )

    return {
        "stance": stance,
        "score": round(net * 100, 2),
        "confidence": round(confidence, 3),
        "count": len(items),
        "bullish": bullish,
        "bearish": bearish,
        "neutral": len(items) - bullish - bearish,
        "summary": summary,
        "model": "finbert" if _finbert() is not None else "finance-lexicon",
    }
