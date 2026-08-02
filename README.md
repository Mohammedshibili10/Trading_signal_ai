# AI Trading Intelligence Platform

Market analysis, per-candle forecasting, risk management and portfolio tools for
**Indian equities (NSE/BSE), forex, crypto and Indian investment products**
(mutual funds, ETFs, gold, bonds). Nothing else — the scope is deliberately
narrow so each category is covered properly.

The centrepiece is an analysis engine that measures every candle, blends nine
weighted evidence groups, and reports a probability for the next bar **alongside
its own measured hit-rate**. If the engine has no edge on an instrument, it says
so rather than dressing up a coin flip.

---

## Quick start

```bash
cp .env.example .env          # every value has a working default
npm install

docker compose up -d postgres redis

npm run db:generate           # Prisma client
npm run db:migrate            # create the schema
npm run db:seed               # instruments, fundamentals, demo account

npm run dev                   # web :3000, api :4000, ai :8000
```

Sign in with **`demo@alphaline.app` / `DemoPassword1`** (seeded as ADMIN).

No API keys are needed. The market-data chain ends in a deterministic offline
provider, so charts, analysis and backtests all work with zero external accounts.

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:4000/api/v1 · docs at `/api/docs` |
| AI engine | http://localhost:8000 · docs at `/docs` |

### Running pieces individually

```bash
npm run dev:web        # Next.js
npm run dev:api        # NestJS
npm run ai             # FastAPI (creates its own venv)
npm run ai:test        # engine self-test — 51 assertions, no pytest needed
npm run ai:ml          # optional: torch + FinBERT (~2.5 GB)
```

The Python launcher (`services/ai/run.mjs`) finds a suitable interpreter,
creates a venv and installs dependencies. It prefers 3.12/3.13 because the
scientific stack reliably ships wheels for them, but the engine is tested on
**3.11 through 3.14** (including pandas 3.x).

Behind a TLS-intercepting proxy, add `--trusted`:

```bash
node services/ai/run.mjs --test --trusted
```

Or skip Python entirely: `docker compose --profile full up`.

---

## Architecture

```
apps/web        Next.js 15 · React 19 · Tailwind v4 · shadcn/ui · Redux Toolkit · TanStack Query
apps/api        NestJS 11 · Prisma · PostgreSQL · Redis · BullMQ · Socket.IO
services/ai     FastAPI · NumPy · pandas · SciPy   (stateless, no database)
docs/           Trading concepts, data sources, signal methodology
```

**Why three services.** The AI service holds no user data and no database
connection — it takes candles and returns analysis. That makes it trivially
scalable and keeps every piece of user state behind the API's auth and audit
trail. The API never calls a market-data provider inline; background jobs
populate Redis and Postgres, and request handlers read from those.

**State split on the client.** Redux Toolkit holds client state (session, UI
preferences, chart configuration, risk parameters). TanStack Query holds server
state. Mirroring server data into Redux would mean rebuilding caching,
refetching and invalidation by hand.

---

## The analysis engine

Full specification in [docs/signal-methodology.md](docs/signal-methodology.md).

### Per-candle anatomy

Every bar is measured before anything tries to name it — body and wick shares,
close location in range, range vs ATR, volume ratio, gap, inside/outside,
climax, and Wyckoff effort-vs-result. These exist for *every* bar, not just the
~5% that match a named pattern, and they carry more information than the label.

### Nine weighted factor groups

| Group | Weight | | Group | Weight |
| --- | --- | --- | --- | --- |
| Trend | 20% | | Volume | 10% |
| Indicators | 16% | | Volatility | 6% |
| Price action | 15% | | News | 6% |
| Market structure (SMC) | 13% | | Fundamentals | 4% |
| Candlestick | 10% | | | |

Two rules do the heavy lifting:

- **Correlated indicators are grouped, not counted separately.** RSI, Stochastic,
  CCI and Williams %R all measure the same thing. They're normalised *within*
  the indicator group, so momentum can't be counted four times.
