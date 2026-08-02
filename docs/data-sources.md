# Market Data Sources

Every provider the platform can use, with exact endpoints, auth requirements and
limits. The API implements these in `apps/api/src/market-data/providers/`.

**Design rule:** providers are a *chain*. Each request walks the chain in the order
given by `MARKET_DATA_PROVIDERS` and returns the first successful response. The
`simulated` provider is always last and never fails, so the platform runs with zero
external accounts. Every `Quote` carries a `source` field so the UI can show where a
number actually came from, and `stale: true` when it is a cached/last-close value.

---

## 1. Indian equities (NSE / BSE)

### 1.1 Yahoo Finance chart API — primary, no key

Verified working unauthenticated as of 2026. The **v8 chart** endpoint is the one to
use; the older **v7 quote** endpoint now requires a session cookie + crumb pair and
should be avoided.

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}
    ?interval=1d          # 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo
    &range=1y             # 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max
    # or explicit window:
    &period1={unix}&period2={unix}
```

Symbol suffixes:

| Instrument | Yahoo symbol |
| --- | --- |
| NSE equity | `RELIANCE.NS`, `TCS.NS`, `HDFCBANK.NS` |
| BSE equity | `RELIANCE.BO` |
| NIFTY 50 | `^NSEI` |
| NIFTY Bank | `^NSEBANK` |
| BSE SENSEX | `^BSESN` |
| Forex | `USDINR=X`, `EURUSD=X` |
| Crypto | `BTC-USD`, `ETH-USD` |

Response shape (trimmed):

```jsonc
{
  "chart": {
    "result": [{
      "meta": { "regularMarketPrice": 2841.5, "previousClose": 2820.1,
                "currency": "INR", "exchangeName": "NSI",
                "fiftyTwoWeekHigh": 3217.9, "fiftyTwoWeekLow": 2220.3 },
      "timestamp": [1735689600, ...],                       // unix seconds
      "indicators": {
        "quote": [{ "open": [...], "high": [...], "low": [...],
                    "close": [...], "volume": [...] }]
      }
    }],
    "error": null
  }
}
```

Gotchas the adapter handles:

- **Null holes.** `open/high/low/close` arrays contain `null` for halted or
  non-trading bars. Rows with a null `close` are dropped, not forward-filled.
- **Intraday history is short.** 1m data goes back ~7 days, 5m ~60 days. Requesting a
  longer range silently returns fewer bars.
- **User-Agent required.** Requests without a browser-like UA get 429s.
- **No official SLA.** This is an undocumented endpoint. Treat outages as normal and
  let the chain fall through.

### 1.2 Alpha Vantage — optional, keyed

```
GET https://www.alphavantage.co/query
    ?function=TIME_SERIES_DAILY_ADJUSTED&symbol=RELIANCE.BSE
    &outputsize=full&apikey={ALPHA_VANTAGE_API_KEY}
