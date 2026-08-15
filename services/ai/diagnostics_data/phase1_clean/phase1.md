# Phase 1 — Diagnostic Report

Generated 2026-08-15T13:09:16+00:00 · commit `1a89e03`

Replay covered **104 instrument-timeframe series**,
**8,693 scored bars**, producing **398 signals**
and **398 resolved trades**.

## 0. Sample size and what it permits

> Trade count clears the 200-trade floor.

The replay scored **8,693 bars** across 104 series and emitted **398 tradeable signals** — a firing rate of **4.58%** of scored bars. 398 of those resolved into simulated trades.

The engine declined on the remaining 8,295 bars. Its own stated reasons, most frequent first:

- `Confidence N is below the N floor` — 6,870 (82.8%)
- `Factor groups are balanced with no directional edge` — 1,223 (14.7%)
- `Reward-to-risk of N` — 142 (1.7%)
- `Reward-to-risk is N` — 37 (0.4%)
- `Volatility is at the Nth percentile and confidence is only N` — 21 (0.3%)
- `Trend and market structure point in opposite directions` — 1 (0.0%)

Candle store: 37741 rows read, 104 series built; dropped 0 unparseable, 0 invalid, 0 duplicate; 54 future-dated.

**54 bars carry timestamps in the future** and were excluded from the replay. A bar the store says has not happened yet cannot be a bar the engine was entitled to see. Examples:

- MF_HDFC_MIDCAP 1D stamped 1788287400 (17 days ahead, source=amfi)
- MF_HDFC_MIDCAP 1D stamped 1788373800 (18 days ahead, source=amfi)
- MF_HDFC_MIDCAP 1D stamped 1788460200 (19 days ahead, source=amfi)
- MF_HDFC_MIDCAP 1D stamped 1788633000 (21 days ahead, source=amfi)
- MF_HDFC_MIDCAP 1D stamped 1788719400 (22 days ahead, source=amfi)
## 1.1 Zero-cost ablation

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Zero cost | 398 | -61.98 | -0.1557 | 0.703 | 32.9% | -2.88 |
| Full costs | 398 | -212.39 | -0.5336 | 0.311 | 24.9% | -9.98 |

Average round-trip cost: **0.378R** per trade.
Cost drag as a share of gross result: **242.7%**.
Break-even hit rate at the reward:risk the engine quotes: **38.9%**.

Signals that produced no trade: 0 never filled,
0 had too little forward data,
0 had unusable geometry.

**Verdict — `NO_EDGE_AT_ZERO_COST`**

Expectancy is -0.1557R per trade with every fee, spread and slippage set to zero. There is no edge in the signal layer to protect. No cost model, gate, ranking layer or execution change can rescue this, because all of them operate on a quantity that is already negative. The work belongs in the signal hypothesis, not downstream of it.

## 1.2 One-bar lag test

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Baseline (next-open fill) | 398 | -212.39 | -0.5336 | 0.311 | 24.9% | -9.98 |
| Lagged (+1 bar) | 398 | -212.56 | -0.5341 | 0.305 | 24.1% | -9.99 |

Delta: net -0.17R, expectancy -0.0004R,
hit rate -0.8pp.

**Verdict — BASELINE_ALREADY_NEGATIVE — a lag test on a system with no positive baseline cannot distinguish leakage from noise. Resolve §1.1 first.**

The lag test measures the symptom. The five data-path questions in the audit section locate the cause, and are answered from the source rather than from this run — a system can pass the lag test on stored candles and still leak live, because the stored series contains only closed bars and the live feed does not.

### 1.2 Data-path audit — the five required answers

**1. Does the live feed's candle array include the in-progress (unclosed) candle as its last element?**

> **YES — at least one live provider passes the forming bar through.** · severity `CRITICAL`

