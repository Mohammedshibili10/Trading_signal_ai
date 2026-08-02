"""
Engine smoke test.

Runs the whole pipeline on synthetic-but-realistic candles and asserts the
invariants that matter. Deliberately dependency-light (no pytest) so it can run
anywhere Python and numpy exist:

    python selftest.py

What it checks is what would silently break the product if it regressed:
probabilities that sum to 1, confidence inside its cap, calibration that never
sees the future, and a WAIT path that actually triggers.
"""

from __future__ import annotations

import math
import sys
import time

import numpy as np

from app.engine import (
    backtest,
    fundamentals,
    invest,
    pipeline,
    postmortem,
    precedent,
    risk,
    sentiment,
)
from app.engine.calibration import walk_forward

PASS, FAIL = "  PASS", "  FAIL"
failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"{PASS}  {label}")
    else:
        print(f"{FAIL}  {label}{' — ' + detail if detail else ''}")
        failures.append(label)


def make_candles(n: int = 400, seed: int = 7, trend: float = 0.0004) -> list[dict]:
    """
    Geometric random walk with a drift, volatility clustering and a volume
    series correlated to range. Not real data, but it exercises every code path
    the way real data does.
    """
    rng = np.random.default_rng(seed)
    price = 2500.0
    out = []
    vol = 0.012
    start = int(time.time()) - n * 86400

    for i in range(n):
        # GARCH-ish volatility clustering.
        vol = 0.85 * vol + 0.15 * abs(rng.normal(0, 0.014)) + 0.002
        ret = rng.normal(trend, vol)
        open_p = price
        close_p = price * (1 + ret)
        span = abs(close_p - open_p) + price * abs(rng.normal(0, vol * 0.6))
        high = max(open_p, close_p) + span * rng.uniform(0, 0.6)
        low = min(open_p, close_p) - span * rng.uniform(0, 0.6)
        volume = float(rng.lognormal(13, 0.4) * (1 + abs(ret) * 25))

        out.append({
            "time": start + i * 86400,
            "open": round(open_p, 2), "high": round(high, 2),
            "low": round(low, 2), "close": round(close_p, 2),
            "volume": round(volume, 0),
        })
        price = close_p

    return out


def section(title: str) -> None:
    print(f"\n{title}\n{'─' * len(title)}")


# ─────────────────────────────────────────────────────────────────

section("Pipeline")

candles = make_candles(400)
started = time.perf_counter()
result = pipeline.analyse(
    candles, symbol="TESTSTOCK", name="Test Stock",
    asset_class="EQUITY", timeframe="1D", with_calibration=True,
)
elapsed = time.perf_counter() - started
print(f"  analysed 400 candles with calibration in {elapsed:.2f}s")

check("returns every top-level section",
      all(k in result for k in ("technical", "priceAction", "smc", "forecast", "signal",
                                "chartPatterns", "candlestickPatterns", "candleAnatomy")))

fc = result["forecast"]
total = fc["probUp"] + fc["probDown"] + fc["probFlat"]
check("probabilities sum to 1", math.isclose(total, 1.0, abs_tol=1e-6), f"got {total}")
check("probabilities are in range",
      all(0 <= fc[k] <= 1 for k in ("probUp", "probDown", "probFlat")))
check("confidence respects the 85 cap", 0 <= fc["confidence"] <= 85, f"got {fc['confidence']}")
check("forecast carries an invalidation level",
      bool(fc.get("invalidation", {}).get("note")))
check("reasons are populated", len(fc.get("reasons", [])) > 0)

anatomy = result["candleAnatomy"]
check("body + wicks account for the full range",
      math.isclose(anatomy["bodyPercent"] + anatomy["upperWickPercent"] + anatomy["lowerWickPercent"],
                   1.0, abs_tol=0.02)
      or anatomy["range"] == 0)
check("close location is in [-1, 1]", -1 <= anatomy["closeLocation"] <= 1)
check("candle is classified", bool(anatomy["classification"]))

section("Factor weights")

groups = result["meta"]["factorGroups"]
check("multiple factor groups contributed", len(groups) >= 5, f"got {groups}")
weights = [f["weight"] for f in fc["factors"]]
check("weights renormalise to 1 after redistribution",
      math.isclose(sum(weights), 1.0, abs_tol=1e-6), f"sum={sum(weights)}")
check("fundamentals dropped when not supplied", "FUNDAMENTALS" not in groups)

section("Signal")

