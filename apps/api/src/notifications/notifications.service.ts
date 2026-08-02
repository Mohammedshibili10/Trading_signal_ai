import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { MailService } from '../auth/mail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway, RealtimeModule } from '../realtime/realtime.module';
import { TelegramController, TelegramService } from './telegram.controller';

/**
 * Display timezone for anything a person reads.
 *
 * `toISOString()` renders UTC, which for an IST reader is five and a half
 * hours in the past — a signal issued at 21:30 arrives stamped 16:00, and the
 * natural reading is that the alert is stale and can be ignored. That is the
 * worst possible failure for a time-sensitive message.
 *
 * Configurable, defaulting to the timezone of the platform's primary market.
 */
const DISPLAY_TZ = process.env.DISPLAY_TIMEZONE || 'Asia/Kolkata';

function localTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

export interface SignalNotification {
  signalId: string;
  symbol: string;
  name: string;
  action: 'BUY' | 'SELL';
  timeframe: string;
  entry: number;
  stopLoss: number;
  targets: number[];
  riskRewardRatio: number;
  confidence: number;
  reason: string;
  confluence: string;
  createdAt: Date;
}

/**
 * Confidence at which a signal is worth telling someone who was not already
 * watching the symbol. Above the scanner's own 62 floor, because an unsolicited
 * message about an unfamiliar instrument has to clear a higher bar than one
 * about something already on your watchlist.
 */
const BROADCAST_CONFIDENCE = 65;

export interface HealthNotification {
  signalId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  severity: 'NONE' | 'WARNING' | 'CRITICAL';
  summary: string;
  findings: Array<{
    label: string;
    detail: string;
    evidence: string;
    action: string;
    severity: string;
  }>;
  recommendation: string;
  confidenceNow: number;
  confidenceDelta: number;
  entry?: number;
  currentPrice?: number;
}

export interface ResolutionNotification {
  signalId: string;
  symbol: string;
  outcome: 'STOPPED' | 'HIT_T1' | 'HIT_T2' | 'HIT_T3' | 'EXPIRED';
  price: number;
}

