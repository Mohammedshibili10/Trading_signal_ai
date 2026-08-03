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

/**
 * The bar when the higher timeframes have no view.
 *
 * Every entry below is taken with the daily context already read, and the
 * normal case is that the context *agrees* with the entry — that agreement is
 * most of what makes a lower-timeframe setup worth acting on. When the higher
 * timeframes are genuinely directionless the setup has to stand on its own
 * evidence alone, so it is held to a materially higher confidence instead of
 * being refused outright. Refusing outright would silence the scanner through
 * every ranging market, which is precisely when intraday setups are the only
 * ones on offer.
 */
const UNANCHORED_CONFIDENCE = 72;

/**
 * How many **instruments** one scan pass may cover.
 *
 * Counted in instruments rather than in instrument-timeframe pairs, because a
 * pass is now organised around the instrument: the higher-timeframe context is
 * read once and then several lower timeframes are searched against it. Forty
 * pairs and forty instruments were the same thing when crypto and forex were
 * scanned on two timeframes; at four they are not.
 *
 * This is the ceiling, not the target — `SCAN_BUDGET_MS` is what actually ends
 * a pass, because the honest cost of a batch is not knowable in advance.
 */
const BATCH_SIZE = 16;

/**
 * Wall-clock budget for one pass.
 *
 * The scan runs every five minutes and must finish inside that, or the overlap
 * guard starts skipping ticks and coverage silently gets worse the more
 * instruments are added. A fixed count cannot express this: forty warm scans
 * take seconds, forty cold ones would take ten minutes. Stopping on elapsed
 * time instead means a cold pass covers fewer instruments and hands the rest to
 * the next pass, while a warm pass gets through the whole batch.
 */
const SCAN_BUDGET_MS = 210_000;

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

/** One instrument, with every timeframe it is to be searched on. */
interface ScanSubject {
  symbol: string;
  assetClass: string;
  exchange: string | null;
  tier: AssetTier;
  timeframes: Timeframe[];
}

/**
 * What the timeframes above the entry are saying, read once per instrument.
 *
 * This is the "higher timeframes first" half of the pass. It is deliberately
 * the cheap read — trend and structure agreement across 1h/4h/1D/1W/1M, with
 * no calibration and no trade attached — because its job is to decide *whether
 * and in which direction* to spend the expensive read below it, not to produce
 * a signal itself.
 */
interface HigherTimeframeContext {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  verdict: string;
  alignment: number;
  summary: string;
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
  private async targets(): Promise<ScanSubject[]> {
    const [watched, held, universe] = await Promise.all([
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
      // The rest of the tradeable universe.
      //
      // This used to be eight index instruments — a fallback so a fresh install
      // had something to say. Everything else was invisible to the scanner
      // unless somebody had already watchlisted it, which meant the engine only
      // ever looked where a user had already looked and could not surface a
      // setup on an instrument nobody was watching yet. Finding those is the
      // entire point of an autonomous scan.
      //
      // Affordable now because calibration is cached per closed bar: a scan
      // that cost ~15s per instrument costs ~1s once that bar's report exists,
      // so the universe is bounded by the rotation budget rather than by how
      // much work one pass can survive.
      this.prisma.instrument.findMany({
        where: { isActive: true },
        select: { symbol: true, assetClass: true, exchange: true },
        take: 300,
      }),
    ]);

    // Watchlisted and held instruments are inserted first, so they sit at the
    // head of the rotation and are reached soonest within any given pass.
    const seen = new Map<string, { assetClass: string; exchange: string | null }>();
    for (const row of [...watched, ...held]) {
      if (row.instrument) {
        seen.set(row.symbol, {
          assetClass: row.instrument.assetClass,
          exchange: row.instrument.exchange ?? null,
        });
      }
    }
    for (const row of universe) {
      if (seen.has(row.symbol)) continue;
      seen.set(row.symbol, { assetClass: row.assetClass, exchange: row.exchange ?? null });
    }

    const subjects: ScanSubject[] = [];
    for (const [symbol, meta] of seen) {
      subjects.push({
        symbol,
        assetClass: meta.assetClass,
        exchange: meta.exchange,
        // Overwritten by `prioritise` before the batch is chosen.
        tier: 3,
        timeframes: this.scanTimeframes(meta.assetClass),
      });
    }

    return subjects;
  }

