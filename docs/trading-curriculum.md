# The Complete Trading Curriculum — Zero to Institutional

### A written knowledge base for the AI analysis engine

**How this document is structured.** Ten levels, each building on the last. Every concept follows the same pattern: a plain-language explanation anyone can follow → how it actually works → when to use it and when not to → common mistakes and professional practice → an **AI:** note stating exactly how the engine should encode and use it. Read in order; later levels assume earlier ones. No videos are referenced — everything is explained fully in writing.

---

# LEVEL 0 — ABSOLUTE FOUNDATIONS

## 0.1 What is trading?

Imagine a fruit market. A farmer wants to sell mangoes. A shopper wants to buy them. They agree on a price — say ₹50 — and the mangoes change hands. That agreed price *is* the market price. Trading in financial markets is exactly this, except instead of mangoes people exchange shares of companies (stocks), one country's money for another's (forex), or digital coins (crypto).

A **trader** tries to buy something at one price and sell it later at a better price. Buy at 50, sell at 60: profit of 10. You can also do it backwards in most markets — sell first at 60 (borrowing the item) and buy it back at 50 — that's called **short selling**, and it profits when prices fall.

**Why markets exist:** companies need money to grow (so they sell shares), businesses need foreign currency (so they exchange money), and people want to move value and take risk. Traders provide **liquidity** — they are always willing to buy or sell, which lets everyone else transact instantly.

## 0.2 Why do prices move?

Back to the mango market. If a wedding season starts and everyone wants mangoes, but there are only a few baskets, buyers start offering more: ₹55, ₹60, ₹70. Price rises because **demand exceeds supply**. If a huge harvest arrives and sellers outnumber buyers, sellers accept less and less: ₹45, ₹40. Price falls because **supply exceeds demand**.

That is the entire secret of price movement: **price moves to the level where the number of things people want to buy equals the number people want to sell**. Every pattern, indicator, and strategy in this document is just a different way of guessing where that balance will shift next.

Crucially, price is moved by *transactions*, not opinions. A million people believing a stock should rise changes nothing until someone actually buys aggressively enough to consume the available sell orders.

## 0.3 The order book — how buyers and sellers actually meet

Modern markets are a giant public list called the **order book**:

- **Bids** — orders from people wanting to buy, each saying "I'll buy X amount at price Y or lower."
- **Asks (offers)** — orders from people wanting to sell at price Y or higher.
- The gap between the highest bid and the lowest ask is the **spread**.

Two types of orders interact:

- A **limit order** waits passively in the book ("buy at 100 or better"). It *provides* liquidity.
- A **market order** executes immediately at the best available price. It *takes* liquidity.

**Price moves when market orders eat through one side of the book.** If buyers send market orders faster than sellers add new asks, the asks at 100 get consumed, then 101, then 102 — the price prints upward. This is why *aggression* (market orders) is what moves price, and why later levels study "order flow": watching which side is being aggressive.

A third crucial order type: the **stop order** — a dormant order that becomes a market order when price touches a trigger level. Traders use stops to exit losing positions automatically. Remember this: **clusters of stop orders are pools of guaranteed future market orders**, and Level 4 shows how professionals hunt them.

**AI:** the engine should internally model every market event as "aggressive buying vs. aggressive selling meeting passive liquidity." Features like cumulative volume delta (Level 3) are direct measurements of this.

## 0.4 Market participants — who is on the other side of your trade

1. **Retail traders** — individuals with small size. Predictable behavior: buy breakouts, place stops at obvious levels, chase news, panic at bottoms. Their collective footprints create the liquidity patterns institutions exploit.
2. **Institutions** — mutual funds, pension funds, hedge funds, banks. They trade sizes so large they *cannot* buy in one go without pushing price against themselves, so they must accumulate slowly, in pieces, often disguising intent. Much of "advanced" trading is detecting these footprints.
3. **Market makers** — firms paid (via the spread) to always quote both a bid and an ask. They profit from the spread and hedge inventory. They are not villains "hunting your stops" personally, but their inventory management plus institutional execution *does* produce the sweep behavior described later.
4. **Algorithms/HFT** — machines doing market making, arbitrage, and execution at microsecond speed. They dominate short-term price formation.
5. **Hedgers and commercial players** — airlines hedging fuel, exporters hedging currency. In COT data (Level 5) they are the "commercials."

**Key asymmetry to encode:** retail decides *whether* to trade based on patterns; institutions decide *how* to execute a decision already made for fundamental/flow reasons. The visible chart is largely the execution footprint of the second group interacting with the reactions of the first.

## 0.5 Market psychology — the emotional engine

Prices are set by humans (and machines trained on human behavior), so recurring emotions create recurring patterns:

- **Fear of missing out (FOMO):** after price rises sharply, latecomers buy at any price → final spike → exhaustion. This is why blow-off tops exist.
- **Loss aversion:** losing ₹100 hurts about twice as much as gaining ₹100 feels good. So traders hold losers too long ("it will come back") and cut winners too early. This single bias explains why trends persist: people exit winning positions gradually, and trapped losers provide fuel when they finally capitulate.
- **Anchoring:** people fixate on reference prices — their entry, round numbers, prior highs. This is *why* support/resistance works: thousands of participants have orders and emotions anchored to the same visible prices.
- **Herding:** humans copy the crowd, amplifying trends and creating bubbles and crashes.
- **The market cycle of emotions:** optimism → excitement → euphoria (top) → anxiety → denial → fear → capitulation (bottom) → despair → hope → repeat. Every chart pattern in Level 2 is a snapshot of a stage in this cycle.

**AI:** psychology cannot be measured directly but leaves measurable shadows: volume spikes at extremes (capitulation/euphoria), positioning extremes (crowding), sentiment survey extremes, funding-rate extremes in crypto. Encode these as contrarian-context features: when the crowd's emotion is measurable and extreme, forward returns statistically skew the other way.

---

# LEVEL 1 — READING PRICE

## 1.1 Charts and timeframes

A price chart plots price (vertical) against time (horizontal). A **timeframe** is how much time each unit represents: a 5-minute chart draws one symbol per 5 minutes; a daily chart, one per day.

The same market looks different on different timeframes — a downtrend on the 5-minute can be a tiny pullback inside a daily uptrend. Neither is "the truth"; they are different resolutions of the same order flow. Professionals therefore analyze **top-down**: form the bias on high timeframes (weekly/daily), refine the location on middle ones (4h/1h), and time the entry on low ones (15m/5m). Higher timeframes carry more weight because more money transacted to form each bar.

**AI:** hard-code the hierarchy. A signal's direction must be permitted by the timeframe two steps above its entry timeframe, or be explicitly tagged countertrend and held to a stricter evidence bar.

## 1.2 The candlestick — anatomy

Each candle summarizes all trading in its period with four prices — **O**pen, **H**igh, **L**ow, **C**lose (OHLC):

- The **body** spans open→close. Close above open = bullish (buyers won the period); close below = bearish.
- The **wicks (shadows)** extend to the high and low — prices visited but *rejected*.

The candle is a battle report. A big body with tiny wicks = one side dominated. A tiny body with huge wicks = violent fight, no winner. A long lower wick = sellers pushed down but buyers slammed price back up — rejection of lower prices.

**Where the close sits in the range is the single most informative fact:** close in the top 25% of the candle's range = buyers finished in control regardless of the candle's color.

## 1.3 Candlestick patterns — complete working set

Hundreds are named; below is the full set with real signal content, grouped by function. Two universal laws first:

- **Law 1 — Location over pattern.** A hammer in the middle of nowhere is noise. The same hammer at major daily support after a liquidity sweep is a signal. Patterns are *triggers*, never reasons.
- **Law 2 — Context of size.** Judge every candle relative to recent average range (ATR). A "big" candle is ≥1.5× ATR; patterns built from sub-average candles carry little information.

**Single-candle reversal patterns**