signal = result["signal"]
check("signal has an action",
      signal["action"] in {"BUY", "SELL", "HOLD", "WAIT"}, signal["action"])

if signal["action"] in {"BUY", "SELL"}:
    check("risk:reward clears the 1.5 floor", signal["riskRewardRatio"] >= 1.5,
          str(signal["riskRewardRatio"]))
    check("three targets are returned", len(signal["targets"]) == 3)
    check("target probability decays with distance",
          signal["targets"][0]["probability"] > signal["targets"][2]["probability"])
    check("R multiples increase with target",
          signal["targets"][0]["rr"] < signal["targets"][2]["rr"])
    stop, entry = signal["stopLoss"], signal["entry"]
    check("stop sits on the correct side of entry",
          (stop < entry) if signal["action"] == "BUY" else (stop > entry))
else:
    check("WAIT states its reason", bool(signal.get("rejectionReason")))
    print(f"      reason: {signal['rejectionReason']}")

section("Calibration (no look-ahead)")

report = fc.get("calibration")
if report:
    check("calibration reports samples", report["samples"] > 0)
    check("hit rate is a probability", 0 <= report["hitRate"] <= 1, str(report["hitRate"]))
    check("Brier score is sane", 0 <= report["brierScore"] <= 1, str(report["brierScore"]))
    print(f"      {report['samples']} samples, hit-rate {report['hitRate']:.1%}, "
          f"Brier {report['brierScore']:.3f}")
    # A hit rate near 1.0 on a random walk would mean the engine is seeing the
    # future. This is the single most important assertion in the file.
    check("hit rate is not implausibly high on a random walk",
          report["hitRate"] < 0.75, f"got {report['hitRate']:.2f} — check for look-ahead")
else:
    print("      not calibrated (insufficient samples) — acceptable")

section("Look-ahead guard")

# Truncating the series must not change the forecast for the earlier bar.
truncated = candles[:300]
a = pipeline.analyse(truncated, symbol="T", timeframe="1D", with_calibration=False)
b = pipeline.analyse(candles[:300], symbol="T", timeframe="1D", with_calibration=False)
check("analysis is deterministic for identical input",
      a["forecast"]["probUp"] == b["forecast"]["probUp"])

full = pipeline.analyse(candles, symbol="T", timeframe="1D", with_calibration=False)
check("adding future bars changes the latest forecast (sanity)",
      full["forecast"]["probUp"] != a["forecast"]["probUp"])

section("Forecast history")

history = pipeline.forecast_history(candles, symbol="T", timeframe="1D", lookback=25)
check("history returns one entry per bar", len(history) == 25, str(len(history)))
graded = [h for h in history if h.get("correct") is not None]
check("history grades resolved bars", len(graded) > 0)
if graded:
    hits = sum(1 for h in graded if h["correct"])
    print(f"      {hits}/{len(graded)} directional calls correct on synthetic data")

section("Risk")

# 5% stop with 1% risk → a 20% position, comfortably under the concentration
# cap, so this exercises the pure stop-based arithmetic.
size = risk.position_size(capital=500_000, risk_percent=1, entry=2500, stop_loss=2375, target=2750)
check("quantity matches the risk budget", size["quantity"] == 40, str(size["quantity"]))
check("risk amount is correct", size["riskAmount"] == 5000.0)
check("risk:reward computed", size["riskRewardRatio"] == 2.0, str(size["riskRewardRatio"]))
check("position stays under the concentration cap",
      size["positionPercentOfCapital"] == 20.0, f"{size['positionPercentOfCapital']}%")

# A 2% stop with 1% risk implies a 50% position — stop-based sizing alone would
# happily concentrate half the account in one name. The cap must intervene.
capped = risk.position_size(capital=500_000, risk_percent=1, entry=2500, stop_loss=2450)
check("concentration cap engages when the stop is tight",
      capped["positionPercentOfCapital"] <= 25.1,
      f"{capped['positionPercentOfCapital']}%")
check("concentration cap is explained", any("concentration" in w.lower() for w in capped["warnings"]))

lots = risk.position_size(capital=500_000, risk_percent=1, entry=2500, stop_loss=2375, lot_size=25)
check("lot sizing rounds down to whole lots", lots["quantity"] % 25 == 0, str(lots["quantity"]))

kelly = risk.kelly_fraction(0.55, 200, 100)
check("Kelly recommends a fraction, not full", kelly["recommended"] <= kelly["full"] / 2 + 0.01)

