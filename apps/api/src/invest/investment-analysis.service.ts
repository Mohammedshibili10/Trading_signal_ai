import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AiClientService } from '../analysis/ai-client.service';
import { AnalysisService } from '../analysis/analysis.service';
import { MarketDataService } from '../market-data/market-data.service';
import { prioritise } from '../market-data/asset-priority';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Investment analysis.
 *
 * Kept apart from the trading services on purpose. The two produce different
 * kinds of claim on different horizons, and a user who cannot tell a signal
 * from an investment recommendation will eventually treat one as the other.
 */
@Injectable()
export class InvestmentAnalysisService {
  private readonly logger = new Logger('Investment');

  constructor(
    private readonly ai: AiClientService,
    private readonly analysis: AnalysisService,
    private readonly marketData: MarketDataService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Fundamentals for one symbol, flattened into the shape the engine wants. */
  private async fundamentalsFor(symbol: string) {
    const record = await this.prisma.fundamentals.findFirst({
      where: { symbol },
      include: { instrument: { select: { name: true, sector: true, assetClass: true } } },
    });
    if (!record) return null;

    const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));

    return {
      symbol: record.symbol,
      name: record.instrument?.name,
      sector: record.instrument?.sector,
      assetClass: record.instrument?.assetClass,
      marketCap: n(record.marketCap),
      pe: n(record.pe),
      pb: n(record.pb),
      industryPe: n(record.industryPe),
      evEbitda: n(record.evEbitda),
      dividendYield: n(record.dividendYield),
      roe: n(record.roe),
      roce: n(record.roce),
      netMargin: n(record.netMargin),
      operatingMargin: n(record.operatingMargin),
      revenueGrowth: n(record.revenueGrowth),
      profitGrowth: n(record.profitGrowth),
      epsGrowth: n(record.epsGrowth),
      debtToEquity: n(record.debtToEquity),
      interestCoverage: n(record.interestCoverage),
      currentRatio: n(record.currentRatio),
      eps: n(record.eps),
      bookValue: n(record.bookValue),
      operatingCashFlow: n(record.operatingCashFlow),
      freeCashFlow: n(record.freeCashFlow),
      promoterHolding: n(record.promoterHolding),
      promoterPledge: n(record.promoterPledge),
      fiiHolding: n(record.fiiHolding),
      diiHolding: n(record.diiHolding),
      publicHolding: n(record.publicHolding),
      quarterly: record.quarterly,
      annual: record.annual,
      strengths: record.strengths,
      concerns: record.concerns,
    };
  }

  /**
   * Full investment view for one instrument.
   *
   * The technical read is fetched but used only for entry timing — never to
   * form the thesis. A downtrend turns a buy into an accumulate; it never
   * turns a good business into a bad one.
   */
  async analyseSymbol(symbol: string, options: { ethicalMode?: boolean } = {}) {
    const instrument = await this.marketData.findInstrument(symbol);
    const ethical = options.ethicalMode ?? false;

    return this.redis.wrap(
      `investment:${instrument.symbol}:${ethical ? 'ethical' : 'all'}`,
      15 * 60,
      async () => {
        const data = await this.fundamentalsFor(instrument.symbol);
        if (!data) {
          throw new BadRequestException(
            `No fundamentals on file for ${instrument.symbol}. Investment analysis needs ` +
              'reported financials; only equities and investment products carry them.',
          );
        }

        const [quote, peers, technical] = await Promise.all([
          this.marketData.getQuote(instrument.symbol).catch(() => null),
          this.peersFor(instrument.symbol, data.sector ?? null),
          // Timing only, and cheap: calibration off.
          this.analysis
            .analyse(instrument.symbol, '1D', { withCalibration: false })
            .then((result) => (result as { technical?: unknown }).technical ?? null)
            .catch(() => null),
        ]);

        return this.ai.post(
          '/investment',
          {
            data,
            price: quote?.price ?? null,
            technical,
            peers,
            ethicalMode: ethical,
          },
          { timeoutMs: 20_000 },
        );
      },
    );
  }

  /** Sector peers, for the industry comparison. */
  private async peersFor(symbol: string, sector: string | null) {
    if (!sector) return [];

    const rows = await this.prisma.fundamentals.findMany({
      where: { symbol: { not: symbol }, instrument: { sector } },
      take: 15,
      select: {
        symbol: true, pe: true, pb: true, roe: true, roce: true,
        netMargin: true, revenueGrowth: true, profitGrowth: true,
        debtToEquity: true, dividendYield: true, marketCap: true,
      },
    });

    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((row) => ({
      symbol: row.symbol,
      pe: n(row.pe),
      pb: n(row.pb),
      roe: n(row.roe),
      roce: n(row.roce),
      netMargin: n(row.netMargin),
      revenueGrowth: n(row.revenueGrowth),
      profitGrowth: n(row.profitGrowth),
      debtToEquity: n(row.debtToEquity),
      dividendYield: n(row.dividendYield),
      marketCap: n(row.marketCap),
    }));
  }

  /**
   * Rank the investable universe, optionally by style.
   *
   * Ordered by liquidity before scoring, so the names that surface are ones a
   * position can actually be built in.
   */
  async screen(options: { style?: string; ethicalMode?: boolean; limit?: number } = {}) {
    const style = options.style?.toUpperCase();
    const ethical = options.ethicalMode ?? false;
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);

    return this.redis.wrap(
      `investment-screen:${style ?? 'all'}:${ethical ? 'ethical' : 'all'}:${limit}`,
      10 * 60,
      async () => {
        const rows = await this.prisma.fundamentals.findMany({
          include: { instrument: { select: { name: true, sector: true, assetClass: true, isActive: true } } },
          take: 80,
        });

        const active = rows.filter((row) => row.instrument?.isActive);
        const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

        const candidates = active.map((row) => ({
          symbol: row.symbol,
          name: row.instrument?.name,
          sector: row.instrument?.sector,
          assetClass: row.instrument?.assetClass ?? 'EQUITY',
          marketCap: n(row.marketCap),
          pe: n(row.pe),
          pb: n(row.pb),
          industryPe: n(row.industryPe),
          dividendYield: n(row.dividendYield),
          roe: n(row.roe),
          roce: n(row.roce),
          netMargin: n(row.netMargin),
          operatingMargin: n(row.operatingMargin),
          revenueGrowth: n(row.revenueGrowth),
          profitGrowth: n(row.profitGrowth),
          epsGrowth: n(row.epsGrowth),
          debtToEquity: n(row.debtToEquity),
          eps: n(row.eps),
          promoterPledge: n(row.promoterPledge),
          strengths: row.strengths,
          concerns: row.concerns,
        }));

        const marketCaps = new Map(
          candidates
            .filter((c) => c.marketCap)
            .map((c) => [c.symbol, c.marketCap as number]),
        );
        const ranked = prioritise(candidates, marketCaps);

        const result = (await this.ai.post('/investment/screen', {
          candidates: ranked,
          style: style ?? null,
          ethicalMode: ethical,
          limit,
        }, { timeoutMs: 45_000 })) as Record<string, unknown>;

        // Attach the tier so the UI can show why an order is what it is.
        const tiers = new Map(ranked.map((r) => [r.symbol, r.tier]));
        const results = ((result.results as Array<Record<string, unknown>>) ?? []).map((r) => ({
          ...r,
          tier: tiers.get(r.symbol as string) ?? 3,
        }));

        return { ...result, results };
      },
    );
  }

  /** Portfolio health for one user. */
  async portfolioHealth(userId: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { userId },
      include: {
        instrument: { select: { sector: true, assetClass: true, currency: true } },
      },
    });

    if (holdings.length === 0) {
      return {
        available: false,
        healthScore: null,
        summary: 'No holdings to analyse. Record a trade to see portfolio health.',
      };
    }

    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const [quotes, yields] = await Promise.all([
      this.marketData.getQuotes(symbols).catch(() => []),
      this.prisma.fundamentals.findMany({
        where: { symbol: { in: symbols } },
        select: { symbol: true, dividendYield: true },
      }),
    ]);

    const priceBy = new Map(quotes.map((q) => [q.symbol, q.price]));
    const yieldBy = new Map(
      yields.map((y) => [y.symbol, y.dividendYield === null ? null : Number(y.dividendYield)]),
    );

    const shaped = holdings.map((holding) => {
      const price = priceBy.get(holding.symbol) ?? Number(holding.averagePrice);
      return {
        symbol: holding.symbol,
        currentValue: Number(holding.quantity) * price,
        assetClass: holding.instrument?.assetClass ?? 'EQUITY',
        sector: holding.instrument?.sector ?? null,
        // Every instrument in this platform's universe is Indian or a global
        // 24×7 asset, so country is derived rather than stored.
        country:
          holding.instrument?.assetClass === 'CRYPTO'
            ? 'Global'
            : holding.instrument?.currency === 'USD'
              ? 'International'
              : 'India',
        dividendYield: yieldBy.get(holding.symbol) ?? null,
      };
    });

    return this.ai.post('/investment/portfolio', { holdings: shaped }, { timeoutMs: 15_000 });
  }
}