- **Hammer / Pin bar (bullish):** small body at top, lower wick ≥ 2× body. Story: sellers drove price down, buyers aggressively rejected it. Meaning: demand present below. Bearish mirror: **shooting star** — long upper wick, body at bottom.
- **Doji:** open ≈ close, wicks both sides. Story: total indecision. Meaning: after a strong trend, the engine stalled — potential turn; inside a range, meaningless. Variants: **dragonfly** (long lower wick — like a hammer), **gravestone** (long upper wick).
- **Marubozu:** all body, no wicks. Total domination by one side; usually continuation, and the candle itself becomes a support/resistance zone (institutions transacted through its entire range).

**Two-candle patterns**

- **Engulfing:** candle 2's body completely covers candle 1's body in the opposite direction. Story: yesterday's winners were steamrolled today. The most reliable of the classical reversal patterns *at a level*; strengthen the requirement to "closes beyond candle 1's extreme" for higher quality.
- **Tweezer top/bottom:** two candles with matching highs (or lows) — precise double rejection of one price.
- **Harami:** small candle inside the prior big candle's body — momentum pause; weak alone, useful as the "quiet before" a breakout.

**Three-candle patterns**

- **Morning star / evening star:** big trend candle → small indecision candle → big opposite candle closing past the midpoint of candle 1. A full psychological arc: dominance → doubt → reversal.
- **Three white soldiers / three black crows:** three consecutive large same-direction bodies — strong momentum, but *after* an extended move often marks exhaustion rather than continuation (the crowd is all-in).
- **Inside bar (and multi-bar inside clusters):** bar(s) fully within the prior bar's range — compression. Trade the eventual break, but see fake breakouts (Level 4): the first break of compression at an obvious level frequently sweeps before the real move.

**When patterns should NOT be used:** on illiquid assets (wicks are noise), during news candles (the pattern is the news, not psychology), on sub-5-minute charts of thin markets, or standalone without a level.

**Common mistakes:** trading every pattern everywhere; ignoring the trend (a bearish engulfing in a strong uptrend is usually just a pullback starting, not a reversal); using textbook pictures without ATR-relative sizing.

**AI:** implement each pattern as a deterministic detector with ATR-normalized geometry (wick/body ratios, close-position-in-range, size vs. ATR) and *require* a location gate (Section 1.5/3.x) before any pattern contributes to a signal score. Log per-pattern hit rates per market — prune what doesn't verify.

## 1.4 Trend — the market's direction

A **trend** is persistent directional movement. The definition professionals actually use is structural, not indicator-based:

- **Uptrend:** each rally reaches a **Higher High (HH)** and each pullback bottoms at a **Higher Low (HL)**.
- **Downtrend:** **Lower Lows (LL)** and **Lower Highs (LH)**.
- **Range:** highs and lows at roughly the same levels.

Why trends exist (encode these mechanisms, not just the label): (1) information spreads gradually — big investors build positions over weeks; (2) herding — rising prices attract buyers; (3) trapped traders — shorts in an uptrend must eventually buy back, adding fuel; (4) institutional execution takes time.

**The core professional rule:** trade *with* the higher-timeframe trend. Trend-following loses often (many small failed entries in chop) but wins big; fighting trends wins often and loses catastrophically.

**Trendlines** connect successive HLs (up) or LHs (down). They work because they are visible to everyone (anchoring), but treat them as *zones* not exact lines, and beware: the more touches and the more obvious a trendline, the more liquidity (stops) rests just beyond it — prime sweep territory (Level 4).

**AI:** implement trend as a swing-point state machine per timeframe (outputs: direction, bars-since-last-structure-event, and confidence from swing magnitude). Use ADX/efficiency-ratio (Level 2) as a secondary "trend strength" scalar. All strategy routing keys off this state.

## 1.5 Support and Resistance — the market's memory

**Support** is a price area where falling price repeatedly stops and bounces — a floor. **Resistance** is a ceiling. Plain version: it's a price where, last time, lots of people decided to buy (or sell), and many of them — plus new observers — will act there again.

**Why it exists — three real mechanisms:**

1. **Unfinished business:** institutions that bought at 100 and couldn't fill their whole order leave resting bids there; price returning lets them finish.
2. **Regret and anchoring:** traders who missed the bounce at 100 promise themselves "next time"; traders who sold the bottom at 100 want to "get back in where I sold."
3. **Visible reference:** everyone's charts show the same prior highs/lows and round numbers, concentrating orders.

**Professional handling:**

- Draw **zones**, not lines (institutions execute across a range).
- **Fresh levels beat tested levels.** Each touch *consumes* the resting orders that make the level work. First test: strongest. Third or fourth test: the level is thin — breakout becomes likely. (This contradicts the common belief that "more touches = stronger" — more touches make a level more *visible*, but less *loaded*.)
- **Role reversal (flip):** broken resistance becomes support and vice versa, because breakout buyers defend their entries and trapped sellers exit at breakeven there.
- The strongest zones combine origins: a prior swing low + high-volume node + round number + weekly level stacking within one ATR.

**When not to use:** in fresh price discovery (all-time highs — no memory above), and never as an entry reason alone — a level is *location*, the trigger must still fire.