  /**
   * Which timeframes an instrument is searched on, slowest first.
   *
   * Ordered deliberately. The pass walks this list in order, so the daily read
   * happens before the four-hour and the four-hour before the fifteen-minute —
   * the context is established on the timeframe that sets it, and every faster
   * entry is judged against a picture that has already been formed.
   *
   * Daily for equities and funds; the 24-hour markets get the full ladder,
   * because that is where this platform's users actually trade and because a
   * market with no close has no natural daily reset to wait for.
   *
   * The setup timeframe decides the horizon, and the horizon decides which
   * timeframes vote in the confluence gate: 15m is INTRADAY (voted on by
   * 1m…1D), 1h and 4h are SWING (15m…1W), 1D is POSITIONAL (1h…1M). So this
   * one list produces exactly the two trade types the platform leads with —
   * **intraday** off the 15m and **swing** off the 1h and 4h — with the
   * positional daily kept as the slowest read and as the anchor the others are
   * measured against.
   *
   * Scanning crypto and forex at 1h and 1D only, as this did, left the intraday
   * horizon completely unscanned: no 15m setup could ever be issued because no
   * 15m setup was ever looked for. It also skipped 4h entirely, which measured
   * as the most productive swing timeframe on this universe.
   *
   * Each entry is an independent signal with its own horizon — deduplication is
   * keyed on symbol *and* timeframe — so BTC can carry a positional long and an
   * intraday short at once. That is a real thing traders do, and the horizon is
   * labelled on every signal, so the two are told apart on sight.
   */
  private scanTimeframes(assetClass: string): Timeframe[] {
    return assetClass === 'CRYPTO' || assetClass === 'FOREX'
      ? ['1D', '4h', '1h', '15m']
      : ['1D'];
  }

