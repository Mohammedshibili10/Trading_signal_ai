"""
Factor attribution and adaptive weights.

The loop the whole system exists to close: measure which factor groups actually
predicted outcomes, then weight the ones that worked more heavily and the ones
that did not more lightly.

This is also the single most dangerous module in the engine, because a weight
adjustment applies to every future signal. A bug here does not produce one bad
trade — it silently degrades every trade after it. Four safeguards follow from
that, and none of them are optional:

**1. Shrinkage before anything else.** Every hit rate is a Beta-Binomial
posterior against a 50% prior with 30 pseudo-observations. Twelve trades cannot
move a weight meaningfully, and that is the intended behaviour, not a limitation.
The pattern that "works" over twelve trades is usually the market's regime, and
regimes end.

**2. Bounded adjustment.** No weight moves more than ±35% from its base, ever.
A factor with a genuinely terrible record gets quieter, not silenced — because
the record is measured over one period and the factor may be exactly what is
needed in the next one.

**3. Weights renormalise.** They must sum to 1.0 after adjustment or every
probability the engine produces shifts scale, and calibration silently breaks.

**4. Nothing applies until validated.** Proposed weights are held as a proposal
until a walk-forward test shows they would have improved outcomes on data the
proposal was not fitted to. `validated: false` means the engine keeps using the
base weights and says so.

The honest framing: this makes the engine adaptive, not smart. It tunes the
relative volume of evidence it already collects. It does not discover new
evidence, and it cannot rescue a factor that was never predictive.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Prior strength in pseudo-observations. Higher than the learning module's,
#: because a weight change is more consequential than a confidence nudge.
PRIOR_STRENGTH = 30.0
PRIOR_HIT_RATE = 0.50

#: Hard bound on how far any weight may move from its base, as a ratio.
MAX_WEIGHT_DRIFT = 0.35

#: Resolved trades a group needs before its record influences anything.
MIN_SAMPLES_PER_GROUP = 20
#: Total resolved trades before any adjustment is proposed at all.
MIN_TOTAL_SAMPLES = 40
#: Improvement in hit rate a proposal must show in validation to be applied.
MIN_VALIDATION_EDGE = 0.02


def _posterior(hits: int, total: int) -> float:
    if total <= 0:
        return PRIOR_HIT_RATE
    alpha = PRIOR_HIT_RATE * PRIOR_STRENGTH + hits
    beta = (1 - PRIOR_HIT_RATE) * PRIOR_STRENGTH + (total - hits)
    return float(alpha / (alpha + beta))


def measure(trades: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Per-factor-group performance across resolved trades.

    A group "called" a trade when its score pointed the same way as the action
    taken. It was right when the trade then won. Groups that were neutral on a
    trade are excluded from that trade entirely — counting a neutral read as a
    wrong call would punish factors for correctly having no opinion.
    """
    per_group: dict[str, dict[str, Any]] = {}

    for trade in trades:
        status = str(trade.get("status", ""))
        if status not in ("HIT_T1", "HIT_T2", "HIT_T3", "STOPPED"):
            continue

        won = status.startswith("HIT_")
        action = str(trade.get("action", "BUY"))
        direction = 1.0 if action == "BUY" else -1.0

        for factor in trade.get("factors") or []:
            group = str(factor.get("group", ""))
            if not group:
                continue

            score = float(factor.get("score", 0.0))
            # Neutral means no opinion. Excluded rather than counted as wrong.
            if abs(score) < 0.10:
                continue

            agreed = (score * direction) > 0
            bucket = per_group.setdefault(
                group,
                {"calls": 0, "correct": 0, "agreedCalls": 0, "agreedCorrect": 0,
                 "againstCalls": 0, "againstCorrect": 0, "weightSum": 0.0},
            )

            bucket["calls"] += 1
            bucket["weightSum"] += float(factor.get("weight", 0.0))

            if agreed:
                bucket["agreedCalls"] += 1
                if won:
                    bucket["agreedCorrect"] += 1
                    bucket["correct"] += 1
            else:
                bucket["againstCalls"] += 1
                # A factor that argued against a trade is right when it loses.
                if not won:
                    bucket["againstCorrect"] += 1
                    bucket["correct"] += 1

    results: dict[str, Any] = {}
    for group, bucket in per_group.items():
        calls = bucket["calls"]
        hit_rate = _posterior(bucket["correct"], calls)

        results[group] = {
            "calls": calls,
            "correct": bucket["correct"],
            "rawHitRate": round(bucket["correct"] / calls, 4) if calls else None,
            "adjustedHitRate": round(hit_rate, 4),
            # Reported separately because they mean different things: one is the
            # factor as a signal, the other as a veto.
            "whenAgreeing": {
                "calls": bucket["agreedCalls"],
                "winRate": round(bucket["agreedCorrect"] / bucket["agreedCalls"], 4)
                if bucket["agreedCalls"]
                else None,
            },
            "whenOpposing": {
                "calls": bucket["againstCalls"],
                "correctlyWarned": round(bucket["againstCorrect"] / bucket["againstCalls"], 4)
                if bucket["againstCalls"]
                else None,
            },
            "averageWeight": round(bucket["weightSum"] / calls, 4) if calls else 0.0,
            "reliable": calls >= MIN_SAMPLES_PER_GROUP,
        }

    return results


