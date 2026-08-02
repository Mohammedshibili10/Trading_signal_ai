import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { Timeframe } from '../market-data/providers/provider.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import { AiClientService } from './ai-client.service';
import { assessReissue, type ReissueSuppressed } from './signal-reissue';
import { PrecedentService } from './precedent.service';

/** Bars needed for a meaningful read. Below 60 the engine refuses to score. */
const MIN_BARS = 60;
const DEFAULT_BARS = 400;

/** Which timeframe provides the higher-timeframe bias for each setup timeframe. */
const HIGHER_TIMEFRAME: Partial<Record<Timeframe, Timeframe>> = {
  '1m': '15m',
  '3m': '30m',
  '5m': '1h',
  '15m': '1h',
  '30m': '4h',
  '1h': '1D',
  '4h': '1D',
  '1D': '1W',
};

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly ai: AiClientService,
    private readonly marketData: MarketDataService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly precedent: PrecedentService,
  ) {}

  /**
   * Full analysis for one instrument.
   *
   * Cached for 60 seconds per symbol+timeframe. The walk-forward calibration
   * pass alone costs ~12 seconds on 400 daily bars, so serving this uncached
   * would make the symbol page unusable.
   */
  async analyse(
    symbol: string,
    timeframe: Timeframe = '1D',
    options: { withCalibration?: boolean; riskPerTrade?: number } = {},
  ) {
    const instrument = await this.marketData.findInstrument(symbol);
    const withCalibration = options.withCalibration ?? true;
    const riskPerTrade = options.riskPerTrade ?? 1;

    const key = `analysis:${instrument.symbol}:${timeframe}:${withCalibration ? 'cal' : 'raw'}:${riskPerTrade}`;

    return this.redis.wrap(key, 60, async () => {
      const { candles } = await this.marketData.getCandles(instrument.symbol, timeframe, DEFAULT_BARS);

      if (candles.length < MIN_BARS) {
        throw new BadRequestException(
          `Only ${candles.length} bars available for ${instrument.symbol} on ${timeframe}. ` +
            `At least ${MIN_BARS} are needed. Try a higher timeframe.`,
        );
      }

      // Higher-timeframe bias. Fetched in parallel and omitted on failure —
      // the engine simply skips that adjustment rather than guessing.
      const higherTf = HIGHER_TIMEFRAME[timeframe];
      const [higherCandles, news, fundamentals, orderBook] = await Promise.all([
        higherTf
          ? this.marketData
              .getCandles(instrument.symbol, higherTf, 200)
              .then((r) => r.candles)
              .catch(() => [])
          : Promise.resolve([]),
        this.recentNews(instrument.symbol),
        this.fundamentalsFor(instrument.symbol, instrument.assetClass),
        // Only crypto has a real book in this platform today. The call is
        // skipped rather than attempted-and-failed for everything else.
        instrument.assetClass === 'CRYPTO'
          ? this.marketData.getOrderBook(instrument.symbol).catch(() => null)
          : Promise.resolve(null),
      ]);

      return this.ai.post('/analysis', {
        symbol: instrument.symbol,
        name: instrument.name,
        assetClass: instrument.assetClass,
        timeframe,
        candles,
        higherTimeframeCandles: higherCandles.length >= 20 ? higherCandles : null,
        news,
        fundamentals,
        orderBook,
        riskPerTradePercent: riskPerTrade,
        withCalibration,
      });
    });
  }

  /** Just the next-candle forecast — lighter, used on the dashboard. */
  async forecast(symbol: string, timeframe: Timeframe = '1D') {
    const instrument = await this.marketData.findInstrument(symbol);

    return this.redis.wrap(`forecast:${instrument.symbol}:${timeframe}`, 45, async () => {
      const { candles } = await this.marketData.getCandles(instrument.symbol, timeframe, 300);
      if (candles.length < MIN_BARS) {
        throw new BadRequestException(`Not enough history for ${instrument.symbol} on ${timeframe}`);
      }

      return this.ai.post('/analysis/forecast', {
        symbol: instrument.symbol,
        name: instrument.name,
        assetClass: instrument.assetClass,
        timeframe,
        candles,
        withCalibration: false,
      });
    });
  }

  /**
   * Per-candle history: what the engine would have predicted at each bar, and
   * what actually happened.
   */
  async candleHistory(symbol: string, timeframe: Timeframe = '1D', lookback = 30) {
    const instrument = await this.marketData.findInstrument(symbol);

    return this.redis.wrap(
      `candle-history:${instrument.symbol}:${timeframe}:${lookback}`,
      300,
      async () => {
        const { candles } = await this.marketData.getCandles(instrument.symbol, timeframe, DEFAULT_BARS);
        if (candles.length < 100) {
          throw new BadRequestException(
            `Need at least 100 bars for a candle history. ${instrument.symbol} has ${candles.length}.`,
          );
        }

        return this.ai.post('/analysis/forecast/history', {
          symbol: instrument.symbol,
          assetClass: instrument.assetClass,
          timeframe,
          candles,
          lookback: Math.min(Math.max(lookback, 5), 100),
        });
      },
    );
  }

  /**
   * Score many symbols at once. Backs the scanners and the dashboard signal feed.
   *
   * Calibration is off for batches — it re-runs the pipeline ~125 times per
   * symbol, which is fine for one instrument and unusable for fifty.
   */
  async batchSignals(
    symbols: string[],
    timeframe: Timeframe = '1D',
    options: { minConfidence?: number; includeWait?: boolean; persist?: boolean } = {},
  ) {
    const capped = symbols.slice(0, 40);

    const items = await Promise.all(
      capped.map(async (symbol) => {
        try {
          const instrument = await this.marketData.findInstrument(symbol);
          const { candles } = await this.marketData.getCandles(instrument.symbol, timeframe, 300);
          if (candles.length < MIN_BARS) return null;

          return {
            symbol: instrument.symbol,
            name: instrument.name,
            assetClass: instrument.assetClass,
            timeframe,
            candles,
            withCalibration: false,
          };
        } catch {
          return null;
        }
      }),
    );

    const valid = items.filter((item): item is NonNullable<typeof item> => item !== null);
    if (valid.length === 0) return { signals: [], requested: symbols.length, scored: 0, failed: 0 };

    const result = await this.ai.post<{
      signals: Array<Record<string, unknown>>;
      requested: number;
      scored: number;
      failed: number;
    }>('/analysis/signals/batch', {
      items: valid,
      minConfidence: options.minConfidence ?? 0,
      includeWait: options.includeWait ?? false,
    });

    // ── Persist what was found ───────────────────────────────────
    //
    // Without this a scan returns signals in the HTTP response and then throws
    // them away: the signals page reads the database, so a scan that found two
    // setups showed an empty feed the moment the response finished rendering.
    //
    // `persist` defaults on for a scan the user asked for. The scanners page
    // passes it off, because it enriches rows with `includeWait: true` purely
    // to show an action column, and storing a row every time someone opens a
    // scan would fill the feed with duplicates nobody requested.
    if (options.persist !== false) {
      const { stored, suppressed } = await this.persistBatch(result.signals ?? [], timeframe);

      // Suppressed setups are reported rather than silently dropped. A scan
      // that quietly withholds a signal is indistinguishable from a scan that
      // found nothing, and the two mean opposite things.
      const withheld = suppressed.map((item) => ({
        symbol: item.symbol,
        action: item.action,
        reason: item.reason,
        label: item.label,
        detail: item.detail,
        reissuePossibleAt: item.until,
      }));

      // A withheld setup must not come back as a *display* either. Persisting
      // it was only half the problem: leaving it in the response meant the
      // cancelled signal still appeared in the scan results, which is the
      // reopening the guard exists to prevent.
      //
      // ALREADY_OPEN is the exception and stays visible — that signal is live
      // and valid, and hiding it would make an open position vanish from the
      // scan that just confirmed it.
      const blocked = new Set(
        suppressed
          .filter((item) => item.reason !== 'ALREADY_OPEN')
          .map((item) => `${item.symbol}:${item.action}`),
      );

      return {
        ...result,
        signals: (result.signals ?? []).filter(
          (signal) => !blocked.has(`${signal.symbol}:${signal.action}`),
        ),
        persisted: stored,
        withheld: withheld.filter((item) => item.reason !== 'ALREADY_OPEN'),
      };
    }

    return result;
  }

  /**
   * Store the tradeable signals from a batch, skipping ones that must not be
   * re-issued.
   *
   * The decision itself lives in `assessReissue`, shared with the autonomous
   * scanner. What used to be here was a lookup for an *active* signal, which
   * meant a cancelled one matched nothing and the next scan recreated it
   * verbatim — the harder a signal had failed, the faster it came back.
   */
  private async persistBatch(
    signals: Array<Record<string, unknown>>,
    timeframe: Timeframe,
  ): Promise<{ stored: number; suppressed: ReissueSuppressed[] }> {
    const tradeable = signals.filter((signal) => {
      const action = signal.action as string;
      return action === 'BUY' || action === 'SELL';
    });
    if (tradeable.length === 0) return { stored: 0, suppressed: [] };

    let stored = 0;
    const suppressed: ReissueSuppressed[] = [];

    for (const signal of tradeable) {
      try {
        const symbol = signal.symbol as string;
        const verdict = await assessReissue(this.prisma, {
          symbol,
          timeframe: this.toPrismaTimeframe(timeframe) as string,
          action: signal.action as 'BUY' | 'SELL',
          entry: signal.entry === undefined || signal.entry === null ? null : Number(signal.entry),
          stopLoss:
            signal.stopLoss === undefined || signal.stopLoss === null
              ? null
              : Number(signal.stopLoss),
        });

        if (!verdict.allow) {
          suppressed.push(verdict);
          this.logger.debug(`withheld ${signal.action} ${symbol}: ${verdict.reason}`);
          continue;
        }

        // ── Has this been tried before, and did it work? ────────
        //
        // Applied here rather than inside the scoring engine because it needs
        // the trade record, which lives on this side. A rejection is reported
        // like any other suppression; a caution marks the confidence down and
        // says why, so the number the user sees already carries the history.
        const precedent = await this.precedent.check(
          {
            symbol,
            timeframe: this.toPrismaTimeframe(timeframe),
            action: signal.action,
            factors: signal.factors ?? [],
          },
          this.precedent.buildContext(signal, signal),
        );

        if (precedent?.verdict === 'REJECT') {
          suppressed.push({
            allow: false,
            reason: 'PRECEDENT',
            symbol,
            action: signal.action as string,
            label: 'Matches past failures',
            detail: precedent.rejectReason ?? precedent.summary,
            until: null,
            priorSignalId: null,
          });
          this.logger.debug(`withheld ${signal.action} ${symbol}: PRECEDENT`);
          continue;
        }

        if (precedent && precedent.confidencePenalty > 0) {
          const before = Number(signal.confidence ?? 0);
          const after = Math.max(0, before - precedent.confidencePenalty);
          // Mutated in place so the scan response shows the same number that
          // gets stored, rather than the pre-adjustment score.
          signal.confidence = after;
          signal.reasons = [
            ...((signal.reasons as string[]) ?? []),
            ...precedent.notes.map((note) => `Precedent: ${note}`),
          ];
          this.logger.debug(
            `${symbol} confidence ${before.toFixed(0)} → ${after.toFixed(0)} on precedent`,
          );
        }

        await this.persistSignal(signal, timeframe, {
          supersedesId: verdict.supersedesId,
          note: verdict.note,
          precedent,
        });
        stored += 1;
      } catch (error) {
        this.logger.debug(`persist failed for ${signal.symbol}: ${(error as Error).message}`);
      }
    }

    if (stored > 0) this.logger.log(`stored ${stored} signal(s) from a batch scan`);
    if (suppressed.length > 0) {
      const engineEnded = suppressed.filter((s) => s.reason !== 'ALREADY_OPEN').length;
      if (engineEnded > 0) {
        this.logger.log(`withheld ${engineEnded} previously-ended setup(s) from a batch scan`);
      }
    }
    return { stored, suppressed };
  }

  /**
   * Fan a freshly stored signal out to notifications and to any open socket.
   *
   * Previously only the autonomous scanner did this, so a signal found by a
   * manual scan was written to the database and announced to nobody. Every
   * path that issues a signal now goes through here, which is the only way the
   * two can be guaranteed not to drift apart again.
   */
  private async announce(
    signal: Record<string, unknown>,
    stored: { id: string; createdAt: Date },
    instrument: { symbol: string; name: string; assetClass: string },
    timeframe: Timeframe,
  ): Promise<void> {
    const targets = (signal.targets as Array<{ price: number }>) ?? [];

    try {
      this.realtime.broadcastSignal(instrument.symbol, {
        ...signal,
        id: stored.id,
        name: instrument.name,
        assetClass: instrument.assetClass,
        createdAt: stored.createdAt.toISOString(),
        status: 'ACTIVE',
      });

      await this.notifications.signalIssued({
        signalId: stored.id,
        symbol: instrument.symbol,
        name: instrument.name,
        action: signal.action as 'BUY' | 'SELL',
        timeframe,
        entry: Number(signal.entry),
        stopLoss: Number(signal.stopLoss),
        targets: targets.map((t) => t.price),
        riskRewardRatio: Number(signal.riskRewardRatio ?? 0),
        confidence: Number(signal.confidence),
        reason:
          (signal.explanation as string) ||
          ((signal.reasons as string[]) ?? []).slice(0, 2).join(' '),
        confluence: '',
        createdAt: stored.createdAt,
      });
    } catch (error) {
      // A delivery failure must not undo a stored signal.
      this.logger.warn(`announce failed for ${instrument.symbol}: ${(error as Error).message}`);
    }
  }

  /** Recent news for the sentiment factor, with ages the engine can decay. */
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
    // Only equities and investment products have fundamentals worth scoring.
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

  /**
   * Persist a signal so it can be tracked and audited after the fact.
   *
   * Called by `persistBatch` and by the autonomous scanner. Everything that
   * issues a signal goes through here, so the lifecycle tracker and the
   * analytics section see one consistent record regardless of origin.
   */
  async persistSignal(
    signal: Record<string, unknown>,
    timeframe: Timeframe,
    lineage: {
      supersedesId?: string | null;
      note?: string | null;
      precedent?: unknown;
    } = {},
  ): Promise<{ id: string; createdAt: Date } | null> {
    try {
      const symbol = signal.symbol as string;
      const action = signal.action as string;
      if (!symbol || action === 'WAIT') return null;

      const instrument = await this.marketData.findInstrument(symbol);
      const targets = (signal.targets as Array<{ level: number; price: number }>) ?? [];

      const stored = await this.prisma.signal.create({
        data: {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          assetClass: instrument.assetClass,
          timeframe: this.toPrismaTimeframe(timeframe),
          action: action as never,
          confidence: signal.confidence as number,
          horizon: (signal.horizon as string) ?? 'SWING',
          entry: signal.entry as number,
          entryLow: (signal.entryZone as { low: number } | null)?.low,
          entryHigh: (signal.entryZone as { high: number } | null)?.high,
          stopLoss: signal.stopLoss as number,
          target1: targets.find((t) => t.level === 1)?.price,
          target2: targets.find((t) => t.level === 2)?.price,
          target3: targets.find((t) => t.level === 3)?.price,
          riskLevel: (signal.riskLevel as never) ?? 'MEDIUM',
          riskRewardRatio: (signal.riskRewardRatio as number) ?? 0,
          riskPercent: (signal.riskPercent as number) ?? 0,
          suggestedAllocationPercent: (signal.suggestedAllocationPercent as number) ?? 0,
          reasons: (signal.reasons as never) ?? [],
          factors: (signal.factors as never) ?? [],
          forecast: (signal.forecast as never) ?? undefined,
          calibration: (signal.calibration as never) ?? undefined,
          explanation: (signal.explanation as string) ?? '',
          // Recorded so a later volatility expansion can be measured against
          // what the stop was actually sized for.
          atrPercentAtIssue:
            (signal.atrPercent as number) ??
            ((signal.forecast as { atrPercent?: number } | null)?.atrPercent ?? null),
          validUntil: new Date(Date.now() + this.validityMs(timeframe)),
          // Links a re-entry back to the setup it replaces, so a legitimate
          // second attempt stays distinguishable from a recycled signal.
          supersedesId: lineage.supersedesId ?? undefined,
          precedent: (lineage.precedent as never) ?? undefined,
        },
        select: { id: true, createdAt: true },
      });

      await this.announce(signal, stored, instrument, timeframe);
      return stored;
    } catch (error) {
      this.logger.debug(`signal persist failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** A 5-minute signal is stale in an hour; a weekly one lasts a month. */
  private validityMs(timeframe: Timeframe): number {
    const hours: Record<string, number> = {
      '1m': 1, '3m': 1.5, '5m': 2, '15m': 6, '30m': 12,
      '1h': 24, '4h': 72, '1D': 168, '1W': 720, '1M': 2160,
    };
    return (hours[timeframe] ?? 168) * 3_600_000;
  }

  private toPrismaTimeframe(timeframe: Timeframe) {
    return (
      {
        '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
        '1h': 'H1', '4h': 'H4', '1D': 'D1', '1W': 'W1', '1M': 'MN1',
      } as const
    )[timeframe];
  }
}