Guarded: Binance REST klines. Unguarded: Yahoo chart API, Simulated provider. Yahoo's chart endpoint returns the current, still-forming bar as the last element of `timestamp`/`quote` during a session, exactly as Binance does. The Binance provider filters it out by `closeTime`; the Yahoo path has no equivalent filter, so every equity and index analysis run during market hours scores a partial bar as though it were complete. Its close is wherever price happens to sit, its range is truncated and its volume is a fraction of normal — and the engine reads that bar's close as the signal's entry price.

  - `apps/api/src/market-data/providers/binance.provider.ts:75` — `updatedAt: new Date(data.closeTime).toISOString(),`
  - `apps/api/src/market-data/providers/binance.provider.ts:108` — `// `closeTime` (field 6) is the venue's own answer to "is this done?", so`
  - `apps/api/src/market-data/providers/yahoo.provider.ts:158` — `async getCandles(`

**2. Does the backtest iterate only closed candles?**

> **YES — for both simulators, but only because the store contains no forming bars.** · severity `MEDIUM`

The strategy simulator stops one bar short of the end so a next-bar fill always exists, and the replay harness slices at `candles[: i + 1]`, so neither can see past the bar it is scoring. The qualification matters: both iterate whatever the candle store holds, and the store is written from the same providers audited in question 1. A forming bar persisted once becomes a closed bar to every later reader, and no simulator can detect that after the fact.

  - `services/ai/app/engine/backtest.py:292` — `for i in range(start, len(df) - 1):`
  - `services/ai/app/diagnostics/replay.py:18` — `**The slice ends at a closed bar.** ``candles[: i + 1]`` makes bar *i* the last`
  - `services/ai/app/diagnostics/replay.py:200` — `Every call sees ``candles[: i + 1]`` and nothing else.`

**3. Is any feature computed using the high, low or close of the same bar the signal fires on?**

> **YES — by design, and it is sound only if that bar is closed.** · severity `HIGH`

The whole analysis is anchored on the last element of the frame: the current price is its close, candle anatomy is measured on it, the stop is derived from the last 20 bars' high/low including it, and every moving average and range measure ends on it. That is correct behaviour for a signal generated *after* a bar closes — it is the definition of acting on the latest complete information. It becomes look-ahead the moment the last element is a bar that has not finished, because then its high, low and close are all still moving. The correctness of this entire layer is therefore conditional on question 1, and question 1 fails on the Yahoo path.

  - `services/ai/app/engine/signals.py:71` — `price = float(df["close"].iloc[-1])`
  - `services/ai/app/engine/pipeline.py:88` — `price = float(df["close"].iloc[-1])`
  - `services/ai/app/engine/pipeline.py:240` — `price = float(df["close"].iloc[-1])`

**4. Is the fill price the signal bar's close?**

> **SPLIT — the strategy simulator fills at the next bar's open; the published signal quotes the signal bar's close as its entry.** · severity `HIGH`

`backtest.py` is explicit and correct: `fill = opens[i + 1]`. The signal engine is not a simulator and never fills anything, but the entry price it publishes is `df['close'].iloc[-1]` — the close of the bar it fired on. Anyone acting on that number is, by construction, trying to trade a price that stopped being available the instant the bar ended, and the live tracker then marks the entry as filled when the *next polled quote* sits within a quarter-ATR band around it. So the recorded fill is neither a real fill nor a next-open fill; it is 'price was still nearby five minutes later'. The replay harness in this package deliberately refuses to use the published entry as a fill and prices every trade at the next bar's open instead.

  - `services/ai/app/engine/backtest.py:345` — `fill = opens[i + 1]  # next bar's open — never the signal bar's close`
  - `services/ai/app/engine/signals.py:82` — `entry = price`
  - `apps/api/src/jobs/autoscan.service.ts:677` — `const filled = long ? price <= limit : price >= limit;`

**5. Are any auxiliary data sources timestamped at publish time rather than effective time?**

> **YES — every one of them, and none carries an effective timestamp at all.** · severity `HIGH`