def propose(
    base_weights: dict[str, float],
    performance: dict[str, Any],
    *,
    total_trades: int,
) -> dict[str, Any]:
    """
    Proposed weights from measured performance.

    Returns the proposal plus everything needed to judge it. `applied` is always
    False here — this function proposes, `validate` decides.
    """
    if total_trades < MIN_TOTAL_SAMPLES:
        return {
            "proposed": dict(base_weights),
            "changes": [],
            "applied": False,
            "validated": False,
            "reason": (
                f"{total_trades} resolved trades — at least {MIN_TOTAL_SAMPLES} are needed before "
                "weights are touched. Adjusting on less would be fitting to noise."
            ),
        }

    adjusted: dict[str, float] = {}
    changes: list[dict[str, Any]] = []

    for group, base in base_weights.items():
        record = performance.get(group)

        if not record or not record.get("reliable"):
            adjusted[group] = base
            continue

        hit_rate = float(record["adjustedHitRate"])
        # Ratio against the 50% baseline, then bounded.
        drift = (hit_rate - PRIOR_HIT_RATE) / PRIOR_HIT_RATE
        drift = float(np.clip(drift, -MAX_WEIGHT_DRIFT, MAX_WEIGHT_DRIFT))

        new_weight = base * (1.0 + drift)
        adjusted[group] = new_weight

        if abs(drift) > 0.02:
            changes.append({
                "group": group,
                "baseWeight": round(base, 4),
                "proposedWeight": round(new_weight, 4),
                "driftPercent": round(drift * 100, 1),
                "adjustedHitRate": round(hit_rate, 4),
                "calls": record["calls"],
                "rationale": (
                    f"{group.replace('_', ' ').title()} called {record['calls']} trades at a "
                    f"shrunk {hit_rate * 100:.0f}% hit rate — "
                    + ("above" if drift > 0 else "below")
                    + f" the 50% baseline, so its weight moves {drift * 100:+.1f}%."
                ),
            })

    # Renormalise. Without this the blend's scale drifts and every calibrated
    # probability the engine has ever produced becomes wrong by a constant.
    total = sum(adjusted.values()) or 1.0
    normalised = {group: round(weight / total, 6) for group, weight in adjusted.items()}

    changes.sort(key=lambda c: -abs(c["driftPercent"]))

    return {
        "proposed": normalised,
        "changes": changes,
        "applied": False,
        "validated": False,
        "reason": (
            f"{len(changes)} weight change(s) proposed from {total_trades} resolved trades. "
            "Held pending validation."
            if changes
            else "Measured performance does not justify changing any weight."
        ),
    }


