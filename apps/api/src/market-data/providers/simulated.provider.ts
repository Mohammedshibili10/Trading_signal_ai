import { Injectable } from '@nestjs/common';

import {
  type InstrumentRef,
  type MarketDataProvider,
  type ProviderCandle,
  type ProviderQuote,
  type Timeframe,
} from './provider.interface';

/**
 * Deterministic offline market data — the last link in the provider chain.
 *
 * Why this exists: every upstream provider here is a free, undocumented or
 * rate-limited endpoint. Without a terminal fallback the app would show empty
 * charts the first time Yahoo rate-limits us, and would be unusable on a plane,
 * in CI, or behind a corporate proxy. This provider never fails.
 *
 * It is **not** a random number generator. Prices are derived from a seeded
 * hash of the symbol and the bar timestamp, so:
 *   - the same symbol always produces the same series
 *   - reloading the page does not reshuffle the chart
 *   - the analysis engine, calibration and backtester get a stable input
 *
 * Every quote it returns carries `source: 'simulated'`, and the UI labels it
 * explicitly. Nobody should ever mistake this for a real price.
 */
@Injectable()
export class SimulatedProvider implements MarketDataProvider {
  readonly name = 'simulated';

  supports(): boolean {
    return true;
  }

  /** Plausible starting price and volatility per instrument type. */
  private profile(instrument: InstrumentRef): { base: number; volatility: number; drift: number } {
    const seed = this.hash(instrument.symbol);

    switch (instrument.kind) {
      case 'INDEX':
        return { base: 18_000 + (seed % 8000), volatility: 0.008, drift: 0.0003 };
      case 'FOREX': {
        // INR crosses sit near 83; majors near parity.
        const isInr = instrument.symbol.toUpperCase().includes('INR');
        return {
          base: isInr ? 78 + (seed % 900) / 100 : 0.9 + (seed % 80) / 100,
          volatility: 0.004,
          drift: 0.00005,
        };
      }
      case 'CRYPTO': {
        const majors: Record<string, number> = { BTC: 62_000, ETH: 3200, SOL: 145, BNB: 580 };
        const symbol = instrument.symbol.toUpperCase();
        return {
          base: majors[symbol] ?? 1 + (seed % 20_000) / 100,
          volatility: 0.032,
          drift: 0.0006,
        };
      }
      case 'MUTUAL_FUND':
        return { base: 40 + (seed % 60_000) / 100, volatility: 0.006, drift: 0.00045 };
      case 'GOLD':
        return { base: 62_000 + (seed % 8000), volatility: 0.009, drift: 0.0003 };
      case 'BOND':
        return { base: 100 + (seed % 2000) / 100, volatility: 0.002, drift: 0.00025 };
      default:
        return { base: 150 + (seed % 350_000) / 100, volatility: 0.016, drift: 0.0004 };
    }
  }

  private secondsFor(timeframe: Timeframe): number {
    return (
      {
        '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
        '1h': 3600, '4h': 14_400, '1D': 86_400, '1W': 604_800, '1M': 2_592_000,
      } as Record<Timeframe, number>
    )[timeframe];
  }

  async getCandles(
    instrument: InstrumentRef,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]> {
    const { base, volatility, drift } = this.profile(instrument);
    const step = this.secondsFor(timeframe);

    // Anchor to a bar boundary so the series doesn't shift on every request.
    const now = Math.floor(Date.now() / 1000 / step) * step;
    const candles: ProviderCandle[] = [];

    let price = base;
    let currentVolatility = volatility;

    for (let i = limit - 1; i >= 0; i--) {
      const time = now - i * step;

      // Two independent noise streams: one for the return, one for volatility.
      const noise = this.noise(instrument.symbol, time, 1);
      const volNoise = this.noise(instrument.symbol, time, 2);

      // Volatility clustering — quiet periods follow quiet periods, which is
      // what makes ATR regimes and Bollinger squeezes behave realistically.
      currentVolatility = currentVolatility * 0.9 + volatility * (0.6 + volNoise * 0.8) * 0.1;

      const change = drift + noise * currentVolatility;
      const open = price;
      const close = open * (1 + change);

      // Wick size scales with the bar's own move, so wide-range bars get
      // proportionate shadows rather than uniform noise.
      const bodySpan = Math.abs(close - open);
      const wickScale = bodySpan + open * currentVolatility * 0.5;
      const upperWick = wickScale * Math.abs(this.noise(instrument.symbol, time, 3)) * 0.7;
      const lowerWick = wickScale * Math.abs(this.noise(instrument.symbol, time, 4)) * 0.7;

      const high = Math.max(open, close) + upperWick;
      const low = Math.max(0.01, Math.min(open, close) - lowerWick);

      // Volume correlates with range — the effort/result relationship the
      // Wyckoff factor depends on has to be present for it to mean anything.
      const rangeFactor = 1 + Math.abs(change) / Math.max(currentVolatility, 1e-6) / 3;
      const baseVolume =
        instrument.kind === 'FOREX' || instrument.kind === 'MUTUAL_FUND'
          ? 0
          : 250_000 * (1 + (this.hash(instrument.symbol) % 40) / 10);
      const volume = Math.round(
        baseVolume * rangeFactor * (0.6 + Math.abs(this.noise(instrument.symbol, time, 5)) * 0.9),
      );

      candles.push({
        time,
        open: this.round(open),
        high: this.round(high),
        low: this.round(low),
        close: this.round(close),
        volume,
      });

      price = close;
    }

    return candles;
  }

  async getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null> {
    // Derive the quote from the daily series so the price and the chart agree.
    const candles = await this.getCandles(instrument, '1D', 260);
    if (candles.length < 2) return null;

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const change = last.close - previous.close;

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const currency: 'INR' | 'USD' =
      instrument.assetClass === 'CRYPTO' ||
      (instrument.kind === 'FOREX' && !instrument.symbol.toUpperCase().includes('INR'))
        ? 'USD'
        : 'INR';

    return {
      symbol: instrument.symbol,
      price: last.close,
      change: this.round(change),
      changePercent: previous.close ? this.round((change / previous.close) * 100, 4) : 0,
      open: last.open,
      high: last.high,
      low: last.low,
      previousClose: previous.close,
      volume: last.volume,
      yearHigh: this.round(Math.max(...highs)),
      yearLow: this.round(Math.min(...lows)),
      marketCap:
        instrument.kind === 'STOCK'
          ? Math.round(last.close * (5_000_000 + (this.hash(instrument.symbol) % 900_000_000)))
          : null,
      currency,
      updatedAt: new Date().toISOString(),
      source: this.name,
    };
  }

  /**
   * Deterministic noise in roughly [-1.7, 1.7], approximately normal.
   *
   * Sum of three decorrelated hash streams — the central limit theorem does the
   * rest. A single uniform stream would give flat-tailed returns and produce
   * unrealistic ATR percentiles.
   */
  private noise(symbol: string, time: number, stream: number): number {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const h = this.hash(`${symbol}:${time}:${stream}:${k}`);
      sum += (h % 10_000) / 10_000 - 0.5;
    }
    return sum * 1.15;
  }

  /** FNV-1a. Fast, well-distributed, and stable across processes. */
  private hash(input: string): number {
    let hash = 2_166_136_261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
}