/**
 * Notification fan-out.
 *
 * One signal becomes many deliveries: an in-app row, a live socket push, an
 * email, a Telegram message. Each channel is attempted independently and a
 * failure in one never blocks the others — an SMTP timeout must not stop the
 * socket push that was going to arrive in fifty milliseconds.
 *
 * Delivery respects per-user preferences. Someone who turned signal alerts off
 * gets the in-app record (so the history stays complete) but no interruption.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private get telegramToken(): string {
    return this.config.get<string>('notifications.telegramBotToken') ?? '';
  }

  /**
   * Everyone who should hear about a signal on this symbol.
   *
   * Two routes in, and the second is the one that matters for an autonomous
   * scanner. Following the symbol — via a watchlist or a holding — always
   * qualifies. But the whole premise of a background scanner is finding setups
   * on instruments the user was *not* already watching, and an audience built
   * only from followers means those signals reach nobody: they are stored,
   * they appear in the feed, and no notification is ever sent.
   *
   * So anyone with signal alerts enabled also receives signals that clear the
   * high-confidence bar, whatever the symbol. Below that bar the notification
   * stays limited to followers, because a scanner that messages you about every
   * instrument in the universe is one you turn off within a day.
   */
  private async audienceFor(symbol: string, confidence?: number) {
    const [watchers, holders] = await Promise.all([
      this.prisma.watchlistItem.findMany({
        where: { symbol },
        select: { watchlist: { select: { userId: true } } },
      }),
      this.prisma.holding.findMany({ where: { symbol }, select: { userId: true } }),
    ]);

    const userIds = new Set<string>();
    for (const row of watchers) if (row.watchlist?.userId) userIds.add(row.watchlist.userId);
    for (const row of holders) userIds.add(row.userId);

    const broadcast = confidence !== undefined && confidence >= BROADCAST_CONFIDENCE;

    if (userIds.size === 0 && !broadcast) return [];

    return this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(broadcast
          ? {
              OR: [
                { id: { in: [...userIds] } },
                { preferences: { signalAlerts: true } },
              ],
            }
          : { id: { in: [...userIds] } }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        preferences: {
          select: {
            signalAlerts: true,
            emailNotifications: true,
            telegramChatId: true,
          },
        },
      },
      take: 200,
    });
  }

  /** Format a signal the way a trader would want to read it on a phone. */
  private format(signal: SignalNotification): { title: string; body: string } {
    const targets = signal.targets.length
      ? signal.targets.map((t, i) => `TP${i + 1} ${t.toFixed(2)}`).join(' · ')
      : 'no targets';

    return {
      title: `${signal.action} ${signal.symbol} · ${signal.timeframe} · ${signal.confidence.toFixed(0)}/100`,
      body: [
        `${signal.action} ${signal.symbol} (${signal.name}) on ${signal.timeframe}`,
        `Entry ${signal.entry.toFixed(2)} · SL ${signal.stopLoss.toFixed(2)} · ${targets}`,
        `R:R ${signal.riskRewardRatio.toFixed(2)}:1 · confidence ${signal.confidence.toFixed(0)}/100`,
        '',
        signal.reason,
        signal.confluence ? `\nConfluence: ${signal.confluence}` : '',
        `\n${signal.createdAt.toISOString()}`,
        '\nNot investment advice. Probabilities are historical frequencies, not promises.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async signalIssued(signal: SignalNotification): Promise<{ delivered: number }> {
    const audience = await this.audienceFor(signal.symbol, signal.confidence);
    if (audience.length === 0) {
      this.logger.debug(
        `no audience for ${signal.symbol} at confidence ${signal.confidence} — nobody follows it ` +
          `and it is below the ${BROADCAST_CONFIDENCE} broadcast bar`,
      );
      return { delivered: 0 };
    }

    const { title, body } = this.format(signal);
    const telegramText = `*${title}*\n\n${body}`;

    // ── Push first, persist second ──────────────────────────────
    //
    // Telegram goes out before anything is written. A trade alert is worth
    // only as much as its timeliness, whereas the database row is worth the
    // same whenever it lands. Previously each user's message waited behind
    // that user's INSERT and the inserts ran one at a time, so against a
    // remote database every recipient added a full round-trip — the last
    // person on a long list could be many seconds behind the first.
    //
    // Nothing here is awaited: a slow or failing Telegram call must not delay
    // the next recipient.
    for (const user of audience) {
      if (user.preferences?.signalAlerts === false) continue;
      const chatId = user.preferences?.telegramChatId;
      if (chatId) void this.telegram(chatId, telegramText);
    }

    // The in-app record is always written, even for users with alerts off: it
    // is the signal history, and dropping rows because of a preference would
    // leave gaps in a record someone later wants to audit.
    //
    // One statement rather than one per user — moving the sends earlier would
    // achieve little if the writes still cost N sequential round-trips.
    const notifications = await this.prisma.notification.createManyAndReturn({
      data: audience.map((user) => ({
        userId: user.id,
        title,
        body,
        kind: 'SIGNAL' as const,
        symbol: signal.symbol,
        link: `/markets/${signal.symbol}`,
      })),
    });

    const byUser = new Map(notifications.map((row) => [row.userId, row]));
    let delivered = 0;

    for (const user of audience) {
      const prefs = user.preferences;
      if (prefs?.signalAlerts === false) continue;

      this.realtime.notifyUser(user.id, {
        ...byUser.get(user.id),
        signalId: signal.signalId,
        action: signal.action,
        confidence: signal.confidence,
      });
      delivered += 1;

      if (prefs?.emailNotifications) {
        void this.mail
          .send({ to: user.email, subject: title, text: body })
          .catch((error: Error) => this.logger.debug(`email failed: ${error.message}`));
      }
    }

    this.logger.log(
      `${signal.action} ${signal.symbol} notified to ${delivered} of ${audience.length} user(s)`,
    );
    return { delivered };
  }

  /** Outcome updates. Shorter, because they interrupt for less. */
  async signalResolved(resolution: ResolutionNotification): Promise<void> {
    const audience = await this.audienceFor(resolution.symbol);
    if (audience.length === 0) return;

    const label =
      resolution.outcome === 'STOPPED'
        ? 'stopped out'
        : resolution.outcome === 'EXPIRED'
          ? 'cancelled'
          : `reached ${resolution.outcome.replace('HIT_T', 'target ')}`;

    const title = `${resolution.symbol} ${label}`;
    const body = `The ${resolution.symbol} signal ${label} at ${resolution.price.toFixed(2)}.`;

    for (const user of audience) {
      const prefs = user.preferences;

      const notification = await this.prisma.notification.create({
        data: {
          userId: user.id,
          title,
          body,
          kind: 'SIGNAL',
          symbol: resolution.symbol,
          link: `/signals`,
        },
      });

      if (prefs?.signalAlerts === false) continue;
      this.realtime.notifyUser(user.id, notification);

      const chatId = user.preferences?.telegramChatId;
      if (chatId) void this.telegram(chatId, `*${title}*\n${body}`);
    }
  }

  /**
   * A live signal's reasoning has changed.
   *
   * The most important message this system sends, because it is the only one
   * that asks someone to act on a position they already hold. It therefore
   * leads with *why* — a close instruction without a reason is one people
   * either ignore or follow blindly, and both are bad.
   */
  async signalHealthChanged(update: HealthNotification): Promise<{ delivered: number }> {
    const critical = update.severity === 'CRITICAL';
    const audience = await this.audienceFor(update.symbol, critical ? 100 : undefined);
    if (audience.length === 0) return { delivered: 0 };

    const title = critical
      ? `⚠️ CLOSE ${update.action} ${update.symbol} — setup no longer valid`
      : update.severity === 'NONE'
        ? `${update.symbol} — conditions normalised`
        : `${update.symbol} — ${update.action} setup weakening`;

    const lines = [
      critical
        ? `The ${update.action} setup on ${update.symbol} is no longer valid.`
        : `Update on the ${update.action} signal for ${update.symbol}.`,
      '',
      update.summary,
    ];

    if (update.findings.length > 0) {
      lines.push('', 'Why:');
      for (const finding of update.findings.slice(0, 4)) {
        lines.push(`• ${finding.label} — ${finding.detail}`);
        if (finding.evidence) lines.push(`  ${finding.evidence}`);
      }
    }

    lines.push(
      '',
      `Confidence now ${update.confidenceNow.toFixed(0)}/100 (${update.confidenceDelta >= 0 ? '+' : ''}${update.confidenceDelta.toFixed(0)} since issue)`,
    );

    if (update.entry && update.currentPrice) {
      const move = ((update.currentPrice - update.entry) / update.entry) * 100;
      lines.push(
        `Entry ${update.entry.toFixed(2)} · now ${update.currentPrice.toFixed(2)} (${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`,
      );
    }

    if (critical) {
      lines.push(
        '',
        'Recommended: close the position manually.',
        // Stated every time, because a "close this" message implies an ability
        // this platform does not have and silence would be taken as capability.
        'This platform has no broker connection and cannot place or close orders.',
      );
    }

    lines.push('', 'Not investment advice.');
    const body = lines.join('\n');

    let delivered = 0;

    for (const user of audience) {
      const prefs = user.preferences;

      const notification = await this.prisma.notification.create({
        data: {
          userId: user.id,
          title,
          body,
          kind: 'SIGNAL',
          symbol: update.symbol,
          link: `/markets/${update.symbol}`,
        },
      });

      if (prefs?.signalAlerts === false) continue;

      this.realtime.notifyUser(user.id, {
        ...notification,
        signalId: update.signalId,
        severity: update.severity,
        kind: 'SIGNAL_HEALTH',
      });
      delivered += 1;

      // Email only for an invalidation — a warning does not warrant an inbox.
      if (critical && prefs?.emailNotifications) {
        void this.mail
          .send({ to: user.email, subject: title, text: body })
          .catch((error: Error) => this.logger.debug(`email failed: ${error.message}`));
      }

      const chatId = prefs?.telegramChatId;
      if (chatId) void this.telegram(chatId, `*${title}*\n\n${body}`);
    }

    this.logger.log(
      `${update.severity} ${update.symbol} health alert to ${delivered} of ${audience.length} user(s)`,
    );
    return { delivered };
  }

  /**
   * Telegram delivery.
   *
   * Chosen over WhatsApp because it needs one bot token and a chat id — no
   * business verification, no template approval, no per-message billing. A
   * WhatsApp channel would implement this same interface; the difference is
   * entirely in the onboarding, not the code.
   */
  private async telegram(chatId: string, text: string): Promise<void> {
    const token = this.telegramToken;
    if (!token) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      clearTimeout(timer);

      if (!response.ok) {
        this.logger.debug(`telegram ${response.status}: ${(await response.text()).slice(0, 120)}`);
      }
    } catch (error) {
      this.logger.debug(`telegram failed: ${(error as Error).message}`);
    }
  }
}

@Module({
  imports: [PrismaModule, RealtimeModule, ConfigModule],
  controllers: [TelegramController],
  providers: [NotificationsService, TelegramService, MailService],
  exports: [NotificationsService, TelegramService],
})
export class NotificationsModule {}