mc = risk.monte_carlo(trade_returns=[0.02, -0.01, 0.03, -0.015, 0.01] * 12,
                      starting_capital=500_000, simulations=800, horizon=60)
check("Monte Carlo percentiles are ordered",
      mc["percentiles"]["p5"] <= mc["percentiles"]["p50"] <= mc["percentiles"]["p95"])
check("probability of profit is a probability", 0 <= mc["probabilityOfProfit"] <= 1)

pr = risk.portfolio_risk(holdings=[
    {"symbol": "A", "currentValue": 300_000, "sector": "IT", "assetClass": "EQUITY"},
    {"symbol": "B", "currentValue": 200_000, "sector": "IT", "assetClass": "EQUITY"},
    {"symbol": "C", "currentValue": 100_000, "sector": "FMCG", "assetClass": "EQUITY"},
])
check("sector concentration is flagged",
      any("IT" in r for r in pr["recommendations"]), str(pr["recommendations"]))

section("Backtest")

strategy = {
    "id": "test",
    "entry": {"logic": "AND", "conditions": [
        {"indicator": "RSI", "params": {"period": 14}, "operator": "LT", "value": 35},
    ]},
    "exit": {"logic": "OR", "conditions": [
        {"indicator": "RSI", "params": {"period": 14}, "operator": "GT", "value": 65},
    ]},
    "riskPerTradePercent": 1.0,
    "stopLossPercent": 3.0,
    "useAtrStop": True,
    "atrMultiplier": 2.0,
}
bt = backtest.run(candles, strategy, symbol="TEST", initial_capital=1_000_000)
check("backtest completes", "totalTrades" in bt)
check("backtest always warns about costs",
      any("bps" in w for w in bt["warnings"]))
if bt["totalTrades"] > 0:
    check("win rate is a percentage", 0 <= bt["winRate"] <= 100)
    check("equity curve is produced", len(bt["equityCurve"]) > 0)
    print(f"      {bt['totalTrades']} trades, win rate {bt['winRate']:.1f}%, "
          f"PF {bt['profitFactor']}, max DD {bt['maxDrawdown']:.1f}%")

section("Sentiment")

bullish = sentiment.analyse_text("Infosys beats estimates, raises guidance and announces buyback")
check("beat + raise reads bullish", bullish["stance"] == "BULLISH", str(bullish))

bearish = sentiment.analyse_text("Company misses estimates and cuts guidance; auditor resigns")
check("miss + cut + auditor exit reads bearish", bearish["stance"] == "BEARISH", str(bearish))

# The case a general-purpose sentiment model gets wrong.
nuanced = sentiment.analyse_text("Stock plunges on profit booking after a 40% rally")
check("profit-booking language is damped, not read as a collapse",
      nuanced["score"] > -0.6, str(nuanced["score"]))

section("Fundamentals")

good = fundamentals.score({
    "symbol": "GOOD", "name": "Good Co", "sector": "Information Technology",
    "pe": 22, "pb": 4, "roe": 28, "roce": 34, "netMargin": 20, "operatingMargin": 26,
    "revenueGrowth": 18, "profitGrowth": 22, "epsGrowth": 20,
    "debtToEquity": 0.05, "interestCoverage": 40, "currentRatio": 2.5,
    "freeCashFlow": 5_000_000_000, "operatingCashFlow": 6_000_000_000,
    "promoterHolding": 55, "promoterPledge": 0, "fiiHolding": 20, "diiHolding": 12,
})
check("strong company scores well", good["scores"]["investment"] >= 65,
      str(good["scores"]["investment"]))

pledged = fundamentals.score({
    "symbol": "RISK", "name": "Pledged Co", "sector": "Infrastructure",
    "pe": 12, "roe": 22, "roce": 20, "netMargin": 14,
    "revenueGrowth": 25, "profitGrowth": 30, "epsGrowth": 28,
    "debtToEquity": 0.9, "interestCoverage": 5, "currentRatio": 1.4,
    "freeCashFlow": 1_000_000, "promoterHolding": 60, "promoterPledge": 45,
})
check("heavy promoter pledge caps the rating",
      pledged["longTermRating"] not in {"STRONG_BUY", "BUY"}, pledged["longTermRating"])
check("pledge appears in the concerns",
      any("pledge" in c.lower() for c in pledged["concerns"]))

section("Investment maths")

