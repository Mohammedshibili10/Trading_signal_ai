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
 * Frankfurter — central-bank FX reference rates. Free, no key, no rate limit.
 *
 * Important limitation: **daily granularity only**. One reference fix per
 * working day, published around 16:00 CET, with no weekend rows and no bid/ask.
 * So this provider serves 1D and above; intraday forex falls through to Yahoo
 * or the simulated provider.
 *
 * Endpoints: docs/data-sources.md §2.1
 */
@Injectable()
export class FrankfurterProvider implements MarketDataProvider {
  readonly name = 'frankfurter';
  private readonly logger = new Logger(FrankfurterProvider.name);
  private readonly base = 'https://api.frankfurter.dev/v2';

  private readonly dailyOrLonger = new Set<Timeframe>(['1D', '1W', '1M']);

  supports(instrument: InstrumentRef): boolean {
    return instrument.assetClass === 'FOREX';
  }

  /** "USDINR" → { base: "USD", quote: "INR" } */
  private split(symbol: string): { base: string; quote: string } | null {
    const clean = symbol.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length !== 6) return null;
    return { base: clean.slice(0, 3), quote: clean.slice(3) };
  }

  async getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null> {
    if (!this.supports(instrument)) return null;

    const pair = this.split(instrument.symbol);
    if (!pair) return null;

    try {
      // Ask for a short window rather than just the latest, so we have a
      // previous close to compute the change from. A quote with change: 0
      // because we only fetched one row is worse than no quote.
      const to = new Date();
      const from = new Date(to.getTime() - 10 * 86_400_000);

      const url =
        `${this.base}/rates?from=${this.iso(from)}&to=${this.iso(to)}` +
        `&base=${pair.base}&quotes=${pair.quote}`;

      const data = await fetchJson<FrankfurterSeries>(url, { timeoutMs: 8000 });
      const series = this.toSeries(data, pair.quote);
      if (series.length < 1) return null;

      const last = series[series.length - 1];
      const previous = series.length > 1 ? series[series.length - 2] : last;
      const change = last.rate - previous.rate;

      const window = series.slice(-260).map((row) => row.rate);

      return {
        symbol: instrument.symbol,
        price: last.rate,
        change,
        changePercent: previous.rate ? (change / previous.rate) * 100 : 0,
        open: previous.rate,
        high: Math.max(last.rate, previous.rate),
        low: Math.min(last.rate, previous.rate),
        previousClose: previous.rate,
        volume: 0, // reference rates carry no volume
        yearHigh: window.length ? Math.max(...window) : null,
        yearLow: window.length ? Math.min(...window) : null,
        currency: pair.quote === 'INR' ? 'INR' : 'USD',
        updatedAt: new Date(`${last.date}T16:00:00Z`).toISOString(),
        source: this.name,
      };
    } catch (error) {
      this.logger.debug(`quote failed for ${instrument.symbol}: ${(error as Error).message}`);
      return null;
    }
  }

  async getCandles(
    instrument: InstrumentRef,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]> {
    // Refuse intraday outright rather than returning daily bars mislabelled as
    // hourly — silently wrong data is worse than none.
    if (!this.supports(instrument) || !this.dailyOrLonger.has(timeframe)) return [];

    const pair = this.split(instrument.symbol);
    if (!pair) return [];

    try {
      const days = timeframe === '1D' ? limit * 1.5 : timeframe === '1W' ? limit * 8 : limit * 32;
      const to = new Date();
      const from = new Date(to.getTime() - Math.ceil(days) * 86_400_000);

      const group = timeframe === '1W' ? '&group=week' : timeframe === '1M' ? '&group=month' : '';
      const url =
        `${this.base}/rates?from=${this.iso(from)}&to=${this.iso(to)}` +
        `&base=${pair.base}&quotes=${pair.quote}${group}`;

      const data = await fetchJson<FrankfurterSeries>(url, { timeoutMs: 12_000 });
      const series = this.toSeries(data, pair.quote);

      // A single daily fix has no intrabar shape. Open comes from the previous
      // close so the series is continuous; high/low bracket the two. This is an
      // honest reconstruction, not invented volatility.
      return series
        .map((row, index) => {
          const open = index > 0 ? series[index - 1].rate : row.rate;
          return {
            time: Math.floor(new Date(`${row.date}T00:00:00Z`).getTime() / 1000),
            open,
            high: Math.max(open, row.rate),
            low: Math.min(open, row.rate),
            close: row.rate,
            volume: 0,
          };
        })
        .slice(-limit);
    } catch (error) {
      this.logger.debug(`candles failed for ${instrument.symbol}: ${(error as Error).message}`);
      return [];
    }
  }

  private toSeries(data: FrankfurterSeries, quote: string): Array<{ date: string; rate: number }> {
    // The API returns either `rates` keyed by date (range query) or a flat
    // `rates` object (single date). Normalise both.
    const rates = data?.rates;
    if (!rates) return [];

    const rows: Array<{ date: string; rate: number }> = [];

    for (const [key, value] of Object.entries(rates)) {
      if (typeof value === 'number') {
        // Flat shape: { "INR": 83.42 } with a top-level date.
        if (key === quote && data.date) rows.push({ date: data.date, rate: value });
      } else if (value && typeof value === 'object') {
        const rate = (value as Record<string, number>)[quote];
        if (Number.isFinite(rate)) rows.push({ date: key, rate });
      }
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  private iso(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

interface FrankfurterSeries {
  base?: string;
  date?: string;
  rates?: Record<string, number | Record<string, number>>;
}
