# Trading Concepts — Reference

The domain model behind the platform. Written so that every claim the product makes
traces back to something stated here, and every module maps to a section.

A theme runs through all of it: **context dominates pattern.** The same candlestick,
the same RSI reading, the same breakout means different things depending on trend,
location and volume. Systems that score patterns in isolation produce confident
nonsense. The engine here is built the other way around — patterns are weak evidence
that only becomes strong when context agrees.

---

## 1. Market structure

### 1.1 Trend

A trend is a sequence of swing points, not a line on a chart.

- **Uptrend** — higher highs *and* higher lows.
- **Downtrend** — lower highs *and* lower lows.
- **Range** — neither holds; swings alternate inside a band.

Swing points are identified with a **fractal** rule: a swing high is a bar whose high
exceeds the `n` bars either side of it (n = 2 for intraday, 3–5 for daily). Everything
downstream — structure breaks, order blocks, trendlines, support/resistance, pattern
detection — is built on this one primitive. Getting `n` right matters more than any
indicator setting: too small and you get noise, too large and you miss the turn.

### 1.2 Break of Structure (BOS) vs Change of Character (CHoCH)

- **BOS** — price breaks the most recent swing high *in an uptrend* (or swing low in
  a downtrend). Trend **continues**. Confirmation, not reversal.
- **CHoCH** — price breaks the most recent swing low *while in an uptrend* (or swing
  high in a downtrend). The first structural evidence the trend is **turning**.

The distinction is the single most useful idea in modern price-action trading, and
the most commonly confused. A BOS after a CHoCH confirms the new direction.

### 1.3 Timeframe hierarchy

Higher timeframes set direction; lower timeframes set entry. The platform enforces
a 3-tier read:

| Role | Equity | Forex / Crypto |
| --- | --- | --- |
| Bias | 1W / 1D | 1D / 4h |
| Setup | 1D / 1h | 4h / 1h |
| Trigger | 15m / 5m | 15m / 5m |

A trade taken against the bias timeframe needs materially more confirmation. The
signal engine applies an explicit penalty for higher-timeframe conflict rather than
silently averaging it away.

---

## 2. Support, resistance and levels

### 2.1 What makes a level real

Levels are not lines, they are **zones**. Strength is scored 0–100 from four inputs:

1. **Touches** — how many times price reacted there. 2 is a level, 3+ is a strong one.
2. **Recency** — a level touched last week matters more than one from 2019.
3. **Reaction size** — how far price travelled away from it after each touch.
4. **Volume at the level** — high-volume nodes are where positions actually sit.

A level that has been broken flips role: broken resistance becomes support
(*polarity*). The platform tracks this and labels it explicitly.

### 2.2 Pivot points

Mechanical levels computed from the prior period, widely watched intraday — which is
what makes them self-fulfilling. Standard (floor-trader) formulation:

```
P  = (H + L + C) / 3
R1 = 2P − L        S1 = 2P − H
R2 = P + (H − L)   S2 = P − (H − L)
R3 = H + 2(P − L)  S3 = L − 2(H − P)
```

Camarilla and Fibonacci variants are also implemented; Camarilla's tight R3/S3 are
the practical intraday reversal levels.

### 2.3 Fibonacci

Retracements at 23.6 / 38.2 / **50** / **61.8** / 78.6 % of the last impulse leg.
The 50 % level is not a Fibonacci number but is the most respected in practice.
Extensions at 127.2 / 161.8 / 200 / 261.8 % give targets.

**The honest caveat:** Fibonacci levels work largely because enough participants
watch them, and because in any trending market *some* retracement level will be near
*some* reversal. The platform weights Fibonacci lower than volume-confirmed structural
levels for exactly this reason.

### 2.4 VWAP

Volume-Weighted Average Price — the session's true average transaction price, and the
benchmark institutional desks are measured against.

```
VWAP = Σ(typical_price × volume) / Σ(volume),  typical = (H + L + C) / 3
```

Anchoring matters: VWAP resets each session for intraday use. Price above VWAP means
buyers are in control of the session; the standard-deviation bands around it act as
mean-reversion boundaries. For instruments without real volume (spot forex), VWAP is
**not computed** — a tick-count proxy would be misleading, so the platform returns
`null` and redistributes that factor's weight.

