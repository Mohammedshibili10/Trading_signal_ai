import { Injectable, Logger, Module } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AlertsModule, AlertsService } from '../alerts/alerts.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ReviewService } from '../analysis/review.service';
import { NotificationsModule } from '../notifications/notifications.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { NewsModule, NewsService } from '../news/news.module';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway, RealtimeModule } from '../realtime/realtime.module';
import { AutoScanService } from './autoscan.service';
import { SignalMonitorService } from './signal-monitor.service';

/**
 * Scheduled background work.
 *
 * Everything expensive happens here rather than on a request path — the API
 * reads from Postgres and Redis, never from an upstream provider inline.
 *
 * Cadences are chosen against the constraints in docs/data-sources.md: news
 * every 10 minutes, alerts every minute while a market is open, AMFI once
 * nightly because the file is 9 MB.
 */
@Injectable()
class JobsService {
  private readonly logger = new Logger('Jobs');
  private running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly news: NewsService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly autoscan: AutoScanService,
    private readonly review: ReviewService,
    private readonly monitor: SignalMonitorService,
  ) {}

  /**
   * Revalidate open signals — is the reasoning still true?
   *
   * Every three minutes. Faster than the post-trade review because this one is
   * about a position someone is currently holding, slower than the price
   * tracker because a full re-analysis is expensive and a thesis does not
   * break between one minute and the next.
   */
  @Cron('*/3 * * * *')
  revalidateSignals(): Promise<void> {
    return this.once('revalidate-signals', async () => {
      const result = await this.monitor.revalidateOpen();
      if (result.invalidated > 0 || result.warned > 0) {
        this.logger.log(
          `revalidation: ${result.invalidated} invalidated, ${result.warned} warned ` +
            `of ${result.checked} checked`,
        );
      }
    });
  }

  /**
   * Diagnose signals that have resolved since the last pass.
   *
   * Every ten minutes rather than every minute: a post-mortem is not urgent,
   * and the trade has already closed. What matters is that it happens reliably,
   * not quickly.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  reviewClosedTrades(): Promise<void> {
    return this.once('post-mortems', async () => {
      const result = await this.review.runPostMortems();
      if (result.reviewed > 0) {
        this.logger.log(`post-mortems: ${result.reviewed} reviewed, ${result.failed} failed`);
      }
    });
  }

  /**
   * Re-measure factor performance and test whether the weights should change.
   *
   * Nightly, after the market has closed and the day's outcomes are settled.
   * Running it more often would mean proposing weight changes on data that has
   * barely moved, and every proposal carries a small risk of validating on
   * noise — so the correct frequency is the lowest one that still learns.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  reweightEngine(): Promise<void> {
    return this.once('attribution', async () => {
      const result = await this.review.runAttribution();
      if (result) {
        const weights = result.weights as { applied: boolean; reason: string };
        this.logger.log(
          weights.applied ? `weights updated: ${weights.reason}` : `weights held: ${weights.reason}`,
        );
      }
    });
  }

  /**
   * Autonomous market monitoring.
   *
   * Every five minutes, continuously. Each pass covers a rotating slice of the
   * instruments users follow, runs the confluence-gated analysis, and issues a
   * signal only when both the timeframe agreement and the six-condition
   * checklist pass. Most passes issue nothing, which is the intent.
   */
  @Cron('*/5 * * * *')
  autoScan(): Promise<void> {
    return this.once('autoscan', async () => {
      const result = await this.autoscan.scan();
      if (result.issued > 0) {
        this.logger.log(
          `autoscan: ${result.issued} signal(s) from ${result.scanned} scanned`,
        );
      }
    });
  }

  /**
   * Track live signals against price.
   *
   * Runs more often than the scanner: issuing a signal is a considered act,
   * but noticing that a stop has been hit is time-critical.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  trackSignals(): Promise<void> {
    return this.once('track-signals', async () => {
      const result = await this.autoscan.track();
      if (result.resolved > 0) {
        this.logger.log(`signals: ${result.resolved} resolved of ${result.checked} tracked`);
      }
    });
  }

  /**
   * Guard against overlap.
   *
   * A slow run must not stack on top of the next tick — with a 1-minute alert
   * cadence and a 90-second run, overlapping executions would compound until
   * the process fell over.
   */
  private async once(name: string, work: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      this.logger.warn(`${name} still running, skipping this tick`);
      return;
    }
    this.running.add(name);
    const started = Date.now();
    try {
      await work();
    } catch (error) {
      this.logger.error(`${name} failed: ${(error as Error).message}`);
    } finally {
      this.running.delete(name);
      const elapsed = Date.now() - started;
      if (elapsed > 30_000) this.logger.warn(`${name} took ${Math.round(elapsed / 1000)}s`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  ingestNews(): Promise<void> {
    return this.once('news', async () => {
      const result = await this.news.ingest();
      if (result.stored > 0) this.logger.log(`news: ${result.stored} new items`);
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  checkAlerts(): Promise<void> {
    return this.once('alerts', async () => {
      // Crypto runs 24×7, so alerts are always worth checking; but skip the
      // expensive pass when nothing is open and nothing crypto is watched.
      const result = await this.alerts.evaluate();
      if (result.triggered > 0) {
        this.logger.log(`alerts: ${result.triggered} triggered of ${result.checked} checked`);

        // Push the notifications straight to any connected socket.
        const notifications = await this.prisma.notification.findMany({
          where: { isRead: false, createdAt: { gte: new Date(Date.now() - 120_000) } },
          take: 100,
        });
        for (const notification of notifications) {
          this.realtime.notifyUser(notification.userId, notification);
        }
      }
    });
  }

  /**
   * Warm the quote cache for everything on a watchlist or in a portfolio.
   *
   * Means the first page load after a user signs in is instant rather than
   * waiting on a cold provider fetch.
   */
  @Cron('*/2 9-16 * * 1-5', { timeZone: 'Asia/Kolkata' })
  warmQuotes(): Promise<void> {
    return this.once('warm-quotes', async () => {
      const [watched, held] = await Promise.all([
        this.prisma.watchlistItem.findMany({ select: { symbol: true }, distinct: ['symbol'], take: 200 }),
        this.prisma.holding.findMany({ select: { symbol: true }, distinct: ['symbol'], take: 200 }),
      ]);

      const symbols = [...new Set([...watched, ...held].map((row) => row.symbol))];
      if (symbols.length === 0) return;

      const quotes = await this.marketData.getQuotes(symbols);
      // Persist so `lastKnownQuote` has something to serve during an outage.
      await Promise.all(quotes.map((quote) => this.marketData.persistQuote(quote.symbol, quote)));
    });
  }

  /** Expire signals whose validity window has passed. */
  @Cron(CronExpression.EVERY_HOUR)
  expireSignals(): Promise<void> {
    return this.once('expire-signals', async () => {
      const result = await this.prisma.signal.updateMany({
        where: { status: 'ACTIVE', validUntil: { lt: new Date() } },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      });
      if (result.count > 0) this.logger.log(`expired ${result.count} signals`);
    });
  }

  /**
   * Archive resolved signals once they are well past their cooldown.
   *
   * Archiving is a flag, not a status: the status *is* the outcome, and
   * overwriting it would destroy the one fact the learning data is built from.
   * A stopped trade that gets archived is still a stopped trade — it simply
   * stops appearing in live views.
   *
   * Nothing is deleted. The precedent check reads this history to decide
   * whether a new setup repeats an old mistake, so a pruned record would make
   * the engine forget exactly the trades it most needs to remember.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  archiveSignals(): Promise<void> {
    return this.once('archive-signals', async () => {
      const cutoff = new Date(Date.now() - 7 * 86_400_000);

      const result = await this.prisma.signal.updateMany({
        where: {
          status: { in: ['HIT_T3', 'STOPPED', 'EXPIRED', 'CANCELLED', 'INVALID'] },
          resolvedAt: { lt: cutoff },
          archivedAt: null,
          // Never archive anything still inside its cooldown, or the reissue
          // guard would lose sight of it and hand the setup straight back.
          OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: new Date() } }],
        },
        data: { archivedAt: new Date() },
      });

      if (result.count > 0) this.logger.log(`archived ${result.count} resolved signal(s)`);
    });
  }

  /** Housekeeping: revoked sessions, used tokens, stale notifications. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  cleanup(): Promise<void> {
    return this.once('cleanup', async () => {
      const monthAgo = new Date(Date.now() - 30 * 86_400_000);

      const [sessions, tokens, notifications, news] = await Promise.all([
        this.prisma.session.deleteMany({
          where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: monthAgo } }] },
        }),
        this.prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
        this.prisma.notification.deleteMany({ where: { isRead: true, createdAt: { lt: monthAgo } } }),
        this.prisma.newsItem.deleteMany({ where: { publishedAt: { lt: monthAgo } } }),
      ]);

      this.logger.log(
        `cleanup: ${sessions.count} sessions, ${tokens.count} tokens, ` +
          `${notifications.count} notifications, ${news.count} news items`,
      );
    });
  }
}

@Module({
  imports: [
    MarketDataModule,
    NewsModule,
    AlertsModule,
    RealtimeModule,
    AnalysisModule,
    NotificationsModule,
  ],
  providers: [JobsService, AutoScanService, SignalMonitorService],
})
export class JobsModule {}