```

Free tier is **25 requests/day** — far too tight for live quotes. Wired up as a
history backfill source only.

### 1.3 Finnhub — optional, keyed

```
GET https://finnhub.io/api/v1/quote?symbol={SYM}&token={FINNHUB_API_KEY}
```

Free tier 60 req/min. Indian equity coverage is limited; used mainly for crypto and
forex when configured.

### 1.4 Official NSE / BSE endpoints — not used

`nseindia.com` exposes JSON endpoints, but they require rotating cookies, break
frequently, and their terms do not permit redistribution. Deliberately excluded.
For production, the right answer is a licensed broker feed:

| Vendor | Notes |
| --- | --- |
| **Zerodha Kite Connect** | ₹2,000/mo. WebSocket ticks, 1-min historical. The de-facto Indian retail standard. |
| **ICICI Breeze** | Free for ICICIdirect customers. 3 years of second-level LTP. |
| **Upstox / Angel One SmartAPI** | Free tiers, REST + WebSocket. |
| **Global Datafeeds / TrueData** | Paid, exchange-authorised redistribution. |

Adding one is a single file implementing `MarketDataProvider` — see
`providers/provider.interface.ts`.

---

## 2. Forex

### 2.1 Frankfurter — daily reference rates, no key

Public, no signup, no rate limit. Sourced from central-bank reference rates
(ECB-led, 84 banks), 201 currencies, history back to 1948.

```
GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=INR,EUR,GBP
GET https://api.frankfurter.dev/v2/rates?date=2026-01-15&base=USD&quotes=INR
GET https://api.frankfurter.dev/v2/rates?from=2025-01-01&to=2026-01-01&base=USD&quotes=INR
GET https://api.frankfurter.dev/v2/currencies
```

```jsonc
{ "base": "USD", "date": "2026-01-15", "rates": { "INR": 83.42, "EUR": 0.92 } }
```

Limitations that matter:

- **Daily granularity only** — one reference fix per working day, published ~16:00
  CET. No intraday, no bid/ask, no weekend rows.
- Therefore Frankfurter backs the **1D+ timeframes**; intraday forex falls through to
  Yahoo (`USDINR=X`) or the simulated provider.

### 2.2 RBI reference rate

The Reserve Bank publishes an official INR reference rate each working day at
~13:30 IST. Useful as the authoritative INR mark for portfolio valuation. Published
as a web table/PDF rather than a JSON API, so it is scraped on a daily BullMQ job
rather than requested inline.

---

## 3. Crypto

### 3.1 Binance public REST — primary, no key

Public market-data endpoints need no API key.

```
GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500
GET https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT
GET https://api.binance.com/api/v3/avgPrice?symbol=BTCUSDT
```

Intervals: `1s 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`.
`limit` max **1000**, default 500. Optional `startTime` / `endTime` in **milliseconds**.

Kline rows are 12-element arrays, positionally:

```
[0] openTime(ms)  [1] open  [2] high  [3] low  [4] close  [5] volume
[6] closeTime(ms) [7] quoteAssetVolume  [8] trades
[9] takerBuyBase  [10] takerBuyQuote    [11] ignore
```

All price/volume fields are **strings** — parse to float. Weight-based rate limiting
applies per IP; `klines` costs 2 weight, and the ceiling is 6000 weight/minute, so
this is generous for our use.

Live ticks use the WebSocket stream rather than polling:

```
wss://stream.binance.com:9443/ws/btcusdt@kline_1m
wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker
```

### 3.2 CoinGecko — market cap and metadata, no key

```
GET https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&ids=bitcoin,ethereum
GET https://api.coingecko.com/api/v3/coins/{id}/market_chart?vs_currency=inr&days=90
```

Free tier ~10–30 calls/min. Used for market cap, supply, INR-denominated pricing and
logos — not for candles.

---

## 4. Mutual funds, ETFs, gold, bonds

### 4.1 AMFI NAV — authoritative, free, no key

The Association of Mutual Funds in India publishes every scheme's NAV daily.

```
GET https://www.amfiindia.com/spages/NAVAll.txt
```

Pipe-delimited, grouped by fund house, with section headers between blocks:

```
Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)
Aditya Birla Sun Life Mutual Fund
119551;INF209K01YM2;INF209K01YN0;Aditya Birla Sun Life Frontline Equity Fund - Growth;512.34;15-Jan-2026
```

Parser rules implemented in `providers/amfi.provider.ts`:

- Skip blank lines, the repeated header line, and any line without exactly 6 fields.
- Lines with 1 field are **category or fund-house headers** — track them as the
  current grouping rather than discarding.
- `Date` is `DD-MMM-YYYY`; NAV may be `N.A.` for schemes that did not report.
- The full file is ~9 MB and ~16,000 schemes → fetched once daily by a scheduled job
  into Postgres, never on the request path.

Historical NAV for a scheme:

```
GET https://api.mfapi.in/mf/{schemeCode}
GET https://api.mfapi.in/mf/{schemeCode}/latest
```

Community-run mirror of AMFI history, no key. Convenient, but AMFI is the source of
truth — mfapi is used for backfill only.

### 4.2 Gold

No clean free Indian spot-gold API. Two workable routes:

- `XAUUSD` via Yahoo (`GC=F` futures or `XAUUSD=X`) converted at the USDINR rate.
- Gold ETF NAVs from AMFI (e.g. Nippon India ETF Gold BeES) — closer to what a retail
  Indian investor actually buys, and already in the AMFI feed.

The platform uses the ETF route by default and treats gold as an `INVESTMENT` kind.

### 4.3 Bonds

Indian retail bond data (G-Secs, SDLs) comes from RBI's NDS-OM and CCIL. There is no
free JSON API. The platform models bonds through **debt mutual funds and gilt funds**
from the AMFI feed, plus a static yield-curve reference updated by a scheduled job.
Direct bond quotes are out of scope.

---

## 5. News

### 5.1 RSS — default, no key

Free, reliable, no rate limits, and legally safe to summarise with attribution.

| Source | Feed |
| --- | --- |
| Economic Times Markets | `https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms` |
| Moneycontrol Business | `https://www.moneycontrol.com/rss/business.xml` |
| Moneycontrol Markets | `https://www.moneycontrol.com/rss/marketreports.xml` |
| Business Standard Markets | `https://www.business-standard.com/rss/markets-106.rss` |
| Livemint Markets | `https://www.livemint.com/rss/markets` |
| The Hindu BusinessLine | `https://www.thehindubusinessline.com/markets/feeder/default.rss` |
| CoinDesk | `https://www.coindesk.com/arc/outboundfeeds/rss/` |
| Cointelegraph | `https://cointelegraph.com/rss` |
| FXStreet | `https://www.fxstreet.com/rss/news` |

