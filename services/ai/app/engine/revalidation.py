"""
Signal revalidation.

A signal is a claim about the future made at a moment in the past. Markets move
on, and the question this module answers is the one the original analysis
cannot: **is the reason for this trade still true?**

That is deliberately not the same as "is it losing". A trade can be underwater
with its thesis entirely intact — that is what a stop is for. A trade can be in
profit while the reason for taking it has evaporated, which is the more
dangerous case because nothing about the P&L prompts you to look.

So the comparison here is always *then versus now*, against the analysis
recorded at issue rather than against a fresh opinion. Six ways a thesis dies:

1. **Trend reversal** — the direction the trade needs has turned.
2. **Market structure changed** — a break of structure against the position.
3. **High-impact news** — an event the technical read cannot price.
4. **Confidence collapse** — the engine re-runs and no longer believes it.
5. **Stop-loss probability increased** — price has closed most of the distance
   to the stop, or volatility has widened enough that the stop is now inside
   the noise.
6. **Volatility or liquidity shift** — the market the trade was sized for is
   not the market it is now in.

Every finding carries a severity. `CRITICAL` means the thesis is gone and the
position should not be held on the original reasoning; `WARNING` means
something has degraded and is worth watching. The distinction matters because
alerting on every wobble trains people to ignore alerts, and the one that
actually mattered arrives looking identical to the forty that did not.
"""

from __future__ import annotations

from typing import Any

import numpy as np

#: Confidence fall, in absolute points, that counts as a collapse.
CONFIDENCE_DROP_CRITICAL = 22.0
CONFIDENCE_DROP_WARNING = 12.0

#: Confidence below which a signal is no longer worth holding on its own terms.
CONFIDENCE_FLOOR = 38.0

#: Share of the entry-to-stop distance travelled before the stop is "likely".
STOP_PROXIMITY_WARNING = 0.55
STOP_PROXIMITY_CRITICAL = 0.78

#: ATR expansion multiple that invalidates the original stop placement.
VOLATILITY_EXPANSION = 1.6

#: Hours ahead within which a high-impact event matters to an open position.
NEWS_HORIZON_HOURS = 12.0

REASONS = {
    "TREND_REVERSAL": "Trend reversal detected",
    "STRUCTURE_CHANGED": "Market structure changed",
    "NEWS_IMPACT": "High-impact news released",
    "CONFIDENCE_DROP": "AI confidence dropped below the required threshold",
    "STOP_RISK": "Stop-loss probability increased",
    "VOLATILITY_SHIFT": "Unusual volatility or liquidity change",
    "SESSION_CLOSED": "Market closed with the position open",
    "ORDER_FLOW_REVERSAL": "Order flow turned against the position",
}