---

## 3. Smart Money Concepts (SMC)

Modern repackaging of Wyckoff and order-flow logic. Useful vocabulary and genuinely
useful geometry, but heavily over-claimed by its retail teachers. Treated here as one
weighted evidence group, not as truth.

### 3.1 Order blocks

The last opposing candle before an impulsive move that breaks structure. A **bullish
order block** is the last down-candle before a strong rally; the theory is that
unfilled institutional buy orders rest there. Quality filters applied:

- Must precede a move that actually broke structure (BOS), not just a bounce.
- Impulse leg should be ≥ 1.5 × ATR.
- **Unmitigated** blocks (never revisited) carry more weight than used ones.
- Blocks that overlap a fair value gap are stronger.

### 3.2 Fair Value Gap (FVG) / imbalance

A three-candle pattern where candle 1's high and candle 3's low do not overlap,
leaving a price range that traded in one direction only.

```
Bullish FVG: low[2] > high[0]   →  gap between high[0] and low[2]
Bearish FVG: high[2] < low[0]   →  gap between high[2] and low[0]
```

Gaps tend to get revisited ("filled") because they represent inefficient price
delivery. Larger gaps relative to ATR are more significant; gaps inside a strong trend
often stay unfilled for a long time.

### 3.3 Liquidity

Clusters of stop orders — resting above equal highs (**buy-side liquidity**) and below
equal lows (**sell-side liquidity**). A **liquidity sweep** is a wick through those
levels that immediately reverses: the move existed to fill orders, not to trend.

This is the mechanism behind the classic "stop hunt", and it is the most tradeable SMC
idea because it is objectively detectable: equal highs within a tolerance band, then a
wick beyond, then a close back inside.

### 3.4 Premium / discount

Split the current dealing range at its midpoint (equilibrium).

- Above 50 % = **premium** — favour selling.
- Below 50 % = **discount** — favour buying.
- The 62–79 % zone of a retracement is the "optimal trade entry" band.

Simple, and a genuinely useful discipline: it stops you buying at the top of a range.

---

## 4. Candlestick analysis

### 4.1 Anatomy first, name second

Before naming a pattern, the engine measures the bar. This is the part most systems
skip, and it is where the actual information is:

| Measure | Meaning |
| --- | --- |
| `bodyPercent` = \|C−O\| / range | Conviction. >0.7 decisive, <0.3 indecisive |
| `upperWickPercent`, `lowerWickPercent` | Where price was rejected |
| `closeLocation` = (2C − H − L) / range | −1 closed on low … +1 closed on high |
| `rangeVsAtr` = range / ATR(14) | >1.5 wide-range, <0.6 narrow-range |
| `volumeRatio` = vol / SMA(vol, 20) | Participation |
| `gapPercent` | Overnight repricing |
| inside / outside bar | Compression vs expansion |

**Effort vs result** (Wyckoff): high volume with a small range means effort without
result — supply is absorbing demand, a warning. Large range on low volume means the
move is unsupported. This single comparison catches things no named pattern does.

### 4.2 Named patterns

Implemented: Hammer, Hanging Man, Inverted Hammer, Shooting Star, Doji (standard,
long-legged, dragonfly, gravestone), Spinning Top, Marubozu, Bullish/Bearish
Engulfing, Piercing Line, Dark Cloud Cover, Morning Star, Evening Star, Three White
Soldiers, Three Black Crows, Harami (+ cross), Tweezer top/bottom, Three Inside/Outside.

### 4.3 What the research actually says

This matters enough to state plainly, because it shapes the whole engine.

Bulkowski's testing across 103 candlestick patterns found:

- **Three white soldiers** — bullish reversal ~82 % of the time (rank 3/103).
- **Three black crows** — bearish reversal ~78 %.
- **White marubozu** — continuation ~56 %.
- **Bullish kicking** — ~53 %, essentially a coin flip.
- **A single black candle** — ~52 %, indistinguishable from random.
- **Hanging man** — resolved as a bullish *continuation* ~59 % of the time, i.e. the
  **opposite** of what the textbook says it means.

Conclusions the platform bakes in:

1. Most single-candle patterns in isolation are near-random. They are given a low
   base weight.
