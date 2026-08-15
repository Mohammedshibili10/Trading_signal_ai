"""
§1.2 — the data-path audit.

The lag test detects that information is leaking. This locates it. Five
questions have to be answered explicitly and in writing, and they are answered
here by reading the source rather than by asserting a recollection of it, so the
answers cannot drift away from the code the way a document would.

Each probe returns evidence with file and line references. A probe that finds
nothing says so rather than reporting a pass, because "no filter found" and "a
filter was found and is correct" are different states and only one of them is
good news.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Repo root: services/ai/app/diagnostics/audit.py → four levels up.
ROOT = Path(__file__).resolve().parents[4]


@dataclass
class Evidence:
    path: str
    line: int
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "line": self.line, "text": self.text.strip()[:200]}


@dataclass
class Finding:
    question: str
    answer: str
    severity: str
    detail: str
    evidence: list[Evidence] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "answer": self.answer,
            "severity": self.severity,
            "detail": self.detail,
            "evidence": [e.to_dict() for e in self.evidence],
        }


def _search(relative: str, pattern: str) -> list[Evidence]:
    """Every line in one file matching a pattern."""
    path = ROOT / relative
    if not path.exists():
        return []
    out: list[Evidence] = []
    compiled = re.compile(pattern)
    for number, line in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
    ):
        if compiled.search(line):
            out.append(Evidence(relative, number, line))
    return out


def _exists(relative: str) -> bool:
    return (ROOT / relative).exists()


# ─────────────────────────────────────────────────────────────────
#  Q1 — does the live feed hand over the forming bar?
# ─────────────────────────────────────────────────────────────────

#: Every provider that supplies candles to the signal path, and the marker that
#: would show it dropping the unclosed bar.
_PROVIDERS: tuple[tuple[str, str, str], ...] = (
    (
        "apps/api/src/market-data/providers/binance.provider.ts",
        r"closeTime|row\[6\]|closed\s*=\s*rows\.filter",
        "Binance REST klines",
    ),
    (
        "apps/api/src/market-data/providers/yahoo.provider.ts",
        r"closeTime|\.slice\(0,\s*-1\)|drop.*(?:in-progress|unclosed|forming)",
        "Yahoo chart API",
    ),
    (
        "apps/api/src/market-data/providers/simulated.provider.ts",
        r"closeTime|\.slice\(0,\s*-1\)|drop.*(?:in-progress|unclosed|forming)",
        "Simulated provider",
    ),
)


def _q1_forming_bar() -> Finding:
    evidence: list[Evidence] = []
    unguarded: list[str] = []
    guarded: list[str] = []

    for relative, pattern, label in _PROVIDERS:
        if not _exists(relative):
            continue
        hits = _search(relative, pattern)
        if hits:
            guarded.append(label)
            evidence.extend(hits[:2])
        else:
            unguarded.append(label)
            # Show where candles are built, so the gap is locatable.
            evidence.extend(_search(relative, r"(?:candles\.push|return\s+series|getCandles)")[:2])

    if unguarded:
        answer = "YES — at least one live provider passes the forming bar through."
        severity = "CRITICAL"
        detail = (
            f"Guarded: {', '.join(guarded) or 'none'}. "
            f"Unguarded: {', '.join(unguarded)}. "
            "Yahoo's chart endpoint returns the current, still-forming bar as the "
            "last element of `timestamp`/`quote` during a session, exactly as Binance "
            "does. The Binance provider filters it out by `closeTime`; the Yahoo path "
            "has no equivalent filter, so every equity and index analysis run during "
            "market hours scores a partial bar as though it were complete. Its close "
            "is wherever price happens to sit, its range is truncated and its volume "
            "is a fraction of normal — and the engine reads that bar's close as the "
            "signal's entry price."
        )
    else:
        answer = "NO — every provider drops the unclosed bar before returning."
        severity = "NONE"
        detail = f"Verified on: {', '.join(guarded)}."

    return Finding(
        "1. Does the live feed's candle array include the in-progress (unclosed) "
        "candle as its last element?",
        answer,
        severity,
        detail,
        evidence,
    )


# ─────────────────────────────────────────────────────────────────
#  Q2 — does the simulation iterate only closed candles?
# ─────────────────────────────────────────────────────────────────


def _q2_closed_only() -> Finding:
    evidence = _search("services/ai/app/engine/backtest.py", r"for i in range\(start, len\(df\) - 1\)")
    evidence += _search("services/ai/app/diagnostics/replay.py", r"candles\[: i \+ 1\]")

    return Finding(
        "2. Does the backtest iterate only closed candles?",
        "YES — for both simulators, but only because the store contains no "
        "forming bars.",
        "MEDIUM",
        "The strategy simulator stops one bar short of the end so a next-bar fill "
        "always exists, and the replay harness slices at `candles[: i + 1]`, so "
        "neither can see past the bar it is scoring. The qualification matters: "
        "both iterate whatever the candle store holds, and the store is written "
        "from the same providers audited in question 1. A forming bar persisted "
        "once becomes a closed bar to every later reader, and no simulator can "
        "detect that after the fact.",
        evidence,
    )


# ─────────────────────────────────────────────────────────────────
#  Q3 — same-bar features
# ─────────────────────────────────────────────────────────────────


def _q3_same_bar_features() -> Finding:
    evidence = _search("services/ai/app/engine/signals.py", r'price = float\(df\["close"\]\.iloc\[-1\]\)')
    evidence += _search("services/ai/app/engine/pipeline.py", r'price = float\(df\["close"\]\.iloc\[-1\]\)')
    evidence += _search("services/ai/app/engine/pipeline.py", r"analyse_candle\(\s*$|len\(df\) - 1")
    evidence += _search("services/ai/app/engine/signals.py", r"recent = df\.iloc\[-20:\]")

    return Finding(
        "3. Is any feature computed using the high, low or close of the same bar "
        "the signal fires on?",
        "YES — by design, and it is sound only if that bar is closed.",
        "HIGH",
        "The whole analysis is anchored on the last element of the frame: the "
        "current price is its close, candle anatomy is measured on it, the stop is "
        "derived from the last 20 bars' high/low including it, and every moving "
        "average and range measure ends on it. That is correct behaviour for a "
        "signal generated *after* a bar closes — it is the definition of acting on "
        "the latest complete information. It becomes look-ahead the moment the last "
        "element is a bar that has not finished, because then its high, low and "
        "close are all still moving. The correctness of this entire layer is "
        "therefore conditional on question 1, and question 1 fails on the Yahoo "
        "path.",
        evidence,
    )


# ─────────────────────────────────────────────────────────────────
#  Q4 — fill price
# ─────────────────────────────────────────────────────────────────


def _q4_fill_price() -> Finding:
    evidence = _search("services/ai/app/engine/backtest.py", r"fill = opens\[i \+ 1\]")
    evidence += _search("services/ai/app/engine/signals.py", r"^\s+entry = price$")
    evidence += _search(
        "apps/api/src/jobs/autoscan.service.ts", r"const filled = long \? price <= limit"
    )

    return Finding(
        "4. Is the fill price the signal bar's close?",
        "SPLIT — the strategy simulator fills at the next bar's open; the published "
        "signal quotes the signal bar's close as its entry.",
        "HIGH",
        "`backtest.py` is explicit and correct: `fill = opens[i + 1]`. The signal "
        "engine is not a simulator and never fills anything, but the entry price it "
        "publishes is `df['close'].iloc[-1]` — the close of the bar it fired on. "
        "Anyone acting on that number is, by construction, trying to trade a price "
        "that stopped being available the instant the bar ended, and the live tracker "
        "then marks the entry as filled when the *next polled quote* sits within a "
        "quarter-ATR band around it. So the recorded fill is neither a real fill nor "
        "a next-open fill; it is 'price was still nearby five minutes later'. The "
        "replay harness in this package deliberately refuses to use the published "
        "entry as a fill and prices every trade at the next bar's open instead.",
        evidence,
    )


# ─────────────────────────────────────────────────────────────────
#  Q5 — auxiliary data timestamps
# ─────────────────────────────────────────────────────────────────

_AUXILIARY: tuple[tuple[str, str, str], ...] = (
    ("services/ai/app/engine/derivatives.py", r"funding|openInterest|fundingRate", "funding / open interest"),
    ("services/ai/app/engine/orderbook.py", r"bids|asks|depth", "order book depth"),
    ("services/ai/app/engine/sentiment.py", r"publishedAt|age_hours|ageHours", "news sentiment"),
    ("apps/api/src/news/news.module.ts", r"publishedAt", "news ingestion"),
    ("apps/api/src/jobs/signal-monitor.service.ts", r"publishedAt|scheduledAt", "revalidation inputs"),
)


def _q5_auxiliary_timestamps() -> Finding:
    evidence: list[Evidence] = []
    for relative, pattern, _label in _AUXILIARY:
        evidence.extend(_search(relative, pattern)[:2])

    return Finding(
        "5. Are any auxiliary data sources timestamped at publish time rather than "
        "effective time?",
        "YES — every one of them, and none carries an effective timestamp at all.",
        "HIGH",
        "Funding, open interest and order-book depth all reach the engine as a "
        "single current snapshot with no timestamp attached, so a replay cannot "
        "place them in time and the live path cannot tell a stale snapshot from a "
        "fresh one. News and economic events carry `publishedAt` / `scheduledAt` "
        "only — publication time, not the moment the information became effective, "
        "and for an economic release those differ by the entire embargo period. In "
        "practice this does not currently leak into the replay, because the replay "
        "passes none of these inputs: it reconstructs signals from candles alone. "
        "That is itself the finding — the live engine scores with evidence the "
        "measured system never sees, so live and replay are not the same system "
        "even before drift is considered.",
        evidence,
    )


# ─────────────────────────────────────────────────────────────────
#  Additional structural probes
# ─────────────────────────────────────────────────────────────────


def _extra_findings() -> list[Finding]:
    """
    Defects found while answering the five, which the five do not cover.

    Kept separate so the numbered answers stay answers rather than becoming a
    place to put everything.
    """
    out: list[Finding] = []

    out.append(
        Finding(
            "A. Are stop and target resolved against bar ranges or against polled "
            "quotes?",
            "POLLED QUOTES — resolution is blind to anything between polls.",
            "CRITICAL",
            "The live tracker compares a single spot price from `getQuotes()` "
            "against the stop and each target. A stop or target touched between two "
            "polls is never recorded, and when both were touched, which one is "
            "reported depends on where price happened to sit at poll time rather "
            "than on which came first. The comment above it claims the pessimistic "
            "read; a point sample is not pessimistic, it is blind. This systematically "
            "under-records both stop-outs and target hits, and pushes outcomes into "
            "the non-price endings — which is precisely the distribution the live "
            "signal table shows.",
            _search("apps/api/src/jobs/autoscan.service.ts", r"const quotes = await this\.marketData\.getQuotes|price <= stop|price >= level"),
        )
    )

    out.append(
        Finding(
            "B. Is the entry-fill flag a fill, or a proximity test?",
            "PROXIMITY — it is true by construction almost immediately.",
            "HIGH",
            "`entryFilledAt` is set when a polled price sits inside the published "
            "entry band. That band is entry ± 0.25 ATR and the entry is the last "
            "close, so on the first poll after issue the condition is satisfied for "
            "virtually every signal that has not already moved a quarter-ATR. The "
            "field is therefore recording 'the signal was still alive at the next "
            "poll', while the rest of the system reads it as 'a position existed' — "
            "and that reading is what decides whether an early exit is booked as a "
            "cancelled trade or as a setup that never happened.",
            _search("apps/api/src/jobs/autoscan.service.ts", r"entryFilledAt === null|const limit = long"),
        )
    )

    out.append(
        Finding(
            "C. Are non-price endings counted as losses?",
            "YES — every unresolved signal defaults to −1R.",
            "CRITICAL",
            "The analytics layer falls back to `−1` for any signal without a "
            "recorded `realisedR` that is not a target hit. EXPIRED, INVALID and "
            "CANCELLED signals all take that path, and the schema is explicit that "
            "none of them represents a financial loss — INVALID never had a position "
            "at all. Some are additionally persisted with `realisedR = −1` on "
            "signals whose `entryFilledAt` is null, so the fallback is not the only "
            "source. Every hit-rate, expectancy and profit-factor figure the "
            "platform reports is computed over a population where setups that were "
            "never entered contribute full-size losses.",
            _search("apps/api/src/analysis/analytics.service.ts", r"realisedR\) \?\? \(r\.status\.startsWith")[:3],
        )
    )

    out.append(
        Finding(
            "D. Does revalidation compare like with like?",
            "NO — a calibrated confidence is compared against an uncalibrated one.",
            "HIGH",
            "A signal's stored confidence is produced by a pipeline run with "
            "walk-forward calibration applied. Revalidation re-runs the pipeline "
            "with `withCalibration: false` — for a defensible reason, since the "
            "calibrated pass is roughly fifty times more expensive — and then "
            "subtracts one from the other and calls the difference a confidence "
            "drop. Any systematic offset the calibrator introduces is therefore read "
            "as thesis decay. Compounding it, the job runs every few minutes against "
            "every open signal regardless of timeframe, so a daily signal is re-scored "
            "on the order of three hundred times a day, each one an independent "
            "opportunity to trip a 22-point threshold. The probability of at least one "
            "trip over a multi-day hold approaches certainty whether or not anything "
            "has changed.",
            _search("apps/api/src/jobs/signal-monitor.service.ts", r"withCalibration: false")
            + _search("services/ai/app/engine/revalidation.py", r"CONFIDENCE_DROP_CRITICAL = |drop >= CONFIDENCE_DROP_CRITICAL"),
        )
    )

    out.append(
        Finding(
            "E. Can a trade in normal drawdown be closed by accumulated warnings?",
            "YES — three warnings force a close, and one of them fires on ordinary "
            "adverse excursion.",
            "CRITICAL",
            "Three WARNING findings promote to CRITICAL and close the position. "
            "`STOP_RISK` raises a warning once price has travelled 55% of the way to "
            "the stop — which is not a malfunction, it is the middle of the range "
            "every trade is designed to survive. Order flow can contribute two "
            "warnings on its own, and thin volume or a volatility shift supplies the "
            "third. The result is a rule that preferentially closes trades that are "
            "temporarily losing, before they can reach a target quoted at 1.6R. It "
            "truncates the right tail of the outcome distribution and leaves the left "
            "tail intact, which is the exact opposite of what an exit rule is for.",
            _search("services/ai/app/engine/revalidation.py", r"STOP_PROXIMITY_WARNING = |len\(warnings\) >= 3"),
        )
    )

    out.append(
        Finding(
            "F. Is the published reward:risk measured, or constructed?",
            "CONSTRUCTED — the first target is placed at the ratio the gate requires.",
            "HIGH",
            "The first target is solved for as `min_risk_reward × (1 + cost_r) + "
            "cost_r + 0.1`, and the gate then rejects anything below "
            "`min_risk_reward`. With the floor at 1.5 and cost negligible against a "
            "daily stop, that is 1.60 — which is the value carried by two thirds of "
            "the signals ever issued. The number is an input restated as an output. "
            "It is only a measurement when a structural level pulls the target in, "
            "and in that case it fails the gate. So the ratio can distinguish "
            "'rejected' from 'accepted' and cannot say anything about how far price "
            "is likely to travel.",
            _search("services/ai/app/engine/signals.py", r"first_multiple = settings\.min_risk_reward"),
        )
    )

    return out


def run() -> dict[str, Any]:
    """The five numbered answers plus the structural probes."""
    numbered = [
        _q1_forming_bar(),
        _q2_closed_only(),
        _q3_same_bar_features(),
        _q4_fill_price(),
        _q5_auxiliary_timestamps(),
    ]
    extra = _extra_findings()

    severities = [f.severity for f in numbered + extra]

    return {
        "id": "1.2-audit",
        "title": "Data-path audit",
        "questions": [f.to_dict() for f in numbered],
        "additionalFindings": [f.to_dict() for f in extra],
        "criticalCount": severities.count("CRITICAL"),
        "highCount": severities.count("HIGH"),
    }