def _f(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _finding(
    key: str, severity: str, detail: str, evidence: str, action: str
) -> dict[str, Any]:
    return {
        "key": key,
        "label": REASONS.get(key, key),
        "severity": severity,
        "detail": detail,
        "evidence": evidence,
        "action": action,
    }


def revalidate(
    signal: dict[str, Any],
    current: dict[str, Any],
    *,
    price: float | None = None,
    economic_events: list[dict[str, Any]] | None = None,
    news: list[dict[str, Any]] | None = None,
    market_open: bool = True,
) -> dict[str, Any]:
    """
    Compare a live signal against a fresh analysis.

    `signal` is the record as issued — action, entry, stop, the factor
    breakdown and confidence at the time. `current` is a fresh analysis of the
    same instrument and timeframe.
    """
    action = str(signal.get("action", ""))
    if action not in ("BUY", "SELL"):
        return {
            "valid": True,
            "findings": [],
            "severity": "NONE",
            "summary": "Not a directional position — nothing to revalidate.",
        }

    long = action == "BUY"
    direction = 1.0 if long else -1.0

    entry = _f(signal.get("entry"))
    stop = _f(signal.get("stopLoss"))
    issued_confidence = _f(signal.get("confidence")) or 0.0

    technical = current.get("technical") or {}
    forecast = current.get("forecast") or {}
    smc = current.get("smc") or {}

    findings: list[dict[str, Any]] = []

    # ── 1. Trend reversal ────────────────────────────────────────
    trend = (technical.get("trend") or {}).get("direction")
    trend_strength = _f((technical.get("trend") or {}).get("strength")) or 0.0

    if trend == "DOWNTREND" and long:
        findings.append(_finding(
            "TREND_REVERSAL", "CRITICAL" if trend_strength >= 25 else "WARNING",
            "The trend has turned down while this is a long position.",
            f"Trend now reads DOWNTREND with strength {trend_strength:.0f}.",
            "The directional premise of the trade no longer holds.",
        ))
    elif trend == "UPTREND" and not long:
        findings.append(_finding(
            "TREND_REVERSAL", "CRITICAL" if trend_strength >= 25 else "WARNING",
            "The trend has turned up while this is a short position.",
            f"Trend now reads UPTREND with strength {trend_strength:.0f}.",
            "The directional premise of the trade no longer holds.",
        ))

    # ── 2. Structure break against the position ──────────────────
    structure = smc.get("structure") or []
    if structure:
        latest = structure[-1]
        event_direction = 1.0 if latest.get("direction") == "BULLISH" else -1.0
        if event_direction * direction < 0:
            # A change of character is a stronger statement than a continuation.
            critical = str(latest.get("type")) == "CHOCH"
            findings.append(_finding(
                "STRUCTURE_CHANGED", "CRITICAL" if critical else "WARNING",
                f"A {latest.get('type')} printed against the position.",
                f"{latest.get('type')} {str(latest.get('direction', '')).lower()} at "
                f"{latest.get('price')}.",
                (
                    "Structure has flipped against the trade — the level the setup was built on "
                    "has given way."
                    if critical
                    else "Structure is weakening against the position."
                ),
            ))

    # ── 3. Confidence collapse ───────────────────────────────────
    now_confidence = _f(forecast.get("confidence")) or 0.0
    drop = issued_confidence - now_confidence

    if now_confidence < CONFIDENCE_FLOOR and issued_confidence >= CONFIDENCE_FLOOR:
        findings.append(_finding(
            "CONFIDENCE_DROP", "CRITICAL",
            f"Confidence has fallen to {now_confidence:.0f}, below the {CONFIDENCE_FLOOR:.0f} "
            "floor for holding on the original reasoning.",
            f"Issued at {issued_confidence:.0f}, now {now_confidence:.0f} "
            f"(−{drop:.0f} points).",
            "The engine would not issue this signal today.",
        ))
    elif drop >= CONFIDENCE_DROP_CRITICAL:
        findings.append(_finding(
            "CONFIDENCE_DROP", "CRITICAL",
            f"Confidence has fallen {drop:.0f} points since the signal was issued.",
            f"Issued at {issued_confidence:.0f}, now {now_confidence:.0f}.",
            "The evidence that justified the trade has materially weakened.",
        ))
    elif drop >= CONFIDENCE_DROP_WARNING:
        findings.append(_finding(
            "CONFIDENCE_DROP", "WARNING",
            f"Confidence has slipped {drop:.0f} points.",
            f"Issued at {issued_confidence:.0f}, now {now_confidence:.0f}.",
            "Worth watching; not yet a reason to close on its own.",
        ))

    # ── 4. Stop-loss probability ─────────────────────────────────
    if price is not None and entry is not None and stop is not None and entry != stop:
        risk = abs(entry - stop)
        travelled = (entry - price) / risk if long else (price - entry) / risk
        travelled = max(0.0, travelled)

        if travelled >= STOP_PROXIMITY_CRITICAL:
            findings.append(_finding(
                "STOP_RISK", "CRITICAL",
                f"Price has covered {travelled * 100:.0f}% of the distance to the stop.",
                f"Entry {entry:.2f}, stop {stop:.2f}, now {price:.2f}.",
                "The stop is close enough that the trade is nearly resolved against you.",
            ))
        elif travelled >= STOP_PROXIMITY_WARNING:
            findings.append(_finding(
                "STOP_RISK", "WARNING",
                f"Price has covered {travelled * 100:.0f}% of the distance to the stop.",
                f"Entry {entry:.2f}, stop {stop:.2f}, now {price:.2f}.",
                "Still within the trade's designed risk, but over halfway to it.",
            ))

    # ── 5. Volatility / liquidity shift ──────────────────────────
    volatility = technical.get("volatility") or {}
    regime = volatility.get("regime")
    atr_percent = _f(volatility.get("atrPercent"))
    issued_atr = _f(signal.get("atrPercentAtIssue"))

    if regime == "EXTREME":
        findings.append(_finding(
            "VOLATILITY_SHIFT", "WARNING",
            "Volatility has moved to an extreme regime.",
            f"ATR is {atr_percent:.2f}% of price at the "
            f"{_f(volatility.get('percentile')) or 0:.0f}th percentile.",
            (
                "The stop was sized for a calmer market. It is now inside the range of ordinary "
                "noise, which raises the chance of being stopped out on a move that means nothing."
            ),
        ))
    elif issued_atr and atr_percent and atr_percent > issued_atr * VOLATILITY_EXPANSION:
        findings.append(_finding(
            "VOLATILITY_SHIFT", "WARNING",
            f"Volatility has expanded {atr_percent / issued_atr:.1f}× since the signal was issued.",
            f"ATR was {issued_atr:.2f}% of price at issue, now {atr_percent:.2f}%.",
            "The stop distance no longer reflects how far this instrument moves.",
        ))

    volume = technical.get("volume") or {}
    volume_ratio = _f(volume.get("ratio"))
    if volume_ratio is not None and volume_ratio < 0.4:
        findings.append(_finding(
            "VOLATILITY_SHIFT", "WARNING",
            "Participation has thinned sharply.",
            f"Volume is {volume_ratio:.2f}× its 20-bar average.",
            "Levels set on this little volume are unreliable, and an exit will fill worse.",
        ))

    # ── 6. Order flow reversal, where it is measured ─────────────
    flow = current.get("orderFlow") or {}
    if flow.get("available"):
        delta = _f(flow.get("cumulativeDelta")) or 0.0
        if delta * direction < -0.18:
            findings.append(_finding(
                "ORDER_FLOW_REVERSAL", "WARNING",
                "Aggressive flow has turned against the position.",
                f"Cumulative delta {delta * 100:+.0f}% over the recent window.",
                (
                    "Measured taker-side volume is now on the other side — this is the order flow "
                    "itself, not an inference from candle shape."
                ),
            ))
        if flow.get("divergence") and str(flow.get("divergence")) != action.replace("BUY", "BULLISH").replace("SELL", "BEARISH"):
            findings.append(_finding(
                "ORDER_FLOW_REVERSAL", "WARNING",
                f"{flow.get('divergence', '').title()} delta divergence against the position.",
                "Price and aggressive flow are moving apart.",
                "Often the signature of a move being absorbed rather than followed.",
            ))

    # ── 7. High-impact news ──────────────────────────────────────
    imminent = [
        event
        for event in (economic_events or [])
        if str(event.get("importance", "")).upper() == "HIGH"
        and 0 <= float(event.get("hoursUntil", 999)) <= NEWS_HORIZON_HOURS
    ]
    if imminent:
        first = imminent[0]
        findings.append(_finding(
            "NEWS_IMPACT", "WARNING",
            f"A high-impact event lands in {float(first.get('hoursUntil', 0)):.0f} hours "
            "while this position is open.",
            str(first.get("title")),
            (
                "Holding through it converts a technical trade into a bet on the announcement, "
                "which is a different trade with different odds."
            ),
        ))

    strong_news = [
        item
        for item in (news or [])
        if str(item.get("impact", "")).upper() == "HIGH"
        and float(item.get("ageHours", 999)) <= 6
    ]
    if strong_news:
        item = strong_news[0]
        stance = str(item.get("stance", "")).upper()
        against = (stance == "BEARISH" and long) or (stance == "BULLISH" and not long)
        findings.append(_finding(
            "NEWS_IMPACT", "CRITICAL" if against else "WARNING",
            (
                "High-impact news has landed against the position."
                if against
                else "High-impact news has landed on this instrument."
            ),
            str(item.get("headline", ""))[:160],
            (
                "News moves price for reasons the chart had not priced. When it cuts against an "
                "open position, the technical case is no longer the operative one."
            ),
        ))

    # ── 8. Market closed with the position open ──────────────────
    if not market_open:
        findings.append(_finding(
            "SESSION_CLOSED", "INFO",
            "The market is closed while this position is open.",
            "No further monitoring is possible until it reopens.",
            "Overnight gap risk is not covered by the stop.",
        ))

    # ── Verdict ──────────────────────────────────────────────────
    critical = [f for f in findings if f["severity"] == "CRITICAL"]
    warnings = [f for f in findings if f["severity"] == "WARNING"]

    if critical:
        severity = "CRITICAL"
        valid = False
        primary = critical[0]
        summary = (
            f"{primary['label']}. {primary['detail']} {primary['evidence']} "
            f"{primary['action']}"
        )
        recommendation = "CLOSE"
    elif len(warnings) >= 3:
        # Several independent degradations add up to a broken thesis even when
        # no single one is decisive.
        severity = "CRITICAL"
        valid = False
        summary = (
            f"{len(warnings)} separate conditions have degraded since this signal was issued: "
            + "; ".join(w["label"].lower() for w in warnings[:3])
            + ". No single one is decisive, but together the setup is no longer the one that was "
            "analysed."
        )
        recommendation = "CLOSE"
    elif warnings:
        severity = "WARNING"
        valid = True
        summary = (
            f"{len(warnings)} condition(s) worth watching: "
            + "; ".join(w["label"].lower() for w in warnings)
            + ". The thesis still holds."
        )
        recommendation = "MONITOR"
    else:
        severity = "NONE"
        valid = True
        summary = "The setup is unchanged since it was issued — nothing has invalidated it."
        recommendation = "HOLD"

    return {
        "valid": valid,
        "severity": severity,
        "recommendation": recommendation,
        "findings": findings,
        "criticalCount": len(critical),
        "warningCount": len(warnings),
        "confidenceAtIssue": round(issued_confidence, 1),
        "confidenceNow": round(now_confidence, 1),
        "confidenceDelta": round(now_confidence - issued_confidence, 1),
        "summary": summary,
        "note": (
            "Revalidation compares the current read against the analysis recorded at issue. It is "
            "about whether the *reason* still holds, not whether the trade is winning — a losing "
            "trade with an intact thesis is what a stop is for."
        ),
    }