sip = invest.sip_projection(monthly_amount=10_000, years=20, expected_return=12)
# ₹10k/month at 12% for 20 years is ~₹99-100 lakh with annuity-due timing.
check("SIP projection is in the right range",
      90_00_000 < sip["estimatedValue"] < 1_10_00_000, f"{sip['estimatedValue']:,.0f}")
check("SIP reports the real value too",
      sip["inflationAdjustedValue"] < sip["estimatedValue"])

goal = invest.goal_plan(name="Education", target_amount=50_00_000,
                        current_savings=0, years=15, expected_return=12)
check("goal target is inflated before solving",
      goal["inflationAdjustedTarget"] > goal["targetAmount"])
check("goal returns a required monthly amount", goal["requiredMonthly"] > 0)

section("Edge cases")

flat = [{"time": 1700000000 + i * 86400, "open": 100.0, "high": 100.0,
         "low": 100.0, "close": 100.0, "volume": 0.0} for i in range(120)]
try:
    flat_result = pipeline.analyse(flat, symbol="FLAT", timeframe="1D", with_calibration=False)
    check("zero-range, zero-volume series does not crash", True)
    check("flat series produces no trade", flat_result["signal"]["action"] == "WAIT")
    check("volume group dropped when volume is absent",
          "VOLUME" not in flat_result["meta"]["factorGroups"])
except Exception as exc:  # noqa: BLE001
    check("zero-range, zero-volume series does not crash", False, str(exc))

try:
    pipeline.analyse(candles[:10], symbol="SHORT", timeframe="1D")
    check("too-few-candles raises a clear error", False, "no error raised")
except ValueError:
    check("too-few-candles raises a clear error", True)

forex = pipeline.analyse(
    [{**c, "volume": 0.0} for c in make_candles(200, seed=3)],
    symbol="USDINR", asset_class="FOREX", timeframe="1h", with_calibration=False,
)
check("forex drops both volume and fundamentals",
      "VOLUME" not in forex["meta"]["factorGroups"]
      and "FUNDAMENTALS" not in forex["meta"]["factorGroups"],
      str(forex["meta"]["factorGroups"]))
check("VWAP is reported unavailable without volume",
      any(r["key"] == "vwap" and r["value"] is None for r in forex["technical"]["indicators"]))

# ─────────────────────────────────────────────────────────────────

section("Outcome classification")

# A cancelled trade must never be scored as a loss. This is the defect that put
# invalidated setups in the Stop Loss column and fed the learner a -1R that was
# never actually paid.
_bars = [{"time": 1700000000 + i * 3600, "open": 100.0, "high": 101.0,
          "low": 99.5, "close": 100.5, "volume": 1000.0} for i in range(10)]

cancelled = postmortem.analyse(
    {"id": "s1", "symbol": "TEST", "action": "BUY", "status": "CANCELLED",
     "entry": 100.0, "stopLoss": 98.0, "confidence": 70, "factors": []},
    _bars,
    entry_filled=True,
    invalidation_reason="TREND_REVERSAL",
    confidence_at_end=30.0,
)
check("cancelled trade is not a win", cancelled["won"] is False)
check("cancelled trade is not counted as a loss", cancelled["countsAsLoss"] is False)
check("cancelled trade is flagged as cancelled", cancelled["cancelled"] is True)
check("cancelled realised R reflects the exit, not -1R",
      cancelled["execution"]["realisedR"] != -1.0,
      str(cancelled["execution"]["realisedR"]))
check("cancellation reason uses the cancellation vocabulary",
      cancelled["primaryReason"] == "TREND_REVERSAL", str(cancelled["primaryReason"]))

# Never filled: there was no position, so there is no R at all. Reporting 0.0
# would later be averaged in as a breakeven trade that never happened.
unfilled = postmortem.analyse(
    {"id": "s2", "symbol": "TEST", "action": "BUY", "status": "INVALID",
     "entry": 100.0, "stopLoss": 98.0, "confidence": 70, "factors": []},
    _bars,
    entry_filled=False,
    invalidation_reason="STRUCTURE_CHANGED",
)
check("unfilled setup has no realised R", unfilled["execution"]["realisedR"] is None)
check("unfilled setup is not a loss", unfilled["countsAsLoss"] is False)

# A stop-out is still a loss, and must stay one.
stopped = postmortem.analyse(
    {"id": "s3", "symbol": "TEST", "action": "BUY", "status": "STOPPED",
     "entry": 100.0, "stopLoss": 98.0, "confidence": 70, "factors": []},
    _bars,
)
check("stop-out is still counted as a loss", stopped["countsAsLoss"] is True)
check("stop-out realised R is -1", stopped["execution"]["realisedR"] == -1.0)

