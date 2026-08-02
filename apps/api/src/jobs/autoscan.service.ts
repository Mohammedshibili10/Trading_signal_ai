import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ConfluenceService } from '../analysis/confluence.service';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.module';
import type { Timeframe } from '../market-data/providers/provider.interface';
import { calendarFor, statusFor } from '../market-data/market-hours';
import { allocateBudget, prioritise, type AssetTier } from '../market-data/asset-priority';
import { assessReissue, cooldownUntilFor, OPEN_STATUSES } from '../analysis/signal-reissue';

/**
 * The confidence a setup must clear to be pushed to a user unprompted.
 *
 * Materially above the engine's own 45 floor. A signal that arrives as a
 * notification interrupts someone — it has to be worth the interruption, and
 * the bar for "worth showing when asked" is not the bar for "worth pushing".
 */
const NOTIFY_CONFIDENCE = 62;

/** Minimum reward:risk before a scan will emit anything. */
const NOTIFY_MIN_RR = 1.8;

/** How many instruments one scan pass covers. Keeps a pass inside its interval. */
const BATCH_SIZE = 12;

/** A repeat signal on the same symbol+timeframe is suppressed for this long. */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Price movement that makes a pending signal's entry stale, as % of entry. */
const ENTRY_DRIFT_PERCENT = 1.5;

interface ScanTarget {
  symbol: string;
  assetClass: string;
  exchange: string | null;
  timeframe: Timeframe;
  tier: AssetTier;
}

/**
 * Autonomous market monitoring.
 *
 * Runs continuously in the background, scans the instruments users actually
 * care about, and pushes only setups that clear both the confluence gate and a
 * raised confidence bar.
 *
 * The design pressure here is entirely in one direction: **not** notifying.
 * A scanner that fires often trains people to ignore it, at which point it is
 * worse than no scanner at all — so every rule below exists to suppress rather
 * than to surface. Deduplication, a raised confidence floor, a reward:risk
 * floor, market-hours awareness and cursor-based rotation are all forms of
 * saying less.
 */
@Injectable()
export class AutoScanService {
  private readonly logger = new Logger('AutoScan');

