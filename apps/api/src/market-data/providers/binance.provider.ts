import { Injectable, Logger } from '@nestjs/common';

import {
  fetchJson,
  type InstrumentRef,
  type MarketDataProvider,
  type ProviderCandle,
  type ProviderOrderBook,
  type ProviderQuote,
  type Timeframe,
} from './provider.interface';

/**
 * Binance public market data — crypto only.
 *
 * Public endpoints need no API key. Klines cap at 1000 bars per request and
 * every numeric field arrives as a string, so everything is parsed explicitly.
 *
 * Endpoints and the 12-element kline row layout: docs/data-sources.md §3.1
 */
@Injectable()
export class BinanceProvider implements MarketDataProvider {
  readonly name = 'binance';
  private readonly logger = new Logger(BinanceProvider.name);
  private readonly base = 'https://api.binance.com/api/v3';

  supports(instrument: InstrumentRef): boolean {
    return instrument.assetClass === 'CRYPTO';
  }

  private pair(instrument: InstrumentRef): string {
    const override = instrument.providerSymbols?.binance;
    if (override) return override;
    const symbol = instrument.symbol.toUpperCase().replace('-USD', '').replace('USDT', '');
    return `${symbol}USDT`;
  }

  private interval(timeframe: Timeframe): string {
    return (
      {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M',
      } as Record<Timeframe, string>
    )[timeframe];
  }

  async getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null> {
    if (!this.supports(instrument)) return null;
    const pair = this.pair(instrument);

    try {
      const data = await fetchJson<BinanceTicker>(
        `${this.base}/ticker/24hr?symbol=${pair}`,
        { timeoutMs: 8000 },
      );

      const price = Number(data.lastPrice);
      const previousClose = Number(data.prevClosePrice) || price;
      if (!Number.isFinite(price)) return null;

      return {
        symbol: instrument.symbol,
        price,
        change: Number(data.priceChange),
        changePercent: Number(data.priceChangePercent),
        open: Number(data.openPrice),
        high: Number(data.highPrice),
        low: Number(data.lowPrice),
        previousClose,
        volume: Number(data.volume),
        bid: Number(data.bidPrice) || null,
        ask: Number(data.askPrice) || null,
        currency: 'USD',
        updatedAt: new Date(data.closeTime).toISOString(),
        source: this.name,
      };
    } catch (error) {
      this.logger.debug(`quote failed for ${pair}: ${(error as Error).message}`);
      return null;
    }
  }