2. Multi-candle confirmed patterns (three soldiers/crows, engulfing at a level) carry
   real signal.
3. Textbook stance is not trusted where measurement contradicts it — the hanging man
   is scored from measured behaviour, not folklore.
4. **Context multipliers** are what turn a candle into evidence:

```
adjusted_reliability = base × f(trend_alignment)
                             × f(location vs support/resistance)
                             × f(volume_ratio)
                             × f(range_vs_atr)
```

A hammer in a downtrend, at a tested support level, on 2× volume is a real signal.
A hammer mid-range on average volume is noise. Both are "a hammer".

---

## 5. Chart patterns

Detected: double top/bottom, head & shoulders (+ inverse), ascending / descending /
symmetrical triangles, bull & bear flags, pennants, rising & falling wedges,
rectangles, cup & handle.

All are found geometrically from the fractal swing series, then filtered:

- **Symmetry** — the two tops of a double top must be within ~3 % of each other.
- **Duration** — a pattern spanning 5 bars is noise; 20–100 bars is meaningful.
- **Volume signature** — H&S should show declining volume into the right shoulder;
  breakouts should expand.
- **Status** — `FORMING` (incomplete), `CONFIRMED` (neckline broken with a close),
  `FAILED` (invalidated). Most systems only report confirmed patterns, which is why
  they look prescient in hindsight and useless live.

Measured-move targets: project the pattern's height from the breakout point. Reported
as a *target*, never as a prediction.

**Caveat:** pattern detection is inherently subjective, and any algorithm will find
patterns in random data. Confidence scores here reflect geometric fit quality, not
probability of success — those come from the calibration layer instead.

---

## 6. Technical indicators

Grouped by what they actually measure. Full formulas in
[indicator-formulas.md](./indicator-formulas.md).

| Group | Indicators | Reads |
| --- | --- | --- |
| Trend | EMA, SMA, MA stack, SuperTrend, Ichimoku, ADX/DMI, Parabolic SAR | Direction & strength |
| Momentum | RSI, MACD, Stochastic, CCI, Williams %R, ROC | Speed & exhaustion |
| Volatility | ATR, Bollinger Bands, Keltner, historical volatility | Regime & position sizing |
| Volume | OBV, MFI, CMF, volume SMA, VWAP, A/D line | Participation & conviction |

### 6.1 Correlation is the trap

RSI, Stochastic, CCI and Williams %R are all oscillators derived from recent price
extremes. Averaging their four "votes" doesn't give four independent opinions — it
gives one opinion counted four times, with false confidence attached.

The engine therefore assigns weights to **groups**, not indicators, and normalises
within each group. Adding a fifth oscillator does not increase momentum's influence
on the outcome. This is the difference between a scoring system and a slot machine.

### 6.2 Divergence

Price makes a higher high while the oscillator makes a lower high (bearish), or the
mirror (bullish). Genuinely informative at extremes, unreliable in strong trends where
momentum divergence can persist for months. Detected on RSI and MACD from confirmed
fractal swings only, and down-weighted when ADX > 30.

---

## 7. Signal construction

### 7.1 Entry

- **Breakout entry** — a *close* beyond the level, not a wick. Optionally require a
  retest.
- **Pullback entry** — into a moving average, order block, FVG or Fibonacci zone in
  the direction of trend. Better risk-reward, lower hit rate.
- **Reversal entry** — only at a structural level with a CHoCH and volume evidence.

An **entry zone** is quoted rather than a single price, because fills are never exact.

### 7.2 Stop loss

Never arbitrary percentages. Three methods, and the engine takes the *widest* of the
structural and volatility stops so noise doesn't take you out:

1. **Structural** — beyond the swing low/high that invalidates the idea.
2. **Volatility (ATR)** — entry ∓ (1.5 … 2.5) × ATR(14).
3. **Pattern** — beyond the pattern's invalidation point.

**Trailing:** Chandelier exit (`highest_high(22) − 3 × ATR`), SuperTrend line, or a
moving average. Trail only after 1R is banked.

### 7.3 Targets

- **T1** — 1R or the nearest opposing level. Book partial, move stop to breakeven.
- **T2** — 2R or the measured move.
- **T3** — 3R+ or a higher-timeframe level; runner.