Funding, open interest and order-book depth all reach the engine as a single current snapshot with no timestamp attached, so a replay cannot place them in time and the live path cannot tell a stale snapshot from a fresh one. News and economic events carry `publishedAt` / `scheduledAt` only — publication time, not the moment the information became effective, and for an economic release those differ by the entire embargo period. In practice this does not currently leak into the replay, because the replay passes none of these inputs: it reconstructs signals from candles alone. That is itself the finding — the live engine scores with evidence the measured system never sees, so live and replay are not the same system even before drift is considered.

  - `services/ai/app/engine/derivatives.py:2` — `Perpetual-futures funding, open interest and positioning.`
  - `services/ai/app/engine/derivatives.py:6` — `carry: price tells you where the market is, funding tells you what it costs to`
  - `services/ai/app/engine/orderbook.py:23` — `**Spread and depth** — execution quality. A signal whose target is inside the`

### 1.2 Additional structural findings

Found while answering the five. Kept separate so the numbered answers stay answers.

**A. Are stop and target resolved against bar ranges or against polled quotes?**

> **POLLED QUOTES — resolution is blind to anything between polls.** · severity `CRITICAL`

The live tracker compares a single spot price from `getQuotes()` against the stop and each target. A stop or target touched between two polls is never recorded, and when both were touched, which one is reported depends on where price happened to sit at poll time rather than on which came first. The comment above it claims the pessimistic read; a point sample is not pessimistic, it is blind. This systematically under-records both stop-outs and target hits, and pushes outcomes into the non-price endings — which is precisely the distribution the live signal table shows.

  - `apps/api/src/jobs/autoscan.service.ts:649` — `const quotes = await this.marketData.getQuotes([...new Set(active.map((s) => s.symbol))]);`
  - `apps/api/src/jobs/autoscan.service.ts:690` — `if (stop !== null && ((long && price <= stop) || (!long && price >= stop))) {`
  - `apps/api/src/jobs/autoscan.service.ts:705` — `const reached = long ? price >= level : price <= level;`

**B. Is the entry-fill flag a fill, or a proximity test?**

> **PROXIMITY — it is true by construction almost immediately.** · severity `HIGH`

`entryFilledAt` is set when a polled price sits inside the published entry band. That band is entry ± 0.25 ATR and the entry is the last close, so on the first poll after issue the condition is satisfied for virtually every signal that has not already moved a quarter-ATR. The field is therefore recording 'the signal was still alive at the next poll', while the rest of the system reads it as 'a position existed' — and that reading is what decides whether an early exit is booked as a cancelled trade or as a setup that never happened.

  - `apps/api/src/jobs/autoscan.service.ts:673` — `if (signal.entryFilledAt === null && entry !== null) {`
  - `apps/api/src/jobs/autoscan.service.ts:674` — `const limit = long`

**C. Are non-price endings counted as losses?**

> **YES — every unresolved signal defaults to −1R.** · severity `CRITICAL`

The analytics layer falls back to `−1` for any signal without a recorded `realisedR` that is not a target hit. EXPIRED, INVALID and CANCELLED signals all take that path, and the schema is explicit that none of them represents a financial loss — INVALID never had a position at all. Some are additionally persisted with `realisedR = −1` on signals whose `entryFilledAt` is null, so the fallback is not the only source. Every hit-rate, expectancy and profit-factor figure the platform reports is computed over a population where setups that were never entered contribute full-size losses.

  - `apps/api/src/analysis/analytics.service.ts:171` — `const rOf = (r: TradeRow) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1);`
  - `apps/api/src/analysis/analytics.service.ts:305` — `const rs = rows.map((r) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1));`
  - `apps/api/src/analysis/analytics.service.ts:334` — `const rs = rows.map((r) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1));`

**D. Does revalidation compare like with like?**

> **NO — a calibrated confidence is compared against an uncalibrated one.** · severity `HIGH`

