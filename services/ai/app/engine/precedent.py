"""
Has this setup been tried before, and how did it go?

The engine scores a setup on its merits. That is necessary and not sufficient,
because a setup can look excellent on every measure and still belong to a family
that has repeatedly failed — the same instrument, the same direction, the same
factor profile, the same missing volume confirmation. Scoring alone cannot see
that, since it has no memory beyond the current chart.

This module supplies the memory. It answers two separate questions:

  1. **Base rate.** Among past setups that look like this one, how many worked?
  2. **Named risk.** Do the specific conditions that broke those trades exist
     right now, in this setup?

The second matters more than the first and is the harder of the two. A poor base
rate says "be careful"; a present, named, previously-fatal condition says
"this is the same mistake again", which is a claim one can act on and argue with.

Deliberately conservative about claiming knowledge. With few precedents the
shrinkage below pulls every estimate back toward the overall base rate, so a
single unlucky pair of trades cannot veto a good setup — the commonest way a
learning system talks itself out of ever trading.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

#: Below this many similar precedents, the base rate is not evidence and only
#: named-risk checks are allowed to influence the outcome.
MIN_PRECEDENTS = 6

#: Pseudo-observations of the prior. Matches the strength used elsewhere in the
#: learning code so the two cannot disagree about how much evidence is enough.
PRIOR_STRENGTH = 25.0

#: Assumed base rate before any evidence. Deliberately below a coin flip: most
#: setups do not work, and starting at 0.5 flatters every thin sample.
PRIOR_WIN_RATE = 0.42

#: Similarity at or above which a past signal counts as a precedent.
SIMILARITY_FLOOR = 0.72

#: Shrunk win rate below which a setup is refused outright.
REJECT_WIN_RATE = 0.30

#: Below this, the setup is allowed but marked down.
CAUTION_WIN_RATE = 0.45

#: Largest confidence deduction the base rate alone may impose.
MAX_BASE_RATE_PENALTY = 18.0

#: Deduction per named risk that is both present now and previously fatal.
NAMED_RISK_PENALTY = 9.0

#: Named risks present at once that force a refusal regardless of base rate.
NAMED_RISK_REJECT_COUNT = 3


def _factor_vector(factors: list[dict[str, Any]] | None) -> dict[str, float]:
    """Factor group → signed score, the shape a setup is compared on."""
    vector: dict[str, float] = {}
    for factor in factors or []:
        group = str(factor.get("group", ""))
        if not group:
            continue
        try:
            vector[group] = float(factor.get("score", 0.0))
        except (TypeError, ValueError):
            continue
    return vector


def _similarity(a: dict[str, float], b: dict[str, float]) -> float:
    """
    How alike are two setups, by factor profile?

    Cosine over the shared groups, rescaled to 0..1. Cosine rather than
    Euclidean because what identifies a setup is the *pattern* of agreement
    between factors — trend strong, structure weak, volume absent — and not the
    absolute magnitudes, which drift with volatility.
    """
    shared = set(a) & set(b)
    if len(shared) < 3:
        return 0.0

    va = np.array([a[k] for k in shared])
    vb = np.array([b[k] for k in shared])

    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        return 0.0

    cosine = float(np.dot(va, vb) / (na * nb))
    # Coverage: two setups agreeing on three groups are less comparable than
    # two agreeing on ten, and cosine alone cannot tell the difference.
    coverage = len(shared) / max(len(a), len(b))
    return max(0.0, ((cosine + 1.0) / 2.0)) * (0.6 + 0.4 * coverage)


def _shrunk_win_rate(wins: int, losses: int) -> float:
    """
    Beta-Binomial shrinkage toward the prior.

    Two wins from two trades is not a 100% strategy, and treating it as one is
    how a learning system ends up chasing noise. This pulls small samples back
    toward the prior in proportion to how little evidence they carry.
    """
    trades = wins + losses
    if trades == 0:
        return PRIOR_WIN_RATE
    return (PRIOR_WIN_RATE * PRIOR_STRENGTH + wins) / (PRIOR_STRENGTH + trades)


#: Conditions that broke past trades, and how to test whether each is present
#: right now. This is the mapping that turns a historical failure reason into a
#: check against the live setup — without it, "we lost to low volume before" is
#: a fact about the past with no bearing on the decision at hand.
#:
#: Each entry reads the *current* analysis context and returns evidence when the
#: condition holds, or None when it does not.
def _check_low_volume(ctx: dict[str, Any]) -> str | None:
    ratio = ctx.get("volumeRatio")
    if ratio is not None and float(ratio) < 0.9:
        return f"volume is {float(ratio):.2f}× its average — the same thin participation as before"
    return None


def _check_htf_conflict(ctx: dict[str, Any]) -> str | None:
    if ctx.get("htfAligned") is False:
        return "the higher timeframe disagrees with this direction, as it did then"
    return None


def _check_high_volatility(ctx: dict[str, Any]) -> str | None:
    percentile = ctx.get("volatilityPercentile")
    if percentile is not None and float(percentile) > 80.0:
        return f"volatility is in the {float(percentile):.0f}th percentile — stops get run at these levels"
    return None


def _check_weak_structure(ctx: dict[str, Any]) -> str | None:
    score = ctx.get("structureScore")
    if score is not None and abs(float(score)) < 0.2:
        return "market structure is indecisive, offering nothing to lean the stop against"
    return None


def _check_trend_misread(ctx: dict[str, Any]) -> str | None:
    strength = ctx.get("trendStrength")
    if strength is not None and float(strength) < 25.0:
        return f"trend strength is only {float(strength):.0f} — there is no trend to be right about"
    return None


def _check_news(ctx: dict[str, Any]) -> str | None:
    if ctx.get("newsImminent"):
        return "a high-impact event is scheduled inside the trade's horizon, as before"
    return None


def _check_poor_timing(ctx: dict[str, Any]) -> str | None:
    if ctx.get("extendedFromMean"):
        return "price is already extended from its mean, which is where the last entries were late"
    return None


NAMED_RISK_CHECKS = {
    "LOW_VOLUME": _check_low_volume,
    "HTF_CONFLICT": _check_htf_conflict,
    "HIGH_VOLATILITY": _check_high_volatility,
    "WEAK_STRUCTURE": _check_weak_structure,
    "TREND_MISREAD": _check_trend_misread,
    "NEWS_IMPACT": _check_news,
    "POOR_TIMING": _check_poor_timing,
    # Cancellation reasons that are also testable in the present.
    "VOLATILITY_SHIFT": _check_high_volatility,
    "STRUCTURE_CHANGED": _check_weak_structure,
    "TREND_REVERSAL": _check_trend_misread,
}


def evaluate(
    candidate: dict[str, Any],
    history: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Judge a candidate setup against what has happened before.

    `history` is past signals with a recorded outcome; `context` is the current
    analysis, used to test whether previously fatal conditions are present now.

    Returns a verdict, a confidence adjustment and the evidence for both. The
    caller applies it — this module does not decide policy, it supplies the
    grounds for one.
    """
    ctx = context or {}
    action = str(candidate.get("action", ""))
    symbol = str(candidate.get("symbol", ""))
    timeframe = str(candidate.get("timeframe", ""))
    candidate_vector = _factor_vector(candidate.get("factors"))

    # ── Find precedents ──────────────────────────────────────────
    precedents: list[dict[str, Any]] = []
    for past in history:
        # Direction must match. A losing long says nothing about a short, and
        # pooling them would let opposite trades cancel each other out.
        if str(past.get("action")) != action:
            continue

        similarity = _similarity(candidate_vector, _factor_vector(past.get("factors")))
        if similarity < SIMILARITY_FLOOR:
            continue

        # Same instrument is more informative than merely the same shape, and
        # same timeframe more still. Weighted rather than filtered, so a thin
        # instrument history can still borrow strength from the wider set.
        weight = similarity
        if str(past.get("symbol")) == symbol:
            weight *= 1.5
        if str(past.get("timeframe")) == timeframe:
            weight *= 1.2

        precedents.append({**past, "similarity": round(similarity, 3), "weight": weight})

    precedents.sort(key=lambda item: item["weight"], reverse=True)
    top = precedents[:40]

    wins = sum(1 for p in top if str(p.get("status", "")).startswith("HIT_"))
    losses = sum(1 for p in top if str(p.get("status")) == "STOPPED")
    cancellations = sum(1 for p in top if str(p.get("status")) in {"CANCELLED", "INVALID"})
    decided = wins + losses

    win_rate = _shrunk_win_rate(wins, losses)

    # ── Which problems keep recurring, and are they here now? ────
    #
    # Counted across losses *and* cancellations. A reason that keeps forcing
    # cancellations is a reason this kind of setup keeps going wrong before it
    # can pay, which is worth as much warning as a stop-out.
    reason_counts: dict[str, int] = {}
    for past in top:
        if str(past.get("status", "")).startswith("HIT_"):
            continue
        reason = past.get("primaryReason") or past.get("invalidationReason")
        if reason:
            reason_counts[str(reason)] = reason_counts.get(str(reason), 0) + 1

    named_risks: list[dict[str, Any]] = []
    for reason, count in sorted(reason_counts.items(), key=lambda kv: -kv[1]):
        check = NAMED_RISK_CHECKS.get(reason)
        if check is None:
            continue
        evidence = check(ctx)
        if evidence is None:
            continue
        named_risks.append(
            {
                "reason": reason,
                "priorFailures": count,
                "evidence": evidence,
                "detail": (
                    f"{count} similar setup(s) previously failed on {reason.lower().replace('_', ' ')}, "
                    f"and {evidence}."
                ),
            }
        )

    # ── Verdict ──────────────────────────────────────────────────
    penalty = 0.0
    notes: list[str] = []

    base_rate_is_evidence = decided >= MIN_PRECEDENTS

    if base_rate_is_evidence and win_rate < CAUTION_WIN_RATE:
        # Scaled by how far below the caution line it sits, so a marginal record
        # costs a little and a bad one costs a lot.
        shortfall = (CAUTION_WIN_RATE - win_rate) / CAUTION_WIN_RATE
        penalty += min(MAX_BASE_RATE_PENALTY, MAX_BASE_RATE_PENALTY * shortfall)
        notes.append(
            f"Similar setups have won {win_rate * 100:.0f}% of the time "
            f"across {decided} decided trades."
        )

    penalty += NAMED_RISK_PENALTY * len(named_risks)
    for risk in named_risks:
        notes.append(risk["detail"])

    reject = False
    reject_reason = None

    if named_risks and base_rate_is_evidence and win_rate < CAUTION_WIN_RATE:
        # The strongest case there is, and much stronger than either half alone:
        # setups like this have a poor record, *and* the specific condition that
        # broke them is present right now. That is not a bad base rate to be
        # weighed against the setup's merits — it is the same mistake again.
        worst = named_risks[0]
        reject = True
        reject_reason = (
            f"Setups like this have won {win_rate * 100:.0f}% of {decided} decided trades, "
            f"and the cause is here again: {worst['evidence']}."
        )
    elif len(named_risks) >= NAMED_RISK_REJECT_COUNT:
        reject = True
        reject_reason = (
            f"{len(named_risks)} conditions that have previously broken this kind of setup "
            f"are all present right now."
        )
    elif base_rate_is_evidence and win_rate < REJECT_WIN_RATE:
        reject = True
        reject_reason = (
            f"Setups like this have won only {win_rate * 100:.0f}% of {decided} decided trades — "
            f"below the {REJECT_WIN_RATE * 100:.0f}% floor."
        )

    verdict = "REJECT" if reject else ("CAUTION" if penalty > 0 else "CLEAR")

    if verdict == "CLEAR":
        summary = (
            f"No adverse precedent. {len(top)} similar setup(s) on file."
            if top
            else "No comparable setups on file yet — judged on its own merits."
        )
    elif verdict == "CAUTION":
        summary = f"Confidence reduced by {penalty:.0f}. " + " ".join(notes)
    else:
        summary = f"Rejected. {reject_reason}"

    return {
        "verdict": verdict,
        "confidencePenalty": round(min(penalty, 40.0), 1),
        "rejectReason": reject_reason,
        "precedents": {
            "matched": len(top),
            "wins": wins,
            "losses": losses,
            "cancellations": cancellations,
            "decided": decided,
            "shrunkWinRate": round(win_rate, 4),
            "baseRateIsEvidence": base_rate_is_evidence,
        },
        "namedRisks": named_risks,
        "recurringReasons": [
            {"reason": reason, "count": count}
            for reason, count in sorted(reason_counts.items(), key=lambda kv: -kv[1])[:5]
        ],
        "closest": [
            {
                "symbol": p.get("symbol"),
                "timeframe": p.get("timeframe"),
                "status": p.get("status"),
                "similarity": p.get("similarity"),
                "primaryReason": p.get("primaryReason") or p.get("invalidationReason"),
            }
            for p in top[:5]
        ],
        "summary": summary,
        "notes": notes,
    }
