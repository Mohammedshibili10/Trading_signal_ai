"""
The unified confluence score.

Everything else in this engine produces a partial view: the factor blend says
how bullish the evidence reads, the multi-timeframe module says whether the
timeframes agree, the checklist says whether anything confirms the direction,
sessions say whether the clock helps, no-trade zones say whether the market is
in a workable state, correlation says whether this is a new bet, and the
learning loop says how the engine has actually performed.

A trader looking at seven separate numbers has to weigh them by hand, every
time, under time pressure. This collapses them into one 0–100 score — and,
crucially, keeps the components visible underneath so the number can be argued
with rather than merely obeyed.

Two properties matter more than the exact weights:

**It is multiplicative on the gates, additive on the evidence.** Evidence
accumulates — more confirmation is better. Gates do not: a blocking no-trade
zone is not offset by beautiful evidence, it is a veto. Averaging those two
kinds of input together is how a scoring system ends up recommending trades in
conditions it explicitly identified as untradeable.

**A high score is hard to get.** With every component at a realistic best the
ceiling is in the high 80s, not 100. A scale where the top is routinely reached
is a scale with no headroom left to distinguish good from exceptional.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: How much each evidence component contributes, before gating.
#:
#: Timeframe agreement leads because it is the check most consistently
#: associated with a setup working, and the one traders most consistently skip.
#: The checklist is close behind — it is the only component that can report a
#: *missing* confirmation rather than a weak one.
EVIDENCE_WEIGHTS: dict[str, float] = {
    "timeframe_alignment": 0.30,
    "checklist": 0.28,
    "factor_agreement": 0.22,
    "calibration_quality": 0.12,
    "realised_record": 0.08,
}

#: Score bands, for the label shown next to the number.
BANDS = (
    (78.0, "EXCEPTIONAL", "Every component confirms. This is as aligned as this engine gets."),
    (65.0, "STRONG", "Broad confirmation with no outstanding conflict."),
    (52.0, "MODERATE", "More confirming than not, but something material is missing."),
    (38.0, "WEAK", "Thin confirmation. The setup exists; the case for it does not."),
    (0.0, "NONE", "Nothing meaningful is confirming this direction."),
)


def _band(score: float) -> tuple[str, str]:
    for threshold, label, note in BANDS:
        if score >= threshold:
            return label, note
    return BANDS[-1][1], BANDS[-1][2]


def _factor_agreement(factors: list[dict[str, Any]] | None) -> tuple[float, str]:
    """
    How much the weighted factor groups agree with each other.

    Not the blended score — its *consistency*. Nine groups at +0.3 is a far
    better setup than four at +0.9 and five at −0.3, even though the weighted
    means can be identical. The second case is a disagreement wearing the
    costume of a consensus.
    """
    if not factors:
        return 0.0, "No factor groups scored."

    scores = [float(f.get("score", 0.0)) for f in factors]
    weights = [float(f.get("weight", 0.0)) for f in factors]
    total_weight = sum(weights) or 1.0

    weighted_mean = sum(s * w for s, w in zip(scores, weights)) / total_weight
    direction = 1.0 if weighted_mean >= 0 else -1.0

    # Share of weight pointing the same way as the blend.
    agreeing = sum(
        w for s, w in zip(scores, weights) if s * direction > 0.05
    )
    contradicting = sum(
        w for s, w in zip(scores, weights) if s * direction < -0.05
    )

    consensus = agreeing / total_weight
    conflict = contradicting / total_weight

    # Magnitude matters too: unanimous agreement on nothing much is not a setup.
    magnitude = min(1.0, abs(weighted_mean) / 0.45)
    value = float(np.clip(consensus * 0.6 + magnitude * 0.4 - conflict * 0.5, 0.0, 1.0))

    return value, (
        f"{consensus * 100:.0f}% of factor weight agrees with the blend, "
        f"{conflict * 100:.0f}% contradicts it, at |{weighted_mean:.2f}| strength."
    )


def _calibration_quality(calibration: dict[str, Any] | None) -> tuple[float, str]:
    """
    How much the confidence number has earned the right to be believed.

    Driven by sample count and Brier score. An uncalibrated instrument scores
    the neutral 0.5 rather than 0 — absence of measurement is not evidence of
    poor measurement, and penalising it would systematically favour instruments
    that happen to have long histories.
    """
    if not calibration:
        return 0.5, "Not yet calibrated on this instrument — treated as neutral, not as a fault."

    samples = int(calibration.get("samples") or 0)
    brier = calibration.get("brierScore")

    if samples < 100 or brier is None:
        return 0.5, f"Only {samples} scored samples — below the 100 needed to calibrate."

    # 0.25 is a coin flip; below 0.20 is genuinely informative.
    brier_quality = float(np.clip((0.25 - float(brier)) / 0.08, 0.0, 1.0))
    sample_quality = float(np.clip(samples / 250.0, 0.0, 1.0))
    value = brier_quality * 0.7 + sample_quality * 0.3

    return value, (
        f"Brier {float(brier):.3f} over {samples} scored bars "
        f"({'informative' if float(brier) < 0.24 else 'near coin-flip'})."
    )


def compute(
    *,
    action: str,
    confluence: dict[str, Any] | None = None,
    checklist: dict[str, Any] | None = None,
    factors: list[dict[str, Any]] | None = None,
    calibration: dict[str, Any] | None = None,
    learning: dict[str, Any] | None = None,
    session: dict[str, Any] | None = None,
    no_trade: dict[str, Any] | None = None,
    correlation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    One score, with every component and every gate visible.

    `tradeable` is the operative field: it is False whenever any gate vetoes,
    regardless of how high the evidence score climbed.
    """
    if action not in ("BUY", "SELL"):
        return {
            "score": 0.0,
            "band": "NONE",
            "tradeable": False,
            "components": [],
            "gates": [],
            "vetoes": ["No directional setup."],
            "summary": "No directional setup to score.",
        }

    # ── Evidence ─────────────────────────────────────────────────
    components: list[dict[str, Any]] = []

    alignment = float((confluence or {}).get("alignmentScore", 0.0)) / 100.0
    bias = (confluence or {}).get("bias", "NEUTRAL")
    direction_ok = (action == "BUY" and bias == "BULLISH") or (action == "SELL" and bias == "BEARISH")
    # Alignment against the trade direction is worth nothing, not something.
    alignment_value = alignment if direction_ok else 0.0
    components.append({
        "key": "timeframe_alignment",
        "label": "Timeframe alignment",
        "value": round(alignment_value, 3),
        "weight": EVIDENCE_WEIGHTS["timeframe_alignment"],
        "detail": (
            f"{(confluence or {}).get('alignmentScore', 0):.0f}/100 alignment, bias {bias.lower()}"
            + ("" if direction_ok else " — against this setup, so it contributes nothing.")
        ),
    })

    applicable = int((checklist or {}).get("applicable", 0))
    passed = int((checklist or {}).get("passed", 0))
    checklist_value = (passed / applicable) if applicable else 0.0
    if (checklist or {}).get("criticalFailures"):
        # A critical failure is not a partial score; the checklist has said no.
        checklist_value = 0.0
    components.append({
        "key": "checklist",
        "label": "Pre-trade checklist",
        "value": round(checklist_value, 3),
        "weight": EVIDENCE_WEIGHTS["checklist"],
        "detail": (checklist or {}).get("summary", "Not evaluated."),
    })

    factor_value, factor_detail = _factor_agreement(factors)
    components.append({
        "key": "factor_agreement",
        "label": "Factor agreement",
        "value": round(factor_value, 3),
        "weight": EVIDENCE_WEIGHTS["factor_agreement"],
        "detail": factor_detail,
    })

    calibration_value, calibration_detail = _calibration_quality(calibration)
    components.append({
        "key": "calibration_quality",
        "label": "Calibration quality",
        "value": round(calibration_value, 3),
        "weight": EVIDENCE_WEIGHTS["calibration_quality"],
        "detail": calibration_detail,
    })

    record = learning or {}
    if record.get("learned"):
        rate = float((record.get("overall") or {}).get("adjustedWinRate", 0.5))
        record_value = float(np.clip((rate - 0.35) / 0.30, 0.0, 1.0))
        record_detail = record.get("summary", "")
    else:
        record_value = 0.5
        record_detail = "No realised record yet — treated as neutral."
    components.append({
        "key": "realised_record",
        "label": "Realised performance",
        "value": round(record_value, 3),
        "weight": EVIDENCE_WEIGHTS["realised_record"],
        "detail": record_detail,
    })

    evidence = sum(c["value"] * c["weight"] for c in components)

    # ── Gates ────────────────────────────────────────────────────
    gates: list[dict[str, Any]] = []
    vetoes: list[str] = []
    multiplier = 1.0

    for name, label, payload, veto_key in (
        ("session", "Trading session", session, "allowed"),
        ("no_trade", "Market state", no_trade, "blocked"),
        ("correlation", "Correlation", correlation, "blocked"),
    ):
        if not payload:
            continue

        factor = float(payload.get("confidenceMultiplier", 1.0))
        # session reports `allowed`; the others report `blocked`.
        vetoed = (not payload.get("allowed", True)) if veto_key == "allowed" else bool(payload.get("blocked"))

        gates.append({
            "key": name,
            "label": label,
            "multiplier": round(factor, 3),
            "vetoed": vetoed,
            "detail": payload.get("reason") or payload.get("summary", ""),
        })

        if vetoed:
            vetoes.append(payload.get("reason") or payload.get("summary") or f"{label} veto.")
        multiplier *= factor

    score = float(np.clip(evidence * multiplier * 100.0, 0.0, 100.0))
    band, band_note = _band(score)
    tradeable = not vetoes and score >= 52.0

    if vetoes:
        summary = f"Vetoed. {vetoes[0]}"
    elif tradeable:
        summary = (
            f"Confluence {score:.0f}/100 ({band.lower()}). {band_note} "
            f"Evidence scored {evidence * 100:.0f} before gating, "
            f"×{multiplier:.2f} from session, market state and correlation."
        )
    else:
        summary = (
            f"Confluence {score:.0f}/100 ({band.lower()}) — below the 52 needed to act. "
            f"{band_note}"
        )

    return {
        "score": round(score, 1),
        "band": band,
        "tradeable": tradeable,
        "evidenceScore": round(evidence * 100, 1),
        "gateMultiplier": round(multiplier, 3),
        "components": components,
        "gates": gates,
        "vetoes": vetoes,
        "summary": summary,
    }
