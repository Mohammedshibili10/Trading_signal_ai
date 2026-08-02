import { Injectable, Logger } from '@nestjs/common';

import { AiClientService } from '../analysis/ai-client.service';
import { AnalysisService } from '../analysis/analysis.service';
import { calendarFor, statusFor } from '../market-data/market-hours';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import type { Timeframe } from '../market-data/providers/provider.interface';
import { cooldownUntilFor } from '../analysis/signal-reissue';

const PRISMA_TO_TIMEFRAME: Record<string, Timeframe> = {
  M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D1: '1D', W1: '1W', MN1: '1M',
};

/** How many signals one revalidation pass covers. */
const BATCH = 8;

/**
 * Don't re-alert on the same degradation repeatedly.
 *
 * A warning that is still true in ten minutes is the same warning. Only a
 * *change* in severity, or a genuinely new finding, is worth another message.
 */
const REALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Live signal monitoring.
 *
 * The tracker asks "has price hit the stop or a target?". This asks the harder
 * question: **is the reason for this trade still true?**
 *
 * Those come apart in the case that matters most. A position can be comfortably
 * in profit while the thesis behind it has quietly evaporated — nothing in the
 * P&L prompts anyone to look, and the trade is then being held for a reason
 * that no longer exists. Equally a trade can be underwater with its reasoning
 * entirely intact, which is what a stop is for and not a reason to panic out.
 *
 * The alert budget is spent carefully. Revalidating is expensive — each one is
 * a full analysis — and alerting on every wobble trains people to ignore the
 * alerts, so that the one that mattered arrives looking like the forty that
 * did not.
 */