def validate(
    proposal: dict[str, Any],
    holdout: list[dict[str, Any]],
    base_weights: dict[str, float],
) -> dict[str, Any]:
    """
    Test a proposal on trades it was not fitted to.

    Re-scores each holdout trade under both weight sets and compares how well
    each ranked winners above losers. A proposal that cannot beat the base
    weights on unseen trades is rejected — which is the common outcome, and the
    point of doing this at all.

    The metric is separation of mean blended score between winners and losers,
    not accuracy. Accuracy on a small holdout is noisy; separation degrades more
    gracefully and is what the weights actually control.
    """
    resolved = [
        t for t in holdout
        if str(t.get("status", "")) in ("HIT_T1", "HIT_T2", "HIT_T3", "STOPPED")
    ]

    if len(resolved) < 15:
        return {
            **proposal,
            "validated": False,
            "applied": False,
            "holdoutSize": len(resolved),
            "reason": (
                f"Only {len(resolved)} holdout trades — too few to validate a weight change. "
                "The proposal is held, not discarded."
            ),
        }

    def separation(weights: dict[str, float]) -> float:
        winners, losers = [], []
        for trade in resolved:
            direction = 1.0 if str(trade.get("action")) == "BUY" else -1.0
            blended = 0.0
            total_weight = 0.0
            for factor in trade.get("factors") or []:
                group = str(factor.get("group", ""))
                weight = weights.get(group)
                if weight is None:
                    continue
                blended += float(factor.get("score", 0.0)) * direction * weight
                total_weight += weight
            if total_weight <= 0:
                continue
            value = blended / total_weight
            (winners if str(trade.get("status", "")).startswith("HIT_") else losers).append(value)

        if not winners or not losers:
            return 0.0
        return float(np.mean(winners) - np.mean(losers))

    base_separation = separation(base_weights)
    proposed_separation = separation(proposal["proposed"])
    edge = proposed_separation - base_separation

    validated = edge >= MIN_VALIDATION_EDGE

    return {
        **proposal,
        "validated": validated,
        "applied": validated,
        "holdoutSize": len(resolved),
        "baseSeparation": round(base_separation, 4),
        "proposedSeparation": round(proposed_separation, 4),
        "edge": round(edge, 4),
        "reason": (
            f"Validated on {len(resolved)} unseen trades: the proposed weights separate winners "
            f"from losers by {proposed_separation:.3f} against {base_separation:.3f} for the base "
            f"weights, an edge of {edge:+.3f}. Applied."
            if validated
            else (
                f"Rejected. On {len(resolved)} unseen trades the proposal scored {edge:+.3f} "
                f"against the base weights — below the {MIN_VALIDATION_EDGE:+.2f} required. "
                "The base weights remain in use."
            )
        ),
    }


def failure_breakdown(postmortems: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Which failure modes actually cost the most, ranked.

    The output people should act on. "Nine of your last thirty losses were
    higher-timeframe conflicts" is actionable in a way that a 47% win rate is not.
    """
    losses = [p for p in postmortems if not p.get("won")]
    if not losses:
        return {"total": 0, "reasons": [], "summary": "No losing trades to analyse."}

    counts: dict[str, dict[str, Any]] = {}
    for postmortem in losses:
        reason = str(postmortem.get("primaryReason", "UNCLEAR"))
        bucket = counts.setdefault(reason, {"count": 0, "confidenceSum": 0.0, "examples": []})
        bucket["count"] += 1
        causes = postmortem.get("causes") or []
        bucket["confidenceSum"] += float(causes[0].get("confidence", 0.0)) if causes else 0.0
        if len(bucket["examples"]) < 3:
            bucket["examples"].append(postmortem.get("symbol"))

    from .postmortem import FAILURE_REASONS

    reasons = [
        {
            "reason": reason,
            "label": FAILURE_REASONS.get(reason, reason),
            "count": bucket["count"],
            "share": round(bucket["count"] / len(losses), 4),
            "averageConfidence": round(bucket["confidenceSum"] / bucket["count"], 3),
            "examples": bucket["examples"],
        }
        for reason, bucket in counts.items()
    ]
    reasons.sort(key=lambda r: -r["count"])

    top = reasons[0]
    summary = (
        f"{len(losses)} losses analysed. The most common cause is {top['label'].lower()} "
        f"({top['count']} of {len(losses)}, {top['share'] * 100:.0f}%)"
        + (
            " — and it was visible before entry, which makes it the most improvable."
            if top["reason"] in ("HTF_CONFLICT", "WEAK_STRUCTURE", "LOW_VOLUME")
            else "."
        )
    )

    return {"total": len(losses), "reasons": reasons, "summary": summary}