- **Unavailable groups are dropped and their weight redistributed** — never
  scored as neutral, which would drag the blend toward zero and fake a balanced
  read. Spot forex loses `VOLUME` (tick counts aren't volume); crypto and forex
  lose `FUNDAMENTALS`; NAV series lose `CANDLESTICK` and `MARKET_STRUCTURE`.

### Candlestick patterns are weighted honestly

Bulkowski's testing across 103 patterns found most single-candle patterns resolve
at 52–56% — statistically a coin flip — and that the **hanging man resolves as a
bullish continuation ~59% of the time**, the opposite of the textbook. This
engine scores patterns from measured behaviour, anchors context multipliers on
the *edge over random* rather than the raw percentage (so a 50% pattern stays 50%
however good the setup looks), and caps the whole group at 10%.

### Calibration is what makes the numbers mean anything

The engine re-runs itself over the last ~125 closed bars using only data
available at each bar, then compares against what actually happened. It reports
hit-rate, per-bucket reliability, calibration error and Brier score, and fits a
monotone correction so future probabilities are pulled toward measured reality.

> Confidence 71 · measured hit-rate 63% over 250 bars · Brier 0.213

With fewer than 100 scored samples it reports *not yet calibrated* instead of an
unearned number. Confidence is hard-capped at 85 — there is no market state in
which this engine should claim near-certainty.

On a synthetic random walk the self-test asserts the hit-rate stays **below
75%**. A higher number would mean look-ahead had crept in.

### WAIT is a real answer

No signal is issued when reward:risk at the first target is below 1.5, confidence
is below 45, the stop would sit more than 8% away, history is under 60 bars, or
trend and structure directly contradict each other. On typical daily data the
engine returns `WAIT` roughly 40% of the time, with the reason stated.

### Explanations can't disagree with the arithmetic

Reasons are ranked by `|score × weight|` — literally the terms that drove the
number — and **contradicting factors are always included** by the same rule. When
`GEMINI_API_KEY` is set, Gemini rephrases those factors into prose; it is
forbidden from introducing claims or altering numbers. Without a key the
assistant returns the same facts as templates.

---

## Data sources

Full endpoint reference in [docs/data-sources.md](docs/data-sources.md).

| Category | Primary | Fallback |
| --- | --- | --- |
| Indian equities | Yahoo v8 chart (`RELIANCE.NS`, `^NSEI`) | simulated |
| Forex | Frankfurter (daily, no key) → Yahoo (intraday) | simulated |
| Crypto | Binance public REST | Yahoo → simulated |
| Mutual funds | AMFI `NAVAll.txt` (nightly job) | mfapi.in |
| News | RSS — ET, Moneycontrol, Mint, CoinDesk, FXStreet | — |

Providers are a chain: each request walks it and takes the first success. Every
quote carries the provider that served it, and `stale: true` when it came from
cache during an outage. **A stale price flagged as stale beats a spinner.**

The `simulated` provider is deterministic — seeded from the symbol and bar
timestamp, with volatility clustering and volume correlated to range. Reloading
never reshuffles the chart. It always labels itself.

> **Production note.** Redistributing real-time NSE/BSE prices in India requires
> an exchange licence — a licensed vendor feed (Kite Connect, Breeze, TrueData)
> is a single file implementing `MarketDataProvider`. Depending on what you
> offer, SEBI Research Analyst or Investment Adviser registration may also apply.

---

## Security

- Argon2id password hashing (64 MiB / 3 passes, OWASP baseline)
- Access token in memory only; refresh token in an httpOnly cookie
- **Refresh rotation with reuse detection** — a replayed token revokes every
  session for that user
- Only token *hashes* are stored, so a database leak yields no live sessions
- Global auth guard: endpoints are protected by default and must opt out with
  `@Public()`
- Password change or reset invalidates all existing sessions
- Single-flight refresh on the client, so N parallel 401s produce one refresh
  rather than N (which rotation would treat as reuse and sign the user out)
- Production boot **fails** if JWT secrets are still the development defaults
- Per-route rate limits: 10/min on login, 3/5min on password reset
- Prisma errors are mapped, never leaked — raw ones expose your schema

---

## Testing

```bash
npm run ai:test          # 51 engine assertions
npm run typecheck        # both Node apps
npm run build            # full production build
```

The engine self-test covers probability normalisation, the confidence cap,
weight redistribution, look-ahead guards, calibration sanity, concentration
caps, backtest cost accounting, sentiment nuance (profit-booking language is not
read as a collapse), the promoter-pledge rating cap, and degenerate inputs
(zero-range bars, zero-volume series, too-few candles).

---

## Current status

**Complete and verified**

- ✅ Analysis engine — indicators, anatomy, candlesticks, structure, SMC, chart
  patterns, price action, 9-group forecast, calibration, signals, risk, Monte
  Carlo, backtesting, sentiment, fundamentals, investment maths. 51/51 tests pass.
- ✅ FastAPI service with Docker image and full OpenAPI docs
- ✅ NestJS API — auth, RBAC, market-data chain, all domain modules, WebSocket
  gateway, BullMQ jobs, health probes. Builds clean.
- ✅ Prisma schema (25 models) + seed: 62 instruments, 30 fundamentals records,
  economic calendar, demo account with watchlists and a portfolio
- ✅ Web foundations — design tokens, 17 UI primitives, Redux store with
  SSR-safe persistence, API client with token refresh, providers
- ✅ Web pages — app shell, sidebar, topbar, command palette (⌘K), dashboard,
  login, register. Builds clean.
- ✅ Documentation — trading concepts, data sources, signal methodology

**Not yet built** — the API endpoints and engine behind each of these are done
and callable; what's missing is the page that renders them:

- Symbol detail page: TradingView chart, indicator overlays, drawing tools, and
  the candle-by-candle forecast table
- Markets browser, watchlist manager, signals feed
- Portfolio, risk calculators, scanners, strategy builder, invest, news,
  assistant, admin, settings

`src/lib/nav.ts` lists every route; the unbuilt ones 404 until their page is
added. `src/lib/api.ts` already has typed helpers for all of them.

---

## What this platform does not claim

- No guaranteed profits. No "100% accurate" signals.
- Probabilities are **calibrated historical frequencies**, not promises. 65%
  confidence means that in similar past setups the call resolved correctly about
  65% of the time — and that it will be wrong roughly a third of the time.
- Calibration is backward-looking. When a market's character changes, measured
  hit-rates lag reality.
- No order-flow data — no L2 book, no options chain, no intraday FII/DII flows.
- Backtest ≠ live. Slippage, partial fills, market impact and psychology are not
  in the numbers.

This is analysis software, not investment advice, and not a substitute for a
SEBI-registered adviser.

---

## Documentation

| | |
| --- | --- |
| [docs/trading-concepts.md](docs/trading-concepts.md) | Market structure, SMC, patterns, risk, Indian fundamentals, cognitive hazards |
| [docs/signal-methodology.md](docs/signal-methodology.md) | Exact factor weights, blending, calibration, rejection rules |
| [docs/data-sources.md](docs/data-sources.md) | Every provider — endpoints, auth, limits, caching, legal |
