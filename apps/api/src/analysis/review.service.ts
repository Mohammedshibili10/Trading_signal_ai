import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Timeframe } from '../market-data/providers/provider.interface';
import { AiClientService } from './ai-client.service';
import { countsAsPerformance, isEngineEnded } from './signal-outcome';

const PRISMA_TO_TIMEFRAME: Record<string, Timeframe> = {
  M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D1: '1D', W1: '1W', MN1: '1M',
};

/** Trades fitted on; the remainder is held back to validate against. */
const HOLDOUT_SHARE = 0.25;

/**
 * Post-trade review.
 *
 * Runs after signals resolve, not on a request path. Two jobs:
 *
 * **Post-mortem** — for each newly resolved signal, fetch the bars that
 * followed the entry and diagnose what happened. Written back onto the signal
 * so the record is self-contained and auditable years later.
 *
 * **Attribution** — periodically re-measure which factor groups predicted
 * outcomes, propose new weights, and validate them on trades the proposal was
 * not fitted to. Every proposal is stored including the rejections, because the
 * rejections are what stop the same unproven adjustment being retried monthly.
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger('Review');

  constructor(
    private readonly ai: AiClientService,
    private readonly marketData: MarketDataService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Diagnose every resolved signal that has not yet been reviewed.
   *
   * Capped per pass. A backlog is fine — nothing downstream is waiting, and a
   * pass that tries to review two hundred signals at once would monopolise the
   * analysis service for minutes.
   */
  async runPostMortems(limit = 15): Promise<{ reviewed: number; failed: number }> {
    const pending = await this.prisma.signal.findMany({
      where: {
        // Every ending gets a post-mortem, not just the ones price decided.
        // A cancellation that turns out to have been wrong is the single most
        // instructive record this system produces, and it was being discarded.
        status: { in: ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED', 'CANCELLED', 'INVALID'] },
        postMortem: { equals: Prisma.DbNull },
      },
      orderBy: { resolvedAt: 'desc' },
      take: limit,
    });

    if (pending.length === 0) return { reviewed: 0, failed: 0 };

    let reviewed = 0;
    let failed = 0;

    for (const signal of pending) {
      try {
        await this.reviewOne(signal);
        reviewed += 1;
      } catch (error) {
        failed += 1;
        this.logger.debug(`post-mortem failed for ${signal.symbol}: ${(error as Error).message}`);
      }
    }

    return { reviewed, failed };
  }

  private async reviewOne(signal: Record<string, unknown>): Promise<void> {
    const symbol = signal.symbol as string;
    const timeframe = PRISMA_TO_TIMEFRAME[signal.timeframe as string] ?? '1D';
    const createdAt = signal.createdAt as Date;
    const resolvedAt = (signal.resolvedAt as Date | null) ?? new Date();

    // The bars between issue and resolution are what the diagnosis reads. A
    // generous window is fetched and then sliced, because provider granularity
    // means asking for "exactly these bars" is not something one can do.
    const { candles } = await this.marketData.getCandles(symbol, timeframe, 400);

    const from = Math.floor(createdAt.getTime() / 1000);
    const to = Math.floor(resolvedAt.getTime() / 1000);
    const after = candles.filter((candle) => candle.time >= from && candle.time <= to);

    // Bars since the signal ended. For a cancellation these are the evidence
    // for whether the decision was right — everything before it only says why
    // the decision was made, which is not the same question.
    const since = candles.filter((candle) => candle.time > to);

    const status = signal.status as string;
    const engineEnded = status === 'CANCELLED' || status === 'INVALID';

    const diagnosis = await this.ai.post<Record<string, unknown>>(
      '/review/postmortem',
      {
        signal: {
          id: signal.id,
          symbol,
          action: signal.action,
          status,
          confidence: signal.confidence ? Number(signal.confidence) : null,
          entry: signal.entry ? Number(signal.entry) : 0,
          stopLoss: signal.stopLoss ? Number(signal.stopLoss) : 0,
          factors: signal.factors ?? [],
          confluence: signal.confluence ?? null,
        },
        candlesAfterEntry: after,
        candlesAfterExit: engineEnded ? since : [],
        healthFindings: (signal.healthFindings as unknown[]) ?? null,
        invalidationReason: (signal.invalidationReason as string | null) ?? null,
        entryFilled: Boolean(signal.entryFilledAt),
        target: signal.target1 ? Number(signal.target1) : null,
      },
      { timeoutMs: 20_000 },
    );

    const execution = (diagnosis.execution ?? {}) as Record<string, number>;

    await this.prisma.signal.update({
      where: { id: signal.id as string },
      data: {
        postMortem: diagnosis as never,
        primaryReason: (diagnosis.primaryReason as string) ?? null,
        maeR: execution.maeR ?? null,
        mfeR: execution.mfeR ?? null,
        realisedR: execution.realisedR ?? null,
        captureRatio: execution.captureRatio ?? null,
        barsHeld: execution.barsHeld ?? null,
      },
    });
  }

  /**
   * Re-measure factor performance and propose weights.
   *
   * The split is chronological, not random: the holdout is the most recent
   * quarter of trades. Random splits leak information across time in a series
   * where regimes persist, and would make almost any proposal look validated.
   */
  async runAttribution(): Promise<Record<string, unknown> | null> {
    const resolved = await this.prisma.signal.findMany({
      where: { status: { in: ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED'] } },
      orderBy: { createdAt: 'asc' },
      take: 1000,
      select: {
        symbol: true, timeframe: true, action: true, confidence: true,
        status: true, riskRewardRatio: true, factors: true, postMortem: true,
      },
    });

    if (resolved.length < 40) {
      this.logger.debug(`attribution skipped — ${resolved.length} resolved trades, need 40`);
      return null;
    }

    const shaped = resolved.map((signal) => ({
      symbol: signal.symbol,
      timeframe: PRISMA_TO_TIMEFRAME[signal.timeframe] ?? '1D',
      action: signal.action,
      confidence: Number(signal.confidence),
      status: signal.status,
      riskRewardRatio: Number(signal.riskRewardRatio),
      factors: signal.factors ?? [],
    }));

    const cut = Math.floor(shaped.length * (1 - HOLDOUT_SHARE));
    const fit = shaped.slice(0, cut);
    const holdout = shaped.slice(cut);

    const postMortems = resolved
      .map((signal) => signal.postMortem)
      .filter((value): value is NonNullable<typeof value> => value !== null);

    const result = await this.ai.post<{
      weights: {
        proposed: Record<string, number>;
        changes: unknown[];
        validated: boolean;
        applied: boolean;
        reason: string;
        baseSeparation?: number;
        proposedSeparation?: number;
        edge?: number;
        holdoutSize?: number;
      };
      performance: Record<string, unknown>;
      baseWeights: Record<string, number>;
    }>(
      '/review/attribution',
      { trades: fit, holdout, postMortems, baseWeights: await this.activeWeights() },
      { timeoutMs: 60_000 },
    );

    const proposal = result.weights;

    const stored = await this.prisma.weightProposal.create({
      data: {
        baseWeights: result.baseWeights as never,
        proposedWeights: proposal.proposed as never,
        changes: proposal.changes as never,
        performance: result.performance as never,
        tradesAnalysed: fit.length,
        holdoutSize: proposal.holdoutSize ?? holdout.length,
        baseSeparation: proposal.baseSeparation ?? null,
        proposedSeparation: proposal.proposedSeparation ?? null,
        edge: proposal.edge ?? null,
        validated: proposal.validated,
        applied: proposal.applied,
        isActive: false,
        reason: proposal.reason,
      },
    });

    // Only a validated proposal becomes the active weight set, and it replaces
    // the previous one atomically so there is never a moment with two active.
    if (proposal.applied) {
      await this.prisma.$transaction([
        this.prisma.weightProposal.updateMany({
          where: { isActive: true },
          data: { isActive: false },
        }),
        this.prisma.weightProposal.update({
          where: { id: stored.id },
          data: { isActive: true },
        }),
      ]);
      this.logger.log(`weights updated — ${proposal.reason}`);
    } else {
      this.logger.debug(`weights unchanged — ${proposal.reason}`);
    }

    return { ...result, proposalId: stored.id };
  }

  /** The weight set currently in force, or null to use the engine's defaults. */
  async activeWeights(): Promise<Record<string, number> | null> {
    try {
      const active = await this.prisma.weightProposal.findFirst({
        where: { isActive: true, applied: true },
        orderBy: { createdAt: 'desc' },
        select: { proposedWeights: true },
      });
      return (active?.proposedWeights as Record<string, number>) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The performance record, for the UI.
   *
   * Deliberately includes the losses broken down by cause. A performance page
   * that shows only aggregate win rate teaches nothing — the useful question is
   * always "what keeps going wrong?"
   */
  async performance(): Promise<Record<string, unknown>> {
    const [resolved, active, latest] = await Promise.all([
      this.prisma.signal.findMany({
        where: {
          status: {
            in: ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED', 'EXPIRED', 'CANCELLED', 'INVALID'],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true, symbol: true, timeframe: true, action: true, status: true,
          confidence: true, riskRewardRatio: true, primaryReason: true,
          maeR: true, mfeR: true, realisedR: true, captureRatio: true,
          barsHeld: true, createdAt: true, resolvedAt: true, outcomeNote: true,
        },
      }),
      this.prisma.weightProposal.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.weightProposal.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, validated: true, applied: true, reason: true, edge: true,
          tradesAnalysed: true, holdoutSize: true, changes: true, createdAt: true,
        },
      }),
    ]);

    // Only price-resolved trades. Excluding merely `EXPIRED` was not enough:
    // cancelled and invalid setups fell through into `closed`, and since they
    // are not wins they were silently counted against the win rate as losses.
    const closed = resolved.filter((s) => countsAsPerformance(s.status));
    const cancelled = resolved.filter((s) => isEngineEnded(s.status));
    const wins = closed.filter((s) => s.status.startsWith('HIT_'));

    const rMultiples = closed
      .map((s) => (s.realisedR === null ? null : Number(s.realisedR)))
      .filter((value): value is number => value !== null);

    const expectancy =
      rMultiples.length > 0
        ? rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length
        : null;

    // Peak-to-trough of the cumulative R curve. The number that actually
    // describes what holding this system would have felt like.
    let peak = 0;
    let equity = 0;
    let maxDrawdown = 0;
    for (const value of rMultiples) {
      equity += value;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }

    const byReason = new Map<string, number>();
    for (const signal of closed) {
      if (signal.status.startsWith('HIT_')) continue;
      const reason = signal.primaryReason ?? 'UNREVIEWED';
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }

    const captures = closed
      .map((s) => (s.captureRatio === null ? null : Number(s.captureRatio)))
      .filter((value): value is number => value !== null && value > 0);

    return {
      summary: {
        total: resolved.length,
        closed: closed.length,
        wins: wins.length,
        // Stop-outs only. Reported alongside cancellations rather than merged
        // with them, so the record distinguishes trades that lost money from
        // trades the engine chose not to keep.
        losses: closed.length - wins.length,
        cancelled: cancelled.length,
        expired: resolved.filter((s) => s.status === 'EXPIRED').length,
        winRate: closed.length ? wins.length / closed.length : null,
        expectancyR: expectancy,
        maxDrawdownR: maxDrawdown,
        averageCapture: captures.length
          ? captures.reduce((sum, value) => sum + value, 0) / captures.length
          : null,
        // Stated explicitly: below ~40 closed trades none of the above means much.
        meaningful: closed.length >= 40,
      },
      failureBreakdown: [...byReason.entries()]
        .map(([reason, count]) => ({
          reason,
          count,
          share: closed.length ? count / (closed.length - wins.length || 1) : 0,
        }))
        .sort((a, b) => b.count - a.count),
      recent: resolved.slice(0, 50),
      activeWeights: active,
      proposals: latest,
    };
  }
}