@Injectable()
export class SignalMonitorService {
  private readonly logger = new Logger('SignalMonitor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
    private readonly analysis: AnalysisService,
    private readonly marketData: MarketDataService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Revalidate open signals, oldest check first.
   *
   * Ordering by `lastCheckedAt` ascending with nulls first means a newly
   * issued signal is checked promptly and nothing is starved — without it a
   * fixed batch would revalidate the same eight signals forever.
   */
  async revalidateOpen(): Promise<{ checked: number; invalidated: number; warned: number }> {
    const open = await this.prisma.signal.findMany({
      where: { status: { in: ['ACTIVE', 'HIT_T1', 'HIT_T2'] }, validUntil: { gt: new Date() } },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: BATCH,
    });

    if (open.length === 0) return { checked: 0, invalidated: 0, warned: 0 };

    let invalidated = 0;
    let warned = 0;

    for (const signal of open) {
      try {
        const result = await this.revalidateOne(signal);
        if (result === 'INVALIDATED') invalidated += 1;
        else if (result === 'WARNING') warned += 1;
      } catch (error) {
        this.logger.debug(`revalidate failed for ${signal.symbol}: ${(error as Error).message}`);
      }
    }

    return { checked: open.length, invalidated, warned };
  }

  private async revalidateOne(signal: Record<string, unknown>): Promise<string> {
    const symbol = signal.symbol as string;
    const timeframe = PRISMA_TO_TIMEFRAME[signal.timeframe as string] ?? '1D';

    const instrument = await this.marketData.findInstrument(symbol);
    const market = statusFor(calendarFor(instrument.exchange, instrument.assetClass));

    const [current, quote, events, news] = await Promise.all([
      // Calibration off: this runs every few minutes and the walk-forward pass
      // is the single most expensive thing in the engine. The question here is
      // "what changed", which the uncalibrated read answers just as well.
      this.analysis.analyse(symbol, timeframe, { withCalibration: false }),
      this.marketData.getQuote(symbol).catch(() => null),
      this.upcomingEvents(),
      this.recentNews(symbol),
    ]);

    const verdict = (await this.ai.post<{
      valid: boolean;
      severity: string;
      recommendation: string;
      findings: Array<Record<string, unknown>>;
      summary: string;
      confidenceAtIssue: number;
      confidenceNow: number;
      confidenceDelta: number;
    }>(
      '/review/revalidate',
      {
        signal: {
          action: signal.action,
          entry: signal.entry ? Number(signal.entry) : null,
          stopLoss: signal.stopLoss ? Number(signal.stopLoss) : null,
          confidence: Number(signal.confidence),
          atrPercentAtIssue: signal.atrPercentAtIssue
            ? Number(signal.atrPercentAtIssue)
            : null,
        },
        current,
        price: quote?.price ?? null,
        economicEvents: events,
        news,
        marketOpen: market.isOpen,
      },
      { timeoutMs: 20_000 },
    ));

    const previousSeverity = (signal.healthSeverity as string | null) ?? 'NONE';
    const lastChecked = signal.lastCheckedAt as Date | null;

    await this.prisma.signal.update({
      where: { id: signal.id as string },
      data: {
        lastCheckedAt: new Date(),
        healthSeverity: verdict.severity,
        healthFindings: verdict.findings as never,
      },
    });

    // Push the health update to any open chart regardless of severity — the
    // UI showing a live "thesis intact" is worth as much as showing a warning.
    this.realtime.broadcastSignal(symbol, {
      id: signal.id,
      type: 'HEALTH',
      severity: verdict.severity,
      valid: verdict.valid,
      summary: verdict.summary,
      confidenceNow: verdict.confidenceNow,
      confidenceDelta: verdict.confidenceDelta,
    });

    if (verdict.valid) {
      // Recovery is worth saying once: a signal that was warning and is now
      // clean should not leave the last alert standing as the current state.
      if (previousSeverity === 'CRITICAL' || previousSeverity === 'WARNING') {
        await this.notifications.signalHealthChanged({
          signalId: signal.id as string,
          symbol,
          action: signal.action as 'BUY' | 'SELL',
          severity: 'NONE',
          summary: `Conditions have normalised. ${verdict.summary}`,
          findings: [],
          recommendation: 'HOLD',
          confidenceNow: verdict.confidenceNow,
          confidenceDelta: verdict.confidenceDelta,
        });
      } else if (
        verdict.severity === 'WARNING' &&
        this.shouldRealert(previousSeverity, verdict.severity, lastChecked)
      ) {
        // A degradation short of invalidation is still a change worth knowing
        // about. Gated by the re-alert window so a condition that persists for
        // an hour produces one message rather than twenty.
        await this.notifications.signalHealthChanged({
          signalId: signal.id as string,
          symbol,
          action: signal.action as 'BUY' | 'SELL',
          severity: 'WARNING',
          summary: verdict.summary,
          findings: verdict.findings.map((f) => ({
            label: String(f.label),
            detail: String(f.detail),
            evidence: String(f.evidence),
            action: String(f.action),
            severity: String(f.severity),
          })),
          recommendation: verdict.recommendation,
          confidenceNow: verdict.confidenceNow,
          confidenceDelta: verdict.confidenceDelta,
          entry: signal.entry ? Number(signal.entry) : undefined,
          currentPrice: quote?.price,
        });
      }
      return verdict.severity;
    }

    // ── Ended by the engine ──────────────────────────────────────
    //
    // Which of the two endings this is turns entirely on whether the entry ever
    // filled. A filled position closed early is CANCELLED — a decision, with a
    // real position behind it. An unfilled setup that broke is INVALID — there
    // was never a position, so there was never anything to lose. Neither is a
    // loss, and the distinction is what keeps them out of the loss column.
    const wasFilled = Boolean(signal.entryFilledAt);
    const endStatus = wasFilled ? 'CANCELLED' : 'INVALID';

    await this.prisma.signal.update({
      where: { id: signal.id as string },
      data: {
        status: endStatus,
        invalidatedAt: new Date(),
        invalidationReason: (verdict.findings[0]?.key as string) ?? 'UNKNOWN',
        outcomeNote: verdict.summary,
        resolvedAt: new Date(),
        // Stops the next scan handing back the setup just stood down from.
        cooldownUntil: cooldownUntilFor(signal.timeframe as string),
      },
    });

    this.logger.log(`${endStatus} ${signal.action} ${symbol}: ${verdict.summary.slice(0, 110)}`);

    await this.notifications.signalHealthChanged({
      signalId: signal.id as string,
      symbol,
      action: signal.action as 'BUY' | 'SELL',
      severity: 'CRITICAL',
      summary: verdict.summary,
      findings: verdict.findings.map((f) => ({
        label: String(f.label),
        detail: String(f.detail),
        evidence: String(f.evidence),
        action: String(f.action),
        severity: String(f.severity),
      })),
      recommendation: verdict.recommendation,
      confidenceNow: verdict.confidenceNow,
      confidenceDelta: verdict.confidenceDelta,
      entry: signal.entry ? Number(signal.entry) : undefined,
      currentPrice: quote?.price,
    });

    return 'INVALIDATED';
  }

  /** Suppress a repeat of the same severity inside the re-alert window. */
  private shouldRealert(previous: string, next: string, lastChecked: Date | null): boolean {
    if (previous !== next) return true;
    if (!lastChecked) return true;
    return Date.now() - lastChecked.getTime() > REALERT_WINDOW_MS;
  }

  private async upcomingEvents() {
    try {
      const now = Date.now();
      const events = await this.prisma.economicEvent.findMany({
        where: { scheduledAt: { gte: new Date(now), lte: new Date(now + 24 * 3_600_000) } },
        orderBy: { scheduledAt: 'asc' },
        take: 10,
        select: { title: true, importance: true, scheduledAt: true },
      });
      return events.map((event) => ({
        title: event.title,
        importance: event.importance,
        hoursUntil: (event.scheduledAt.getTime() - now) / 3_600_000,
      }));
    } catch {
      return [];
    }
  }

  private async recentNews(symbol: string) {
    try {
      const cutoff = new Date(Date.now() - 12 * 3_600_000);
      const items = await this.prisma.newsItem.findMany({
        where: { symbols: { has: symbol }, publishedAt: { gte: cutoff } },
        orderBy: { publishedAt: 'desc' },
        take: 8,
        select: { headline: true, impact: true, stance: true, publishedAt: true },
      });
      return items.map((item) => ({
        headline: item.headline,
        impact: item.impact,
        stance: item.stance,
        ageHours: (Date.now() - item.publishedAt.getTime()) / 3_600_000,
      }));
    } catch {
      return [];
    }
  }
}
