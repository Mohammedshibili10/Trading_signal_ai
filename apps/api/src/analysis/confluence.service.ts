import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { ProviderCandle, Timeframe } from '../market-data/providers/provider.interface';
import { AiClientService } from './ai-client.service';
import { ReviewService } from './review.service';

export type Horizon = 'INTRADAY' | 'SWING' | 'POSITIONAL' | 'LONG_TERM';

/** Which timeframes each horizon votes on. Mirrors the engine's own table. */
const HORIZON_TIMEFRAMES: Record<Horizon, Timeframe[]> = {
  INTRADAY: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D'],
  SWING: ['15m', '30m', '1h', '4h', '1D', '1W'],
  POSITIONAL: ['1h', '4h', '1D', '1W', '1M'],
  LONG_TERM: ['4h', '1D', '1W', '1M'],
};

/**
 * How many bars to request per timeframe.
 *
 * Enough for the moving averages and swing detection the engine needs, not so
 * many that a ten-timeframe fetch becomes a minute of provider calls. 200 is
 * the point where an EMA-200 becomes computable, which is what sets the floor.
 */
const BARS_PER_TIMEFRAME = 220;

/** Timeframes that make no sense for a given category. */
const UNSUPPORTED: Record<string, Timeframe[]> = {
  // A NAV publishes once a day. Anything intraday would be interpolation.
  INVESTMENT: ['1m', '3m', '5m', '15m', '30m', '1h', '4h'],
  // Only Binance serves a native 3-minute bar.
  EQUITY: ['3m'],
  FOREX: ['3m'],
};

@Injectable()
export class ConfluenceService {
  private readonly logger = new Logger(ConfluenceService.name);

  constructor(
    private readonly ai: AiClientService,
    private readonly marketData: MarketDataService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly review: ReviewService,
  ) {}

  /** Timeframes worth fetching for this instrument and horizon. */
  timeframesFor(assetClass: string, horizon: Horizon): Timeframe[] {
    const excluded = new Set(UNSUPPORTED[assetClass] ?? []);
    return HORIZON_TIMEFRAMES[horizon].filter((timeframe) => !excluded.has(timeframe));
  }