Each target carries a probability that *declines* with distance. Any system showing
T3 with the same confidence as T1 is not modelling anything.

### 7.4 Risk-reward

```
R:R = (target − entry) / (entry − stop)
```

Below **1.5:1** the platform will not issue a signal. The arithmetic is unforgiving:
at 2:1 you need a 33 % hit rate to break even; at 1:1 you need 50 %; at 0.5:1 you need
67 %, which almost nobody sustains.

---

## 8. Risk management

The part that determines whether an account survives. Weighted accordingly.

### 8.1 Position sizing

```
risk_amount   = capital × risk_percent
risk_per_unit = |entry − stop|
quantity      = floor(risk_amount / risk_per_unit)
```

Standard risk is **1 %** per trade, 2 % maximum. The stop distance determines size —
size is never chosen first and a stop fitted around it.

**Kelly criterion:** `f* = W − (1 − W)/R`. Mathematically optimal for growth, and far
too aggressive in practice because W and R are estimates. Fractional Kelly (¼ to ½) is
the professional application. The platform shows full Kelly and recommends ¼.

### 8.2 Loss limits

Circuit breakers, enforced not suggested:

| Limit | Default | On breach |
| --- | --- | --- |
| Daily loss | 3 % | Stop trading for the day |
| Weekly loss | 6 % | Halve size for the rest of the week |
| Max drawdown | 15 % | Full stop, review the system |

The recovery arithmetic is why: a 10 % drawdown needs +11 % to recover, 25 % needs
+33 %, 50 % needs +100 %, 75 % needs +300 %. Drawdown is non-linear and asymmetric.

### 8.3 Portfolio risk

- **Correlation** — 5 PSU bank positions is one position at 5× size. Correlation
  ≥ 0.7 is treated as concentration.
- **Sector exposure** — cap ~25 % per sector.
- **Value at Risk** — 1-day 95 % VaR, historical and parametric. VaR describes the
  quantile, not the tail; **CVaR** (expected shortfall) is reported alongside because
  the tail is what actually hurts.
- **Beta** — portfolio sensitivity to NIFTY 50.
- **Diversification score** — from the effective number of independent bets
  (inverse Herfindahl on the correlation-adjusted weights), not the raw holding count.

### 8.4 Monte Carlo

Resample historical trade outcomes thousands of times to get the *distribution* of
paths, not one backtest's lucky sequence. Outputs: percentile equity bands,
probability of profit, probability of ruin, median and worst drawdown.

Its real lesson: the same edge produces wildly different equity curves by ordering
alone. A strategy with positive expectancy can still be down after 100 trades.

### 8.5 Performance metrics

| Metric | Formula | Read |
| --- | --- | --- |
| Win rate | wins / total | Alone, meaningless |
| Profit factor | gross profit / gross loss | >1.5 good, >2 strong |
| Expectancy | (W × avgWin) − (L × avgLoss) | Per-trade edge |
| Sharpe | (Rp − Rf) / σp | >1 good. Punishes upside volatility too |
| Sortino | (Rp − Rf) / σdownside | Better — only penalises downside |
| Calmar | CAGR / max drawdown | Return per unit of pain |
| Max DD | peak-to-trough | The number that ends careers |

---

## 9. Fundamental analysis (Indian equity)

### 9.1 Metrics that matter here

**Valuation** — P/E (always vs *industry*, never absolute), P/B (banks/NBFCs),
EV/EBITDA (capital-structure neutral), PEG, dividend yield.

**Profitability** — **ROE** and **ROCE**. ROCE is the more honest number in India
because it is unaffected by leverage; a high ROE on high debt is fragile.

**Growth** — revenue, profit and EPS growth YoY and 3/5-year CAGR. *Consistency*
outranks magnitude.

**Health** — debt/equity (<1 generally, <0.5 preferred outside financials), interest
coverage (>3), current ratio, and **free cash flow**. Profit is an opinion; cash is a
fact. Persistent profit growth without cash-flow growth is the classic warning sign.

### 9.2 The Indian-specific lens

This is what a generic international model misses:

- **Promoter holding** — high and stable (>50 %) is good. *Falling* promoter holding
  is a serious red flag.
