import type { AssetClass, InstrumentKind } from '@prisma/client';

/**
 * Market data provider contract.
 *
 * Adding a licensed feed (Kite Connect, Breeze, TrueData) means implementing
 * this one interface and adding the name to MARKET_DATA_PROVIDERS. Nothing
 * downstream changes.
 *
 * Documented endpoints and limits: docs/data-sources.md
 */

/**
 * Supported bar sizes.
 *
 * `3m` is served natively by Binance and by nothing else in the chain. Rather
 * than synthesise it from 1m bars for other venues — a resampled bar is not the
 * chart a 3-minute trader is looking at — providers that lack it decline, and
 * the timeframe is simply unavailable for those instruments.
 */
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';

export interface ProviderQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  marketCap?: number | null;
  yearHigh?: number | null;
  yearLow?: number | null;
  bid?: number | null;
  ask?: number | null;
  currency: 'INR' | 'USD';
  updatedAt: string;
  source: string;
}

export interface ProviderCandle {
  /** Unix seconds, UTC. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;

  /**
   * Microstructure, where the venue publishes it.
   *
   * Binance returns these on every kline at no extra cost, and they carry
   * information OHLCV cannot: `takerBuyVolume` is the share of the bar that was
   * aggressive buying, which is real order flow rather than the direction of
   * the close. Two bars with identical shape and volume can have opposite
   * delta, and that difference is often the whole story.
   *
   * Undefined for venues that do not publish it — the engine drops the factor
   * rather than inferring it, on the same principle as every other unavailable
   * group.
   */
  trades?: number;
  /** Volume executed by aggressive buyers (taker side), in base units. */
  takerBuyVolume?: number;
  /** Turnover in the quote currency. */
  quoteVolume?: number;
}

/** One side of the book, aggregated into price levels. */
export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface ProviderOrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /** Venue sequence number, so a stale snapshot is detectable. */
  lastUpdateId: number;
  fetchedAt: string;
  source: string;
}

/**
 * Derivatives and positioning data for a crypto instrument.
 *
 * Perpetual futures are where most crypto leverage sits, so funding, open
 * interest and the long/short split say things spot candles cannot: what
 * positioning costs to hold, whether leverage is building or unwinding, and how
 * one-sided the book's participants are. Crowding is the signal — a market that
 * is heavily long and paying to stay long is fragile in a way price alone does
 * not show.
 *
 * This is *exchange* data, not chain data. Active addresses, exchange netflows
 * and whale transfers need a licensed on-chain provider and are not modelled
 * here; nothing in this type should be presented as an on-chain metric.
 */
export interface ProviderDerivatives {
  symbol: string;
  /** Last funding rate as a fraction (0.0001 = 0.01% per interval). */
  fundingRate: number | null;
  /** Annualised equivalent, for a number a human can reason about. */
  fundingRateAnnualisedPercent: number | null;
  /** Notional open interest, most recent observation. */
  openInterest: number | null;
  /** Percent change in open interest across the observed window. */
  openInterestChangePercent: number | null;
  /** All accounts: fraction positioned long, 0…1. */
  longAccountRatio: number | null;
  /** Largest accounts by position — the closest thing to an institutional read. */
  topTraderLongRatio: number | null;
  fetchedAt: string;
  source: string;
}

export interface InstrumentRef {
  symbol: string;
  assetClass: AssetClass;
  kind: InstrumentKind;
  /** Provider-specific symbol overrides, from Instrument.providerSymbols. */
  providerSymbols?: Record<string, string | null> | null;
}

export interface MarketDataProvider {
  readonly name: string;

  /** Which categories this provider can serve. */
  supports(instrument: InstrumentRef): boolean;

  getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null>;

  getCandles(
    instrument: InstrumentRef,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]>;

  /** Optional batch path — providers that have one avoid N round trips. */
  getQuotes?(instruments: InstrumentRef[]): Promise<Map<string, ProviderQuote>>;

  /**
   * Optional depth snapshot.
   *
   * Only venues that publish a real book implement this. Equities via Yahoo do
   * not have one, and synthesising a book from a quote would be inventing the
   * single most consequential piece of data on the screen.
   */
  getOrderBook?(instrument: InstrumentRef, depth?: number): Promise<ProviderOrderBook | null>;
  getDerivatives?(instrument: InstrumentRef): Promise<ProviderDerivatives | null>;
}

/** Shared HTTP helper with a timeout and a browser-like User-Agent. */
export async function fetchJson<T>(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Yahoo returns 429 to requests without a browser-like UA.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingIntelligence/1.0)' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