  async getCandles(
    instrument: InstrumentRef,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]> {
    if (!this.supports(instrument)) return [];
    const pair = this.pair(instrument);

    try {
      // One extra bar, because the last one is dropped below.
      const capped = Math.min(limit + 1, 1000);
      const url = `${this.base}/klines?symbol=${pair}&interval=${this.interval(timeframe)}&limit=${capped}`;
      const rows = await fetchJson<BinanceKline[]>(url, { timeoutMs: 12_000 });

      // ── Drop the bar that has not closed yet ──────────────────
      //
      // Binance returns the in-progress candle as the final element. Analysing
      // it treats a partial bar as a complete one: twenty minutes into an hour,
      // its volume is a third of normal, its range is truncated, and its close
      // is wherever price happens to sit right now. Every downstream measure
      // inherits that — candle anatomy, the volume ratio, pattern detection,
      // and the forecast, which is supposed to predict the *next* bar from the
      // last *closed* one and was instead extrapolating from a fragment.
      //
      // `closeTime` (field 6) is the venue's own answer to "is this done?", so
      // no guessing about clocks or intervals is needed.
      const now = Date.now();
      const closed = rows.filter((row) => Number(row[6]) < now);

      return closed
        .map((row) => {
          // Row layout is positional:
          //   [0] openTime      [1] open      [2] high      [3] low
          //   [4] close         [5] volume    [6] closeTime [7] quoteVolume
          //   [8] trades        [9] takerBuyBase           [10] takerBuyQuote
          //
          // Fields 8–10 arrive on every request and were previously discarded.
          // They are the difference between knowing a bar closed up and knowing
          // it closed up because buyers lifted offers — real order flow, free.
          const volume = Number(row[5]);
          const takerBuyVolume = Number(row[9]);

          return {
            time: Math.floor(Number(row[0]) / 1000),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume,
            quoteVolume: Number(row[7]),
            trades: Number(row[8]),
            takerBuyVolume: Number.isFinite(takerBuyVolume) ? takerBuyVolume : undefined,
          } satisfies ProviderCandle;
        })
        .filter((candle) => Number.isFinite(candle.close));
    } catch (error) {
      this.logger.debug(`candles failed for ${pair}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Depth snapshot.
   *
   * The book is where resting liquidity actually sits, which is what a
   * "liquidity zone" derived from swing highs only approximates. A cluster of
   * size two percent above price is a wall that exists right now, not a level
   * inferred from where price once turned.
   *
   * 100 levels by default: enough to see the walls that matter within a few
   * percent, small enough to stay in the cheapest rate-limit bucket.
   */
  async getOrderBook(
    instrument: InstrumentRef,
    depth = 100,
  ): Promise<ProviderOrderBook | null> {
    if (!this.supports(instrument)) return null;
    const pair = this.pair(instrument);

    // Binance only accepts specific depth values; anything else is a 400.
    const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
    const limit = allowed.find((value) => value >= depth) ?? 100;

    try {
      const data = await fetchJson<BinanceDepth>(
        `${this.base}/depth?symbol=${pair}&limit=${limit}`,
        { timeoutMs: 8000 },
      );

      const parse = (rows: [string, string][]) =>
        rows
          .map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }))
          .filter((level) => Number.isFinite(level.price) && level.quantity > 0);

      return {
        symbol: instrument.symbol,
        bids: parse(data.bids ?? []),
        asks: parse(data.asks ?? []),
        lastUpdateId: data.lastUpdateId,
        fetchedAt: new Date().toISOString(),
        source: this.name,
      };
    } catch (error) {
      this.logger.debug(`depth failed for ${pair}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Batch quotes in one request.
   *
   * `/ticker/24hr` without a symbol returns every pair on the venue — a large
   * payload but a single round trip, and the weight is far lower than issuing
   * one request per symbol.
   */
  async getQuotes(instruments: InstrumentRef[]): Promise<Map<string, ProviderQuote>> {
    const supported = instruments.filter((item) => this.supports(item));
    const out = new Map<string, ProviderQuote>();
    if (supported.length === 0) return out;

    const wanted = new Map(supported.map((item) => [this.pair(item), item]));

    try {
      const symbols = JSON.stringify([...wanted.keys()]);
      const data = await fetchJson<BinanceTicker[]>(
        `${this.base}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`,
        { timeoutMs: 10_000 },
      );

      for (const ticker of data) {
        const instrument = wanted.get(ticker.symbol);
        if (!instrument) continue;

        const price = Number(ticker.lastPrice);
        if (!Number.isFinite(price)) continue;

        out.set(instrument.symbol, {
          symbol: instrument.symbol,
          price,
          change: Number(ticker.priceChange),
          changePercent: Number(ticker.priceChangePercent),
          open: Number(ticker.openPrice),
          high: Number(ticker.highPrice),
          low: Number(ticker.lowPrice),
          previousClose: Number(ticker.prevClosePrice) || price,
          volume: Number(ticker.volume),
          bid: Number(ticker.bidPrice) || null,
          ask: Number(ticker.askPrice) || null,
          currency: 'USD',
          updatedAt: new Date(ticker.closeTime).toISOString(),
          source: this.name,
        });
      }
    } catch (error) {
      // The caller falls back to per-symbol quotes, so a batch failure costs
      // latency rather than data.
      this.logger.debug(`batch quotes failed: ${(error as Error).message}`);
    }

    return out;
  }
}

interface BinanceDepth {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  prevClosePrice: string;
  priceChange: string;
  priceChangePercent: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  bidPrice: string;
  askPrice: string;
  closeTime: number;
}

type BinanceKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];
