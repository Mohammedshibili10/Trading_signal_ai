import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Instrument } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { calendarFor, isOpen, statusFor, type MarketStatus } from './market-hours';
import { RedisService } from '../redis/redis.service';
import { AmfiProvider } from './providers/amfi.provider';
import { BinanceProvider } from './providers/binance.provider';
import { FrankfurterProvider } from './providers/frankfurter.provider';
import { SimulatedProvider } from './providers/simulated.provider';
import { YahooProvider } from './providers/yahoo.provider';
import type {
  InstrumentRef,
  MarketDataProvider,
  ProviderCandle,
  ProviderQuote,
  Timeframe,
} from './providers/provider.interface';

export interface Quote extends ProviderQuote {
  name: string;
  assetClass: string;
  kind: string;
  exchange: string;
  isOpen: boolean;
  stale?: boolean;
}

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly chain: MarketDataProvider[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly yahoo: YahooProvider,
    private readonly binance: BinanceProvider,
    private readonly frankfurter: FrankfurterProvider,
    private readonly amfi: AmfiProvider,
    private readonly simulated: SimulatedProvider,
  ) {
    const configured = this.config.get<string[]>('marketData.providers') ?? ['yahoo', 'simulated'];
    const registry: Record<string, MarketDataProvider> = {
      yahoo: this.yahoo,
      binance: this.binance,
      frankfurter: this.frankfurter,
      amfi: this.amfi,
      simulated: this.simulated,
    };

    // Category-native providers go first regardless of configured order —
    // Binance is strictly better than Yahoo for crypto candles, and AMFI is the
    // only correct source for a NAV.
    this.chain = [this.binance, this.amfi];

    for (const name of configured) {
      const provider = registry[name];
      if (provider && !this.chain.includes(provider)) {
        this.chain.push(provider);
      } else if (!provider) {
        this.logger.warn(`unknown market data provider "${name}" — ignoring`);
      }
    }

    // The simulated provider must always terminate the chain. Without it a
    // provider outage renders empty charts instead of degraded ones.
    if (!this.chain.includes(this.simulated)) this.chain.push(this.simulated);

    this.logger.log(`provider chain: ${this.chain.map((p) => p.name).join(' → ')}`);
  }

  // ── Quotes ─────────────────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    const instrument = await this.findInstrument(symbol);
    const ttl = this.quoteTtl(instrument);

    return this.redis.wrap(`quote:${instrument.symbol}`, ttl, async () => {
      const quote = await this.resolveQuote(instrument);
      return this.decorate(quote, instrument);
    });
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
    // Settled, not all — one dead symbol must not blank an entire watchlist.
    const results = await Promise.allSettled(unique.map((symbol) => this.getQuote(symbol)));
    return results
      .filter((r): r is PromiseFulfilledResult<Quote> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  private async resolveQuote(instrument: Instrument): Promise<ProviderQuote> {
    const ref = this.toRef(instrument);

    for (const provider of this.chain) {
      if (!provider.supports(ref)) continue;

      const started = Date.now();
      try {
        const quote = await provider.getQuote(ref);
        if (quote && Number.isFinite(quote.price) && quote.price > 0) {
          void this.recordHealth(provider.name, true, Date.now() - started);
          return quote;
        }
      } catch (error) {
        void this.recordHealth(provider.name, false, Date.now() - started, (error as Error).message);
      }
    }

    // Unreachable in practice — the simulated provider cannot fail — but a
    // clear error beats a confusing undefined if the chain is misconfigured.
    throw new NotFoundException(`No provider could quote ${instrument.symbol}`);
  }

  /**
   * Last known price, served when every provider fails.
   *
   * A stale price flagged as stale is more useful than a spinner: the user can
   * still see their position, and the UI shows when it was last live.
   */
  private async lastKnownQuote(instrument: Instrument): Promise<Quote | null> {
    const stored = await this.prisma.quote.findUnique({
      where: { instrumentId: instrument.id },
    });
    if (!stored) return null;

    return this.decorate(
      {
        symbol: instrument.symbol,
        price: Number(stored.price),
        change: Number(stored.change),
        changePercent: Number(stored.changePercent),
        open: Number(stored.open),
        high: Number(stored.high),
        low: Number(stored.low),
        previousClose: Number(stored.previousClose),
        volume: Number(stored.volume),
        marketCap: stored.marketCap ? Number(stored.marketCap) : null,
        yearHigh: stored.yearHigh ? Number(stored.yearHigh) : null,
        yearLow: stored.yearLow ? Number(stored.yearLow) : null,
        currency: instrument.currency,
        updatedAt: stored.updatedAt.toISOString(),
        source: stored.source,
      },
      instrument,
      true,
    );
  }

  // ── Candles ────────────────────────────────────────────────────

  async getCandles(
    symbol: string,
    timeframe: Timeframe = '1D',
    limit = 300,
  ): Promise<{ symbol: string; timeframe: Timeframe; candles: ProviderCandle[]; source: string }> {
    const instrument = await this.findInstrument(symbol);
    const capped = Math.min(Math.max(limit, 20), 2000);
    const ttl = this.candleTtl(timeframe);

    return this.redis.wrap(
      `candles:${instrument.symbol}:${timeframe}:${capped}`,
      ttl,
      async () => {
        const ref = this.toRef(instrument);

        for (const provider of this.chain) {
          if (!provider.supports(ref)) continue;

          const started = Date.now();
          try {
            const candles = await provider.getCandles(ref, timeframe, capped);
            // A handful of bars usually means the provider silently truncated
            // an unsupported range — fall through rather than analyse noise.
            if (candles.length >= Math.min(20, capped)) {
              void this.recordHealth(provider.name, true, Date.now() - started);
              void this.persistCandles(instrument, timeframe, candles, provider.name);
              return {
                symbol: instrument.symbol,
                timeframe,
                candles,
                source: provider.name,
              };
            }
          } catch (error) {
            void this.recordHealth(
              provider.name,
              false,
              Date.now() - started,
              (error as Error).message,
            );
          }
        }

        return { symbol: instrument.symbol, timeframe, candles: [], source: 'none' };
      },
    );
  }

  /**
   * Depth snapshot from the first provider in the chain that has a real book.
   *
   * Returns null rather than a synthesised book when no venue publishes one.
   * Inventing depth from a bid/ask pair would produce the most authoritative-
   * looking and least trustworthy object on the screen.
   */
  async getOrderBook(symbol: string, depth = 100) {
    const instrument = await this.findInstrument(symbol);
    const ref = this.toRef(instrument);

    // Cached briefly — the book moves constantly, but every user asking about
    // the same symbol within a few seconds should not each hit the venue.
    return this.redis.wrap(`book:${instrument.symbol}:${depth}`, 5, async () => {
      for (const provider of this.chain) {
        if (!provider.getOrderBook || !provider.supports(ref)) continue;
        try {
          const book = await provider.getOrderBook(ref, depth);
          if (book && book.bids.length > 0 && book.asks.length > 0) return book;
        } catch {
          // Try the next provider; depth is an enhancement, not a requirement.
        }
      }
      return null;
    });
  }

  /**
   * Funding, open interest and positioning from the first venue that has them.
   *
   * Cached for five minutes rather than seconds: funding settles every eight
   * hours and the open-interest series is hourly, so a fresher read would cost
   * requests without telling us anything new.
   *
   * Null is a normal answer — only crypto has a perpetuals market, and the
   * analysis drops the group rather than scoring its absence.
   */
  async getDerivatives(symbol: string) {
    const instrument = await this.findInstrument(symbol);
    if (instrument.assetClass !== 'CRYPTO') return null;
    const ref = this.toRef(instrument);

    return this.redis.wrap(`derivatives:${instrument.symbol}`, 300, async () => {
      for (const provider of this.chain) {
        if (!provider.getDerivatives || !provider.supports(ref)) continue;
        try {
          const data = await provider.getDerivatives(ref);
          if (data) return data;
        } catch {
          // Supplementary context — never worth failing an analysis over.
        }
      }
      return null;
    });
  }

  // ── Instruments ────────────────────────────────────────────────

  async findInstrument(symbol: string): Promise<Instrument> {
    const normalised = symbol.toUpperCase().trim();
    const instrument = await this.prisma.instrument.findUnique({
      where: { symbol: normalised },
    });
    if (!instrument) {
      throw new NotFoundException(
        `Unknown symbol "${normalised}". This platform covers NSE/BSE equities, forex, crypto and Indian investment products.`,
      );
    }
    return instrument;
  }

  async search(query: string, assetClass?: string, limit = 20) {
    const term = query.trim();
    if (term.length < 1) return [];

    return this.prisma.instrument.findMany({
      where: {
        isActive: true,
        ...(assetClass ? { assetClass: assetClass as never } : {}),
        OR: [
          { symbol: { startsWith: term, mode: 'insensitive' } },
          { symbol: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
        ],
      },
      // Symbol prefix matches are what people actually mean when they type.
      orderBy: [{ symbol: 'asc' }],
      take: Math.min(limit, 50),
      select: {
        symbol: true, name: true, assetClass: true, kind: true,
        exchange: true, currency: true, sector: true,
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────

  private toRef(instrument: Instrument): InstrumentRef {
    return {
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      kind: instrument.kind,
      providerSymbols: instrument.providerSymbols as Record<string, string | null> | null,
    };
  }

  private decorate(quote: ProviderQuote, instrument: Instrument, stale = false): Quote {
    return {
      ...quote,
      symbol: instrument.symbol,
      name: instrument.name,
      assetClass: instrument.assetClass,
      kind: instrument.kind,
      exchange: instrument.exchange,
      currency: instrument.currency,
      isOpen: this.isMarketOpen(instrument.assetClass),
      ...(stale ? { stale: true } : {}),
    };
  }

  /**
   * Cache TTL by venue state.
   *
   * Fifteen seconds while a market is open; fifteen minutes once it closes,
   * because the price is not going to change and re-polling a closed venue is
   * pure waste against a rate limit.
   */
  private quoteTtl(instrument: Instrument): number {
    const base = this.config.get<number>('marketData.quoteCacheTtl') ?? 15;
    return this.isMarketOpen(instrument.assetClass) ? base : 900;
  }

  private candleTtl(timeframe: Timeframe): number {
    const base = this.config.get<number>('marketData.candleCacheTtl') ?? 300;
    // A daily bar only changes once a day; caching it for five minutes wastes
    // upstream quota for no freshness gain.
    if (timeframe === '1D') return 43_200;
    if (timeframe === '1W' || timeframe === '1M') return 86_400;
    if (timeframe === '1m') return 60;
    return base;
  }

  /**
   * Whether the venue is open right now.
   *
   * Delegates to the market-hours module rather than re-deriving the rules.
   * This method previously carried its own copy, and that copy had forex
   * opening on Sunday morning IST — a full day early, because it converted a
   * boundary defined in New York time into IST by hand. Exchange-aware
   * callers should prefer `statusFor`, which also distinguishes pre-market and
   * after-hours; this signature is kept because a dozen call sites only need
   * the boolean.
   */
  isMarketOpen(assetClass: string, now = new Date()): boolean {
    return isOpen(null, assetClass, now);
  }

  /** Full status for an instrument, resolved to its actual exchange. */
  async marketStatus(symbol: string, now = new Date()): Promise<MarketStatus> {
    const instrument = await this.findInstrument(symbol);
    return statusFor(calendarFor(instrument.exchange, instrument.assetClass), now);
  }

  /** Write candles through to Postgres. Fire-and-forget; never blocks a read. */
  private async persistCandles(
    instrument: Instrument,
    timeframe: Timeframe,
    candles: ProviderCandle[],
    source: string,
  ): Promise<void> {
    if (candles.length === 0) return;

    try {
      const tf = this.toPrismaTimeframe(timeframe);
      // Only the recent tail — persisting 2000 bars on every request would cost
      // far more than it saves.
      const recent = candles.slice(-120);

      await this.prisma.candle.createMany({
        data: recent.map((candle) => ({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          timeframe: tf,
          time: new Date(candle.time * 1000),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          source,
        })),
        // The unique constraint on (instrument, timeframe, time) makes this
        // idempotent across overlapping provider windows.
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.debug(`candle persist failed: ${(error as Error).message}`);
    }
  }

  private toPrismaTimeframe(timeframe: Timeframe) {
    return (
      {
        '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
        '1h': 'H1', '4h': 'H4', '1D': 'D1', '1W': 'W1', '1M': 'MN1',
      } as const
    )[timeframe];
  }

  /** Provider health, surfaced in the admin panel. */
  private async recordHealth(
    provider: string,
    ok: boolean,
    latencyMs: number,
    error?: string,
  ): Promise<void> {
    try {
      const existing = await this.prisma.providerHealth.findUnique({ where: { provider } });
      const count = (existing?.requestCount ?? 0) + 1;
      // Exponential moving average — a single slow call shouldn't dominate.
      const average = existing
        ? Math.round(existing.averageLatencyMs * 0.9 + latencyMs * 0.1)
        : latencyMs;

      await this.prisma.providerHealth.upsert({
        where: { provider },
        create: {
          provider,
          isHealthy: ok,
          lastSuccessAt: ok ? new Date() : null,
          lastFailureAt: ok ? null : new Date(),
          consecutiveFailures: ok ? 0 : 1,
          lastError: ok ? null : error?.slice(0, 300),
          averageLatencyMs: latencyMs,
          requestCount: 1,
        },
        update: {
          isHealthy: ok,
          ...(ok
            ? { lastSuccessAt: new Date(), consecutiveFailures: 0, lastError: null }
            : {
                lastFailureAt: new Date(),
                consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
                lastError: error?.slice(0, 300),
              }),
          averageLatencyMs: average,
          requestCount: count,
        },
      });
    } catch {
      /* health tracking must never affect the request */
    }
  }

  /** Store the latest quote so `lastKnownQuote` has something to serve. */
  async persistQuote(symbol: string, quote: Quote): Promise<void> {
    try {
      const instrument = await this.findInstrument(symbol);
      await this.prisma.quote.upsert({
        where: { instrumentId: instrument.id },
        create: {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          previousClose: quote.previousClose,
          volume: quote.volume,
          marketCap: quote.marketCap ?? null,
          yearHigh: quote.yearHigh ?? null,
          yearLow: quote.yearLow ?? null,
          source: quote.source,
        },
        update: {
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          previousClose: quote.previousClose,
          volume: quote.volume,
          marketCap: quote.marketCap ?? null,
          source: quote.source,
          isStale: false,
          updatedAt: new Date(),
        },
      });
    } catch {
      /* best effort */
    }
  }

  /** Cheap fallback path used by the realtime gateway. */
  async getQuoteOrLastKnown(symbol: string): Promise<Quote | null> {
    try {
      return await this.getQuote(symbol);
    } catch {
      const instrument = await this.prisma.instrument
        .findUnique({ where: { symbol: symbol.toUpperCase() } })
        .catch(() => null);
      return instrument ? this.lastKnownQuote(instrument) : null;
    }
  }
}
