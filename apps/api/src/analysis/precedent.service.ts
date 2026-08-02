import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AiClientService } from './ai-client.service';

export interface PrecedentVerdict {
  verdict: 'CLEAR' | 'CAUTION' | 'REJECT';
  confidencePenalty: number;
  rejectReason: string | null;
  precedents: {
    matched: number;
    wins: number;
    losses: number;
    cancellations: number;
    decided: number;
    shrunkWinRate: number;
    baseRateIsEvidence: boolean;
  };
  namedRisks: Array<{ reason: string; priorFailures: number; evidence: string; detail: string }>;
  recurringReasons: Array<{ reason: string; count: number }>;
  closest: Array<Record<string, unknown>>;
  summary: string;
  notes: string[];
}

/** How much history the check reads. Enough to be evidence, bounded to stay quick. */
const HISTORY_LIMIT = 600;

/**
 * Checks a candidate setup against everything that has already been tried.
 *
 * The engine scores a setup on the chart in front of it, which is necessary and
 * not sufficient: a setup can look excellent on every measure and still belong
 * to a family that has repeatedly failed. Scoring has no memory, so this
 * supplies one.
 *
 * The history query is cached briefly rather than per-signal, because a scan
 * checks two dozen candidates in a row against a record that has not changed
 * between them.
 */
@Injectable()
export class PrecedentService {
  private readonly logger = new Logger(PrecedentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiClientService,
  ) {}

  /**
   * Resolved signals, with the outcome and the diagnosed cause of each.
   *
   * Cancelled and invalid setups are included deliberately. A reason that keeps
   * forcing cancellations is a reason this kind of setup keeps going wrong
   * before it can pay, and excluding them would hide a recurring fault behind
   * the fact that it never quite cost anything.
   */
  private async history(): Promise<Array<Record<string, unknown>>> {
    return this.redis.wrap('precedent:history', 300, async () => {
      const rows = await this.prisma.signal.findMany({
        where: {
          status: { in: ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED', 'CANCELLED', 'INVALID'] },
        },
        orderBy: { resolvedAt: 'desc' },
        take: HISTORY_LIMIT,
        select: {
          symbol: true,
          timeframe: true,
          action: true,
          status: true,
          factors: true,
          primaryReason: true,
          invalidationReason: true,
          confidence: true,
          realisedR: true,
        },
      });

      return rows.map((row) => ({
        ...row,
        confidence: row.confidence === null ? null : Number(row.confidence),
        realisedR: row.realisedR === null ? null : Number(row.realisedR),
      }));
    });
  }

  /**
   * Judge a candidate against the record.
   *
   * Returns null when the check cannot run. A failure here must not block a
   * signal: this is a filter that improves quality, and a filter that fails
   * closed would silently stop the whole system issuing anything the moment the
   * AI service hiccups.
   */
  async check(
    candidate: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<PrecedentVerdict | null> {
    try {
      const history = await this.history();
      if (history.length === 0) return null;

      return await this.ai.post<PrecedentVerdict>(
        '/review/precedent',
        { candidate, history, context },
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      this.logger.debug(`precedent check unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Build the present-tense context the named-risk checks read.
   *
   * These are the measurements that decide whether a condition which broke past
   * trades is present *now*. Without them the check degrades to a base rate,
   * which is the weaker half of the question.
   */
  buildContext(signal: Record<string, unknown>, analysis: Record<string, unknown>): Record<string, unknown> {
    const factors = (signal.factors as Array<Record<string, unknown>>) ?? [];
    const byGroup = new Map(factors.map((f) => [String(f.group), f]));

    const forecast = (signal.forecast ?? {}) as Record<string, unknown>;
    const trend = (analysis.trend ?? {}) as Record<string, unknown>;
    const volume = (analysis.volume ?? {}) as Record<string, unknown>;
    const mtf = (analysis.multiTimeframe ?? analysis.mtf ?? {}) as Record<string, unknown>;

    const num = (value: unknown): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    return {
      volumeRatio: num(volume.ratio ?? volume.volumeRatio),
      volatilityPercentile: num(forecast.volatilityPercentile ?? analysis.volatilityPercentile),
      trendStrength: num(trend.strength),
      structureScore: num(byGroup.get('STRUCTURE')?.score),
      htfAligned:
        typeof mtf.aligned === 'boolean'
          ? mtf.aligned
          : typeof mtf.agreement === 'number'
            ? (mtf.agreement as number) > 0.5
            : null,
      newsImminent: Boolean(analysis.newsImminent),
      extendedFromMean: Boolean(forecast.extended ?? false),
    };
  }
}
