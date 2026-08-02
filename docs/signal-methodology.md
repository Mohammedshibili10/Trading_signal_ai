# Signal Methodology

The exact specification implemented by `services/ai/app/engine/`. Anything the
platform displays as a probability or confidence number is produced by this pipeline
and nothing else.

---

## 1. Pipeline

```
candles ──► indicators ──► factor groups ──► blended score
                │                                  │
                ├─ candle anatomy                  ├─ probability (calibrated)
                ├─ patterns                        ├─ confidence
                ├─ price action / levels           └─ direction
                ├─ market structure (SMC)
                ├─ volume                                 │
                ├─ volatility regime                      ▼
                ├─ news sentiment                    trade levels
                └─ fundamentals                (entry / SL / T1-T3 / R:R)
                                                          │
                                                          ▼
                                                  risk assessment
                                                          │
                                                          ▼
                                              explanation + invalidation
```

Every stage is causal: bar *i* is scored using data available at the close of bar *i*
only. This is enforced by construction — the engine slices `candles[:i+1]` and has no
access to later bars. It is the reason the calibration numbers mean anything.

---

## 2. Per-candle anatomy

Before any interpretation, each bar is measured (`engine/anatomy.py`):

```python
range          = high - low
body           = abs(close - open)
upper_wick     = high - max(open, close)
lower_wick     = min(open, close) - low
body_pct       = body / range
close_location = (2*close - high - low) / range     # -1 … +1
range_vs_atr   = range / atr14
volume_ratio   = volume / sma(volume, 20)
gap_pct        = (open - prev_close) / prev_close * 100
is_inside      = high <= prev_high and low >= prev_low
is_outside     = high >  prev_high and low <  prev_low
is_climactic   = range_vs_atr > 1.8 and volume_ratio > 2.0 and max(wick_pcts) > 0.4
```

**Effort vs result** (Wyckoff):

| volume_ratio | range_vs_atr | Verdict |
| --- | --- | --- |
| > 1.5 | < 0.8 | `DIVERGENT` — effort without result, absorption |
| < 0.7 | > 1.5 | `DIVERGENT` — unsupported move |
| aligned | aligned | `CONFIRMING` |

Classification is compositional, not a lookup: a bar with `body_pct > 0.85`,
`range_vs_atr > 1.5`, `close > open` is reported as *"Wide-range bullish marubozu"*.

---

## 3. Factor groups

Nine groups. Each emits a score in **[−1, +1]** (negative = bearish) and a weight.
Scores are the *evidence*; weights are how much that evidence is trusted.

| Group | Base weight | Inputs |
| --- | --- | --- |
| `TREND` | 0.20 | MA stack, ADX/DMI, SuperTrend, higher-TF alignment |
| `INDICATORS` | 0.16 | RSI, MACD, Stochastic, CCI, BB position (normalised as one group) |
| `PRICE_ACTION` | 0.15 | Distance to S/R, breakout/breakdown state, pullback quality |
| `MARKET_STRUCTURE` | 0.13 | BOS/CHoCH, order blocks, FVG, liquidity sweeps, premium/discount |
| `CANDLESTICK` | 0.10 | Context-adjusted pattern reliability + anatomy |
| `VOLUME` | 0.10 | Volume ratio, OBV slope, MFI, effort-vs-result |
| `VOLATILITY` | 0.06 | ATR regime, BB squeeze/expansion |
| `NEWS` | 0.06 | FinBERT sentiment, decayed by age |
| `FUNDAMENTALS` | 0.04 | Quality/valuation composite (equity only) |

### 3.1 Why candlesticks are only 10 %

Because that is what the measurements support. Bulkowski's testing puts many
single-candle patterns at 52–56 % — statistically indistinguishable from a coin flip —
and found the hanging man resolving *opposite* to its textbook meaning ~59 % of the
time. Patterns that do carry real signal (three white soldiers ~82 %, three black
crows ~78 %) are multi-bar and are scored higher within the group.

The group is also *context-multiplied* rather than taken at face value:

```
adjusted = base_reliability
         × trend_alignment_mult   # 0.6 … 1.3
         × location_mult          # 0.7 … 1.4  (at a tested level?)
         × volume_mult            # 0.8 … 1.3
         × range_mult             # 0.9 … 1.2
```

A hammer at tested support in a downtrend on 2× volume scores far above a hammer
floating mid-range. Both are "a hammer"; only one is evidence.

### 3.2 Weight redistribution

Not every group applies to every instrument. When a group is unavailable its weight is
redistributed proportionally across the rest — never silently scored as neutral, which
would drag the blend toward zero and fake a "balanced" read.

| Situation | Dropped |
| --- | --- |
| Forex / crypto | `FUNDAMENTALS` |
| Spot forex | `VOLUME` (no real volume; a tick proxy would mislead) |
| < 50 bars of history | `MARKET_STRUCTURE`, `PRICE_ACTION` |
| No news in 72 h | `NEWS` |
| Mutual funds / NAV series | `CANDLESTICK`, `VOLUME`, `MARKET_STRUCTURE` |

### 3.3 Correlation handling

`INDICATORS` contains four oscillators that measure nearly the same thing. They are
normalised *within* the group before it contributes, so momentum cannot be counted
four times. Adding a fifth oscillator changes the group's internal balance, not its
influence on the result.

---

## 4. Blending

```python
raw = Σ(score_i × weight_i) / Σ(weight_i)          # → [-1, +1]
```

Then three adjustments, in order:

**1. Agreement.** Consensus is more trustworthy than one loud factor.

```python
agreement = 1 - (stdev(scores) / 0.8)      # clamped to [0.35, 1.0]
```

**2. Higher-timeframe conflict.** Trading against the bias timeframe is penalised
explicitly rather than averaged away:

```python
if sign(raw) != sign(higher_tf_trend): raw *= 0.65
```

**3. Volatility damping.** In `EXTREME` ATR regimes everything is less predictable:

```python
if regime == 'EXTREME': raw *= 0.8
```

### 4.1 Score → probability

A logistic maps the blended score to a directional probability. `k = 2.2` was fitted so
that predicted probabilities match observed frequencies on held-out data — it is not a
cosmetic constant.

```python
p_up = 1 / (1 + exp(-k * raw))
```

A **flat band** is carved out for bars that realistically won't move, scaled by
volatility regime (a 0.3 % move is flat for BTC, decisive for a bond fund):

```python
p_flat = flat_band(regime)          # 0.06 (EXTREME) … 0.22 (LOW)
p_up   = p_up   * (1 - p_flat)
p_down = (1 - p_up_raw) * (1 - p_flat)
```

Finally probabilities are passed through the calibration map (§6) before display.

### 4.2 Confidence

Confidence is **not** the probability. It answers "how much do we trust this read?"

```python
confidence = 100 × strength(|raw|) × agreement × data_quality × regime_penalty
```

- `data_quality` — bars available, gaps, staleness of the last tick, how many groups
  actually contributed.
- `regime_penalty` — 1.0 normal, 0.85 high volatility, 0.7 extreme.

Confidence is **hard-capped at 85**. There is no market state in which this engine
should report near-certainty, and a cap is more honest than trusting the arithmetic
not to produce 99.

---

## 5. Trade levels

### 5.1 Entry

| Setup | Entry |
| --- | --- |
| Breakout | Level + 0.1 × ATR (needs a close beyond) |
| Pullback | Zone between EMA20 and the nearest OB/FVG |
| Reversal | Current close, only with CHoCH + level + volume |

An **entry zone** (`entry ± 0.25 × ATR`) is always quoted, because exact fills are a
backtest fiction.

### 5.2 Stop loss

Compute all three, take the **widest** of structural and volatility so normal noise
doesn't stop you out:

```python
structural = swing_low - 0.15 * atr        # long
volatility = entry - 1.8 * atr
pattern    = pattern.invalidation
stop       = min(structural, volatility)   # long → lower is wider
```

Then bound it: if `|entry − stop| / entry > 8 %`, the setup is rejected as too wide
rather than issued with an unusable size.

### 5.3 Targets