Only headline, summary, link, source and timestamp are stored. Full article text is
never copied — the UI always links out.

### 5.2 NewsAPI — optional, keyed

`https://newsapi.org/v2/everything?q=...&apiKey=...` — 100 req/day free, and the free
tier is development-only per their terms. Off by default.

---

## 6. Economic calendar

No dependable free API for Indian macro events. The platform ships a **seeded
calendar** of recurring, publicly-scheduled events with known cadences:

| Event | Cadence |
| --- | --- |
| RBI Monetary Policy (MPC) | 6× per year, dates pre-announced |
| CPI inflation | 12th of each month, 17:30 IST |
| WPI inflation | 14th of each month |
| IIP | 12th of each month |
| GDP | Quarterly, last working day of Feb/May/Aug/Nov |
| Trade balance | ~15th monthly |
| US FOMC, NFP, CPI | Drives USDINR and crypto — tracked too |

Seeded in `apps/api/prisma/seed.ts` and editable from the admin panel.

---

## 7. Fundamentals

No free, licensable API delivers full Indian fundamentals (quarterly results,
shareholding patterns, cash flow). Options, in order of practicality:

1. **Screener.in / Tijori** — no public API; scraping breaches their terms. Excluded.
2. **NSE corporate filings + BSE XBRL** — authoritative and public, but XBRL parsing
   is a project in itself. The right long-term answer.
3. **Paid vendors** — Refinitiv, Capitaline, Trendlyne, CMOTS. What production
   platforms actually license.

The platform defines the complete `Fundamentals` contract and scoring engine, and
ships a seeded dataset for the NIFTY 50 universe so every downstream feature
(quality score, investment score, long-term rating, fundamental scanner) is real and
testable. Swapping in a licensed feed means implementing one provider interface —
no changes to the scoring engine or UI.

---

## 8. Caching & refresh policy

| Data | TTL | Where |
| --- | --- | --- |
| Quote (market open) | 15 s | Redis |
| Quote (market closed) | 15 min | Redis |
| Intraday candles | 5 min | Redis |
| Daily candles | 12 h | Redis + Postgres |
| AMFI NAV | 24 h | Postgres, 22:00 IST job |
| News | 10 min | Redis, 10-min job |
| Fundamentals | 24 h | Postgres |
| AI analysis | 60 s per symbol+timeframe | Redis |

Rules enforced in `market-data.service.ts`:

- Never call a provider inside a render path — the cache is populated by BullMQ jobs
  and read synchronously.
- One in-flight request per symbol (request coalescing) so a burst of 50 watchlist
  subscribers produces one upstream call.
- On provider failure, serve the last cached value with `stale: true` rather than
  erroring. A stale price is more useful than a spinner.

---

## 9. Legal

- Yahoo, Binance and CoinGecko public endpoints are undocumented or free-tier. Fine
  for personal and development use; **verify terms before commercial deployment**.
- AMFI and RBI data are public and free to redistribute with attribution.
- NSE/BSE real-time prices require an exchange licence to redistribute. Running this
  commercially in India means a licensed vendor feed and, depending on what you offer,
  SEBI Research Analyst or Investment Adviser registration.
- News is stored as headline + link only. Never republish full articles.
