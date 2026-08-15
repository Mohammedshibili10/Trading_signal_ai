# Phase 1 — Diagnostic Report

Generated 2026-08-15T12:57:03+00:00 · commit `1a89e03`

Replay covered **5 instrument-timeframe series**,
**35 scored bars**, producing **1 signals**
and **1 resolved trades**.

## 0. Sample size and what it permits

> **The trade count is below the 200 the protocol requires for a statistically meaningful result.** Every figure below is reported because the protocol asks for it, and none of them should be treated as established. They are directional evidence about *mechanisms*, not measurements of *performance*.

The replay scored **35 bars** across 5 series and emitted **1 tradeable signals** — a firing rate of **2.86%** of scored bars. 1 of those resolved into simulated trades.

The engine declined on the remaining 34 bars. Its own stated reasons, most frequent first:

- `Factor groups are balanced with no directional edge` — 5 (14.7%)
- `Confidence 3 is below the 45 floor` — 4 (11.8%)
- `Confidence 22 is below the 45 floor` — 3 (8.8%)
- `Confidence 6 is below the 45 floor` — 2 (5.9%)
- `Confidence 7 is below the 45 floor` — 2 (5.9%)
- `Confidence 5 is below the 45 floor` — 2 (5.9%)

Candle store: 38877 rows read, 5 series built; dropped 0 unparseable, 0 invalid, 0 duplicate; 0 future-dated.
## 1.1 Zero-cost ablation

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Zero cost | 1 | +0.78 | +0.7780 | inf | 100.0% | +0.00 |
| Full costs | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

Average round-trip cost: **0.077R** per trade.
Cost drag as a share of gross result: **9.9%**.
Break-even hit rate at the reward:risk the engine quotes: **38.6%**.

Signals that produced no trade: 0 never filled,
0 had too little forward data,
0 had unusable geometry.

**Verdict — `EDGE_SURVIVES_COSTS`**

Expectancy is +0.7008R per trade after costs on 1 trades (t = +0.00). The edge survives the friction the engine models. Whether it survives the friction the market charges is a question for the paper-forward test, not for this one.

## 1.2 One-bar lag test

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Baseline (next-open fill) | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |
| Lagged (+1 bar) | 1 | +0.81 | +0.8104 | inf | 100.0% | +0.00 |

Delta: net +0.11R, expectancy +0.1096R,
hit rate +0.0pp.

**Verdict — STABLE — 116% of expectancy survives one bar of delay, which is consistent with a real edge rather than with leakage.**

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
  - `services/ai/app/diagnostics/replay.py:199` — `Every call sees ``candles[: i + 1]`` and nothing else.`

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

5 seeds, 1 trades each
(protocol asks for 500;
shortfall 499).

Coin-flip net R distribution: min -1.08,
p05 -1.08, median -1.08,
p95 +0.70, max +0.70
(mean -0.37, sd 0.97).

Real system net R: **+0.70** →
**60th percentile** of the random distribution.
On expectancy: 60th percentile.

**Verdict — INDISTINGUISHABLE_FROM_RANDOM — the real system sits at the 60th percentile of the coin-flip distribution. The signal layer is not contributing measurable directional information; the observed results originate in exit geometry and costs. Sample caveat: 1 trades per seed against the 500 the protocol asks for — the distribution is correspondingly wide and the percentile correspondingly imprecise.**

## 1.4 Intrabar path audit

**0 of 1 closed trades
(0.0%)** exited on a bar whose range contained both
the stop and the target.

| Timeframe | Trades | Ambiguous | Rate |
|---|---|---|---|
| 4h | 1 | 0 | 0.0% |

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| Pessimistic (stop first) | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |
| Optimistic (target first) | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

Policy spread: net +0.00R,
expectancy +0.0000R,
hit rate +0.0pp.

**Verdict — ACCEPTABLE_AMBIGUITY — 0.0% of exits are ambiguous and expectancy moves +0.0000R between resolution policies. The pessimistic result stands as the honest one.**

Only the pessimistic column is a result. The optimistic column is the size of the assumption, shown so it cannot be mistaken for a finding.

## 1.5 Live vs backtest reconciliation

Mode: `DETERMINISM_ONLY` · live snapshots available: 0

Determinism check: ran on BTC:4h —
identical across two replays: **True**
(1 signals over 3 bars).

**Verdict — NOT_YET_INSTRUMENTED — no live snapshots exist to reconcile against. The live path now writes them (see diagnostics/live_log.py); this check becomes a real comparison as soon as the scanner has run with logging enabled. Until then it asserts only that the replay harness is deterministic, which is a precondition for the comparison and not a substitute for it.**

## 1.6 MAE / MFE distributions

1 winners, 0 losers.

| Outcome | MAE median | MAE p90 | MFE median | MFE p90 |
|---|---|---|---|---|
| Winners | 0.28R | 0.28R | 1.08R | 1.08R |
| Losers | 0.00R | 0.00R | 0.00R | 0.00R |

**Losing trades whose MFE exceeded half the target distance: 0.0%**
→ targets too far, if high.

**Winning trades whose MAE exceeded half the stop distance: 0.0%**
→ stops too tight, if high.

Reach rate by target distance — an upper bound on what pulling the target in could achieve,
since a bar cannot say whether the stop was touched first:

| Target | Trades reaching | Count |
|---|---|---|
| 0.50R | 100.0% | 1 |
| 0.75R | 100.0% | 1 |
| 1.00R | 100.0% | 1 |
| 1.25R | 0.0% | 0 |
| 1.50R | 0.0% | 0 |
| 2.00R | 0.0% | 0 |
| 2.50R | 0.0% | 0 |
| 3.00R | 0.0% | 0 |

**Verdict — GEOMETRY_REASONABLE — 0% of losers reached half their target and 0% of winners reached half their stop. Neither is the dominant failure.**

## Breakdowns

### By session bucket

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| asia | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

### By timeframe

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| 4h | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

### By asset class

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| CRYPTO | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

### By volatility regime

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| NORMAL | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |

### By direction

| Arm | Trades | Net R | Expectancy | Profit factor | Hit rate | t |
|---|---|---|---|---|---|---|
| SELL | 1 | +0.70 | +0.7008 | inf | 100.0% | +0.00 |