  /**
   * Fetch every timeframe in parallel.
   *
   * `allSettled`, not `all` — one timeframe a provider cannot serve must not
   * empty the whole set. A missing timeframe simply does not vote, which the
   * engine handles explicitly; a failed fetch that took the others with it
   * would silently turn a ten-timeframe confirmation into no confirmation.
   */
  private async fetchAll(
    symbol: string,
    timeframes: Timeframe[],
  ): Promise<{ candles: Record<string, ProviderCandle[]>; missing: string[] }> {
    const results = await Promise.allSettled(
      timeframes.map(async (timeframe) => {
        const { candles } = await this.marketData.getCandles(symbol, timeframe, BARS_PER_TIMEFRAME);
        return { timeframe, candles };
      }),
    );

    const candles: Record<string, ProviderCandle[]> = {};
    const missing: string[] = [];

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value.candles.length >= 40) {
        candles[result.value.timeframe] = result.value.candles;
      } else {
        missing.push(timeframes[index]);
      }
    }

    return { candles, missing };
  }

  /**
   * Multi-timeframe agreement, with no trade attached.
   *
   * Cached briefly: the answer is identical for every user, and a ten-timeframe
   * fetch is the most expensive read in the platform.
   */
  async confluence(symbol: string, horizon: Horizon = 'SWING', setupTimeframe: Timeframe = '1D') {
    const instrument = await this.marketData.findInstrument(symbol);
    const key = `confluence:${instrument.symbol}:${horizon}:${setupTimeframe}`;

    return this.redis.wrap(key, 120, async () => {
      const timeframes = this.timeframesFor(instrument.assetClass, horizon);
      const { candles, missing } = await this.fetchAll(instrument.symbol, timeframes);

      if (Object.keys(candles).length < 2) {
        throw new BadRequestException(
          `Only ${Object.keys(candles).length} timeframe(s) have usable history for ` +
            `${instrument.symbol}. Multi-timeframe confirmation needs at least two.`,
        );
      }

      const result = await this.ai.post<Record<string, unknown>>('/analysis/confluence', {
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        setupTimeframe,
        horizon,
        candlesByTimeframe: candles,
      });

      return { ...result, requested: timeframes, unavailable: missing };
    });
  }

  /**
   * A full analysis that may only issue a signal when the timeframes agree.
   *
   * This is the strict path the autonomous scanner uses. The setup timeframe is
   * analysed in full — indicators, structure, patterns, forecast — and the
   * result is then gated: conflicting timeframes force WAIT rather than
   * producing a low-confidence trade nobody should take.
   */
  async gatedSignal(
    symbol: string,
    timeframe: Timeframe = '1D',
    options: {
      horizon?: Horizon;
      riskPerTrade?: number;
      enforce?: boolean;
      /** Whose open positions to correlate against. Omit for an unowned read. */
      userId?: string;
      applySessionFilter?: boolean;
    } = {},
  ) {
    const instrument = await this.marketData.findInstrument(symbol);
    const horizon = options.horizon ?? this.horizonFor(timeframe);
    const enforce = options.enforce ?? true;

    // The cache key carries the user, because the correlation check makes the
    // answer user-specific — two people can get different verdicts on the same
    // instrument, and serving one the other's result would be wrong.
    const scope = options.userId ?? 'anon';
    const key = `gated:${instrument.symbol}:${timeframe}:${horizon}:${enforce ? 'strict' : 'soft'}:${scope}`;

    return this.redis.wrap(key, 120, async () => {
      const timeframes = this.timeframesFor(instrument.assetClass, horizon).filter(
        (item) => item !== timeframe,
      );

      const [
        setup,
        others,
        news,
        fundamentals,
        economicEvents,
        positions,
        outcomes,
        factorWeights,
        orderBook,
      ] = await Promise.all([
          this.marketData.getCandles(instrument.symbol, timeframe, 400),
          this.fetchAll(instrument.symbol, timeframes),
          this.recentNews(instrument.symbol),
          this.fundamentalsFor(instrument.symbol, instrument.assetClass),
          this.upcomingEvents(instrument.assetClass),
          this.openPositions(options.userId, instrument.symbol),
          this.resolvedOutcomes(),
          this.review.activeWeights(),
          instrument.assetClass === 'CRYPTO'
            ? this.marketData.getOrderBook(instrument.symbol).catch(() => null)
            : Promise.resolve(null),
        ]);

      if (setup.candles.length < 60) {
        throw new BadRequestException(
          `Only ${setup.candles.length} bars available for ${instrument.symbol} on ${timeframe}.`,
        );
      }

      return this.ai.post('/analysis/signal/confluence', {
        symbol: instrument.symbol,
        name: instrument.name,
        assetClass: instrument.assetClass,
        timeframe,
        horizon,
        candles: setup.candles,
        candlesByTimeframe: others.candles,
        news,
        fundamentals,
        economicEvents,
        orderBook,
        openPositions: positions.positions,
        returnsBySymbol: positions.returns,
        outcomes,
        applySessionFilter: options.applySessionFilter ?? true,
        factorWeights,
        riskPerTradePercent: options.riskPerTrade ?? 1,
        enforceConfluence: enforce,
        // Calibration is what makes a confidence number mean anything, and this
        // path exists precisely to produce trustworthy numbers.
        withCalibration: true,
      });
    });
  }

  /** The horizon a timeframe implies, when the caller doesn't say. */
  horizonFor(timeframe: Timeframe): Horizon {
    if (['1m', '3m', '5m', '15m'].includes(timeframe)) return 'INTRADAY';
    if (['30m', '1h', '4h'].includes(timeframe)) return 'SWING';
    if (timeframe === '1D') return 'POSITIONAL';
    return 'LONG_TERM';
  }

  /**
   * Scheduled events in the next 48 hours.
   *
   * Returns null — not an empty array — when the calendar itself is
   * unreachable. The engine treats null as "unverified" and an empty array as
   * "verified clear", and conflating the two would mean a database hiccup
   * silently reported every setup as news-free.
   */
  private async upcomingEvents(assetClass: string) {
    // A currency pair does not care about an Indian earnings calendar, but it
    // very much cares about a central bank decision — which is what this table
    // holds, so the same set applies to every category.
    try {
      const now = Date.now();
      const events = await this.prisma.economicEvent.findMany({
        where: {
          scheduledAt: { gte: new Date(now), lte: new Date(now + 48 * 3_600_000) },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 20,
        select: { title: true, importance: true, scheduledAt: true },
      });

      return events.map((event) => ({
        title: event.title,
        importance: event.importance,
        hoursUntil: (event.scheduledAt.getTime() - now) / 3_600_000,
      }));
    } catch {
      return null;
    }
  }

  /**
   * What the user already holds, plus enough return history to measure
   * correlation properly rather than inferring it from sector labels.
   *
   * Live signals count as positions. A signal you are about to act on carries
   * the same correlation risk as one you already acted on, and only counting
   * filled positions would let three correlated signals through in one pass.
   */
  private async openPositions(userId: string | undefined, exclude: string) {
    if (!userId) return { positions: [], returns: {} as Record<string, number[]> };

    try {
      const [holdings, signals] = await Promise.all([
        this.prisma.holding.findMany({
          where: { userId, symbol: { not: exclude } },
          select: {
            symbol: true,
            quantity: true,
            instrument: { select: { assetClass: true, sector: true } },
          },
          take: 40,
        }),
        this.prisma.signal.findMany({
          where: {
            status: { in: ['ACTIVE', 'HIT_T1', 'HIT_T2'] },
            symbol: { not: exclude },
            validUntil: { gt: new Date() },
          },
          select: {
            symbol: true,
            action: true,
            riskPercent: true,
            assetClass: true,
            instrument: { select: { sector: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
      ]);

      const positions = [
        ...holdings.map((h) => ({
          symbol: h.symbol,
          assetClass: h.instrument?.assetClass ?? 'EQUITY',
          sector: h.instrument?.sector ?? null,
          // A holding is long by construction — this platform records no shorts.
          action: 'BUY',
          riskPercent: 1,
        })),
        ...signals.map((s) => ({
          symbol: s.symbol,
          assetClass: s.assetClass,
          sector: s.instrument?.sector ?? null,
          action: s.action,
          riskPercent: Number(s.riskPercent) || 1,
        })),
      ];

      // Deduplicate — a symbol both held and signalled is one exposure.
      const unique = new Map(positions.map((p) => [p.symbol, p]));
      const list = [...unique.values()].slice(0, 30);

      const returns = await this.returnsFor([exclude, ...list.map((p) => p.symbol)]);
      return { positions: list, returns };
    } catch {
      return { positions: [], returns: {} as Record<string, number[]> };
    }
  }

  /**
   * Daily log returns per symbol, for measured correlation.
   *
   * Reads the cached candle path, so this costs nothing beyond what the
   * platform already fetched. Symbols without enough history simply fall back
   * to structural correlation in the engine.
   */
  private async returnsFor(symbols: string[]): Promise<Record<string, number[]>> {
    const unique = [...new Set(symbols)].slice(0, 20);

    const results = await Promise.allSettled(
      unique.map(async (symbol) => {
        const { candles } = await this.marketData.getCandles(symbol, '1D', 90);
        if (candles.length < 35) return null;
        const series: number[] = [];
        for (let i = 1; i < candles.length; i += 1) {
          const previous = candles[i - 1].close;
          if (previous > 0) series.push((candles[i].close - previous) / previous);
        }
        return { symbol, series };
      }),
    );

    const out: Record<string, number[]> = {};
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        out[result.value.symbol] = result.value.series;
      }
    }
    return out;
  }

  /**
   * The realised record — every signal this engine issued that has resolved.
   *
   * Platform-wide rather than per-user on purpose: the thing being learned is
   * how *the engine* performs, and that is the same engine for everyone. A
   * per-user record would take far longer to reach a usable sample size and
   * would measure the user's watchlist, not the model.
   */
  private async resolvedOutcomes() {
    try {
      const signals = await this.prisma.signal.findMany({
        where: { status: { in: ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED'] } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          symbol: true,
          timeframe: true,
          action: true,
          confidence: true,
          status: true,
          riskRewardRatio: true,
        },
      });

      const toTimeframe: Record<string, string> = {
        M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
        H1: '1h', H4: '4h', D1: '1D', W1: '1W', MN1: '1M',
      };

      return signals.map((s) => ({
        symbol: s.symbol,
        timeframe: toTimeframe[s.timeframe] ?? '1D',
        action: s.action,
        confidence: Number(s.confidence),
        status: s.status,
        riskRewardRatio: Number(s.riskRewardRatio),
      }));
    } catch {
      return [];
    }
  }

  private async recentNews(symbol: string) {
    try {
      const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
      const items = await this.prisma.newsItem.findMany({
        where: { symbols: { has: symbol }, publishedAt: { gte: cutoff } },
        orderBy: { publishedAt: 'desc' },
        take: 12,
        select: { headline: true, summary: true, source: true, publishedAt: true },
      });

      return items.map((item) => ({
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        ageHours: (Date.now() - item.publishedAt.getTime()) / 3_600_000,
      }));
    } catch {
      return [];
    }
  }

  private async fundamentalsFor(symbol: string, assetClass: string) {
    if (assetClass !== 'EQUITY' && assetClass !== 'INVESTMENT') return null;

    try {
      const record = await this.prisma.fundamentals.findFirst({ where: { symbol } });
      if (!record) return null;

      return {
        scores: {
          quality: record.qualityScore ? Number(record.qualityScore) : null,
          valuation: record.valuationScore ? Number(record.valuationScore) : null,
          growth: record.growthScore ? Number(record.growthScore) : null,
          investment: record.investmentScore ? Number(record.investmentScore) : null,
        },
        longTermRating: record.longTermRating,
        summary: record.summary,
      };
    } catch {
      return null;
    }
  }
}