  /**
   * Rotation cursor.
   *
   * Scanning the same first twelve symbols every pass would mean the rest of
   * the universe is never looked at. The cursor advances each pass so coverage
   * is complete over several passes rather than deep on a few.
   */
  private cursor = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly confluence: ConfluenceService,
    private readonly marketData: MarketDataService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('autoscan.enabled') !== 'false';
  }

  /**
   * Everything worth watching, with the timeframe to watch it on.
   *
   * Driven by what users have expressed interest in — watchlists, holdings and
   * active alerts — rather than the whole universe. Scanning instruments nobody
   * follows burns provider quota to produce notifications nobody receives.
   */
  private async targets(): Promise<ScanTarget[]> {
    const [watched, held, indices] = await Promise.all([
      this.prisma.watchlistItem.findMany({
        select: {
          symbol: true,
          instrument: { select: { assetClass: true, exchange: true } },
        },
        distinct: ['symbol'],
        take: 150,
      }),
      this.prisma.holding.findMany({
        select: {
          symbol: true,
          instrument: { select: { assetClass: true, exchange: true } },
        },
        distinct: ['symbol'],
        take: 150,
      }),
      // A handful of index instruments so the scanner has something to say even
      // on a fresh install with no watchlists.
      this.prisma.instrument.findMany({
        where: { isActive: true, kind: 'INDEX' },
        select: { symbol: true, assetClass: true, exchange: true },
        take: 8,
      }),
    ]);

    const seen = new Map<string, { assetClass: string; exchange: string | null }>();
    for (const row of [...watched, ...held]) {
      if (row.instrument) {
        seen.set(row.symbol, {
          assetClass: row.instrument.assetClass,
          exchange: row.instrument.exchange ?? null,
        });
      }
    }
    for (const row of indices) {
      seen.set(row.symbol, { assetClass: row.assetClass, exchange: row.exchange ?? null });
    }

    const targets: ScanTarget[] = [];
    for (const [symbol, meta] of seen) {
      // Daily for equities and funds; 1h for the 24-hour markets, where a daily
      // bar is far too slow to be actionable.
      const timeframe: Timeframe =
        meta.assetClass === 'CRYPTO' || meta.assetClass === 'FOREX' ? '1h' : '1D';
      targets.push({
        symbol,
        assetClass: meta.assetClass,
        exchange: meta.exchange,
        timeframe,
        // Overwritten by `prioritise` before the batch is chosen.
        tier: 3,
      });
    }

    return targets;
  }

  /**
   * One scan pass.
   *
   * Sequential rather than parallel: each gated signal fans out into a
   * ten-timeframe fetch plus a calibration run, and twelve of those at once
   * would saturate both the provider and the analysis service.
   */
  async scan(): Promise<{ scanned: number; issued: number; skipped: number }> {
    if (!this.enabled) return { scanned: 0, issued: 0, skipped: 0 };

    const all = await this.targets();
    if (all.length === 0) return { scanned: 0, issued: 0, skipped: 0 };

    // Only scan instruments whose market is actually open. A closed venue
    // produces the same answer every pass and cannot be traded on anyway.
    //
    // Resolved per exchange rather than per asset class, so a holiday closes
    // the NSE without also silencing anything else.
    const open = all.filter(
      (target) => statusFor(calendarFor(target.exchange, target.assetClass)).tradeable,
    );
    if (open.length === 0) return { scanned: 0, issued: 0, skipped: all.length };

    // ── Budget the pass ──────────────────────────────────────
    //
    // The majors are scanned every pass; everything else rotates through the
    // remaining slots. Previously the whole universe rotated equally, which
    // meant BTC and RELIANCE were looked at as often as the least liquid name
    // on the list — and a stale read on a major costs far more.
    const ranked = prioritise(open);
    const { alwaysScan, rotating } = allocateBudget(ranked, BATCH_SIZE);

    const majors = ranked.filter((item) => item.tier === 1).slice(0, alwaysScan);
    const rest = ranked.filter((item) => !majors.includes(item));

    const batch: ScanTarget[] = [...majors];
    for (let i = 0; i < Math.min(rotating, rest.length); i += 1) {
      batch.push(rest[(this.cursor + i) % rest.length]);
    }
    this.cursor = rest.length > 0 ? (this.cursor + rotating) % rest.length : 0;

    let issued = 0;
    let skipped = 0;

    for (const target of batch) {
      try {
        if (await this.hasOpenSignal(target.symbol, target.timeframe)) {
          skipped += 1;
          continue;
        }

        const result = (await this.confluence.gatedSignal(target.symbol, target.timeframe, {
          enforce: true,
        })) as {
          signal?: Record<string, unknown>;
          confluence?: Record<string, unknown>;
        };

        const signal = result.signal;
        if (!signal || !this.worthNotifying(signal)) {
          skipped += 1;
          continue;
        }

        // The reissue decision proper, now that there is an action and a price
        // to judge. Shared with the manual scan so the two cannot disagree
        // about what counts as a genuinely new setup.
        const verdict = await assessReissue(this.prisma, {
          symbol: target.symbol,
          timeframe: this.toPrismaTimeframe(target.timeframe) as string,
          action: signal.action as 'BUY' | 'SELL',
          entry: signal.entry === undefined || signal.entry === null ? null : Number(signal.entry),
          stopLoss:
            signal.stopLoss === undefined || signal.stopLoss === null
              ? null
              : Number(signal.stopLoss),
        });

        if (!verdict.allow) {
          this.logger.debug(
            `withheld ${signal.action} ${target.symbol} ${target.timeframe}: ${verdict.reason}`,
          );
          skipped += 1;
          continue;
        }

        await this.issue(target, signal, result.confluence ?? {}, verdict.supersedesId);
        issued += 1;
      } catch (error) {
        // One unreachable symbol must not end the pass.
        this.logger.debug(`scan failed for ${target.symbol}: ${(error as Error).message}`);
        skipped += 1;
      }
    }

    return { scanned: batch.length, issued, skipped };
  }

  /** The quality bar for an unprompted notification. */
  private worthNotifying(signal: Record<string, unknown>): boolean {
    const action = signal.action as string;
    if (action !== 'BUY' && action !== 'SELL') return false;

    const confidence = Number(signal.confidence ?? 0);
    const rr = Number(signal.riskRewardRatio ?? 0);
    const entry = Number(signal.entry ?? 0);
    const stop = Number(signal.stopLoss ?? 0);

    if (!Number.isFinite(entry) || entry <= 0) return false;
    if (!Number.isFinite(stop) || stop <= 0) return false;

    return confidence >= NOTIFY_CONFIDENCE && rr >= NOTIFY_MIN_RR;
  }

  /**
   * Cheap pre-filter: is anything already live on this symbol and timeframe?
   *
   * Deliberately direction-blind and run *before* analysis, purely to avoid
   * paying for a full multi-timeframe read whose result could not be issued in
   * either direction anyway. It is not the reissue decision — that needs the
   * action and entry price, which do not exist until the analysis has run, and
   * lives in `assessReissue` where both scanners share it.
   */
  private async hasOpenSignal(symbol: string, timeframe: Timeframe): Promise<boolean> {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await this.prisma.signal.findFirst({
      where: {
        symbol,
        timeframe: this.toPrismaTimeframe(timeframe),
        createdAt: { gte: since },
        status: { in: [...OPEN_STATUSES] },
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /** Persist the signal, then fan it out to everyone who should hear about it. */
  private async issue(
    target: ScanTarget,
    signal: Record<string, unknown>,
    confluence: Record<string, unknown>,
    supersedesId: string | null = null,
  ): Promise<void> {
    const instrument = await this.marketData.findInstrument(target.symbol);
    const targets = (signal.targets as Array<{ level: number; price: number }>) ?? [];

    const stored = await this.prisma.signal.create({
      data: {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        timeframe: this.toPrismaTimeframe(target.timeframe),
        action: signal.action as never,
        confidence: Number(signal.confidence),
        horizon: (signal.horizon as string) ?? 'SWING',
        entry: Number(signal.entry),
        entryLow: (signal.entryZone as { low: number } | null)?.low,
        entryHigh: (signal.entryZone as { high: number } | null)?.high,
        stopLoss: Number(signal.stopLoss),
        target1: targets.find((t) => t.level === 1)?.price,
        target2: targets.find((t) => t.level === 2)?.price,
        target3: targets.find((t) => t.level === 3)?.price,
        riskLevel: (signal.riskLevel as never) ?? 'MEDIUM',
        riskRewardRatio: Number(signal.riskRewardRatio ?? 0),
        riskPercent: Number(signal.riskPercent ?? 0),
        suggestedAllocationPercent: Number(signal.suggestedAllocationPercent ?? 0),
        reasons: (signal.reasons as never) ?? [],
        factors: (signal.factors as never) ?? [],
        forecast: (signal.forecast as never) ?? undefined,
        calibration: (signal.calibration as never) ?? undefined,
        explanation: (signal.explanation as string) ?? '',
        validUntil: new Date(Date.now() + this.validityMs(target.timeframe)),
        supersedesId: supersedesId ?? undefined,
      },
    });

    this.logger.log(
      `${signal.action} ${instrument.symbol} (tier ${target.tier}) ${target.timeframe} ` +
        `@ ${signal.entry} conf ${signal.confidence} RR ${signal.riskRewardRatio}`,
    );

    // Push to anyone watching the symbol, live.
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
      timeframe: target.timeframe,
      entry: Number(signal.entry),
      stopLoss: Number(signal.stopLoss),
      targets: targets.map((t) => t.price),
      riskRewardRatio: Number(signal.riskRewardRatio ?? 0),
      confidence: Number(signal.confidence),
      reason:
        (signal.explanation as string) ||
        ((signal.reasons as string[]) ?? []).slice(0, 2).join(' '),
      confluence: (confluence.summary as string) ?? '',
      createdAt: stored.createdAt,
    });
  }

  /**
   * Track every live signal against the current price.
   *
   * A signal that is issued and never resolved is a signal nobody can learn
   * from. This is what turns the feed into a record with outcomes rather than a
   * list of opinions.
   */
  async track(): Promise<{ checked: number; resolved: number }> {
    const active = await this.prisma.signal.findMany({
      where: { status: { in: ['ACTIVE', 'HIT_T1', 'HIT_T2'] } },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });
    if (active.length === 0) return { checked: 0, resolved: 0 };

    const quotes = await this.marketData.getQuotes([...new Set(active.map((s) => s.symbol))]);
    const priceBySymbol = new Map(quotes.map((q) => [q.symbol, q.price]));

    let resolved = 0;

    for (const signal of active) {
      const price = priceBySymbol.get(signal.symbol);
      if (price === undefined) continue;

      const long = signal.action === 'BUY';
      const stop = signal.stopLoss ? Number(signal.stopLoss) : null;
      const entry = signal.entry ? Number(signal.entry) : null;
      const levels = [signal.target1, signal.target2, signal.target3].map((t) =>
        t === null || t === undefined ? null : Number(t),
      );

      // ── Entry fill ───────────────────────────────────────────
      //
      // Recorded the first time price trades where a limit order would have
      // been filled. This is the fact that separates a cancelled *position*
      // from a setup that was never taken, and so decides whether ending the
      // signal early could have cost anything at all. Without it every
      // cancellation looks alike, and half of them get reported as trades that
      // never happened.
      if (signal.entryFilledAt === null && entry !== null) {
        const limit = long
          ? Number(signal.entryHigh ?? entry)
          : Number(signal.entryLow ?? entry);
        const filled = long ? price <= limit : price >= limit;
        if (filled) {
          await this.prisma.signal.update({
            where: { id: signal.id },
            data: { entryFilledAt: new Date() },
          });
          signal.entryFilledAt = new Date();
        }
      }

      // Stop first. When a bar touches both the stop and a target, assuming the
      // good fill is how a backtest lies to you — and this is live tracking, so
      // the pessimistic read is the honest one.
      if (stop !== null && ((long && price <= stop) || (!long && price >= stop))) {
        await this.resolve(signal.id, 'STOPPED', `Stop hit at ${price}`);
        await this.notifications.signalResolved({
          signalId: signal.id,
          symbol: signal.symbol,
          outcome: 'STOPPED',
          price,
        });
        resolved += 1;
        continue;
      }

      let hit: 'HIT_T1' | 'HIT_T2' | 'HIT_T3' | null = null;
      for (const [index, level] of levels.entries()) {
        if (level === null) continue;
        const reached = long ? price >= level : price <= level;
        if (reached) hit = (['HIT_T1', 'HIT_T2', 'HIT_T3'] as const)[index];
      }

      if (hit && hit !== signal.status) {
        const terminal = hit === 'HIT_T3';
        await this.prisma.signal.update({
          where: { id: signal.id },
          data: {
            status: hit,
            outcomeNote: `${hit.replace('HIT_', 'Target ')} reached at ${price}`,
            ...(terminal ? { resolvedAt: new Date() } : {}),
          },
        });
        await this.notifications.signalResolved({
          signalId: signal.id,
          symbol: signal.symbol,
          outcome: hit,
          price,
        });
        resolved += 1;
        continue;
      }

      // Cancel a signal price has walked away from before it ever triggered.
      // An entry 4% below the market is not a plan, it is a stale number.
      if (
        signal.status === 'ACTIVE' &&
        entry !== null &&
        entry > 0 &&
        Math.abs((price - entry) / entry) * 100 > ENTRY_DRIFT_PERCENT * 2.5
      ) {
        const moved = ((price - entry) / entry) * 100;
        const away = long ? moved > 0 : moved < 0;
        if (away) {
          // Never filled and no longer fillable: the setup became invalid
          // before execution, so there was never a position and never a P&L.
          await this.resolve(
            signal.id,
            'INVALID',
            `Price moved ${Math.abs(moved).toFixed(1)}% past the entry without filling — setup no longer valid`,
            signal.timeframe,
          );
          resolved += 1;
        }
      }
    }

    return { checked: active.length, resolved };
  }

  /**
   * Close a signal out.
   *
   * Statuses the engine chose also get a cooldown, because the market will go
   * on saying what it said and the next scan would otherwise re-derive the
   * setup that was just stood down from. A stop-out gets no cooldown here: it
   * was price that closed it, not a judgement, and the whipsaw check is what
   * covers a run of them.
   */
  private async resolve(
    id: string,
    status: string,
    note: string,
    timeframe?: string,
  ): Promise<void> {
    const engineEnded = status === 'CANCELLED' || status === 'INVALID';
    await this.prisma.signal.update({
      where: { id },
      data: {
        status: status as never,
        outcomeNote: note,
        resolvedAt: new Date(),
        ...(engineEnded && timeframe ? { cooldownUntil: cooldownUntilFor(timeframe) } : {}),
      },
    });
  }

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
