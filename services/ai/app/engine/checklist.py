"""
The pre-trade checklist.

Six conditions, each evaluated explicitly against the analysis, each reported
pass or fail with the evidence that decided it. A signal is only allowed through
when enough of them hold.

Why a checklist alongside the weighted blend, when the blend already reads all
of this? Because a weighted average lets strength in one place paper over
absence in another. A 0.9 trend score and no structural confirmation averages to
something respectable, and the resulting number gives no hint that the single
most important confirmation is simply missing. The blend answers "how bullish
does this look?"; the checklist answers "is anything actually confirming it?" —
and those come apart precisely in the setups that lose money.

Each check returns not just a verdict but *why*, because a checklist that says
"structure: fail" without saying what it wanted is a checklist nobody can argue
with, and one nobody can argue with is one nobody learns from.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Checks that a setup cannot be issued without, regardless of the others.
#:
#: The first two are not compensable — a trade against the higher timeframe with
#: no structural confirmation has nothing holding it up. The third is different
#: in kind: entering ahead of a high-impact announcement is a position on the
#: announcement, and no amount of technical confirmation makes that the trade
#: being analysed. A missing calendar is reported as unverified rather than
#: failing, so this only blocks when an event is actually known to be coming.
CRITICAL = ("higher_timeframe", "market_structure", "news_clear")

#: Of the non-critical checks, how many must pass.
MIN_SUPPORTING = 2


@dataclass
class Check:
    key: str
    label: str
    passed: bool
    #: True when the data needed simply isn't there — different from a fail.
    unavailable: bool
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "passed": self.passed,
            "unavailable": self.unavailable,
            "detail": self.detail,
        }


def _direction(action: str) -> int:
    return 1 if action == "BUY" else -1 if action == "SELL" else 0


def _higher_timeframe(confluence: dict[str, Any] | None, direction: int) -> Check:
    """Does the timeframe above agree with the direction being taken?"""
    if not confluence or not confluence.get("timeframes"):
        return Check(
            "higher_timeframe",
            "Higher timeframe trend matches",
            passed=False,
            unavailable=True,
            detail="No multi-timeframe read available, so higher-timeframe agreement is unconfirmed.",
        )

    bias = confluence.get("bias", "NEUTRAL")
    alignment = float(confluence.get("alignmentScore", 0.0))
    bias_direction = 1 if bias == "BULLISH" else -1 if bias == "BEARISH" else 0

    matches = bias_direction == direction and bias_direction != 0
    return Check(
        "higher_timeframe",
        "Higher timeframe trend matches",
        passed=matches and alignment >= 55,
        unavailable=False,
        detail=(
            f"Timeframes read {bias.lower()} at {alignment:.0f}/100 alignment"
            + ("." if matches else " — against the direction of this setup.")
        ),
    )


def _market_structure(smc: dict[str, Any] | None, direction: int) -> Check:
    """Has structure broken in the direction of the trade?"""
    events = (smc or {}).get("structure") or []
    if not events:
        return Check(
            "market_structure",
            "Market structure confirms direction",
            passed=False,
            unavailable=True,
            detail="No break of structure or change of character detected in the visible range.",
        )

    latest = events[-1]
    event_direction = 1 if latest.get("direction") == "BULLISH" else -1
    matches = event_direction == direction

    return Check(
        "market_structure",
        "Market structure confirms direction",
        passed=matches,
        unavailable=False,
        detail=(
            f"Latest structural event is a {latest.get('type')} "
            f"{str(latest.get('direction', '')).lower()} at {latest.get('price')}"
            + ("." if matches else " — the opposite way to this setup.")
        ),
    )


def _liquidity_sweep(smc: dict[str, Any] | None, direction: int) -> Check:
    """
    Have stops been taken before the move?

    A sweep in the *opposite* direction to the trade is the constructive one — a
    long wants sell-side liquidity taken below, because that is where the stops
    that fuel the move sat.
    """
    pools = (smc or {}).get("liquidity") or []
    swept = [p for p in pools if p.get("swept")]

    if not pools:
        return Check(
            "liquidity_sweep",
            "Liquidity sweep occurred",
            passed=False,
            unavailable=True,
            detail="No identifiable liquidity pools in range.",
        )

    if not swept:
        return Check(
            "liquidity_sweep",
            "Liquidity sweep occurred",
            passed=False,
            unavailable=False,
            detail=(
                f"{len(pools)} liquidity pool(s) identified, none swept yet — "
                "the stops that would fuel this move are still sitting there."
            ),
        )

    wanted = "SELL_SIDE" if direction > 0 else "BUY_SIDE"
    relevant = [p for p in swept if p.get("kind") == wanted]

    return Check(
        "liquidity_sweep",
        "Liquidity sweep occurred",
        passed=bool(relevant),
        unavailable=False,
        detail=(
            f"{wanted.replace('_', '-').lower()} liquidity swept at "
            f"{relevant[0].get('price')} — stops taken before the move."
            if relevant
            else f"Liquidity was swept, but on the wrong side for a {'long' if direction > 0 else 'short'}."
        ),
    )


def _zone_respected(smc: dict[str, Any] | None, direction: int, price: float) -> Check:
    """Is price reacting from an unmitigated order block or unfilled gap?"""
    blocks = (smc or {}).get("orderBlocks") or []
    gaps = (smc or {}).get("fairValueGaps") or []

    wanted = "BULLISH" if direction > 0 else "BEARISH"

    live_blocks = [
        b for b in blocks if not b.get("mitigated") and b.get("kind") == wanted
    ]
    live_gaps = [g for g in gaps if not g.get("filled") and g.get("kind") == wanted]

    if not live_blocks and not live_gaps:
        return Check(
            "zone_respected",
            "Order block or FVG respected",
            passed=False,
            unavailable=not blocks and not gaps,
            detail=(
                "No unmitigated order block or unfilled fair value gap on this side."
                if (blocks or gaps)
                else "No order blocks or fair value gaps identified."
            ),
        )

    # "Respected" means price is at or just beyond the zone, not miles away.
    def near(zone: dict[str, Any]) -> bool:
        top = float(zone.get("top", 0))
        bottom = float(zone.get("bottom", 0))
        if top <= 0 or bottom <= 0:
            return False
        height = max(top - bottom, 1e-9)
        # Within the zone, or within one zone-height of it.
        return (bottom - height) <= price <= (top + height)

    touching = [z for z in (*live_blocks, *live_gaps) if near(z)]

    if touching:
        zone = touching[0]
        kind = "order block" if zone in live_blocks else "fair value gap"
        return Check(
            "zone_respected",
            "Order block or FVG respected",
            passed=True,
            unavailable=False,
            detail=(
                f"Price at an unmitigated {wanted.lower()} {kind} "
                f"({zone.get('bottom')}–{zone.get('top')})."
            ),
        )

    return Check(
        "zone_respected",
        "Order block or FVG respected",
        passed=False,
        unavailable=False,
        detail=(
            f"{len(live_blocks) + len(live_gaps)} live zone(s) exist but price is not at any of "
            "them — entering here means entering away from the level that defines the risk."
        ),
    )


def _volume_confirms(analysis: dict[str, Any], direction: int) -> Check:
    """Did the move come with participation?"""
    technical = analysis.get("technical") or {}
    volume = technical.get("volume") or {}
    anatomy = analysis.get("candleAnatomy") or {}

    ratio = volume.get("ratio")
    if ratio is None:
        return Check(
            "volume_confirms",
            "Volume confirms the move",
            passed=False,
            unavailable=True,
            detail="No volume data for this instrument — spot forex quotes ticks, not volume.",
        )

    ratio = float(ratio)
    candle_direction = 1 if anatomy.get("direction") == "UP" else -1 if anatomy.get("direction") == "DOWN" else 0
    effort = anatomy.get("effortVsResult")

    aligned = candle_direction == direction
    expanded = ratio >= 1.2

    passed = expanded and aligned and effort != "DIVERGENT"

    if effort == "DIVERGENT":
        detail = (
            f"Volume {ratio:.1f}× average but effort and result diverge — "
            "participation without progress is distribution, not confirmation."
        )
    elif not expanded:
        detail = f"Volume {ratio:.1f}× the 20-bar average — no expansion behind this move."
    elif not aligned:
        detail = f"Volume {ratio:.1f}× average, but on a bar against the direction of the setup."
    else:
        detail = f"Volume {ratio:.1f}× the 20-bar average, on a bar in the setup's direction."

    return Check("volume_confirms", "Volume confirms the move", passed, False, detail)


def _news_clear(events: list[dict[str, Any]] | None, hours: float = 24.0) -> Check:
    """
    Is there a high-impact event scheduled before this trade would resolve?

    Entering ahead of one is taking a position on an announcement, which is a
    different trade from the technical one being analysed — and one this engine
    has no edge in.
    """
    if events is None:
        return Check(
            "news_clear",
            "No major news event imminent",
            passed=True,
            unavailable=True,
            detail="No economic calendar supplied — treated as clear, but unverified.",
        )

    imminent = [
        e for e in events
        if str(e.get("importance", "")).upper() == "HIGH"
        and 0 <= float(e.get("hoursUntil", 999)) <= hours
    ]

    if not imminent:
        return Check(
            "news_clear",
            "No major news event imminent",
            passed=True,
            unavailable=False,
            detail=f"No high-impact events scheduled in the next {hours:.0f} hours.",
        )

    first = imminent[0]
    return Check(
        "news_clear",
        "No major news event imminent",
        passed=False,
        unavailable=False,
        detail=(
            f"{first.get('title')} in {float(first.get('hoursUntil', 0)):.0f}h — "
            "entering now is a position on the announcement, not on the chart."
        ),
    )


def evaluate(
    analysis: dict[str, Any],
    *,
    action: str,
    confluence: dict[str, Any] | None = None,
    economic_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Run all six checks.

    Returns the individual results, a pass count, and whether the setup clears
    the bar. `unavailable` checks do not count as failures — a forex pair has no
    volume, and holding that against every forex signal would be measuring the
    data source rather than the setup.
    """
    direction = _direction(action)
    if direction == 0:
        return {
            "checks": [],
            "passed": 0,
            "applicable": 0,
            "clears": False,
            "criticalFailures": [],
            "summary": "No directional setup to check.",
        }

    price = float(analysis.get("price") or 0.0)
    smc = analysis.get("smc")

    checks = [
        _higher_timeframe(confluence, direction),
        _market_structure(smc, direction),
        _liquidity_sweep(smc, direction),
        _zone_respected(smc, direction, price),
        _volume_confirms(analysis, direction),
        _news_clear(economic_events),
    ]

    applicable = [c for c in checks if not c.unavailable]
    passed = [c for c in applicable if c.passed]

    critical_failures = [
        c.label for c in checks if c.key in CRITICAL and not c.passed
    ]

    supporting_passed = len([c for c in passed if c.key not in CRITICAL])
    clears = not critical_failures and supporting_passed >= MIN_SUPPORTING

    if critical_failures:
        summary = (
            f"Rejected: {' and '.join(critical_failures).lower()} did not confirm. "
            "These are the two checks a setup cannot be taken without."
        )
    elif not clears:
        summary = (
            f"Only {supporting_passed} supporting condition(s) confirmed, {MIN_SUPPORTING} required. "
            "The direction is defensible but nothing is confirming it yet."
        )
    else:
        summary = (
            f"{len(passed)} of {len(applicable)} applicable conditions confirmed, "
            "including both critical checks."
        )

    return {
        "checks": [c.to_dict() for c in checks],
        "passed": len(passed),
        "applicable": len(applicable),
        "clears": clears,
        "criticalFailures": critical_failures,
        "summary": summary,
    }