A signal's stored confidence is produced by a pipeline run with walk-forward calibration applied. Revalidation re-runs the pipeline with `withCalibration: false` — for a defensible reason, since the calibrated pass is roughly fifty times more expensive — and then subtracts one from the other and calls the difference a confidence drop. Any systematic offset the calibrator introduces is therefore read as thesis decay. Compounding it, the job runs every few minutes against every open signal regardless of timeframe, so a daily signal is re-scored on the order of three hundred times a day, each one an independent opportunity to trip a 22-point threshold. The probability of at least one trip over a multi-day hold approaches certainty whether or not anything has changed.

  - `apps/api/src/jobs/signal-monitor.service.ts:102` — `this.analysis.analyse(symbol, timeframe, { withCalibration: false }),`
  - `services/ai/app/engine/revalidation.py:40` — `CONFIDENCE_DROP_CRITICAL = 22.0`
  - `services/ai/app/engine/revalidation.py:182` — `elif drop >= CONFIDENCE_DROP_CRITICAL:`

**E. Can a trade in normal drawdown be closed by accumulated warnings?**

> **YES — three warnings force a close, and one of them fires on ordinary adverse excursion.** · severity `CRITICAL`

Three WARNING findings promote to CRITICAL and close the position. `STOP_RISK` raises a warning once price has travelled 55% of the way to the stop — which is not a malfunction, it is the middle of the range every trade is designed to survive. Order flow can contribute two warnings on its own, and thin volume or a volatility shift supplies the third. The result is a rule that preferentially closes trades that are temporarily losing, before they can reach a target quoted at 1.6R. It truncates the right tail of the outcome distribution and leaves the left tail intact, which is the exact opposite of what an exit rule is for.

  - `services/ai/app/engine/revalidation.py:47` — `STOP_PROXIMITY_WARNING = 0.55`
  - `services/ai/app/engine/revalidation.py:341` — `elif len(warnings) >= 3:`

**F. Is the published reward:risk measured, or constructed?**

> **CONSTRUCTED — the first target is placed at the ratio the gate requires.** · severity `HIGH`

The first target is solved for as `min_risk_reward × (1 + cost_r) + cost_r + 0.1`, and the gate then rejects anything below `min_risk_reward`. With the floor at 1.5 and cost negligible against a daily stop, that is 1.60 — which is the value carried by two thirds of the signals ever issued. The number is an input restated as an output. It is only a measurement when a structural level pulls the target in, and in that case it fails the gate. So the ratio can distinguish 'rejected' from 'accepted' and cannot say anything about how far price is likely to travel.

  - `services/ai/app/engine/signals.py:209` — `first_multiple = settings.min_risk_reward * (1.0 + cost_r) + cost_r + 0.1`

## 1.3 Random-direction control

30 seeds, 398 trades each
(protocol asks for 500;
shortfall 102).

Coin-flip net R distribution: min -144.53,
p05 -139.43, median -112.53,
p95 -72.14, max -55.81
(mean -106.77, sd 22.45).

Real system net R: **-212.39** →
**0th percentile** of the random distribution.
On expectancy: 0th percentile.

**Verdict — INDISTINGUISHABLE_FROM_RANDOM — the real system sits at the 0th percentile of the coin-flip distribution. The signal layer is not contributing measurable directional information; the observed results originate in exit geometry and costs. Sample caveat: 398 trades per seed against the 500 the protocol asks for — the distribution is correspondingly wide and the percentile correspondingly imprecise.**

## 1.4 Intrabar path audit

**0 of 398 closed trades
(0.0%)** exited on a bar whose range contained both
the stop and the target.

| Timeframe | Trades | Ambiguous | Rate |
|---|---|---|---|
| 15m | 262 | 0 | 0.0% |
| 4h | 69 | 0 | 0.0% |
| 1h | 67 | 0 | 0.0% |

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Pessimistic (stop first) | 398 | -212.39 | -0.5336 | 0.311 | 24.9% | -9.98 |
| Optimistic (target first) | 398 | -212.39 | -0.5336 | 0.311 | 24.9% | -9.98 |