  /**
   * Read the timeframes above the trade before looking for one.
   *
   * Cheap by design: trend and structure agreement across 1h/4h/1D/1W/1M with
   * no calibration pass and no trade attached. Its job is to decide whether the
   * expensive per-timeframe read below is worth running at all, and in which
   * direction — not to produce a signal.
   *
   * Returns null when the instrument cannot be read at all, which is treated as
   * "skip", not as "no bias": an unreadable instrument is not a directionless
   * one, and conflating the two would let a data outage look like a ranging
   * market and quietly lower the bar.
   */
  private async higherTimeframeContext(symbol: string): Promise<HigherTimeframeContext | null> {
    try {
      const read = (await this.confluence.confluence(symbol, 'POSITIONAL', '1D')) as {
        bias?: string;
        verdict?: string;
        alignmentScore?: number;
        summary?: string;
      };

      const bias = read.bias === 'BULLISH' || read.bias === 'BEARISH' ? read.bias : 'NEUTRAL';

      if (read.verdict === 'INSUFFICIENT_DATA') return null;

      return {
        bias,
        verdict: read.verdict ?? 'UNKNOWN',
        alignment: Number(read.alignmentScore ?? 0),
        summary: read.summary ?? '',
      };
    } catch (error) {
      this.logger.debug(`higher-timeframe read failed for ${symbol}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Does this setup have the higher timeframes behind it?
   *
   * A counter-trend entry is not automatically wrong, but it is not what an
   * unattended scanner should be pushing to someone's phone. When the daily
   * context has a direction, only entries with it are issued; when it does not,
   * the entry has to carry itself on a higher confidence.
   */
  private anchored(
    signal: Record<string, unknown>,
    context: HigherTimeframeContext,
  ): { allow: boolean; reason: string } {
    const wanted = signal.action === 'BUY' ? 'BULLISH' : 'BEARISH';

    if (context.bias === 'NEUTRAL') {
      const confidence = Number(signal.confidence ?? 0);
      return confidence >= UNANCHORED_CONFIDENCE
        ? {
            allow: true,
            reason:
              `Higher timeframes are directionless (${context.verdict}, alignment ` +
              `${context.alignment.toFixed(0)}/100), so this setup stands on its own evidence ` +
              `at ${confidence.toFixed(0)}/100.`,
          }
        : {
            allow: false,
            reason:
              `no higher-timeframe direction and confidence ${confidence.toFixed(0)} is below ` +
              `the unanchored bar of ${UNANCHORED_CONFIDENCE}`,
          };
    }

    if (context.bias !== wanted) {
      return {
        allow: false,
        reason: `counter-trend — higher timeframes read ${context.bias.toLowerCase()}`,
      };
    }

    return {
      allow: true,
      reason:
        `Higher timeframes read ${context.bias.toLowerCase()} at alignment ` +
        `${context.alignment.toFixed(0)}/100, which is the direction of this entry.`,
    };
  }

  /**
   * One scan pass: higher timeframes first, then entries below them.
   *
   * The shape is the method. For each instrument the daily context is read
   * once — cheap, no calibration, no trade — and only then are the faster
   * timeframes searched, slowest first, with every candidate entry checked
   * against that context before it can be issued. An instrument whose higher
   * timeframes cannot be read at all is skipped rather than searched blind.
   *
   * Sequential rather than parallel: each gated signal fans out into a
   * ten-timeframe fetch plus a calibration run, and a dozen of those at once
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

    const batch: ScanSubject[] = [...majors];
    for (let i = 0; i < Math.min(rotating, rest.length); i += 1) {
      batch.push(rest[(this.cursor + i) % rest.length]);
    }
    this.cursor = rest.length > 0 ? (this.cursor + rotating) % rest.length : 0;

    let issued = 0;
    let skipped = 0;
    let covered = 0;
    const startedAt = Date.now();

    for (const subject of batch) {
      // Stop on elapsed time rather than on count. Whatever is left rides the
      // cursor into the next pass, so a slow pass costs coverage rather than
      // colliding with the next tick and losing a whole cycle to the overlap
      // guard.
      if (Date.now() - startedAt > SCAN_BUDGET_MS) {
        const dropped = batch.length - covered;
        this.logger.log(
          `scan budget reached after ${covered} of ${batch.length} — ` +
            `${dropped} deferred to the next pass`,
        );
        // Rewind the cursor so the deferred rotating subjects are picked up next
        // time instead of being skipped over.
        this.cursor = rest.length > 0 ? (this.cursor - dropped + rest.length * 2) % rest.length : 0;
        break;
      }
      covered += 1;

      // ── Higher timeframes, first and once ──────────────────────
      //
      // One read per instrument rather than one per candidate entry: the daily
      // context does not change between the 4h search and the 15m search, and
      // paying for it four times would be the same answer at four times the
      // cost.
      const context = await this.higherTimeframeContext(subject.symbol);
      if (!context) {
        this.logger.debug(`${subject.symbol}: higher timeframes unreadable — skipped`);
        skipped += subject.timeframes.length;
        continue;
      }

      // ── Then the entries, slowest first ────────────────────────
      for (const timeframe of subject.timeframes) {
        if (Date.now() - startedAt > SCAN_BUDGET_MS) break;

        const target: ScanTarget = {
          symbol: subject.symbol,
          assetClass: subject.assetClass,
          exchange: subject.exchange,
          tier: subject.tier,
          timeframe,
        };

        try {
          if (await this.hasOpenSignal(target.symbol, timeframe)) {
            skipped += 1;
            continue;
          }

          const result = (await this.confluence.gatedSignal(target.symbol, timeframe, {
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

          // Does the picture above this entry support it?
          const anchor = this.anchored(signal, context);
          if (!anchor.allow) {
            this.logger.debug(
              `withheld ${signal.action} ${target.symbol} ${timeframe}: ${anchor.reason}`,
            );
            skipped += 1;
            continue;
          }

          // The reissue decision proper, now that there is an action and a
          // price to judge. Shared with the manual scan so the two cannot
          // disagree about what counts as a genuinely new setup.
          const verdict = await assessReissue(this.prisma, {
            symbol: target.symbol,
            timeframe: this.toPrismaTimeframe(timeframe) as string,
            action: signal.action as 'BUY' | 'SELL',
            entry:
              signal.entry === undefined || signal.entry === null ? null : Number(signal.entry),
            stopLoss:
              signal.stopLoss === undefined || signal.stopLoss === null
                ? null
                : Number(signal.stopLoss),
          });

          if (!verdict.allow) {
            this.logger.debug(
              `withheld ${signal.action} ${target.symbol} ${timeframe}: ${verdict.reason}`,
            );
            skipped += 1;
            continue;
          }

          await this.issue(
            target,
            signal,
            result.confluence ?? {},
            verdict.supersedesId,
            `${anchor.reason} ${context.summary}`.trim(),
          );
          issued += 1;
        } catch (error) {
          // One unreachable timeframe must not end the instrument.
          this.logger.debug(
            `scan failed for ${target.symbol} ${timeframe}: ${(error as Error).message}`,
          );
          skipped += 1;
        }
      }
    }

    // `covered`, not `batch.length` — reporting the batch as scanned when the
    // budget cut it short would overstate coverage in the one situation where
    // knowing the real number matters.
    return { scanned: covered, issued, skipped };
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
    /** What the timeframes above this entry said, and why it was allowed. */
    higherTimeframe = '',
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
      horizon: (signal.horizon as string) ?? stored.horizon,
      entry: Number(signal.entry),
      stopLoss: Number(signal.stopLoss),
      targets: targets.map((t) => t.price),
      riskRewardRatio: Number(signal.riskRewardRatio ?? 0),
      confidence: Number(signal.confidence),
      reason:
        (signal.explanation as string) ||
        ((signal.reasons as string[]) ?? []).slice(0, 2).join(' '),
      reasons: (signal.reasons as string[]) ?? [],
      confluence: (confluence.summary as string) ?? '',
      higherTimeframe,
      entryZone: (signal.entryZone as { low: number; high: number } | null) ?? null,
      riskPercent: Number(signal.riskPercent ?? 0),
      assetClass: instrument.assetClass,
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
