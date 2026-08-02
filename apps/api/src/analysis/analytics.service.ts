import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  countsAsPerformance,
  isEngineEnded,
  lifecycleStageOf,
  outcomeOf,
  STATUS_LABEL,
} from './signal-outcome';

const PRISMA_TO_TIMEFRAME: Record<string, string> = {
  M1: '1m', M3: '3m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D1: '1D', W1: '1W', MN1: '1M',
};

/** Which horizon each timeframe belongs to, for the style breakdown. */
const STYLE_BY_TIMEFRAME: Record<string, string> = {
  '1m': 'SCALPING', '3m': 'SCALPING', '5m': 'SCALPING',
  '15m': 'INTRADAY', '30m': 'INTRADAY', '1h': 'INTRADAY',
  '4h': 'SWING', '1D': 'SWING',
  '1W': 'POSITIONAL', '1M': 'POSITIONAL',
};

/**
 * Analysis methods tracked individually.
 *
 * Mapped from the factor groups the engine records on every signal, plus the
 * SMC sub-concepts which live inside MARKET_STRUCTURE and would otherwise be
 * invisible — "market structure worked" is far less actionable than "order
 * blocks worked and liquidity sweeps did not".
 */
const METHODS: Array<{ key: string; label: string; from: string }> = [
  { key: 'SMC', label: 'Smart Money Concepts', from: 'MARKET_STRUCTURE' },
  { key: 'ORDER_BLOCKS', label: 'Order Blocks', from: 'MARKET_STRUCTURE' },
  { key: 'FVG', label: 'Fair Value Gaps', from: 'MARKET_STRUCTURE' },
  { key: 'LIQUIDITY', label: 'Liquidity Sweeps', from: 'MARKET_STRUCTURE' },
  { key: 'PRICE_ACTION', label: 'Price Action', from: 'PRICE_ACTION' },
  { key: 'WYCKOFF', label: 'Wyckoff', from: 'VOLUME' },
  { key: 'TREND', label: 'Trend / EMA', from: 'TREND' },
  { key: 'INDICATORS', label: 'RSI / MACD / oscillators', from: 'INDICATORS' },
  { key: 'VOLUME', label: 'Volume & Order Flow', from: 'VOLUME' },
  { key: 'CANDLESTICK', label: 'Candlestick patterns', from: 'CANDLESTICK' },
  { key: 'VOLATILITY', label: 'Volatility', from: 'VOLATILITY' },
  { key: 'NEWS', label: 'News & Sentiment', from: 'NEWS' },
];

interface FactorRecord {
  group?: string;
  score?: number;
  weight?: number;
  detail?: string;
}