**Common mistakes:** treating levels as exact prices and getting wicked out; buying every touch of support in a downtrend (support in downtrends breaks — that's what a downtrend *is*); drawing so many lines that everything is "a level."

**AI:** auto-generate zones from (a) swing highs/lows with prominence filters, (b) volume-profile HVNs, (c) prior day/week/month extremes, (d) round numbers. Score each zone by: number of independent origins, freshness (touch count), age, timeframe, and ATR-normalized width. Expose `distance_to_nearest_zone_atr` and `zone_score` as core features; require zone proximity for location gates.

---

# LEVEL 2 — TECHNICAL ANALYSIS: INDICATORS AND CHART PATTERNS

An **indicator** is a formula applied to price/volume that highlights one property of market behavior. Master truth: **all indicators are derivatives of price — they lag, and they tell you nothing price hasn't already said.** Their value is *consistency* (perfect for AI features) and *compression* (summarizing state in one number). Professionals use few indicators, each answering a different question; amateurs stack many that all answer the same question and call agreement "confluence."

The four questions and their tools:

## 2.1 "Which way and how strongly?" — Trend indicators

**Moving Averages (MA).** The average close of the last N bars, redrawn each bar — a smoothed version of price. **SMA** weighs all bars equally; **EMA** weighs recent bars more (reacts faster, whipsaws more). Standard settings professionals actually watch (because everyone watches them — self-fulfilling): 9/21 EMA (short-term momentum), 50 SMA (swing trend), 200 SMA/WMA (the institutional bull/bear dividing line).

- **Uses:** trend filter (price above rising 200DMA = long bias only), dynamic support (pullbacks to the 21/50 in strong trends), crossovers (50 over 200 = "golden cross") as *slow regime confirmation*, never as entries.
- **When not:** ranges — MAs whipsaw endlessly sideways. This is the #1 indicator mistake: using a trend tool in a range.
- **AI:** features `close_vs_MA_in_ATR`, MA slope, MA stack order (9>21>50>200 = fully aligned uptrend). Gate trend strategies on alignment.

**MACD.** Difference between the 12- and 26-EMA, plus a 9-EMA "signal line" of that difference, plus a histogram of the gap. It measures *momentum of the trend* — is the trend accelerating or tiring?

- **Uses:** histogram shrinking while price makes new highs = **divergence** (trend running on fumes) — one of the more reliable exhaustion warnings; zero-line side as trend confirmation.
- **When not:** as a mechanical crossover system (backtests poorly nearly everywhere); in ranges.

**ADX** (0–100): trend *strength* regardless of direction. Below ~20: no trend (turn off breakout/trend systems). Above 25–30: trending. **AI:** primary regime feature alongside the efficiency ratio (net change ÷ sum of absolute changes — cleaner and cheaper).

## 2.2 "Is the move stretched?" — Momentum oscillators

**RSI (Relative Strength Index, 0–100).** Compares average up-moves to down-moves over 14 bars. Above 70 = "overbought," below 30 = "oversold" — but here is the professional nuance that beginners miss: **in a strong trend, overbought stays overbought.** RSI pinning above 70 is trend *strength*, not a sell signal. RSI's real uses:

- **Divergence:** price new high, RSI lower high → aggression fading. Strong at HTF levels, meaningless mid-trend.
- **Regime reading:** uptrends hold RSI 40–80; downtrends 20–60. The 40/60 zone bounces reveal the regime.
- **Hidden divergence:** price higher low + RSI lower low in an uptrend = continuation signal (the pullback overshot in momentum terms).
- **When not:** as a mechanical "buy <30" system in trends — this is how beginners catch falling knives.

**Stochastic** (%K/%D): where the close sits within the recent range. Same logic as RSI, faster, noisier; useful mainly for timing within ranges. **Rate of Change / raw N-bar return:** the simplest momentum measure and, for ML features, often better than any oscillator.

**AI:** compute RSI/stoch as features but let the meta-model learn their conditional meaning per regime rather than hard-coding overbought/oversold rules; hard-code only divergence detectors (swing-matched, at zones).

## 2.3 "How wild is the ride?" — Volatility indicators

**ATR (Average True Range).** The average bar range (accounting for gaps) over 14 bars — "how much does this thing move per bar?" This is the most important indicator in the entire document, not for signals but for **normalization**: stops, targets, position sizes, and pattern geometry must all be expressed in ATR units so that logic transfers across BTC, EURUSD, and Reliance alike. Stop = 1.5×ATR beyond structure, not "2%."

**Bollinger Bands.** 20-SMA ± 2 standard deviations. Price touches the bands in normal noise ~5% of the time. Uses: **the squeeze** — bands at multi-month narrowness = energy compression, expansion imminent (direction unknown — pair with structure); **band-walking** — price riding the upper band = strong trend, not "overbought." **When not:** fading every band touch (band touches in trends are continuation, not reversal).

**Keltner Channels** (EMA ± ATR multiples): smoother; the classic "squeeze" definition is Bollinger inside Keltner.

**AI:** ATR percentile vs. its own 1-year distribution is a top-3 regime feature. Squeeze state (binary + duration) gates breakout playbooks.

## 2.4 "Who is participating?" — Volume indicators (preview; full treatment Level 3)

**Volume** = amount transacted per bar — the conviction meter. Rising prices on rising volume = genuine demand; rising prices on fading volume = the move is running out of participants. **OBV** (running sum of volume, added on up-closes, subtracted on down-closes) reveals quiet accumulation when it rises while price is flat. **VWAP** — the volume-weighted average price of the session — is the institutional benchmark: algos execute against it; intraday, price above rising VWAP = buyers in control, and VWAP itself acts as a magnet and dynamic level. Anchored VWAP (from a major low/high/event) extends this to swing horizons.

## 2.5 Chart patterns — crowd psychology in shapes

Chart patterns are multi-week/bar structures. Each is a story about trapped traders and shifting control; the story matters because it tells you *where the fuel (stops) is*.

**Continuation patterns** (pause, then trend resumes):

- **Flag/pennant:** sharp move (the pole) then tight drift against it. Story: profit-taking absorbed by new buyers. Highest-quality version: tight, low-volume flag after a high-volume pole; breakout on volume ≥1.5× average. Target: pole height projected. Failure tell: volume *rising* inside the flag (distribution, not rest).
- **Ascending triangle:** flat resistance + rising lows — buyers escalating against a fixed sell wall. Break of the flat side is the trade; the "flat side breaks" rule holds for descending triangles downward.
- **Symmetrical triangle / coil:** both sides converge — pure compression; trade the break with trend bias.
- **Cup and handle:** rounded base, small pullback (handle) below the rim, breakout. The handle's job is shaking out early buyers — a mini liquidity sweep before the move.

**Reversal patterns:**

- **Head and shoulders:** high (shoulder), higher high (head), lower high (shoulder) — the definitional end of "higher highs." The trade is not the pattern but the **neckline break and retest**; target = head-to-neckline distance. Inverse for bottoms. Most powerful when the right shoulder shows collapsing volume.
- **Double top/bottom:** two failures at one price. Critical nuance: the *clean* textbook double top (exact equal highs) is often actually a liquidity pool — the second touch frequently *exceeds* the first slightly (sweep) before reversing. The engine should treat "equal highs" as a magnet first and a reversal only after the sweep-and-reclaim.
- **Rounding bottom / base:** months of quiet accumulation — the Wyckoff structure of Level 3.

**Universal pattern rules:** patterns need a preceding trend (a "reversal" needs something to reverse); measure targets as projections but treat them as zones; **volume must confirm the breakout** or assume it's false; pattern failure signals are trades in themselves (a failed breakdown from a head-and-shoulders is a violent long).

**When patterns should not be used:** low-liquidity assets, sub-15m timeframes in thin markets, and mechanically without volume/structure context. **Mistake:** seeing patterns everywhere (apophenia) — require strict geometric definitions.

**AI:** encode patterns as geometric detectors (pivot-based, ATR-normalized, with volume conditions built in). More valuable than trading patterns directly: use pattern state as *context features* for the meta-model, and use pattern *boundaries* as liquidity/stop-cluster maps.

## 2.6 Multi-timeframe analysis — putting Level 1–2 together

The professional lens: **HTF = bias, MTF = location, LTF = trigger.** Weekly/daily structure decides direction; 4h/1h finds the zone; 15m/5m provides the entry pattern with a tight stop. The entire edge of this approach is *stop efficiency*: entering a daily-level idea with a 15-minute trigger shrinks the stop distance several-fold, multiplying reward:risk for the identical thesis.

**AI:** every published signal must carry a three-slot context vector (HTF trend state, MTF zone score, LTF trigger quality) — this triple is also among the strongest feature groups for the meta-model.

---

# LEVEL 3 — PRICE ACTION, MARKET STRUCTURE, VOLUME & REGIMES

## 3.1 Pure price action — reading the tape without indicators

Price action is the discipline of inferring intent from price and volume alone. Its foundation is a small set of questions asked of every swing:

1. **Impulse or correction?** Impulses are fast, large-bodied, one-directional legs — *initiative* activity (someone needs to be filled NOW). Corrections are slow, overlapping, small-bodied — *responsive* repositioning. Trends are impulse-correction-impulse chains, and the direction of the impulses IS the trend, regardless of what an MA says.
2. **Acceptance or rejection?** When price enters a new area, does it *stay* (bars closing and building there = acceptance = the move is real) or does it *wick and leave* (rejection = the level held)? Breakouts are proven not by the break but by acceptance above the broken level.
3. **Compression or expansion?** Markets alternate between quiet balance (range, coil) and violent imbalance (trend leg). Compression tells you *when* something will happen; structure and flow tell you *which way*.

## 3.2 Market structure — the formal grammar

- A **swing high** is a bar whose high exceeds N bars on both sides (use fractal or zigzag-with-ATR-threshold definitions to avoid noise).
- **Break of Structure (BOS):** price closes beyond the most recent swing extreme *in the trend direction* — trend continuation confirmed.
- **Change of Character (CHoCH):** price closes beyond the most recent swing extreme *against* the prevailing trend — the first objective evidence a trend may be ending. A CHoCH is a warning; a CHoCH followed by a failed attempt to resume the old trend (lower high after bullish-trend CHoCH) is a reversal in progress.
- **Dealing range:** the span between the last significant swing high and low. Its midpoint (50%, "equilibrium") divides **premium** (upper half — expensive; where professionals prefer to sell) from **discount** (lower half — cheap; where they prefer to buy). This formalizes "buy low, sell high" into a computable gate: in an uptrend, only buy in discount of the current dealing range.
- **Internal vs. external structure:** the small swings inside a correction (internal) vs. the trend's main swings (external). Countless bad signals come from treating internal noise as external structure — enforce a minimum swing size (e.g., ≥1.5 ATR prominence) for external swings.

**AI:** the structure state machine per timeframe (trend direction, last BOS/CHoCH type and age, dealing-range position 0–1) is the backbone of the entire engine — nearly every playbook conditions on it.

## 3.3 Volume analysis in full — effort versus result

The master principle (Wyckoff's third law): compare the **effort** (volume) with the **result** (price progress).

- Big effort, big result → healthy, trend continues.
- **Big effort, no result → absorption.** Enormous volume but price barely moves: someone large is passively taking everything the aggressors throw. At a high after a long rally = distribution (smart money selling into euphoria). At a low after a decline = accumulation. This is the single most reliable "institutions are here" tell available from public data.
- Small effort, big result → a vacuum move through thin liquidity; easily reversed (moves on air retrace).
- **Climax:** extreme-volume, extreme-range bar after an extended move — the crowd's final capitulation/euphoria. Marks the *zone* of a turn (often needs a retest, not a V).
- **Volume dry-up:** in bases, sellers simply running out — the quietest bars near support in a long base are constructive.

**Volume profile.** Instead of volume-per-time, volume-per-price: a histogram showing how much traded at each price. Key objects: **POC** (point of control — the highest-volume price, the market's "fairest" price and a magnet), **Value Area** (the 70% band — inside it expect rotation/chop; outside it expect either quick rejection back in or trend initiation), **HVNs** (high-volume nodes — acceptance zones that act as support/resistance), **LVNs** (low-volume nodes — rejection zones price crosses fast; they make excellent stop placement anchors because acceptance inside an LVN is abnormal).

**Cumulative Volume Delta (CVD).** Per bar, classify each trade as buyer-initiated (at ask) or seller-initiated (at bid); delta = buy volume − sell volume; CVD is the running sum — the purest public measure of aggression. The killer application is **delta divergence**: price makes a new low but CVD makes a higher low → sellers' aggression is drying up or being absorbed → reversal fuel. Conversely, strong positive delta with *no upward price progress* = sell-side absorption ceiling.

**Caveats:** FX spot has no true volume (use futures volume or tick-count proxy); crypto volume must come from a credible exchange subset (fake volume is rampant on small venues); options/expiry days distort stock volume.

**AI:** implement relative volume, absorption score, climax detector, dry-up detector, profile objects (POC/VA/HVN/LVN distances), and CVD slope + divergence flags. Volume features consistently rank near the top of importance in meta-models — prioritize their data quality.

## 3.4 Wyckoff — the institutional campaign template

Richard Wyckoff (1910s) formalized how large operators build and unload positions; the schematic still matches modern accumulation strikingly well because the constraint (size must be acquired without moving price) hasn't changed.

**Accumulation schematic:** Preliminary Support (first big buying into the decline) → **Selling Climax** (capitulation, huge volume) → Automatic Rally (bounce defines range top) → Secondary Test(s) (retests of the low on *less* volume — sellers exhausting) → **Spring** (the crucial event: a final undercut of the range low that triggers all remaining stops, on a spike of volume, immediately reclaimed — the operator's last cheap fill AND the removal of overhead sellers) → Sign of Strength (wide, high-volume rally through the range midpoint) → Last Point of Support (quiet pullback to the breakout zone) → markup (the trend everyone else finally sees). **Distribution** mirrors this at tops with the **Upthrust** (false break above the range) as the spring's twin.

Notice: the Spring *is* the "liquidity sweep" of Level 4 — Wyckoff described stop hunts a century before SMC renamed them. Multiple frameworks converging on one phenomenon is evidence the phenomenon is real.

**AI:** encode Wyckoff as a phase classifier over long ranges (range detection → event sequence matching on volume signature) feeding the position-trading playbooks; the spring/upthrust detector is shared with the sweep detector.

## 3.5 Volatility analysis and market regimes

A **regime** is the market's prevailing personality. Strategies are not good or bad — they are *matched or mismatched to regime*. The four-quadrant model the engine should classify continuously:

| | Low volatility | High volatility |
|---|---|---|
| **Trending** | Smooth trend: pullback buying, trend-following shine | Momentum/crash regime: breakouts run, mean reversion is lethal |
| **Ranging** | Quiet chop: fade edges, sell premium, breakout systems bleed | Violent chop: most strategies lose; reduce size or stand aside |

Measurements: realized volatility (Garman-Klass or Parkinson estimators use OHLC and beat close-to-close), ATR percentile vs. trailing year, ADX/efficiency ratio for trendiness, plus a hidden-Markov or clustering model over these to output a discrete regime label with probabilities. Two structural facts to hard-code: **volatility clusters** (today's vol predicts tomorrow's — forecast vol, size positions inversely to it) and **volatility mean-reverts over weeks** (extremes fade), while **compression precedes expansion** (squeeze duration is a countdown, not a state to fade).

**Correlation analysis.** Assets move in groups: BTC drags altcoins (dominance regime), DXY inversely drives EURUSD/gold/often BTC, sectors move with their index, AUD tracks commodities. Portfolio implication: three long positions with 0.9 pairwise correlation are one position at 3× size. Regime implication: **correlations spike toward 1 in crises** — diversification vanishes exactly when needed; stress-test with crisis correlations, not calm ones. Signal implication: divergence inside a tight correlation pair (ETH making higher lows while BTC makes lower lows) flags relative strength — buy the strong one on the next group-wide dip.

**AI:** rolling correlation matrices per market feed (a) portfolio heat clustering, (b) relative-strength features, (c) a "correlation breakdown" anomaly flag that suppresses signals during structural shifts.

---

# LEVEL 4 — ORDER FLOW, LIQUIDITY, SMART MONEY & MANIPULATION

## 4.1 Liquidity — the professional's map

Redefinition that changes everything: to a large trader, **liquidity is the ability to fill size without moving price**, and the richest source of fillable size is *other people's resting orders* — especially **stop orders**, because stops execute as market orders at any price (perfect counterparties).

Where stops predictably cluster (memorize; this is the map): just beyond swing highs/lows, beyond **equal highs/lows** (double tops/bottoms — the most obvious pools), beyond trendlines, beyond round numbers, beyond session and prior-day extremes, and at liquidation prices of leveraged crypto positions (computable from OI and leverage — liquidation heatmaps literally chart this).

**The core mechanic — the liquidity sweep (stop hunt):** an uptrending market pauses; equal lows form; every textbook says "support." Below those lows sit (a) sell-stops of longs and (b) breakout sell orders. Price is *pushed* below the lows → both groups sell → a burst of sell-side liquidity appears → the institution that needs to BUY size fills into exactly that selling → price snaps back above the level, leaving a wick. The trapped breakout sellers now fuel the rally as they cover. **The sweep is not price failing at support — it is the reason the level existed.** Distinguishing sweep from genuine breakdown: reclaim speed (within 1–3 bars), close back inside, volume spike with delta flip, and no acceptance below.

This one mechanic explains: fake breakouts, why obvious levels "fail" then reverse, Wyckoff springs, "double tops" that overshoot slightly, London's Judas swing, and crypto's liquidation cascades. It is the highest-value pattern in this entire curriculum.

## 4.2 Fake breakouts — full taxonomy

A breakout fails for one of three reasons; the engine should classify which:

1. **Engineered sweep** (above): deliberate liquidity harvest. Tells: obvious level, sub-average breakout volume or huge-volume-instant-reversal, immediate reclaim.
2. **Absorption failure:** the breakout was genuine retail enthusiasm but a large passive seller sat above the level and absorbed everything. Tells: high volume, zero progress, delta positive but price flat, then rollover.
3. **Exhaustion break:** the trend's last gasp — breakout occurs but the move preceding it already consumed all demand. Tells: breakout after an extended run, on climax volume, with momentum divergence.

Confirmation rules that filter most fakes: require a *close* beyond the level (not a wick), then **acceptance** (1–3 bars building beyond it) or a successful retest; require breakout volume ≥1.5× average; distrust breakouts of levels tested 3+ times *less* than fresh-level breaks in the direction of HTF trend; distrust any breakout during dead sessions (Asian lunch, weekend crypto).

## 4.3 Smart Money Concepts (SMC) and ICT — complete written glossary

SMC/ICT is a retail-popularized framework whose vocabulary maps the institutional mechanics above onto chart objects. Taught here fully, followed by an honest evaluation.

- **Order block (OB):** the last opposite-direction candle (or cluster) immediately before a displacement that broke structure. Theory: that candle is where the institution filled the position that caused the move; unfilled interest remains, so a return to the OB finds defense. Refinements: valid only if the OB's move actually broke structure and swept liquidity first; the OB's 50% ("mean threshold") is the preferred touch; an OB that fails becomes a **breaker block** — support/resistance flipped with trapped traders at its origin.
- **Fair value gap (FVG) / imbalance:** a three-candle sequence where candle 1's high and candle 3's low don't overlap (bullish case) — price moved so fast that one side never transacted. Theory: markets "rebalance" by revisiting these gaps, which act as magnets and then reaction zones. The gap's midpoint ("consequent encroachment") is the reference. Stacked FVG + OB = higher-quality zone.
- **Displacement:** an impulsive, large-bodied, structure-breaking leg — the footprint of urgent institutional execution. Without displacement, OBs and FVGs are noise; displacement is the *validity stamp*.
- **Inducement:** a minor, obvious pool of liquidity engineered *in front of* the real zone, so early traders enter, place stops, and get swept into the true level. Practically: expect the shallow obvious pullback level to break before the deep zone fills.
- **Premium/discount & OTE:** as in 3.2; ICT's "optimal trade entry" is the 61.8–79% retracement band of the displacement leg — deep enough to be discount, shallow enough to hold.
- **Kill zones:** windows when institutional flow concentrates — London open (~02:00–05:00 ET), New York open (~07:00–10:00 ET), London close (~10:00–12:00 ET). Setups inside kill zones carry more weight; the same pattern at 3 a.m. ET Sunday carries almost none.
- **Power of Three (AMD):** each session/day tends to unfold as Accumulation (quiet range) → **Manipulation** (the Judas swing — a false move that sweeps one side, often at session open) → Distribution (the true directional leg). Practical use: the first move after a major open is *suspect*; the reversal after the sweep is the trade.
- **Market maker buy/sell models, liquidity voids, mitigation blocks, balanced price ranges** — additional vocabulary for the same core objects (engineered sweep → displacement → retrace → continuation).

**Honest professional evaluation (encode this attitude):** the *phenomena* are real — stop clustering, sweeps, session manipulation patterns, and fast-move retracements are measurable and exploited by actual institutions (they'd exist even if no institution "intended" them, purely from liquidity physics). The *narrative* is unfalsifiable ("smart money intended X") and the framework's popularity means the most textbook-obvious SMC setups now themselves attract crowded retail entries with predictable stops — which get swept. Rules for the engine: implement every SMC object as a precise geometric detector; validate each detector's edge on your own data per market per timeframe; weight what verifies; and prefer setups where the SMC read *agrees with* volume/delta evidence (absorption at the OB, delta flip on the sweep) over pure geometry.

## 4.4 Manipulation beyond sweeps — recognition catalog

- **Spoofing/layering:** large fake resting orders creating an illusion of pressure, canceled before execution (illegal in regulated markets, still routine in crypto). Book-data tell: quotes that persistently retreat as price approaches.
- **Momentum ignition:** a burst of aggressive orders designed to trigger other algos' momentum entries and stops, then reversed into.
- **Marking the close / painting the tape:** pushing price in the final minutes (benchmark manipulation) or wash-trading volume to feign activity (endemic on small crypto venues — filter volume sources).
- **Pump and dump:** coordinated social hype + thin float. Signature: social-volume spike *preceding* price/volume spike, concentrated holders, vertical low-float rally. The engine must blacklist, never trade, these — the exit is unmodelable.
- **Front-running patterns around known flows:** index-rebalance and option-expiry flows are public knowledge; price often moves *before* scheduled mechanical flows and reverses after.

**AI:** each of the above is an anomaly detector whose firing *suppresses or inverts* signals: sweep detector (entry logic), spoof/wash-volume detectors (data-quality veto), pump detector (asset blacklist), event-flow calendar (timing veto).

## 4.5 Institutional execution — what the footprints look like

Institutions split parent orders into thousands of child orders via execution algorithms: **VWAP/TWAP** algos (steady participation across the day — footprint: persistent one-sided delta, price grinding with shallow pullbacks that never reach obvious levels), **implementation-shortfall/POV** algos (participation scales with volume — footprint: every dip gets bought within minutes, relative strength vs. peers), and **iceberg orders** (only a sliver of true size displayed — footprint: the same price level absorbing volume many times its displayed size while price stalls). Add **dark pools** (off-exchange venues, ~30–40% of US equity volume; block prints at stable prices = accumulation) and the options market (dealers hedging large positions create gamma flows that pin or accelerate price — high dealer gamma dampens moves, negative gamma amplifies them, which is why expiry weeks behave differently).

**AI:** the practical distillation — an "institutional participation score" per asset per day combining: absorption events, persistent delta bias, relative strength vs. correlated peers, shallow-pullback trend character, dark-pool/block share (stocks), whale netflow (crypto), and OI-weighted positioning shifts. High scores upgrade continuation setups and downgrade fade setups.

---

# LEVEL 5 — FUNDAMENTALS, MACRO, NEWS & MARKET-SPECIFIC ANALYSIS

## 5.1 Fundamental analysis (stocks) — from zero

A share is a slice of a real business. Its long-run price gravitates toward the business's value even while short-run price is pure supply/demand psychology. Benjamin Graham's line captures it: in the short run the market is a voting machine (popularity), in the long run a weighing machine (substance).

**The three statements, in plain words:**

- **Income statement:** what the company earned and spent this period. Revenue (sales) → subtract costs → **net profit**. Per-share profit = **EPS**.
- **Balance sheet:** what it owns (assets) vs. owes (liabilities) right now. Owns minus owes = equity.
- **Cash flow statement:** actual cash in/out — the honesty check, because accounting profit can be manufactured but cash is hard to fake. **Free cash flow (FCF)** = operating cash flow − capital spending = the money truly available to owners. Professionals trust FCF over EPS.

**Valuation — "is the price fair?":** **P/E** (price ÷ earnings — years of profit you're paying for; meaningful only vs. the company's own history, its sector, and its growth rate — hence **PEG** = P/E ÷ growth), **EV/EBITDA** (capital-structure-neutral), **P/B** (for banks/asset businesses), **DCF** (project future cash flows, discount to today — theoretically pure, extremely assumption-sensitive; use for ranges, not precision). **Quality metrics that predict durability:** ROIC/ROE (profit per unit of capital — the compounding engine; >15% sustained = strong business), margin trends, debt/EBITDA (<2 comfortable), share count trend (shrinking = buybacks working for you; growing = dilution working against you), plus screens like the Piotroski F-score (9 binary health checks) and Altman Z (bankruptcy risk).

**Earnings events:** every quarter, results vs. analyst **estimates**. Price reacts to the *surprise* and above all to **guidance** (the future), not the reported past — a "beat" with cut guidance falls. The **post-earnings-announcement drift** (Level 6/knowledge-base §3.6) is the tradeable consequence: big genuine surprises are under-reacted to and drift for weeks.

**When fundamentals should NOT drive decisions:** intraday/swing timing (fundamentals set multi-month gravity, not this week's path), and never fight a collapsing chart because the "valuation is cheap" — cheap can get cheaper (value traps: falling knife + low P/E = usually a dying business, not a bargain).

**AI:** fundamentals must be **point-in-time** (as originally reported, with report dates — restated databases leak the future). Encode as cross-sectional ranks (percentile vs. sector) rather than raw values; combine a quality composite + valuation composite + revision-momentum composite for the long-term module, and expose only *event-relative* fundamental features (surprise magnitude, guidance direction, revision trend) to swing playbooks.

## 5.2 Macroeconomics and forex analysis — from zero

A currency's price is the price of one economy's money in another's. Money flows toward higher *risk-adjusted return*, and the single biggest driver is the **interest rate** each central bank sets: higher rates → holding that currency pays more → capital inflow → currency strengthens. Therefore forex fundamentals reduce to one comparative question: **which of the two central banks will be relatively tighter, and is that already priced in?**

**Central banks in plain words:** each country's "bank of banks" (Fed, ECB, BoJ, BoE, RBI) sets the base interest rate to steer inflation and employment. Raising rates = fighting inflation = usually currency-positive; cutting = stimulating = currency-negative. Markets move less on the decision (usually pre-priced via futures like the CME FedWatch probabilities) than on **guidance** — the statement's tone about *future* policy. "Hawkish" = leaning toward higher rates; "dovish" = toward lower.

**The economic calendar — what each release means:**

- **CPI (inflation):** the prices ordinary people pay. Hot CPI → expect higher rates → currency up, stocks/gold usually down. The market trades the *surprise vs. forecast*, never the absolute number.
- **NFP (US jobs, first Friday monthly):** strong jobs → economy hot → hawkish pressure. The most violent scheduled FX event.
- **GDP, PMI, retail sales:** growth pulse; PMIs (>50 = expansion) lead GDP.
- **Rate decisions & minutes:** the main event; volatility clusters in the press conference, not the statement.
- Release mechanics the engine must respect: liquidity is *pulled* 1–5 minutes before high-impact releases (spreads widen 5–20×), the first spike frequently reverses fully (algorithmic overreaction + stop cascade), and the "true" post-news direction usually establishes 15–60 minutes later. Rule: **no signals from T−15min to T+15min around high-impact events**, and flag the daily bias only after the post-news dust settles.

**Other forex-specific machinery:** **interest-rate differentials and carry** (long the high-yield currency vs. the low-yield one earns the spread daily — profitable in calm risk-on regimes, catastrophic in risk-off unwinds — regime-gate it), **bond yields as the real-time signal** (the 2-year yield spread between two countries leads their currency pair), **COT positioning** (weekly CFTC report of futures positioning; non-commercial extremes at 3-year percentiles are contrarian context), **DXY as the anchor** (everything trades against the dollar's tide), **risk-on/risk-off regime** (in fear: JPY/CHF/USD strengthen, AUD/NZD/EM weaken — a one-feature regime classifier), and **session structure** (Level 4's kill zones; Asia ranges ~70% of days, London sets the day's extreme early more often than chance).

**AI:** encode a two-economy comparison vector per pair (rate differential + its momentum, surprise indices, policy-tone score from statement NLP), the event calendar as veto windows + gap-risk flags, COT percentiles as slow contrarian features, and risk-regime as a global gate.

## 5.3 Crypto-specific analysis — from zero

A cryptocurrency is a digital asset on a public ledger (blockchain) no single party controls. Two properties change the analysis completely versus stocks: (1) **every transaction is publicly visible forever** — enabling on-chain analysis, an X-ray no other market has; and (2) **the market is young, retail-heavy, 24/7, and dominated by leveraged derivatives** — making the Level-4 liquidity mechanics not occasional but *the primary driver* of short-term price.

**On-chain metrics, each explained:**

- **Realized price/cap:** value every coin at the price it *last moved* — the market's aggregate cost basis. Price below realized price = average holder underwater = historical bear-market floors.
- **MVRV z-score:** (market cap − realized cap) standardized — how far price sits above/below aggregate cost basis. Extreme low (<0.5) has marked every cycle bottom zone; extreme high (>6) every top zone. The premier cycle-position instrument.
- **SOPR:** the average profit/loss ratio of coins moving today. >1 = sellers in profit; the reset to exactly 1 in bull markets (holders refusing to sell at breakeven) marks pullback floors.
- **Exchange netflows/reserves:** coins flowing *to* exchanges = sell preparation; sustained outflows to self-custody = holding conviction. Multi-month reserve decline is structurally bullish supply behavior.
- **Active addresses, new addresses, transfer volume:** network usage — the "revenue" of a blockchain; divergence between price up / usage down flags speculative-only rallies.
- **Whale wallets & cohort analysis (HODL waves):** what the largest and oldest holders are doing; old coins waking up and moving after years = historically distribution near tops.
- **Miner/validator flows:** miners are structural sellers; miner reserve spikes to exchanges pressure price.

**Derivatives layer (dominates intraday–swing):** **funding rate** (perpetual futures' periodic payment keeping perp ≈ spot; persistently high positive funding = crowded leveraged longs = flush fuel — the mean-reversion stat from the knowledge base), **open interest** (money in the game; the four price×OI combinations diagnose whether moves are new positioning or forced covering), **liquidation cascades** (leveraged positions force-closed → their closure is a market order → pushes price → liquidates the next tier → chain reaction; liquidation heatmaps map these fuel depots and price demonstrably gravitates to dense clusters), and **perp-spot basis** (froth gauge).

**Structural calendar:** token unlock schedules (vesting cliffs = scheduled supply hits — public, dated, and reliably front-run), halvings/cycle seasonality, BTC-dominance regime (alt seasons begin when dominance breaks down while BTC ranges).

**AI:** on-chain feeds the position/long-term modules (daily granularity, slow signals — never intraday); derivatives feed intraday/swing (funding z-scores, OI change, liquidation-cluster distance as first-class features); unlock calendar = per-asset veto/short-bias windows; and volume credibility filters (trusted-exchange whitelist) guard all crypto data.

## 5.4 News and sentiment analysis — from zero

News moves markets only through **surprise relative to expectations**, and its effect is conditioned by positioning: bullish news into a market already maximally long produces selling ("buy the rumor, sell the news") because everyone who could buy already did — the news' only function was providing exit liquidity. This positioning-conditioned reading is the professional skill.

**Sentiment instruments:** Fear & Greed indices, put/call ratios, AAII surveys, funding rates (crypto's purest sentiment gauge), social volume and tone (finance-tuned NLP like FinBERT-class models — general sentiment models fail on finance: "beats estimates" and "crushed" are positive), and Google-trends-style attention. Usage rule: sentiment is a **contrarian context feature at extremes** and near-noise mid-range; sentiment *divergence* (price new high, social mood deteriorating) outperforms sentiment *level*.

**AI pipeline:** ingest headlines → dedupe → entity-tag → score (direction, magnitude, novelty vs. prior stories, source credibility) → decay each score by a half-life (minutes for intraday, days for swing) → expose as features; separately maintain the scheduled-event calendar as hard veto windows. Let an LLM structure text into fields (guidance direction, surprise size, risk mentions from earnings calls); never let it pick trades.

## 5.5 Stock-market-specific microstructure

Auctions open and close each session (opening/closing auctions concentrate huge volume; the open sets the day's initial imbalance, month-end closes carry rebalancing flows), gaps exist because news lands while the market sleeps (small no-news gaps statistically fill same-day; large earnings gaps drift instead — classify before trading), short interest creates squeeze fuel (high days-to-cover + rising price = shorts trapped), index inclusion/rebalance creates scheduled mechanical flows, insider transactions (buying is a strong signal — insiders sell for many reasons but buy for one; cluster buys > lone buys), 13F/FII-DII flows show the big money's net direction (India's daily FII/DII feed is unusually timely institutional data), and options expiry gamma effects (Level 4.5) modulate whole-index behavior in expiry weeks.

---

# LEVEL 6 — THE FOUR TRADING STYLES AS COMPLETE WORKFLOWS

Each style below is written as the full professional day/process, so the engine can mirror the *sequence of reasoning*, not just the rules. (Setup specifics live in the companion knowledge-base document §3.)

## 6.1 Intraday — the complete process

**Pre-session** (before any signal): check the economic calendar (mark veto windows), note overnight/prior-day high, low, close, VWAP, and overnight inventory (did overnight trade above or below yesterday's value?), compute opening-gap classification, list the 2–4 liquidity pools flanking price, check the volatility regime (is today's expected range worth trading at all — ATR percentile < 20 = stand down), and for stocks scan for catalysts (gap + volume + news = the day's tradeable names; no catalyst = no edge intraday).

**Session play:** let the opening range form (first 15–30m); the day then usually resolves into one of three **day-types** the engine should classify live — **trend day** (open drives one way, shallow pullbacks, closes near extreme — pullback-buy all day, never fade; tells: gap-and-go with acceptance, one-sided delta, breadth extreme), **range/rotation day** (open rejected back into yesterday's value — fade the edges at VWAP bands/value area; tells: overlapping bars, delta flipping), or **sweep-reversal day** (the open runs one side's stops then reverses through the whole range — the AMD/Judas template; tells: sweep signature at a session extreme in a kill zone). Misclassifying the day-type is the main intraday failure; fading a trend day destroys accounts.

**Per-trade:** location at a pool/level → flow confirmation (delta, absorption) → trigger candle → structural stop → first target at the next pool → manage by structure (trail behind 5m swings), flat before major news, flat by session end. Hard truths to encode: costs decide everything at this frequency (model spread+slippage per asset per hour); most of the day has no edge (2–4 quality windows); overtrading is the retail killer — cap signals/day.

## 6.2 Swing — the complete process

**Weekend/daily routine:** top-down scan — weekly structure state per asset → daily structure and dealing-range position → build a watchlist of assets *approaching* (not at) HTF zones with trend alignment → check the week's catalysts (earnings dates, CPI/FOMC, unlocks) and tag gap-risk → for stocks add relative-strength ranking (trade the strongest names in the strongest sectors on pullbacks); for crypto add funding/OI state; for FX add COT and rate-differential direction.

**Trigger and hold:** alerts at zones, not staring at screens; when a zone is tagged, drop to 4h/1h for the trigger (sweep-reclaim, CHoCH, engulfing at the zone) with volume/delta agreement; stop beyond the zone; targets at opposing HTF liquidity, minimum 1:2. Management: the swing trader's edge is *doing less* — no micro-managing on the 5m; move stop only after a new daily structure point forms; scale ½ at 1R–2R; predefine the event plan (hold through earnings only with house-money cushion; never full size through binary events). Failure modes: entering at the zone without a trigger ("catching knives at support"), stops exactly at the obvious level (inside the sweep radius — place beyond sweep distance ≈ 0.5–1 ATR past the extreme), and revenge-shortening timeframes after a loss.

## 6.3 Position trading — the complete process

Monthly/weekly cadence. **Thesis first:** a macro/fundamental reason the asset should trend for months (rate-cycle turn, earnings inflection, halving-cycle position, structural flow) → **regime check:** does the macro quadrant permit it → **technical confirmation:** weekly base breakout, 200DMA reclaim, Wyckoff phase → **entry program:** staged entries (⅓ on signal, ⅓ on retest, ⅓ on trend confirmation), wide structural stops (weekly invalidation), small unit size to accommodate them → **pyramiding:** add only to winners at fresh structure points, never average losers → **exit:** thesis invalidation (the fundamental reason dies) or weekly CHoCH — whichever first. The psychological battle is sitting through 10–15% pullbacks without acting; the engine equivalent is *not generating exit signals off sub-weekly noise* for position-tagged trades.

## 6.4 Long-term investing — the complete process

Quarterly cadence. Universe screening (quality metrics §5.1) → valuation ranking → portfolio construction under allocation policy (position caps, sector caps, factor balance) → staged accumulation at technical zones (DCA with a levels overlay — technicals as entry smoothing, nothing more) → monitoring = thesis dashboards (margins, revisions, dilution, governance flags), not price alerts → rebalancing bands → sell only on thesis break or extreme overvaluation. Crypto long-term: the cycle framework (MVRV/realized-price bands) governs staged accumulation/distribution schedules. The engine's role here is **monitoring and alerting, not signal generation** — mislabeling this module as a signal product misleads users.

---

# LEVEL 7 — RISK, POSITION SIZING & PORTFOLIO MANAGEMENT

## 7.1 Why risk management outranks entries

The uncomfortable arithmetic every professional internalizes: a −50% loss requires +100% to recover; −80% requires +400%. Losses compound against you asymmetrically, so the first objective is never "maximize wins" but "make ruin impossible." A mediocre entry system with excellent risk management survives and compounds; a brilliant entry system with poor risk management eventually hits the losing streak that ends it. **Streak math** makes this concrete: a 55%-win strategy will, over 1,000 trades, almost certainly encounter 7–9 consecutive losses. At 1% risk per trade that's a −8% drawdown (routine); at 10% risk it's account death. Risk per trade must be set for the *worst plausible streak*, not the average trade.

## 7.2 Position sizing — the complete toolkit

- **Fixed-fractional (the default):** risk a constant fraction (0.5–1%) of current equity per trade. Size = (equity × r) ÷ (entry − stop distance, in money terms). Self-adjusting: size shrinks in drawdowns, grows in expansion.
- **Volatility targeting:** size positions so each contributes equal volatility (size ∝ 1/ATR or 1/σ). This equalizes real risk across BTC and a utility stock, and portfolio-level vol targeting (aim total portfolio at e.g. 12% annualized vol, scale everything to it) is the institutional standard.
- **Kelly criterion:** the mathematically growth-optimal fraction = W − (1−W)/R (W = win rate, R = win/loss ratio). Full Kelly is violently volatile and fatally sensitive to estimation error (your W and R are *estimates*). Professionals use quarter-to-half Kelly as a ceiling sanity check, not a sizing engine.
- **Heat and clustering:** cap total simultaneous open risk (4–6% of equity) and treat correlated positions (>0.7) as one cluster sharing one risk budget.
- **Drawdown governor (automate it):** −5% from equity peak → halve unit risk; −10% → new signals halted, review mode. This converts the psychological discipline pros struggle for into code.

**Stops in full:** a stop's location is *the invalidation of the trade's reason* — beyond the sweep wick, beyond the zone, beyond the structure point — then position size is derived from that distance, never the reverse (sizing first and placing the stop "where the loss feels okay" is the universal amateur inversion). Add sweep-radius padding (0.5–1× ATR beyond the obvious extreme). Trail by structure (behind each new confirmed swing), not by fixed points. Breakeven moves only after a new structure point confirms — moving to breakeven instantly is statistically just voluntary stop-hunting of yourself.

**Targets & trade management:** first target at the next opposing liquidity pool; standard professional shape = scale ⅓–½ at 1R–2R, trail the rest ("pay yourself, let the tail run") — it sacrifices some expectancy for a massive reduction in outcome variance and psychological error. **Time stops** matter too: a thesis that hasn't begun working within its expected horizon (e.g., a sweep-reversal that goes nowhere for 2× the usual bars) is exited — dead trades tie up risk budget and usually resolve badly.

## 7.3 Portfolio management

**Expectancy** is the number that unifies everything: E = W×avgWin − (1−W)×avgLoss − costs, in R-multiples. Track E per playbook per market; allocate risk budget toward the highest-E, lowest-correlation playbooks (this is portfolio management *of strategies*, the institutional layer above managing positions). Diversify across strategy types (trend + mean-reversion + event) and horizons, because their losing regimes differ — the combined equity curve smooths even when components are individually rough. Respect crisis correlation (Level 3.5): stress-test heat rules under "all correlations → 0.9". Rebalance mechanically, and treat leverage as a vol-targeting output, never a conviction expression.

---

# LEVEL 8 — STRATEGY DEVELOPMENT, BACKTESTING & VALIDATION

## 8.1 From idea to hypothesis

A strategy is a **falsifiable claim**: "after condition X, price does Y more often than chance, by enough to beat costs." Every vague belief must be forced through that sentence. Good sources of X: a **mechanism** (trapped traders after sweeps must cover; scheduled unlock supply; PEAD under-reaction) beats a **shape** (a pattern with no story), because mechanisms survive regime change and shapes are often coincidences. Each hypothesis gets: precise entry/exit definitions (no discretion words like "strong" without a formula), the market/timeframe domain, and the reason it should exist written down — that reason is what you check when performance decays.

## 8.2 Backtesting — the honest version

The purpose of a backtest is not to find good numbers — it is to **try to kill the strategy and fail**. The seven sins that create beautiful fake backtests, and their cures:

1. **Lookahead bias** — using information unavailable at decision time (signals on bar close computed with that bar's high/low, indicators repainting, fundamentals restated). *Cure:* event-driven simulation; point-in-time data only.
2. **Survivorship bias** — testing on today's asset list (which excludes everything that died/delisted — precisely the trades that would have hurt). *Cure:* survivorship-free universes with delisted assets (Norgate/Sharadar class data).
3. **Cost blindness** — omitting spread, fees, slippage, funding. *Cure:* per-asset, per-session cost model; for intraday, err pessimistic (costs kill more intraday edges than logic errors do).
4. **Overfitting** — tuning parameters until history looks perfect; you've memorized noise. *Cures:* fewer parameters; **parameter plateaus** (performance must be similar at RSI 25/27/30 — if only 27 works, it's noise); out-of-sample discipline below.
5. **Multiple-testing deception** — test 200 ideas, 10 look great by pure chance. *Cure:* count everything you tried; apply deflated Sharpe/reality-check corrections; distrust your own best result in proportion to how hard you searched.
6. **Data-quality poison** — bad ticks, wash volume, gaps. *Cure:* data validation layer before any research.
7. **Regime myopia** — testing only 2020–2021 crypto and concluding genius. *Cure:* test across regimes explicitly and report performance *per regime*; a strategy allowed to trade only its matched regime (Level 3.5 gating) with honest numbers beats one pretending to work always.

**Statistical bar:** ≥200 trades per playbook before believing anything; confidence intervals on win rate; **walk-forward analysis** as the workhorse (optimize on window A → test untouched on window B → roll; only the stitched out-of-sample curve counts); **Monte Carlo** on the trade list (reshuffle order, resample, jitter entries) to see the *distribution* of drawdowns — you experienced one path of history, you must survive its siblings; and a final untouched **holdout era** used exactly once (using it twice quietly converts it to training data).

## 8.3 Forward testing and live validation

Paper-trade the frozen system on live data 1–3 months: this catches everything backtests can't — feed glitches, real spreads at 2 a.m., signals during halts. Compare live fills vs. modeled fills (slippage audit). Then minimal real size (execution realism without pain), then scale. In production: track live-vs-backtest expectancy per playbook with statistical control limits; breaching the lower limit auto-suspends the playbook ("challenger review"), because **all edges decay** — publication, crowding, and regime change erode them (documented post-publication decay averages roughly a third to a half of an anomaly's return). Strategy development is therefore a **pipeline, not a project**: a running conveyor of hypotheses → research → validation → deployment → monitoring → retirement.

---

# LEVEL 9 — THE PROFESSIONAL DECISION PROCESS, MISTAKES & MINDSET

## 9.1 One full trade, end to end (the reasoning the engine should mirror)

Sunday: trader reviews weekly charts — BTC weekly uptrend intact (HH/HL), daily pulling back toward the 61.8% of the last impulse where a prior breakout level, the daily 50MA, and a high-volume node stack within one ATR; below it, three weeks of equal lows scream liquidity pool. Funding has bled from top-decile to neutral; OI down 12% from the peak — leverage flushed. CPI lands Wednesday: no entries T±15m, reduced size that day. **Plan written before the market moves:** "IF price sweeps the equal lows into the zone AND reclaims within 3 bars on 4h with delta flip, THEN long on the reclaim close; stop 1 ATR below sweep low; T1 = range mid (2.1R), T2 = range high (3.8R); risk 0.75%; invalid if daily closes below zone." Tuesday it happens exactly so; entry executes the plan mechanically; ⅓ off at T1; stop to the new 4h HL after it confirms; trail structure; final exit into the opposing highs as delta diverges. Post-trade: journaled, tagged, outcome logged against the plan.

The lesson to encode: **every decision was made before the moment of action.** The plan-then-execute separation is the entire psychological technology of professional trading — and it is natively how a signal engine works, which is the engine's structural advantage over human users.

## 9.2 The complete catalog of mistakes (each = an engine guard-rail)

**Entry-side:** chasing after the move (entering far from invalidation = terrible R:R — enforce max entry-to-stop distance), trading mid-range "because bored" (location gate), fighting HTF trend on LTF patterns (bias gate), catching knives at levels without triggers (trigger gate), trading dead sessions and pre-news (time/veto gates), oversizing "sure things" (fixed sizing — no conviction override), stacking correlated positions (cluster heat), and signal-shopping across indicators until one agrees (fixed playbook definitions).

**Management-side:** moving stops away (forbidden operation in code), premature breakeven, cutting winners at +0.5R while letting losers ride to −1R (asymmetry inversion — enforce minimum R:R and hard stops), revenge trading after losses and euphoria-sizing after wins (drawdown governor + per-day signal caps), and strategy-hopping after every 3-loss streak (statistical suspension rules instead of vibes).

**Research-side:** all seven backtest sins of 8.2.

**Meta-mistake:** judging decisions by single outcomes — a good process losing is still good; a bad process winning is still bad; only distributions over many trades judge a process. The engine must be evaluated (and marketed) the same way.

## 9.3 How professionals think — the priors to encode

Probabilistic humility (every setup is a coin with a small tilt; no certainty, ever), asymmetry obsession (the question is never "will it go up" but "what do I make if right vs. lose if wrong"), liquidity-first perception (before direction, ask whose stops are where — Level 4's map), patience as position ("no trade" is the default state; edge exists in bursts), regime awareness (what worked last quarter is conditional), cost consciousness, and radical record-keeping (the journal is the dataset — for the engine, the signal log with full feature snapshots *is* this journal, and it compounds into the meta-model's training set).

---

# LEVEL 10 — ASSEMBLING IT INTO THE AI ENGINE

## 10.1 The mapping — curriculum level → engine component

| Curriculum | Engine component |
|---|---|
| L0 order-book & participants | Data model: trades/quotes/OHLCV; delta computation |
| L1 candles, S/R, trend | Pattern detectors (ATR-normalized); zone generator; structure state machine |
| L2 indicators & chart patterns | Feature library; regime scalars (ADX/ER, ATR percentile); geometric pattern detectors |
| L3 volume, Wyckoff, regimes, correlation | Absorption/climax/CVD detectors; volume-profile objects; HMM regime classifier; correlation clusters |
| L4 liquidity, SMC, manipulation | Sweep/FVG/OB detectors; fake-breakout classifier; anomaly suppressors; institutional-participation score |
| L5 fundamentals, macro, on-chain, news | Point-in-time fundamental ranks; event calendar + veto windows; on-chain & derivatives features; NLP scoring pipeline |
| L6 style workflows | Style-routed playbooks with the gate sequences (companion doc §2–3) |
| L7 risk & portfolio | Sizing module, heat/cluster caps, drawdown governor, structural stop/target computation |
| L8 development & validation | Backtest harness (event-driven, cost-modeled, walk-forward, Monte Carlo); champion/challenger deployment |
| L9 process & mistakes | Hard gates encoding each mistake's prevention; plan-object per signal (entry/stop/targets/invalidation/reasons) |

## 10.2 The reasoning chain per signal (the "thinks like a trader" requirement)

For every candidate, the engine should populate — and publish — a structured reasoning object, mirroring Level 9.1:

> regime → HTF bias → location (zones + liquidity map) → participation evidence (volume/delta/derivatives/institutional score) → catalyst & veto check → trigger → trade math (stop, targets, R:R, EV after costs) → portfolio check → calibrated P(win) → reason list & invalidation.

**Signals that cannot fill every slot don't publish.** This object is simultaneously the user-facing explanation, the audit trail, and one row of future training data — the three purposes reinforcing each other is what makes the architecture compound in intelligence over time.

## 10.3 Priorities, restated

If accuracy is the goal, the order of leverage is:

1. Cost modeling + honest labels
2. Regime gating
3. The liquidity-sweep mechanic implemented properly with volume confirmation
4. Veto systems (news windows, manipulation flags, dead liquidity)
5. Per-playbook meta-models with calibrated probabilities
6. Breadth (more playbooks, markets, data layers)

Concepts from Levels 0–5 are the **feature vocabulary**; Levels 6–9 are the **decision grammar**; Level 10's loop — log everything, retrain on outcomes, suspend what decays — is what turns a rules engine into a system that genuinely learns to trade.

---

**Companion documents:** "AI Trading Platform — Roadmap" (architecture, data providers, resources) and "AI Analysis Engine — Knowledge Base" (setup library with exact parameters, feature dictionary, statistical tendencies, training methodology). Together the three form the complete written knowledge base. Any single section here can be expanded into a standalone deep-dive module on request.
