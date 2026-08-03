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

/**
 * How each trade horizon is named in a message.
 *
 * Mirrors `HORIZONS` in the web client. Kept as a small literal rather than
 * imported across the workspace boundary — the API and the web app are built
 * and deployed separately, and a shared constant would couple them for four
 * strings.
 */
const HORIZON_LABEL: Record<string, { label: string; holding: string }> = {
  INTRADAY: { label: 'Intraday', holding: 'same session' },
  SWING: { label: 'Swing', holding: 'days to ~2 weeks' },
  POSITIONAL: { label: 'Positional', holding: 'weeks to months' },
  LONG_TERM: { label: 'Long term', holding: 'months or longer' },
};

/**
 * Escape the four characters Telegram's HTML parser treats as markup.
 *
 * Applied to the whole message body, with the `<b>` wrapper added afterwards,
 * so no amount of engine prose can produce an unparseable message. A trade
 * alert must never be lost to a stray angle bracket in a factor label.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  /** Trade horizon — INTRADAY | SWING | POSITIONAL | LONG_TERM. */
  horizon?: string | null;
  entry: number;
  stopLoss: number;
  targets: number[];
  riskRewardRatio: number;
  confidence: number;
  reason: string;
  confluence: string;
  createdAt: Date;
  /** CRYPTO | FOREX | EQUITY | INVESTMENT, for the message header. */
  assetClass?: string | null;
  /** The ranked factor evidence — the engine's own reasoning, in order. */
  reasons?: string[];
  /** What the timeframes above the entry said, and why the entry was allowed. */
  higherTimeframe?: string;
  /** The band a limit order should sit in, when the engine defined one. */
  entryZone?: { low: number; high: number } | null;
  /** Stop distance as a percentage of entry. */
  riskPercent?: number;
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
   * The chat, group or channel that receives every signal.
   *
   * Empty when unconfigured, in which case delivery falls back to per-user
   * linked chats only — which is the state that made this look broken.
   */
  private get telegramChannel(): string {
    return this.config.get<string>('notifications.telegramChatId') ?? '';
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

  /**
   * Price with a sensible number of decimals for the instrument's scale.
   *
   * `toFixed(2)` is wrong for most of what this platform trades: EURUSD at
   * 1.1547 renders as "1.15", which is not a price anyone can act on — it
   * rounds away four times the typical daily range of the pair. The scale has
   * to come from the number itself.
   */
  private price(value: number): string {
    const magnitude = Math.abs(value);
    if (!Number.isFinite(value)) return '—';
    if (magnitude >= 1000) return value.toFixed(2);
    if (magnitude >= 10) return value.toFixed(2);
    if (magnitude >= 1) return value.toFixed(4);
    return value.toFixed(6);
  }

  /** Format a signal the way a trader would want to read it on a phone. */
  private format(signal: SignalNotification): { title: string; body: string } {
    const targets = signal.targets.length
      ? signal.targets.map((t, i) => `TP${i + 1} ${this.price(t)}`).join(' · ')
      : 'no targets';

    // What kind of trade this is, stated before the numbers. A push notification
    // is read away from the screen and acted on from memory: "SELL BTC on 1h"
    // does not say whether to close it before the session ends or hold it for a
    // fortnight, and that decides both the position size and the stop.
    const horizon = HORIZON_LABEL[String(signal.horizon ?? '').toUpperCase()];

    const entry = signal.entryZone
      ? `Entry ${this.price(signal.entry)} (zone ${this.price(signal.entryZone.low)}–${this.price(signal.entryZone.high)})`
      : `Entry ${this.price(signal.entry)}`;

    const stop = signal.riskPercent
      ? `SL ${this.price(signal.stopLoss)} (${signal.riskPercent.toFixed(2)}% risk)`
      : `SL ${this.price(signal.stopLoss)}`;

    // The engine's ranked evidence, not just the one-line explanation. This is
    // the part a trader uses to decide whether they agree, and it was the one
    // part the message left out.
    const reasoning = (signal.reasons ?? [])
      .slice(0, 6)
      .map((line) => `• ${line}`)
      .join('\n');

    return {
      title:
        `${signal.action} ${signal.symbol} · ` +
        `${horizon ? `${horizon.label} · ` : ''}${signal.timeframe} · ` +
        `${signal.confidence.toFixed(0)}/100`,
      body: [
        `${signal.action} ${signal.symbol} (${signal.name})` +
          `${signal.assetClass ? ` · ${signal.assetClass}` : ''} on ${signal.timeframe}`,
        horizon ? `${horizon.label} trade · typical hold ${horizon.holding}` : '',
        '',
        entry,
        stop,
        targets,
        `R:R ${signal.riskRewardRatio.toFixed(2)}:1 · confidence ${signal.confidence.toFixed(0)}/100`,
        '',
        signal.reason,
        reasoning ? `\nWhy:\n${reasoning}` : '',
        signal.higherTimeframe ? `\nHigher timeframes: ${signal.higherTimeframe}` : '',
        signal.confluence ? `\nConfluence: ${signal.confluence}` : '',
        // Local time, not UTC. An IST reader given a UTC stamp sees an alert
        // dated five and a half hours ago and reads it as stale — the worst
        // possible failure for a time-sensitive message.
        `\nIssued ${localTime(signal.createdAt)}`,
        '\nNot investment advice. Probabilities are historical frequencies, not promises.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  async signalIssued(signal: SignalNotification): Promise<{ delivered: number }> {
    const { title, body } = this.format(signal);
    const telegramText = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;

    // ── Telegram first, and independent of the in-app audience ──
    //
    // The channel receives every issued signal, whether or not a single user
    // has linked a chat and whether or not anybody follows the symbol. This is
    // the delivery that was missing: `audienceFor` returning empty used to
    // return early, so a signal on an instrument nobody had watchlisted was
    // stored, broadcast to sockets, and sent to Telegram never — which is
    // indistinguishable from Telegram being broken, and was reported as such.
    //
    // Nothing here is awaited: a slow or failing Telegram call must not delay
    // the next recipient, or the database write below.
    const channel = this.telegramChannel;
    if (channel) void this.telegram(channel, telegramText, `signal ${signal.symbol}`);

    const audience = await this.audienceFor(signal.symbol, signal.confidence);

    if (audience.length === 0) {
      this.logger.log(
        `${signal.action} ${signal.symbol} — no in-app audience at confidence ` +
          `${signal.confidence.toFixed(0)} (nobody follows it and it is below the ` +
          `${BROADCAST_CONFIDENCE} broadcast bar)` +
          `${channel ? '; sent to the Telegram channel' : ''}`,
      );
      return { delivered: 0 };
    }

    // ── Push first, persist second ──────────────────────────────
    //
    // Telegram goes out before anything is written. A trade alert is worth
    // only as much as its timeliness, whereas the database row is worth the
    // same whenever it lands. Previously each user's message waited behind
    // that user's INSERT and the inserts ran one at a time, so against a
    // remote database every recipient added a full round-trip — the last
    // person on a long list could be many seconds behind the first.
    for (const user of audience) {
      if (user.preferences?.signalAlerts === false) continue;
      const chatId = user.preferences?.telegramChatId;
      // Skip a personal chat that is also the channel, or the same message
      // arrives twice.
      if (chatId && chatId !== channel) {
        void this.telegram(chatId, telegramText, `signal ${signal.symbol}`);
      }
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
    const label =
      resolution.outcome === 'STOPPED'
        ? 'stopped out'
        : resolution.outcome === 'EXPIRED'
          ? 'cancelled'
          : `reached ${resolution.outcome.replace('HIT_T', 'target ')}`;

    const title = `${resolution.symbol} ${label}`;
    const body = `The ${resolution.symbol} signal ${label} at ${this.price(resolution.price)}.`;

    // The channel that was told about the entry is told about the exit. A feed
    // of entries with no outcomes is the least trustworthy thing a signal
    // service can publish.
    const channel = this.telegramChannel;
    if (channel) {
      void this.telegram(
        channel,
        `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
        `resolution ${resolution.symbol}`,
      );
    }

    const audience = await this.audienceFor(resolution.symbol);
    if (audience.length === 0) return;

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
      if (chatId && chatId !== channel) {
        void this.telegram(
          chatId,
          `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
          `resolution ${resolution.symbol}`,
        );
      }
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

    // A "close this position" message is the most consequential thing the
    // platform sends, so it goes to the channel that carried the entry — not
    // only to whoever happens to follow the symbol.
    const channel = this.telegramChannel;
    if (channel) {
      void this.telegram(
        channel,
        `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`,
        `health ${update.symbol}`,
      );
    }

    const audience = await this.audienceFor(update.symbol, critical ? 100 : undefined);
    if (audience.length === 0) return { delivered: 0 };

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
      if (chatId && chatId !== channel) {
        void this.telegram(
          chatId,
          `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`,
          `health ${update.symbol}`,
        );
      }
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
   *
   * **HTML rather than Markdown.** Legacy Markdown has no escape mechanism
   * worth the name, and every message this sends is built from engine prose:
   * factor labels carry `*`, instrument symbols carry `_` (`MF_HDFC_MIDCAP`),
   * and levels carry `(` and `)`. One unbalanced character makes Telegram
   * reject the whole message with `400 Can't parse entities`, which drops a
   * live trade alert on the floor for a formatting reason. HTML has exactly
   * four characters to escape and `escapeHtml` handles all of them.
   *
   * **Failures are logged at warn, with Telegram's own description.** They were
   * logged at debug, which is below the default level — so a bad token, a bot
   * that had never been added to the channel, or a chat that had blocked the
   * bot all failed completely silently. "Telegram is not sending" with nothing
   * in the log is the hardest possible version of this bug to diagnose, and it
   * was self-inflicted.
   */
  private async telegram(chatId: string, text: string, context = 'message'): Promise<void> {
    const token = this.telegramToken;
    if (!token) {
      this.logger.warn(
        `TELEGRAM_BOT_TOKEN is not set — ${context} not delivered. ` +
          'Create a bot with @BotFather and put the token in .env.',
      );
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, 4096),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      clearTimeout(timer);

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          `telegram ${context} to ${chatId} failed (${response.status}): ${detail.slice(0, 200)}`,
        );
        return;
      }

      this.logger.debug(`telegram ${context} delivered to ${chatId}`);
    } catch (error) {
      this.logger.warn(`telegram ${context} to ${chatId} failed: ${(error as Error).message}`);
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
