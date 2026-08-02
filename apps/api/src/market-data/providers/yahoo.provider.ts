import { Injectable, Logger } from '@nestjs/common';

import {
  fetchJson,
  type InstrumentRef,
  type MarketDataProvider,
  type ProviderCandle,
  type ProviderQuote,
  type Timeframe,
} from './provider.interface';

/**
 * Yahoo Finance — the v8 chart endpoint.
 *
 * Covers all four categories: NSE/BSE equities (.NS / .BO), Indian indices
 * (^NSEI, ^NSEBANK, ^BSESN), forex (USDINR=X) and crypto (BTC-USD).
 *
 * Uses `/v8/finance/chart` exclusively. The older `/v7/finance/quote` endpoint
 * now requires a session cookie plus a crumb, breaks regularly, and gives us
 * nothing the chart endpoint doesn't already return in `meta`.
 *
 * This is an undocumented endpoint with no SLA. Treat outages as normal — the
 * provider chain falls through.
 */
@Injectable()
export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  private readonly logger = new Logger(YahooProvider.name);
  private readonly base = 'https://query1.finance.yahoo.com/v8/finance/chart';

  supports(): boolean {
    // Mutual fund NAVs come from AMFI; everything else Yahoo can serve.
    return true;
  }

  /** Map an internal symbol to Yahoo's notation. */
  private yahooSymbol(instrument: InstrumentRef): string | null {
    const override = instrument.providerSymbols?.yahoo;
    if (override) return override;

    const symbol = instrument.symbol.toUpperCase();

    switch (instrument.kind) {
      case 'INDEX': {
        const indices: Record<string, string> = {
          NIFTY50: '^NSEI',
          BANKNIFTY: '^NSEBANK',
          SENSEX: '^BSESN',
          NIFTYIT: '^CNXIT',
          NIFTYAUTO: '^CNXAUTO',
          NIFTYPHARMA: '^CNXPHARMA',
          NIFTYFMCG: '^CNXFMCG',
          NIFTYMETAL: '^CNXMETAL',
        };
        return indices[symbol] ?? null;
      }

      case 'FOREX':
        // Yahoo quotes majors as EURUSD=X and INR crosses as USDINR=X alike.
        return `${symbol}=X`;

      case 'CRYPTO':
        return symbol.includes('-') ? symbol : `${symbol}-USD`;

      case 'STOCK':
      case 'ETF':
        // Default to NSE. BSE-only names carry an explicit providerSymbols entry.
        return symbol.includes('.') ? symbol : `${symbol}.NS`;

      case 'GOLD':
        return 'GC=F';

      default:
        return null;
    }
  }

  /** Yahoo's interval/range grammar. Intraday history is short — see docs. */
  private params(timeframe: Timeframe, limit: number): { interval: string; range: string } {
    const map: Record<Timeframe, { interval: string; maxDays: number }> = {
      '1m': { interval: '1m', maxDays: 7 },
      // Yahoo has no 3m interval. Mapped to 1m so the request still returns
      // usable bars; callers that need true 3m get it from Binance or not at all.
      '3m': { interval: '1m', maxDays: 7 },
      '5m': { interval: '5m', maxDays: 60 },
      '15m': { interval: '15m', maxDays: 60 },
      '30m': { interval: '30m', maxDays: 60 },
      '1h': { interval: '60m', maxDays: 730 },
      '4h': { interval: '60m', maxDays: 730 }, // aggregated client-side
      '1D': { interval: '1d', maxDays: 3650 },
      '1W': { interval: '1wk', maxDays: 3650 },
      '1M': { interval: '1mo', maxDays: 3650 },
    };

    const { interval, maxDays } = map[timeframe];
    const barsPerDay =
      timeframe === '1m' ? 375 : timeframe === '3m' ? 125 : timeframe === '5m' ? 75 : timeframe === '15m' ? 25 : timeframe === '30m' ? 13 : timeframe === '1h' ? 7 : 1;
    const neededDays = Math.ceil(limit / barsPerDay) * (timeframe === '1D' ? 1.5 : 1.4);
    const days = Math.min(Math.max(neededDays, 5), maxDays);

    const range =
      days <= 5 ? '5d' : days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo'
      : days <= 365 ? '1y' : days <= 730 ? '2y' : days <= 1825 ? '5y' : 'max';

    return { interval, range };
  }

  async getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null> {
    const symbol = this.yahooSymbol(instrument);
    if (!symbol) return null;

    try {
      const url = `${this.base}/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const data = await fetchJson<YahooChartResponse>(url, { timeoutMs: 8000 });

      const result = data?.chart?.result?.[0];
      if (!result?.meta) return null;

      const meta = result.meta;
      const price = meta.regularMarketPrice;
      const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
      if (!Number.isFinite(price)) return null;

      // The meta block doesn't carry today's OHLC, so take the last complete
      // row from the series.
      const quotes = result.indicators?.quote?.[0];
      const lastIndex = this.lastValidIndex(quotes?.close);

      const open = this.at(quotes?.open, lastIndex) ?? price;
      const high = this.at(quotes?.high, lastIndex) ?? price;
      const low = this.at(quotes?.low, lastIndex) ?? price;
      const volume = this.at(quotes?.volume, lastIndex) ?? 0;

      const change = price - previousClose;

      return {
        symbol: instrument.symbol,
        price,
        change,
        changePercent: previousClose ? (change / previousClose) * 100 : 0,
        open,
        high,
        low,
        previousClose,
        volume,
        yearHigh: meta.fiftyTwoWeekHigh ?? null,
        yearLow: meta.fiftyTwoWeekLow ?? null,
        currency: meta.currency === 'INR' ? 'INR' : 'USD',
        updatedAt: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
        source: this.name,
      };
    } catch (error) {
      this.logger.debug(`quote failed for ${symbol}: ${(error as Error).message}`);
      return null;
    }
  }

  async getCandles(
    instrument: InstrumentRef,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]> {
    const symbol = this.yahooSymbol(instrument);
    if (!symbol) return [];

    try {
      const { interval, range } = this.params(timeframe, limit);
      const url = `${this.base}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
      const data = await fetchJson<YahooChartResponse>(url, { timeoutMs: 12_000 });

      const result = data?.chart?.result?.[0];
      const timestamps = result?.timestamp;
      const quotes = result?.indicators?.quote?.[0];
      if (!timestamps || !quotes) return [];

      const candles: ProviderCandle[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const close = quotes.close?.[i];
        // Null rows are halted sessions or non-trading bars. Dropped rather
        // than forward-filled — a synthetic price is indistinguishable from a
        // real one once it reaches the analysis engine.
        if (close === null || close === undefined || !Number.isFinite(close)) continue;

        const open = quotes.open?.[i] ?? close;
        const high = quotes.high?.[i] ?? close;
        const low = quotes.low?.[i] ?? close;

        candles.push({
          time: timestamps[i],
          open,
          high: Math.max(open, high, low, close),
          low: Math.min(open, high, low, close),
          close,
          volume: quotes.volume?.[i] ?? 0,
        });
      }

      // Yahoo has no native 4h bar; aggregate from hourly.
      const series = timeframe === '4h' ? this.aggregate(candles, 4) : candles;
      return series.slice(-limit);
    } catch (error) {
      this.logger.debug(`candles failed for ${symbol}: ${(error as Error).message}`);
      return [];
    }
  }

  /** Combine N consecutive bars into one. */
  private aggregate(candles: ProviderCandle[], factor: number): ProviderCandle[] {
    const out: ProviderCandle[] = [];
    for (let i = 0; i < candles.length; i += factor) {
      const group = candles.slice(i, i + factor);
      if (group.length === 0) continue;
      out.push({
        time: group[0].time,
        open: group[0].open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((sum, c) => sum + c.volume, 0),
      });
    }
    return out;
  }

  private lastValidIndex(series: (number | null)[] | undefined): number {
    if (!series) return -1;
    for (let i = series.length - 1; i >= 0; i--) {
      const value = series[i];
      if (value !== null && value !== undefined && Number.isFinite(value)) return i;
    }
    return -1;
  }

  private at(series: (number | null)[] | undefined, index: number): number | null {
    if (!series || index < 0) return null;
    const value = series[index];
    return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
  }
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
        currency?: string;
        regularMarketTime?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        exchangeName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}