- **Promoter pledging** — shares pledged against loans. Any pledging is a concern;
  >25 % is a major one. It has preceded several Indian corporate collapses.
- **FII / DII holding** — institutional conviction and its trend.
- **Related-party transactions** and auditor changes — governance signals that don't
  appear in ratios.

### 9.3 Scoring

Quality, valuation, growth and financial-health sub-scores (0–100) combine into a
composite **investment score** and a long-term rating. Percentile-ranked **within
sector** — comparing an IT company's margins to a bank's is meaningless.

---

## 10. News and sentiment

Sentiment classification uses **FinBERT**, trained on financial text, because general
NLP models misread finance. "Company beats estimates but guidance cut" is negative;
a general model reads "beats" and says positive. When FinBERT is disabled a
finance-tuned lexicon model runs instead — faster, less accurate, and labelled as such.

Signals extracted per item: stance, confidence, impact (high/medium/low), why it
matters, expected impact, affected symbols.

**Limits, stated because they're real:** sentiment is best at *confirming* price
action, not leading it. By the time news is published it is usually priced. Social
sentiment is contaminated by promotion and bots. Sentiment therefore gets a modest
weight (~8 %) and is capped so it can never override structure.

---

## 11. Investment module (long-horizon)

Different discipline from trading — the platform keeps them visually and
conceptually separate so users don't blur the two.

- **SIP** — rupee-cost averaging. Future value of a monthly annuity-due:
  `FV = P × [((1+i)^n − 1) / i] × (1+i)`, `i = annual/12`, `n = months`.
  Step-up SIP compounds the contribution too.
- **Asset allocation** — the dominant driver of long-run outcome. "110 − age" in
  equity is a starting heuristic, not advice.
- **Goal planning** — inflation-adjust the target first (Indian planning should assume
  ~6 %), then solve for the required monthly contribution.
- **Rebalancing** — annual or ±5 % band. Mechanically sells high and buys low.
- **Tax (India, for context not advice)** — equity LTCG >12 months, STCG <12 months;
  debt funds taxed at slab. Rates change with each Budget, so the platform states
  assumptions and lets the user override rather than hardcoding law.

---

## 12. Cognitive and statistical hazards

Designed against, deliberately:

- **Overfitting** — a strategy tuned to past data. Countered with walk-forward
  testing and out-of-sample calibration.
- **Look-ahead bias** — using data the bar didn't have yet. The single most common
  bug in backtests. Every indicator here is computed causally, and the backtester
  fills on the *next* bar's open.
- **Survivorship bias** — testing today's NIFTY 50 over 10 years ignores everyone
  who fell out. Flagged in backtest warnings.
- **Multiple comparisons** — test 500 strategies and some look brilliant by chance.
- **Confirmation bias** — the reason every signal ships with its invalidation level
  and the factors that argue *against* it, not just for it.
- **Narrative fallacy** — a fluent explanation is not evidence. The AI explanations
  are generated *from* the factor scores, never independently of them, so the story
  can never disagree with the arithmetic.

---

## 13. What this platform does not claim

- No guaranteed profits, no "100 % accurate" signals.
- Probabilities are **calibrated historical frequencies**, not promises. 65 %
  confidence means that in similar past setups the call resolved correctly about
  65 % of the time — and that it will be wrong roughly a third of the time.
- Past performance does not predict future results. Regime changes break every model.
- This is analysis software, not investment advice, and not a substitute for a SEBI
  registered adviser.

---

## References

- Bulkowski, *Encyclopedia of Candlestick Charts* / [thepatternsite.com](https://thepatternsite.com) — measured pattern performance
- Murphy, *Technical Analysis of the Financial Markets*
- Wilder, *New Concepts in Technical Trading Systems* — RSI, ATR, ADX, SAR
- Wyckoff method — effort vs result, accumulation/distribution
- Van Tharp, *Trade Your Way to Financial Freedom* — position sizing, expectancy
- Pardo, *Design, Testing and Optimization of Trading Systems* — walk-forward analysis
- [AMFI](https://www.amfiindia.com/) · [RBI](https://www.rbi.org.in/) · [NSE](https://www.nseindia.com/) · [SEBI](https://www.sebi.gov.in/)