```python
r = abs(entry - stop)
t1 = entry + 1.0r   → or nearest opposing level, whichever is closer
t2 = entry + 2.0r   → or measured move
t3 = entry + 3.2r   → or higher-timeframe level
```

Each target's probability decays with distance and is scaled by trend strength:

```python
p(t1) = p_direction × 0.82
p(t2) = p_direction × 0.55 × trend_factor
p(t3) = p_direction × 0.31 × trend_factor
```

A system reporting the same confidence for T3 as T1 is not modelling anything.

### 5.4 Rejection rules

No signal is emitted when:

- R:R at T1 < **1.5**
- confidence < **45**
- stop distance > 8 % of price
- fewer than 60 bars of history
- ATR regime is `EXTREME` *and* confidence < 60
- structure and trend groups directly contradict each other

The action returned is `WAIT`, with the reason stated. **Not trading is a valid
output** and the engine returns it often — roughly 40 % of evaluations on typical
daily data.

---

## 6. Calibration

The part that makes the numbers honest. Without it, "72 % confidence" is decoration.

### 6.1 Walk-forward scoring

For the last *N* closed bars (default 250) the engine re-runs itself using only data
up to that bar, records the prediction, then compares against what the next bar
actually did. No future data touches the prediction — enforced by slicing.

### 6.2 Reported metrics

| Metric | Meaning |
| --- | --- |
| `hitRate` | Share of directional calls that resolved correctly |
| `highConfidenceHitRate` | Same, restricted to confidence ≥ 65 |
| `buckets` | Predicted vs actual per confidence decile |
| `calibrationError` | Mean \|predicted − actual\| across buckets |
| `brierScore` | Mean squared error of probabilities. 0.25 = coin flip |

### 6.3 Isotonic-style correction

If a bucket consistently over- or under-predicts, a monotone correction map is fitted
and applied to future probabilities on that symbol/timeframe. Predictions are pulled
toward measured reality rather than left to drift.

The map is refit nightly by a BullMQ job and cached per symbol+timeframe. With fewer
than 100 samples the raw probability is used and `calibration` returns `null` — the UI
then shows "not yet calibrated" instead of an unearned number.

### 6.4 What gets shown

Every signal and forecast surface displays its calibration alongside its confidence:

> Confidence 71 · measured hit-rate 63 % over 250 bars · Brier 0.213

A user can see whether the engine has earned its confidence on *this* instrument.
Where it hasn't, the UI says so.

---

## 7. Explanations

Generated **from** the factor scores, never independently. The ranking is
`|score × weight|` descending, so the stated reasons are literally the arithmetic that
drove the number — a fluent story can never disagree with the model.

```
1. Trend        +0.72 × 0.20  →  "Price above 20/50/200 EMA with ADX 31 — established uptrend"
2. Structure    +0.61 × 0.13  →  "BOS above 2,845 confirmed the higher high"
3. Volume       +0.45 × 0.10  →  "Volume 1.9× the 20-day average on the breakout bar"
4. Candlestick  -0.30 × 0.10  →  "Upper wick 42% of range — sellers active into the close"
```

Note the fourth line. **Contradicting factors are always included**, ranked by the
same rule. A signal that only lists supporting evidence is a sales pitch.

When `ANTHROPIC_API_KEY` is set, an LLM rewrites these into prose for the assistant —
constrained to the supplied factors, forbidden from introducing new claims, and never
allowed to alter a number.

---

## 8. Known limitations

Stated in the product, not buried here:

- **Regime change.** Calibration is backward-looking. When the market's character
  changes, measured hit-rates lag reality.
- **Thin instruments.** Small-caps and minor pairs have unreliable volume and gappy
  history; confidence is damped but not eliminated.
- **News latency.** RSS polling is 10-minutely. Sentiment lags a fast-moving story.
- **No order-flow data.** No L2 book, no options chain, no FII/DII intraday flows.
  Real institutional desks have these; this doesn't.
- **Events.** Earnings, RBI policy and budget days break technical models. Events are
  flagged from the calendar, but their outcome is not predicted.
- **Backtest ≠ live.** Slippage, partial fills, impact and psychology are not in the
  numbers.