Policy spread: net +0.00R,
expectancy +0.0000R,
hit rate +0.0pp.

**Verdict — ACCEPTABLE_AMBIGUITY — 0.0% of exits are ambiguous and expectancy moves +0.0000R between resolution policies. The pessimistic result stands as the honest one.**

Only the pessimistic column is a result. The optimistic column is the size of the assumption, shown so it cannot be mistaken for a finding.

## 1.5 Live vs backtest reconciliation

Mode: `DETERMINISM_ONLY` · live snapshots available: 0

Determinism check: ran on BTC:15m —
identical across two replays: **True**
(0 signals over 3 bars).

**Verdict — NOT_YET_INSTRUMENTED — no live snapshots exist to reconcile against. The live path now writes them (see diagnostics/live_log.py); this check becomes a real comparison as soon as the scanner has run with logging enabled. Until then it asserts only that the replay harness is deterministic, which is a precondition for the comparison and not a substitute for it.**

## 1.6 MAE / MFE distributions

99 winners, 299 losers.

| Outcome | MAE median | MAE p90 | MFE median | MFE p90 |
|---|---|---|---|---|
| Winners | 0.31R | 0.69R | 1.61R | 4.87R |
| Losers | 1.04R | 1.88R | 0.41R | 0.94R |

**Losing trades whose MFE exceeded half the target distance: 4.7%**
→ targets too far, if high.

**Winning trades whose MAE exceeded half the stop distance: 31.3%**
→ stops too tight, if high.

Reach rate by target distance — an upper bound on what pulling the target in could achieve,
since a bar cannot say whether the stop was touched first:

| Target | Trades reaching | Count |
|---|---|---|
| 0.50R | 55.0% | 219 |
| 0.75R | 38.2% | 152 |
| 1.00R | 28.1% | 112 |
| 1.25R | 20.6% | 82 |
| 1.50R | 16.1% | 64 |
| 2.00R | 9.8% | 39 |
| 2.50R | 6.0% | 24 |
| 3.00R | 4.0% | 16 |

**Verdict — GEOMETRY_REASONABLE — 5% of losers reached half their target and 31% of winners reached half their stop. Neither is the dominant failure.**

## Breakdowns

### By session bucket

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| asia | 143 | -83.91 | -0.5868 | 0.254 | 20.3% | -7.20 |
| europe | 134 | -71.07 | -0.5304 | 0.356 | 24.6% | -5.13 |
| us | 87 | -24.04 | -0.2763 | 0.530 | 39.1% | -2.38 |
| late | 34 | -33.37 | -0.9814 | 0.025 | 8.8% | -9.24 |

### By timeframe

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| 15m | 262 | -161.04 | -0.6147 | 0.294 | 20.6% | -8.80 |
| 4h | 69 | -25.04 | -0.3629 | 0.468 | 44.9% | -2.73 |
| 1h | 67 | -26.31 | -0.3927 | 0.200 | 20.9% | -4.78 |

### By asset class

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| CRYPTO | 301 | -173.20 | -0.5754 | 0.293 | 20.3% | -9.25 |
| FOREX | 84 | -44.55 | -0.5303 | 0.257 | 36.9% | -5.04 |
| EQUITY | 13 | +5.36 | +0.4120 | 2.715 | 53.8% | +1.44 |

### By volatility regime

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| NORMAL | 210 | -112.00 | -0.5333 | 0.309 | 22.9% | -7.33 |
| LOW | 102 | -50.47 | -0.4948 | 0.351 | 32.4% | -4.47 |
| HIGH | 85 | -49.87 | -0.5866 | 0.269 | 21.2% | -5.16 |
| EXTREME | 1 | -0.06 | -0.0549 | 0.000 | 0.0% | +0.00 |

### By direction

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| SELL | 200 | -142.12 | -0.7106 | 0.230 | 14.5% | -9.49 |
| BUY | 198 | -70.28 | -0.3549 | 0.432 | 35.4% | -4.77 |