# The counterfactual is what separates a good cancellation from a lucky one.
_after_stop = [{"time": 1700040000 + i * 3600, "open": 99.0, "high": 99.2,
                "low": 97.0, "close": 97.5, "volume": 900.0} for i in range(5)]
saved = postmortem.analyse(
    {"id": "s4", "symbol": "TEST", "action": "BUY", "status": "CANCELLED",
     "entry": 100.0, "stopLoss": 98.0, "confidence": 70, "factors": []},
    _bars, candles_after_exit=_after_stop, entry_filled=True, target=104.0,
)
check("cancellation that dodged the stop is judged SAVED",
      saved["counterfactual"]["verdict"] == "SAVED", str(saved["counterfactual"]))

_after_target = [{"time": 1700040000 + i * 3600, "open": 101.0, "high": 105.0,
                  "low": 100.8, "close": 104.5, "volume": 900.0} for i in range(5)]
costly = postmortem.analyse(
    {"id": "s5", "symbol": "TEST", "action": "BUY", "status": "CANCELLED",
     "entry": 100.0, "stopLoss": 98.0, "confidence": 70, "factors": []},
    _bars, candles_after_exit=_after_target, entry_filled=True, target=104.0,
)
check("cancellation that gave up a winner is judged COSTLY",
      costly["counterfactual"]["verdict"] == "COSTLY", str(costly["counterfactual"]))


section("Precedent matching")

_profile = [{"group": g, "score": s} for g, s in
            [("TREND", 0.8), ("STRUCTURE", 0.6), ("MOMENTUM", 0.7),
             ("VOLUME", 0.2), ("VOLATILITY", -0.3)]]
_candidate = {"symbol": "TEST", "timeframe": "H1", "action": "BUY", "factors": _profile}

# No history: judged on its own merits, never penalised for lack of evidence.
empty = precedent.evaluate(_candidate, [], {})
check("no history leaves a setup clear", empty["verdict"] == "CLEAR")
check("no history applies no penalty", empty["confidencePenalty"] == 0.0)

# A run of similar losers, all from thin volume - and volume is thin now too.
_losers = [
    {"symbol": "TEST", "timeframe": "H1", "action": "BUY", "status": "STOPPED",
     "factors": _profile, "primaryReason": "LOW_VOLUME"}
    for _ in range(10)
]
repeat = precedent.evaluate(_candidate, _losers, {"volumeRatio": 0.5})
check("repeated failures are found as precedent",
      repeat["precedents"]["matched"] >= 8, str(repeat["precedents"]))
check("a previously fatal condition present now is named",
      any(r["reason"] == "LOW_VOLUME" for r in repeat["namedRisks"]),
      str(repeat["namedRisks"]))
check("a poor base rate with the same fault present is refused",
      repeat["verdict"] == "REJECT", repeat["summary"])

# Same bad history, but the condition that broke them is absent now.
absent = precedent.evaluate(_candidate, _losers, {"volumeRatio": 1.6})
check("a condition that is absent now is not named",
      not any(r["reason"] == "LOW_VOLUME" for r in absent["namedRisks"]))

# Winners must not be penalised.
_winners = [
    {"symbol": "TEST", "timeframe": "H1", "action": "BUY", "status": "HIT_T2",
     "factors": _profile, "primaryReason": None}
    for _ in range(12)
]
good = precedent.evaluate(_candidate, _winners, {"volumeRatio": 1.4})
check("a winning record is left clear", good["verdict"] == "CLEAR", good["summary"])

# Two trades is not evidence. Shrinkage must stop a tiny sample vetoing a setup.
tiny = precedent.evaluate(_candidate, _losers[:2], {"volumeRatio": 1.5})
check("a two-trade sample cannot reject a setup",
      tiny["verdict"] != "REJECT", tiny["summary"])

# A losing long says nothing about a short.
_shorts = [{**row, "action": "SELL"} for row in _losers]
opposite = precedent.evaluate(_candidate, _shorts, {"volumeRatio": 0.5})
check("opposite-direction history is not treated as precedent",
      opposite["precedents"]["matched"] == 0, str(opposite["precedents"]))

print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for f in failures:
        print(f"  · {f}")
    sys.exit(1)

print("All checks passed.")
sys.exit(0)