interface TradeRow {
  id: string;
  symbol: string;
  assetClass: string;
  timeframe: string;
  action: string;
  status: string;
  confidence: unknown;
  riskRewardRatio: unknown;
  riskPercent: unknown;
  entry: unknown;
  stopLoss: unknown;
  target1: unknown;
  realisedR: unknown;
  maeR: unknown;
  mfeR: unknown;
  captureRatio: unknown;
  barsHeld: number | null;
  primaryReason: string | null;
  postMortem: unknown;
  factors: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  outcomeNote: string | null;
  archivedAt: Date | null;
  invalidationReason: string | null;
  entryFilledAt: Date | null;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Backtesting and performance analytics.
 *
 * Every number here is computed from signals the engine actually issued and
 * that actually resolved. Nothing is simulated, and nothing is annualised or
 * extrapolated — a 12-trade record produces 12-trade statistics, reported as
 * such, because the alternative is a confident-looking figure that is mostly
 * an artefact of the sample size.
 *
 * `meaningful` accompanies every aggregate for exactly that reason.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private async trades(limit = 1000): Promise<TradeRow[]> {
    return this.prisma.signal.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, symbol: true, assetClass: true, timeframe: true, action: true,
        status: true, confidence: true, riskRewardRatio: true, riskPercent: true,
        entry: true, stopLoss: true, target1: true, realisedR: true, maeR: true,
        mfeR: true, captureRatio: true, barsHeld: true, primaryReason: true,
        postMortem: true, factors: true, createdAt: true, resolvedAt: true,
        outcomeNote: true, archivedAt: true, invalidationReason: true,
        entryFilledAt: true,
      },
    }) as Promise<TradeRow[]>;
  }

  /**
   * Everything the analytics section needs, in one payload.
   *
   * Cached for a minute. Every subsection reads the same trade set, and issuing
   * nine queries that each scan the signals table to render one page would be
   * the obvious way to write this and the wrong one.
   */
  async overview(): Promise<Record<string, unknown>> {
    return this.redis.wrap('analytics:overview', 60, async () => {
      const rows = await this.trades();

      // Only price-resolved trades carry performance. Anything the engine ended
      // has no P&L to contribute, and counting it would drag the win rate down
      // with trades that were never actually lost.
      const closed = rows.filter((r) => countsAsPerformance(r.status));
      const active = rows.filter((r) => ['ACTIVE'].includes(r.status));
      const cancelled = rows.filter(
        (r) => isEngineEnded(r.status) || r.status === 'EXPIRED',
      );

      return {
        summary: this.summarise(rows, closed, active, cancelled),
        methods: this.byMethod(closed),
        styles: this.byStyle(closed),
        assets: this.groupBy(closed, (r) => r.symbol, 12),
        timeframes: this.groupBy(closed, (r) => PRISMA_TO_TIMEFRAME[r.timeframe] ?? r.timeframe),
        equityCurve: this.equityCurve(closed),
        distribution: this.distribution(closed),
        periods: this.periods(closed),
        journal: rows.slice(0, 100).map((r) => this.journalEntry(r)),
      };
    });
  }

  /** Headline statistics. */
  private summarise(
    all: TradeRow[],
    closed: TradeRow[],
    active: TradeRow[],
    cancelled: TradeRow[],
  ) {
    const wins = closed.filter((r) => r.status.startsWith('HIT_'));
    const losses = closed.filter((r) => r.status === 'STOPPED');

    const rOf = (r: TradeRow) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1);

    const grossProfit = wins.reduce((sum, r) => sum + Math.max(0, rOf(r)), 0);
    const grossLoss = Math.abs(losses.reduce((sum, r) => sum + Math.min(0, rOf(r)), 0));

    // Peak-to-trough on the cumulative R curve, in order.
    const ordered = [...closed].reverse();
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const trade of ordered) {
      equity += rOf(trade);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }

    const durations = closed
      .map((r) =>
        r.resolvedAt ? (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000 : null,
      )
      .filter((v): v is number => v !== null);

    const rrs = closed.map((r) => num(r.riskRewardRatio)).filter((v): v is number => v !== null);

    return {
      totalSignals: all.length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      active: active.length,
      cancelled: cancelled.length,
      winRate: closed.length ? wins.length / closed.length : null,
      // Share of *all* issued signals that reached a target — different from win
      // rate, which excludes those cancelled before entry.
      successRate: all.length ? wins.length / all.length : null,
      averageRiskReward: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
      totalProfitR: grossProfit,
      totalLossR: grossLoss,
      // Averages as well as totals: a 20R profit from forty trades and from
      // four are different systems, and the totals alone cannot tell them apart.
      averageProfitR: wins.length ? grossProfit / wins.length : null,
      averageLossR: losses.length ? grossLoss / losses.length : null,
      // The ratio that decides whether a sub-50% win rate is still profitable.
      payoffRatio:
        wins.length && losses.length
          ? grossProfit / wins.length / (grossLoss / losses.length)
          : null,
      netProfitR: grossProfit - grossLoss,
      maxDrawdownR: maxDrawdown,
      // Undefined rather than Infinity when there are no losses yet — a
      // profit factor of Infinity renders as a number and reads as a result.
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      averageDurationHours: durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : null,
      meaningful: closed.length >= 40,
    };
  }

  /**
   * Per-method performance.
   *
   * A method "participated" in a trade when its factor group had a real opinion
   * that agreed with the direction taken. Neutral readings are excluded rather
   * than counted as participation — otherwise every method appears in every
   * trade and the reliability scores all converge on the overall win rate.
   */
  private byMethod(closed: TradeRow[]) {
    return METHODS.map((method) => {
      let trades = 0;
      let wins = 0;
      let profit = 0;
      let loss = 0;
      let weightSum = 0;

      for (const trade of closed) {
        // The factor breakdown recorded at issue — what the engine believed
        // then, not what it would say now.
        const source = Array.isArray(trade.factors) ? (trade.factors as FactorRecord[]) : [];
        const factor = source.find((f) => f.group === method.from);
        if (!factor) continue;

        const score = Number(factor.score ?? 0);
        if (Math.abs(score) < 0.1) continue;

        const direction = trade.action === 'BUY' ? 1 : -1;
        if (score * direction <= 0) continue;

        trades += 1;
        weightSum += Number(factor.weight ?? 0);
        const r = num(trade.realisedR) ?? (trade.status.startsWith('HIT_') ? 1 : -1);
        if (trade.status.startsWith('HIT_')) {
          wins += 1;
          profit += Math.max(0, r);
        } else {
          loss += Math.abs(Math.min(0, r));
        }
      }

      const winRate = trades ? wins / trades : null;
      // Shrunk toward 50% so a 3-trade sample cannot read as a 100% method.
      const reliability =
        trades > 0 ? ((0.5 * 25 + wins) / (25 + trades)) * 100 : null;

      return {
        key: method.key,
        label: method.label,
        group: method.from,
        trades,
        wins,
        losses: trades - wins,
        winRate,
        profitR: profit,
        lossR: loss,
        netR: profit - loss,
        averageWeight: trades ? weightSum / trades : null,
        reliability,
        reliable: trades >= 20,
      };
    }).sort((a, b) => b.trades - a.trades);
  }

  /** Scalping / intraday / swing / positional. */
  private byStyle(closed: TradeRow[]) {
    const styles = new Map<string, TradeRow[]>();
    for (const trade of closed) {
      const timeframe = PRISMA_TO_TIMEFRAME[trade.timeframe] ?? '1D';
      const style = STYLE_BY_TIMEFRAME[timeframe] ?? 'SWING';
      styles.set(style, [...(styles.get(style) ?? []), trade]);
    }

    return ['SCALPING', 'INTRADAY', 'SWING', 'POSITIONAL'].map((style) => {
      const rows = styles.get(style) ?? [];
      const wins = rows.filter((r) => r.status.startsWith('HIT_'));
      const rs = rows.map((r) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1));
      const holds = rows
        .map((r) =>
          r.resolvedAt ? (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000 : null,
        )
        .filter((v): v is number => v !== null);

      return {
        style,
        trades: rows.length,
        wins: wins.length,
        losses: rows.length - wins.length,
        winRate: rows.length ? wins.length / rows.length : null,
        netR: rs.reduce((a, b) => a + b, 0),
        averageHoldHours: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      };
    });
  }

  private groupBy(closed: TradeRow[], key: (row: TradeRow) => string, limit = 20) {
    const groups = new Map<string, TradeRow[]>();
    for (const trade of closed) {
      const k = key(trade);
      groups.set(k, [...(groups.get(k) ?? []), trade]);
    }

    return [...groups.entries()]
      .map(([name, rows]) => {
        const wins = rows.filter((r) => r.status.startsWith('HIT_'));
        const rs = rows.map((r) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1));
        return {
          name,
          trades: rows.length,
          wins: wins.length,
          winRate: rows.length ? wins.length / rows.length : null,
          netR: rs.reduce((a, b) => a + b, 0),
        };
      })
      .sort((a, b) => b.trades - a.trades)
      .slice(0, limit);
  }

  /** Cumulative R over time, oldest first. */
  private equityCurve(closed: TradeRow[]) {
    const ordered = [...closed].reverse();
    let equity = 0;
    let peak = 0;

    return ordered.map((trade) => {
      const r = num(trade.realisedR) ?? (trade.status.startsWith('HIT_') ? 1 : -1);
      equity += r;
      peak = Math.max(peak, equity);
      return {
        time: (trade.resolvedAt ?? trade.createdAt).toISOString(),
        symbol: trade.symbol,
        r,
        equity,
        drawdown: peak - equity,
      };
    });
  }

  /** Win/loss distribution in R buckets. */
  private distribution(closed: TradeRow[]) {
    const buckets = [
      { label: '≤ −1R', min: -Infinity, max: -0.999 },
      { label: '−1 to 0R', min: -0.999, max: 0 },
      { label: '0 to 1R', min: 0, max: 1 },
      { label: '1 to 2R', min: 1, max: 2 },
      { label: '2 to 3R', min: 2, max: 3 },
      { label: '> 3R', min: 3, max: Infinity },
    ];

    return buckets.map((bucket) => ({
      label: bucket.label,
      count: closed.filter((trade) => {
        const r = num(trade.realisedR) ?? (trade.status.startsWith('HIT_') ? 1 : -1);
        return r > bucket.min && r <= bucket.max;
      }).length,
    }));
  }

  /** Daily / weekly / monthly / yearly roll-ups. */
  private periods(closed: TradeRow[]) {
    const now = Date.now();
    const windows: Array<{ key: string; label: string; ms: number }> = [
      { key: 'day', label: 'Today', ms: 86_400_000 },
      { key: 'week', label: 'This week', ms: 7 * 86_400_000 },
      { key: 'month', label: 'This month', ms: 30 * 86_400_000 },
      { key: 'year', label: 'This year', ms: 365 * 86_400_000 },
    ];

    return windows.map((window) => {
      const rows = closed.filter(
        (r) => (r.resolvedAt ?? r.createdAt).getTime() >= now - window.ms,
      );
      const wins = rows.filter((r) => r.status.startsWith('HIT_'));
      const rs = rows.map((r) => num(r.realisedR) ?? (r.status.startsWith('HIT_') ? 1 : -1));
      return {
        key: window.key,
        label: window.label,
        trades: rows.length,
        wins: wins.length,
        losses: rows.length - wins.length,
        winRate: rows.length ? wins.length / rows.length : null,
        netR: rs.reduce((a, b) => a + b, 0),
      };
    });
  }

  /** One journal row — the full record of a single trade. */
  private journalEntry(trade: TradeRow) {
    const postMortem = trade.postMortem as
      | { summary?: string; causes?: Array<{ reason: string; detail: string }> }
      | null;

    const entry = num(trade.entry);
    const target = num(trade.target1);
    const stop = num(trade.stopLoss);
    const r = num(trade.realisedR);

    // Approximate percentage return from the R multiple and the stop distance,
    // since positions are not actually filled. Labelled as modelled in the UI.
    const riskPercent = num(trade.riskPercent);
    const returnPercent = r !== null && riskPercent !== null ? r * riskPercent : null;

    return {
      id: trade.id,
      symbol: trade.symbol,
      assetClass: trade.assetClass,
      timeframe: PRISMA_TO_TIMEFRAME[trade.timeframe] ?? trade.timeframe,
      action: trade.action,
      status: trade.status,
      statusLabel: STATUS_LABEL[trade.status] ?? trade.status,
      // Was: a chain ending in `: 'LOSS'`, so every status it did not name
      // explicitly — cancelled and invalid included — was reported as a loss.
      outcome: outcomeOf(trade.status),
      lifecycle: lifecycleStageOf(trade.status, trade.archivedAt),
      invalidationReason: trade.invalidationReason ?? null,
      confidence: num(trade.confidence),
      entry,
      stopLoss: stop,
      takeProfit: target,
      exit: trade.status === 'STOPPED' ? stop : trade.status.startsWith('HIT_') ? target : null,
      realisedR: r,
      returnPercent,
      riskReward: num(trade.riskRewardRatio),
      maeR: num(trade.maeR),
      mfeR: num(trade.mfeR),
      captureRatio: num(trade.captureRatio),
      barsHeld: trade.barsHeld,
      holdingHours: trade.resolvedAt
        ? (trade.resolvedAt.getTime() - trade.createdAt.getTime()) / 3_600_000
        : null,
      primaryReason: trade.primaryReason,
      analysis: postMortem?.summary ?? trade.outcomeNote ?? null,
      causes: postMortem?.causes ?? [],
      createdAt: trade.createdAt.toISOString(),
      resolvedAt: trade.resolvedAt?.toISOString() ?? null,
    };
  }
}
