"""
Trade post-mortem.

For every signal that has resolved, this reconstructs what actually happened and
diagnoses why. Not "the trade lost" — *which of the things the engine believed
at entry turned out to be wrong*.

That distinction is the whole value. A losing trade where the trend read was
correct and the stop was simply too tight is a sizing problem. A losing trade
where the engine called an uptrend into a lower high is an analysis problem.
They demand opposite responses, and a win-rate column cannot tell them apart.

**On the honesty of diagnosis.** Several failure modes are genuinely
indistinguishable after the fact. A stop taken out by one tick before price ran
to target looks identical to a liquidity sweep, and calling every such trade a
"liquidity trap" would be flattering the engine — it converts every unlucky loss
into someone else's manipulation. So each diagnosis carries a confidence, and
where the evidence is ambiguous the module says the evidence is ambiguous rather
than picking the most comfortable story.

**On what this feeds.** The diagnoses aggregate into factor attribution, which
adjusts weights. That loop is only sound if the diagnoses are honest, which is
why the bar for asserting a cause is set deliberately high.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

#: Failure taxonomy. Every diagnosis maps to exactly one of these.
FAILURE_REASONS: dict[str, str] = {
    "TREND_MISREAD": "Incorrect trend identification",
    "WEAK_STRUCTURE": "Weak market structure",
    "FALSE_BREAKOUT": "False breakout",
    "LIQUIDITY_TRAP": "Liquidity trap — stop swept then reversed",
    "NEWS_IMPACT": "News impact",
    "LOW_VOLUME": "Low volume — move lacked participation",
    "POOR_TIMING": "Poor entry timing",
    "HIGH_VOLATILITY": "High market volatility",
    "HTF_CONFLICT": "Conflicting higher-timeframe trend",
    "STOP_TOO_TIGHT": "Stop too tight for the instrument's volatility",
    "TARGET_TOO_FAR": "Target beyond what the move could reach",
    "UNCLEAR": "No single cause identifiable",
}

#: Why the engine ended a signal itself, rather than why price ended it.
#:
#: Kept separate from FAILURE_REASONS because these are not failures. A
#: cancellation is a decision, and mixing the two vocabularies is what makes a
#: prudent exit read like a losing trade in every report built on top.
CANCELLATION_REASONS: dict[str, str] = {
    "TREND_REVERSAL": "Higher-timeframe trend reversed",
    "STRUCTURE_CHANGED": "Market structure broke the other way",
    "NEWS_IMPACT": "High-impact news landed",
    "CONFIDENCE_DROP": "Confidence fell below the issuing threshold",
    "STOP_RISK": "Probability of being stopped rose sharply",
    "VOLATILITY_SHIFT": "Volatility expanded beyond what the stop was sized for",
    "SESSION_CLOSED": "Session closed with the setup unresolved",
    "ORDER_FLOW_REVERSAL": "Order flow turned against the position",
    "UNKNOWN": "No single cause recorded",
}

#: How far beyond the stop price must reverse for a sweep to be claimed.
#: Below this, "swept" and "stopped out" are the same event wearing two names.
SWEEP_REVERSAL_R = 0.75
#: Excursion beyond the stop, in R, above which it was a genuine break not a wick.
GENUINE_BREAK_R = 0.35


def _excursions(
    candles: list[dict[str, Any]],
    *,
    entry: float,
    stop: float,
    long: bool,
) -> dict[str, float]:
    """
    Maximum adverse and favourable excursion, in R.

    MAE answers "how much heat did this take?" and MFE answers "how good did it
    get?". Together they diagnose most sizing and target problems on their own:
    a trade with 0.3R MAE and 2.5R MFE that closed at +1R was managed badly, not
    analysed badly.
    """
    if not candles:
        return {"maeR": 0.0, "mfeR": 0.0, "barsHeld": 0}

    risk = abs(entry - stop)
    if risk <= 0:
        return {"maeR": 0.0, "mfeR": 0.0, "barsHeld": len(candles)}

    highs = np.array([float(c["high"]) for c in candles])
    lows = np.array([float(c["low"]) for c in candles])

    if long:
        adverse = (entry - lows.min()) / risk
        favourable = (highs.max() - entry) / risk
    else:
        adverse = (highs.max() - entry) / risk
        favourable = (entry - lows.min()) / risk

    return {
        "maeR": round(float(max(0.0, adverse)), 3),
        "mfeR": round(float(max(0.0, favourable)), 3),
        "barsHeld": len(candles),
    }


def _factor_by_group(factors: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    return {str(f.get("group")): f for f in (factors or [])}


def _counterfactual(
    candles: list[dict[str, Any]],
    *,
    entry: float,
    stop: float,
    target: float | None,
    long: bool,
) -> dict[str, Any]:
    """
    What did price do *after* the engine walked away?

    The only question that can tell a good cancellation from a bad one. Without
    it every cancellation looks equally prudent, and an engine that cancels
    everything would score perfectly while never making a penny.

    Deliberately asks which level was reached *first*, not merely whether each
    was reached at all: over a long enough window price usually touches both,
    and "it eventually recovered" is the excuse that keeps bad exits alive.
    """
    if not candles or entry <= 0 or stop <= 0:
        return {
            "verdict": "UNKNOWN",
            "detail": "No post-cancellation candles available to judge the decision by.",
            "measured": False,
        }

    risk = abs(entry - stop)
    if risk <= 0:
        return {"verdict": "UNKNOWN", "detail": "Zero risk distance.", "measured": False}

    stop_index: int | None = None
    target_index: int | None = None

    for index, candle in enumerate(candles):
        high = float(candle["high"])
        low = float(candle["low"])

        if stop_index is None:
            if (long and low <= stop) or (not long and high >= stop):
                stop_index = index
        if target_index is None and target:
            if (long and high >= target) or (not long and low <= target):
                target_index = index
        if stop_index is not None and target_index is not None:
            break

    # Best and worst the position would have reached had it been held.
    highs = np.array([float(c["high"]) for c in candles])
    lows = np.array([float(c["low"]) for c in candles])
    if long:
        best_r = float((highs.max() - entry) / risk)
        worst_r = float((entry - lows.min()) / risk)
    else:
        best_r = float((entry - lows.min()) / risk)
        worst_r = float((highs.max() - entry) / risk)

    measures = {
        "bestR": round(best_r, 3),
        "worstR": round(-worst_r, 3),
        "barsObserved": len(candles),
        "measured": True,
    }

    if stop_index is not None and (target_index is None or stop_index <= target_index):
        return {
            **measures,
            "verdict": "SAVED",
            "detail": (
                f"Price went on to hit the stop {stop_index + 1} bars later. "
                f"Cancelling avoided a full −1R loss."
            ),
        }

    if target_index is not None:
        return {
            **measures,
            "verdict": "COSTLY",
            "detail": (
                f"Price went on to reach the first target {target_index + 1} bars later, "
                f"peaking at {best_r:.2f}R. The cancellation gave up a winning trade."
            ),
        }

    return {
        **measures,
        "verdict": "INCONCLUSIVE",
        "detail": (
            f"Neither stop nor target was reached in the {len(candles)} bars since. "
            f"Price ranged between {-worst_r:.2f}R and {best_r:.2f}R."
        ),
    }


def _diagnose_cancellation(
    *,
    status: str,
    health_findings: list[dict[str, Any]] | None,
    invalidation_reason: str | None,
    excursions: dict[str, float],
    counterfactual: dict[str, Any],
    confidence_at_issue: float | None,
    confidence_at_end: float | None,
) -> list[dict[str, Any]]:
    """
    Why this signal was ended, and whether ending it was the right call.

    The causes are taken from what the revalidation actually recorded at the
    time rather than re-derived now. Re-deriving would answer a different
    question — what the engine thinks today — and quietly rewrite history in
    whichever direction the market has since moved.
    """
    causes: list[dict[str, Any]] = []

    findings = health_findings or []
    for finding in findings[:4]:
        key = str(finding.get("key") or finding.get("label") or "UNKNOWN")
        causes.append(
            {
                "reason": key,
                "label": CANCELLATION_REASONS.get(key, str(finding.get("label", key))),
                "confidence": 0.9 if str(finding.get("severity")) == "CRITICAL" else 0.6,
                "detail": str(finding.get("detail") or finding.get("evidence") or ""),
            }
        )

    if not causes:
        key = invalidation_reason or "UNKNOWN"
        causes.append(
            {
                "reason": key,
                "label": CANCELLATION_REASONS.get(key, key),
                "confidence": 0.5,
                "detail": "Recorded without detailed findings.",
            }
        )

    if confidence_at_issue is not None and confidence_at_end is not None:
        delta = confidence_at_end - confidence_at_issue
        causes.append(
            {
                "reason": "CONFIDENCE_TRAJECTORY",
                "label": "Confidence trajectory",
                "confidence": 1.0,
                "detail": (
                    f"Confidence moved from {confidence_at_issue:.0f} to "
                    f"{confidence_at_end:.0f} ({delta:+.0f}) over the life of the signal."
                ),
            }
        )

    verdict = counterfactual.get("verdict")
    if verdict in {"SAVED", "COSTLY", "INCONCLUSIVE"}:
        causes.append(
            {
                "reason": f"DECISION_{verdict}",
                "label": {
                    "SAVED": "Cancellation avoided a loss",
                    "COSTLY": "Cancellation gave up a winner",
                    "INCONCLUSIVE": "Cancellation not yet judgeable",
                }[verdict],
                "confidence": 1.0 if verdict != "INCONCLUSIVE" else 0.3,
                "detail": str(counterfactual.get("detail", "")),
            }
        )

    return causes


def _diagnose_loss(
    *,
    long: bool,
    factors: dict[str, dict[str, Any]],
    confluence: dict[str, Any] | None,
    excursions: dict[str, float],
    post: pd.DataFrame,
    entry: float,
    stop: float,
    volatility_percentile: float | None,
    volume_ratio: float | None,
    had_news: bool,
) -> list[dict[str, Any]]:
    """
    Rank the plausible causes of a loss.

    Multiple can be true at once — a false breakout on low volume into a
    conflicting higher timeframe is one trade with three problems, and
    collapsing that to a single label loses the point.
    """
    causes: list[dict[str, Any]] = []
    risk = abs(entry - stop) or 1e-9

    # ── Liquidity trap: stopped, then reversed hard the intended way ──
    if len(post) > 0:
        closes = post["close"].to_numpy(dtype=float)
        final = float(closes[-1])
        recovery = (final - stop) / risk if long else (stop - final) / risk

        excursion_beyond = 0.0
        if long:
            excursion_beyond = max(0.0, (stop - float(post["low"].min())) / risk)
        else:
            excursion_beyond = max(0.0, (float(post["high"].max()) - stop) / risk)

        if recovery >= SWEEP_REVERSAL_R and excursion_beyond < GENUINE_BREAK_R:
            causes.append({
                "reason": "LIQUIDITY_TRAP",
                "confidence": 0.75,
                "detail": (
                    f"Price traded only {excursion_beyond:.2f}R beyond the stop before reversing "
                    f"{recovery:.2f}R back through it. The level was swept, not broken — the stop "
                    "sat where everyone else's did."
                ),
            })
        elif excursion_beyond > 1.0:
            causes.append({
                "reason": "TREND_MISREAD",
                "confidence": 0.7,
                "detail": (
                    f"Price ran {excursion_beyond:.2f}R past the stop and kept going. This was not "
                    "noise around a level; the directional read was wrong."
                ),
            })

    # ── Stop too tight for the instrument ────────────────────────
    if excursions["mfeR"] >= 1.0 and excursions["maeR"] >= 0.95:
        causes.append({
            "reason": "STOP_TOO_TIGHT",
            "confidence": 0.65,
            "detail": (
                f"The trade reached {excursions['mfeR']:.2f}R in favour at some point but took "
                f"{excursions['maeR']:.2f}R of heat first. The direction was right; the stop was "
                "inside the instrument's normal noise."
            ),
        })

    # ── Higher-timeframe conflict, known at entry ────────────────
    if confluence:
        alignment = float(confluence.get("alignmentScore", 100.0))
        conflicts = confluence.get("conflicts") or []
        if alignment < 55 or conflicts:
            causes.append({
                "reason": "HTF_CONFLICT",
                "confidence": 0.8 if conflicts else 0.55,
                "detail": (
                    f"Timeframe alignment was only {alignment:.0f}/100 at entry"
                    + (f". {conflicts[0]}" if conflicts else ".")
                    + " This was visible before the trade was taken."
                ),
            })

    # ── Structure was weak at entry ──────────────────────────────
    structure = factors.get("MARKET_STRUCTURE")
    if structure is not None:
        score = float(structure.get("score", 0.0))
        agreed = score > 0 if long else score < 0
        if not agreed or abs(score) < 0.15:
            causes.append({
                "reason": "WEAK_STRUCTURE",
                "confidence": 0.6,
                "detail": (
                    f"Market structure scored {score:+.2f} at entry — "
                    + ("against the trade" if not agreed else "close to neutral")
                    + ". There was no structural break confirming the direction."
                ),
            })

    # ── Trend factor disagreed ───────────────────────────────────
    trend = factors.get("TREND")
    if trend is not None:
        score = float(trend.get("score", 0.0))
        if (score < -0.1 and long) or (score > 0.1 and not long):
            causes.append({
                "reason": "TREND_MISREAD",
                "confidence": 0.7,
                "detail": f"The trend factor scored {score:+.2f} — against the direction taken.",
            })

    # ── Volume never confirmed ───────────────────────────────────
    if volume_ratio is not None and volume_ratio < 0.9:
        causes.append({
            "reason": "LOW_VOLUME",
            "confidence": 0.5,
            "detail": (
                f"Entry bar volume was {volume_ratio:.2f}× average. Moves without participation "
                "revert more often than they continue."
            ),
        })

    # ── Volatility regime ────────────────────────────────────────
    if volatility_percentile is not None and volatility_percentile >= 85:
        causes.append({
            "reason": "HIGH_VOLATILITY",
            "confidence": 0.55,
            "detail": (
                f"ATR was at the {volatility_percentile:.0f}th percentile. A stop sized for normal "
                "conditions is noise in this regime."
            ),
        })

    # ── News ─────────────────────────────────────────────────────
    if had_news:
        causes.append({
            "reason": "NEWS_IMPACT",
            "confidence": 0.45,
            "detail": (
                "High-impact news landed during the trade. Whatever the chart said, the move that "
                "followed was driven by the announcement."
            ),
        })

    # ── Poor timing: immediately adverse, never in favour ────────
    if excursions["mfeR"] < 0.25 and excursions["barsHeld"] <= 5:
        causes.append({
            "reason": "POOR_TIMING",
            "confidence": 0.6,
            "detail": (
                f"The trade never moved more than {excursions['mfeR']:.2f}R in favour and resolved "
                f"in {excursions['barsHeld']} bars. Entry was at the wrong moment in the move — "
                "most likely chasing rather than waiting for a retest."
            ),
        })

    if not causes:
        causes.append({
            "reason": "UNCLEAR",
            "confidence": 0.3,
            "detail": (
                "No single factor stands out. Some losses are simply the losing side of a "
                "positive-expectancy process, and labelling those would be manufacturing a lesson "
                "that is not there."
            ),
        })

    # Several checks can reach the same conclusion by different routes — price
    # running past the stop and the trend factor having disagreed are both
    # TREND_MISREAD. Reporting it twice inflates its apparent weight in the
    # failure breakdown, which is the one output meant to be counted.
    causes.sort(key=lambda c: -c["confidence"])
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for cause in causes:
        if cause["reason"] in seen:
            continue
        seen.add(cause["reason"])
        unique.append(cause)

    return unique[:4]


def _diagnose_win(
    *,
    factors: dict[str, dict[str, Any]],
    confluence: dict[str, Any] | None,
    excursions: dict[str, float],
    status: str,
) -> list[dict[str, Any]]:
    """What actually carried a winning trade, ranked by contribution."""
    contributors: list[dict[str, Any]] = []

    for group, factor in factors.items():
        score = float(factor.get("score", 0.0))
        weight = float(factor.get("weight", 0.0))
        contribution = abs(score * weight)
        if contribution < 0.02:
            continue
        contributors.append({
            "group": group,
            "score": round(score, 3),
            "weight": round(weight, 3),
            "contribution": round(contribution, 4),
            "detail": str(factor.get("detail", ""))[:200],
        })

    contributors.sort(key=lambda c: -c["contribution"])

    notes: list[dict[str, Any]] = []
    if contributors:
        top = contributors[0]
        notes.append({
            "reason": "PRIMARY_DRIVER",
            "confidence": 0.7,
            "detail": (
                f"{top['group'].replace('_', ' ').title()} carried the most weight "
                f"({top['contribution']:.3f} of the blend) and resolved correctly."
            ),
        })

    if confluence and float(confluence.get("alignmentScore", 0)) >= 70:
        notes.append({
            "reason": "HTF_ALIGNED",
            "confidence": 0.75,
            "detail": (
                f"Timeframes were aligned at {float(confluence['alignmentScore']):.0f}/100 at entry. "
                "Trades taken with the higher timeframe are the ones that run."
            ),
        })

    if excursions["maeR"] < 0.4:
        notes.append({
            "reason": "CLEAN_ENTRY",
            "confidence": 0.7,
            "detail": (
                f"Maximum heat was only {excursions['maeR']:.2f}R — the entry was close to the "
                "level that defined the risk, which is what makes a good reward:risk achievable."
            ),
        })

    if status == "HIT_T3":
        notes.append({
            "reason": "FULL_EXTENSION",
            "confidence": 0.6,
            "detail": "The move reached the third target — the projection was not over-optimistic.",
        })

    return notes, contributors


def analyse(
    signal: dict[str, Any],
    candles_after_entry: list[dict[str, Any]],
    *,
    volatility_percentile: float | None = None,
    volume_ratio: float | None = None,
    had_news: bool = False,
    candles_after_exit: list[dict[str, Any]] | None = None,
    health_findings: list[dict[str, Any]] | None = None,
    invalidation_reason: str | None = None,
    confidence_at_end: float | None = None,
    entry_filled: bool = True,
    target: float | None = None,
) -> dict[str, Any]:
    """
    Full post-mortem for one resolved signal.

    `candles_after_entry` must start at or after the entry bar and run to
    resolution. Without it the excursion measures are unavailable and the
    diagnosis falls back to what was knowable at entry — still useful, and
    labelled as such.
    """
    action = str(signal.get("action", "BUY"))
    long = action == "BUY"
    status = str(signal.get("status", ""))
    entry = float(signal.get("entry") or 0.0)
    stop = float(signal.get("stopLoss") or 0.0)
    won = status.startswith("HIT_")

    factors = _factor_by_group(signal.get("factors"))
    confluence = signal.get("confluence")

    post = pd.DataFrame(candles_after_entry) if candles_after_entry else pd.DataFrame()
    excursions = _excursions(candles_after_entry, entry=entry, stop=stop, long=long)

    # Ended by the engine rather than by price. Diagnosed on its own terms:
    # routing these through the loss path would label a deliberate exit with a
    # failure reason and hand the learner a −1R that was never paid.
    cancelled = status in {"CANCELLED", "INVALID"}

    if cancelled:
        counterfactual = _counterfactual(
            candles_after_exit or [],
            entry=entry,
            stop=stop,
            target=target,
            long=long,
        )
        causes = _diagnose_cancellation(
            status=status,
            health_findings=health_findings,
            invalidation_reason=invalidation_reason,
            excursions=excursions,
            counterfactual=counterfactual,
            confidence_at_issue=(
                float(signal["confidence"]) if signal.get("confidence") is not None else None
            ),
            confidence_at_end=confidence_at_end,
        )
        contributors = []
    elif won:
        counterfactual = {"verdict": "NOT_APPLICABLE", "measured": False}
        notes, contributors = _diagnose_win(
            factors=factors, confluence=confluence, excursions=excursions, status=status
        )
        causes = notes
    else:
        counterfactual = {"verdict": "NOT_APPLICABLE", "measured": False}
        causes = _diagnose_loss(
            long=long,
            factors=factors,
            confluence=confluence,
            excursions=excursions,
            post=post,
            entry=entry,
            stop=stop,
            volatility_percentile=volatility_percentile,
            volume_ratio=volume_ratio,
            had_news=had_news,
        )
        contributors = []

    # ── Execution quality ────────────────────────────────────────
    # How much of the available move was actually captured. A trade that hit T1
    # while price went on to 3R captured a third of what was there.
    realised_r: float | None
    if status == "HIT_T1":
        realised_r = 1.0
    elif status == "HIT_T2":
        realised_r = 2.0
    elif status == "HIT_T3":
        realised_r = 3.0
    elif status == "STOPPED":
        realised_r = -1.0
    elif cancelled and entry_filled and not post.empty and abs(entry - stop) > 0:
        # A position that was actually opened and then closed early realised
        # whatever the exit was worth — usually a small gain or a small loss,
        # and almost never the −1R a stop-out costs.
        exit_price = float(post.iloc[-1]["close"])
        move = (exit_price - entry) if long else (entry - exit_price)
        realised_r = round(move / abs(entry - stop), 3)
    else:
        # Never filled. There was no position, so there is no R — and reporting
        # 0.0 here would be a lie of a different kind, since it would be
        # averaged in as a breakeven trade that never took place.
        realised_r = None

    capture = (
        min(1.0, realised_r / excursions["mfeR"])
        if excursions["mfeR"] > 0 and realised_r is not None and realised_r > 0
        else 0.0
    )

    execution = {
        "maeR": excursions["maeR"],
        "mfeR": excursions["mfeR"],
        "realisedR": realised_r,
        "captureRatio": round(capture, 3),
        "barsHeld": excursions["barsHeld"],
        "measured": bool(candles_after_entry),
        "entryFilled": entry_filled,
        "note": (
            "No post-entry candles supplied — excursion measures unavailable."
            if not candles_after_entry
            else (
                f"Never filled, so no position was taken. Price ranged "
                f"{excursions['maeR']:.2f}R adverse / {excursions['mfeR']:.2f}R favourable "
                f"against the planned entry."
            )
            if realised_r is None
            else (
                f"Took {excursions['maeR']:.2f}R of heat, reached {excursions['mfeR']:.2f}R "
                f"in favour, realised {realised_r:+.2f}R over {excursions['barsHeld']} bars."
            )
        ),
    }

    primary = causes[0] if causes else {"reason": "UNCLEAR", "confidence": 0.0, "detail": ""}

    return {
        "signalId": signal.get("id"),
        "symbol": signal.get("symbol"),
        "status": status,
        "won": won,
        # Stated explicitly so no consumer has to infer it from the status and
        # get it wrong: a cancellation is neither a win nor a loss.
        "cancelled": cancelled,
        "countsAsLoss": status == "STOPPED",
        "primaryReason": primary["reason"],
        "primaryReasonLabel": (
            CANCELLATION_REASONS.get(primary["reason"])
            or FAILURE_REASONS.get(primary["reason"])
            or primary.get("label")
            or primary["reason"]
        ),
        "causes": causes,
        "contributors": contributors[:5],
        "execution": execution,
        "counterfactual": counterfactual,
        "summary": _summarise(won, status, primary, execution, cancelled, counterfactual),
    }


def _summarise(
    won: bool,
    status: str,
    primary: dict[str, Any],
    execution: dict[str, Any],
    cancelled: bool = False,
    counterfactual: dict[str, Any] | None = None,
) -> str:
    if cancelled:
        label = (
            CANCELLATION_REASONS.get(primary["reason"])
            or primary.get("label")
            or primary["reason"]
        )
        opening = (
            "Cancelled before the stop was reached"
            if status == "CANCELLED"
            else "Invalidated before the entry ever filled"
        )
        verdict = (counterfactual or {}).get("verdict")
        judgement = {
            "SAVED": " In hindsight the right call — price went on to hit the stop.",
            "COSTLY": " In hindsight the wrong call — price went on to reach the target.",
        }.get(verdict, "")
        return (
            f"{opening} — {label.lower()}. {primary.get('detail', '')} "
            f"{execution['note']}{judgement}"
        ).strip()

    if won:
        return (
            f"Reached {status.replace('HIT_T', 'target ')}. {primary.get('detail', '')} "
            f"{execution['note']}"
        ).strip()

    label = FAILURE_REASONS.get(primary["reason"], primary["reason"])
    if primary["reason"] == "UNCLEAR":
        return f"Stopped out. {primary['detail']} {execution['note']}".strip()

    return (
        f"Stopped out — most likely {label.lower()} "
        f"({primary['confidence'] * 100:.0f}% confidence in that read). "
        f"{primary['detail']} {execution['note']}"
    ).strip()
