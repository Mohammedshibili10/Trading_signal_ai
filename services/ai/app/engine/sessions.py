"""
Trading session filter.

The same setup does not behave the same way at every hour. NSE's first thirty
minutes carry the overnight gap and the widest spreads of the day; the hour
before close carries position-squaring that has nothing to do with the chart.
Forex is a different instrument at 06:00 IST than during the London–New York
overlap. Crypto never closes but is thin enough at some hours that a stop can be
run on volume no one would call participation.

So this module answers one question — *is now a sensible time to take this
trade?* — and answers it per asset class, because the hours that matter are
completely different for each.

Two deliberate choices:

**Sessions gate, they do not predict.** Nothing here says which direction to
trade. It says whether the clock is working for or against a setup, which is
information the chart does not contain.

**A bad session dampens rather than blocks.** Except for genuinely dead hours,
an unfavourable session reduces confidence and says why. Blocking outright would
mean the engine refuses to look at NSE for the first thirty minutes of every
day, which is where a large share of the day's opportunity actually is.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any

#: IST is UTC+5:30 and has no daylight saving, so a fixed offset is exact.
IST = timezone(timedelta(hours=5, minutes=30))


@dataclass(frozen=True)
class SessionWindow:
    key: str
    label: str
    #: Inclusive start, exclusive end, in IST.
    start: time
    end: time
    #: Multiplier applied to signal confidence during this window.
    quality: float
    note: str


#: NSE/BSE cash session, 09:15–15:30 IST.
#:
#: The windows are drawn where the market's *character* changes, not on round
#: hours. Opening volatility, the midday liquidity trough and the closing
#: auction run are three different environments wearing one ticker.
EQUITY_SESSIONS: tuple[SessionWindow, ...] = (
    SessionWindow(
        "PRE_OPEN", "Pre-open auction", time(9, 0), time(9, 15), 0.0,
        "Order collection and matching — indicative prices only. Nothing here is tradeable.",
    ),
    SessionWindow(
        "OPENING", "Opening volatility", time(9, 15), time(9, 45), 0.75,
        "The overnight gap resolving. Widest spreads and the day's least reliable levels — "
        "real moves start here, and so do the day's worst fills.",
    ),
    SessionWindow(
        "MORNING", "Morning trend", time(9, 45), time(11, 30), 1.10,
        "The most directional stretch of the Indian session. Overnight news is priced and "
        "institutional flow is active.",
    ),
    SessionWindow(
        "MIDDAY", "Midday drift", time(11, 30), time(13, 30), 0.80,
        "The liquidity trough. Ranges compress, breakouts fail more often, and stops get "
        "run on volume that means nothing.",
    ),
    SessionWindow(
        "AFTERNOON", "Afternoon trend", time(13, 30), time(15, 0), 1.05,
        "Direction usually resumes as European markets open and volume returns.",
    ),
    SessionWindow(
        "CLOSING", "Closing hour", time(15, 0), time(15, 30), 0.70,
        "Position squaring and expiry effects. Moves here are often unwinding rather than "
        "conviction, and they frequently reverse the next morning.",
    ),
)

#: Forex, in IST. The overlap is where the volume is.
FOREX_SESSIONS: tuple[SessionWindow, ...] = (
    SessionWindow(
        "SYDNEY", "Sydney", time(3, 30), time(5, 30), 0.65,
        "Thinnest hours of the week. Spreads widen and ranges are small.",
    ),
    SessionWindow(
        "TOKYO", "Tokyo", time(5, 30), time(11, 30), 0.85,
        "Asian session — JPY and AUD pairs are active, majors mostly range.",
    ),
    SessionWindow(
        "LONDON", "London", time(12, 30), time(17, 30), 1.15,
        "The largest single share of daily FX volume. Trends established here tend to hold.",
    ),
    SessionWindow(
        "OVERLAP", "London–New York overlap", time(17, 30), time(21, 30), 1.25,
        "The highest-liquidity window of the day. Tightest spreads and the cleanest follow-through.",
    ),
    SessionWindow(
        "NEW_YORK", "New York", time(21, 30), time(2, 0), 1.00,
        "US data drives direction early; the late session thins out considerably.",
    ),
)

#: Crypto never closes, but it is not uniform.
CRYPTO_SESSIONS: tuple[SessionWindow, ...] = (
    SessionWindow(
        "ASIA", "Asia hours", time(5, 30), time(12, 30), 0.95,
        "Moderate volume. Asian flow leads, moves are often retraced later.",
    ),
    SessionWindow(
        "EUROPE", "Europe hours", time(12, 30), time(17, 30), 1.05,
        "Volume builds as European desks come in.",
    ),
    SessionWindow(
        "US", "US hours", time(17, 30), time(23, 30), 1.15,
        "Highest crypto volume and the strongest correlation with equity risk appetite.",
    ),
    SessionWindow(
        "OFF_HOURS", "Off hours", time(23, 30), time(5, 30), 0.75,
        "Thin book. Wicks here run stops on volume that would not move price in any other window.",
    ),
)


def _in_window(now: time, window: SessionWindow) -> bool:
    """Handles windows that wrap past midnight, which several FX sessions do."""
    if window.start <= window.end:
        return window.start <= now < window.end
    return now >= window.start or now < window.end


def _sessions_for(asset_class: str) -> tuple[SessionWindow, ...]:
    if asset_class == "FOREX":
        return FOREX_SESSIONS
    if asset_class == "CRYPTO":
        return CRYPTO_SESSIONS
    return EQUITY_SESSIONS


def _weekday_ist(moment: datetime) -> int:
    """0 = Monday … 6 = Sunday, in IST."""
    return moment.astimezone(IST).weekday()


def market_open(asset_class: str, moment: datetime | None = None) -> tuple[bool, str]:
    """
    Is the venue open at this instant?

    Forex opens at the Sunday 17:00 New York close-of-week boundary, which is
    Monday 03:30 IST — not Sunday morning. Getting this wrong means analysing a
    market that cannot be traded for a full day each week.
    """
    moment = (moment or datetime.now(timezone.utc)).astimezone(IST)
    weekday = moment.weekday()
    now = moment.time()

    if asset_class == "CRYPTO":
        return True, "Crypto trades 24×7."

    if asset_class == "FOREX":
        # Closes Friday 03:30 IST Saturday (Fri 17:00 NY), reopens Monday 03:30 IST.
        if weekday == 5:  # Saturday
            return False, "Forex is closed for the weekend."
        if weekday == 6:  # Sunday — closed all day in IST terms
            return False, "Forex is closed until Monday 03:30 IST."
        if weekday == 0 and now < time(3, 30):
            return False, "Forex opens at 03:30 IST on Monday."
        if weekday == 4 and now >= time(3, 30):
            # Friday after 03:30 IST is still open; the week ends Saturday 03:30.
            return True, "Forex is open — final session of the week."
        return True, "Forex is open."

    if asset_class == "INVESTMENT":
        if weekday >= 5:
            return False, "NAVs are not published at the weekend."
        return True, "NAV publishes once daily after market close."

    # EQUITY — NSE/BSE
    if weekday >= 5:
        return False, "NSE and BSE are closed at the weekend."
    if now < time(9, 0):
        return False, "NSE opens at 09:15 IST (pre-open from 09:00)."
    if now >= time(15, 30):
        return False, "NSE closed at 15:30 IST."
    return True, "NSE is open."


def current(asset_class: str, moment: datetime | None = None) -> dict[str, Any]:
    """
    The active session and what it implies for a trade taken right now.

    `quality` is a confidence multiplier, not a probability. 1.0 is the neutral
    baseline; below it the clock is working against the setup.
    """
    moment = (moment or datetime.now(timezone.utc)).astimezone(IST)
    is_open, open_note = market_open(asset_class, moment)
    now = moment.time()

    if not is_open:
        return {
            "assetClass": asset_class,
            "isOpen": False,
            "session": None,
            "label": "Closed",
            "quality": 0.0,
            "tradeable": False,
            "note": open_note,
            "istTime": moment.strftime("%H:%M"),
        }

    windows = _sessions_for(asset_class)
    active = next((w for w in windows if _in_window(now, w)), None)

    if active is None:
        # Between defined windows — open, but in no characterised session.
        return {
            "assetClass": asset_class,
            "isOpen": True,
            "session": "UNCHARACTERISED",
            "label": "Open",
            "quality": 0.9,
            "tradeable": True,
            "note": "Open, but outside the sessions this engine characterises.",
            "istTime": moment.strftime("%H:%M"),
        }

    return {
        "assetClass": asset_class,
        "isOpen": True,
        "session": active.key,
        "label": active.label,
        "quality": active.quality,
        # Quality of exactly zero means the window is structurally untradeable —
        # the pre-open auction, where the price shown is indicative.
        "tradeable": active.quality > 0.0,
        "note": active.note,
        "istTime": moment.strftime("%H:%M"),
    }


def filter_result(
    asset_class: str,
    *,
    moment: datetime | None = None,
    min_quality: float = 0.75,
) -> dict[str, Any]:
    """
    The gate itself.

    `allowed` is False when the venue is shut or the window is one where this
    engine has no business issuing a signal. Everything between `min_quality`
    and 1.0 passes but carries a stated penalty.
    """
    session = current(asset_class, moment)
    quality = float(session["quality"])

    if not session["isOpen"]:
        return {
            **session,
            "allowed": False,
            "reason": session["note"],
            "confidenceMultiplier": 0.0,
        }

    if not session["tradeable"]:
        return {
            **session,
            "allowed": False,
            "reason": session["note"],
            "confidenceMultiplier": 0.0,
        }

    if quality < min_quality:
        return {
            **session,
            "allowed": False,
            "reason": (
                f"{session['label']} ({session['istTime']} IST) is a low-quality window. "
                f"{session['note']}"
            ),
            "confidenceMultiplier": quality,
        }

    return {
        **session,
        "allowed": True,
        "reason": (
            f"{session['label']} — {session['note']}"
            if quality >= 1.0
            else f"{session['label']}, a weaker window. {session['note']}"
        ),
        "confidenceMultiplier": quality,
    }


def next_good_window(asset_class: str, moment: datetime | None = None) -> str | None:
    """
    When the next favourable window opens, phrased for a human.

    Shown alongside a session rejection so the answer is "not yet, and here is
    when" rather than a flat no.
    """
    moment = (moment or datetime.now(timezone.utc)).astimezone(IST)
    windows = [w for w in _sessions_for(asset_class) if w.quality >= 1.0]
    if not windows:
        return None

    now = moment.time()
    upcoming = sorted(windows, key=lambda w: w.start)

    for window in upcoming:
        if window.start > now:
            return f"{window.label} opens at {window.start.strftime('%H:%M')} IST"

    first = upcoming[0]
    return f"{first.label} opens at {first.start.strftime('%H:%M')} IST tomorrow"
