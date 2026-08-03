import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser, Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { Timeframe } from '../market-data/providers/provider.interface';
import { AiClientService } from './ai-client.service';
import { AnalysisService } from './analysis.service';
import { ConfluenceService, type Horizon } from './confluence.service';
import { ReviewService } from './review.service';
import { OPEN_STATUSES } from './signal-reissue';
import { AnalyticsService } from './analytics.service';

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'];
const HORIZONS: Horizon[] = ['INTRADAY', 'SWING', 'POSITIONAL', 'LONG_TERM'];

function parseHorizon(value: string | undefined): Horizon | undefined {
  return HORIZONS.includes(value as Horizon) ? (value as Horizon) : undefined;
}

function parseTimeframe(value: string | undefined, fallback: Timeframe = '1D'): Timeframe {
  return TIMEFRAMES.includes(value as Timeframe) ? (value as Timeframe) : fallback;
}

@ApiTags('analysis')
@Controller('analysis')
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly confluenceService: ConfluenceService,
    private readonly review: ReviewService,
    private readonly analytics: AnalyticsService,
    private readonly ai: AiClientService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('analytics')
  @ApiOperation({
    summary: 'Backtesting and performance analytics across every issued signal',
  })
  analyticsOverview() {
    return this.analytics.overview();
  }

  @Public()
  @Get('performance')
  @ApiOperation({
    summary: 'Realised performance — win rate, expectancy, drawdown, why losses lost',
  })
  performance() {
    return this.review.performance();
  }

  @Get(':symbol/confluence')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Multi-timeframe agreement — every timeframe read, alignment scored, conflicts named',
  })
  confluence(
    @Param('symbol') symbol: string,
    @Query('horizon') horizon?: string,
    @Query('timeframe') timeframe?: string,
  ) {
    const setup = parseTimeframe(timeframe);
    return this.confluenceService.confluence(
      symbol,
      parseHorizon(horizon) ?? this.confluenceService.horizonFor(setup),
      setup,
    );
  }

  @Get(':symbol/signal')
  // The strictest and most expensive path in the platform: a full analysis plus
  // a read of every other timeframe. Capped hard.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confluence-gated signal — only issues BUY/SELL when the timeframes agree',
  })
  async gatedSignal(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('horizon') horizon?: string,
    @Query('enforce') enforce?: string,
    @CurrentUser('id') userId?: string,
  ) {
    const riskPerTrade = await this.riskPerTrade(userId);
    return this.confluenceService.gatedSignal(symbol, parseTimeframe(timeframe), {
      horizon: parseHorizon(horizon),
      riskPerTrade,
      enforce: enforce !== 'false',
      userId,
    });
  }

  @Get(':symbol')
  // Full analysis is the most expensive call in the platform. Capped per user.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Full analysis — technical, price action, SMC, patterns, forecast, signal' })
  async analyse(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('calibration') calibration?: string,
    @CurrentUser('id') userId?: string,
  ) {
    const riskPerTrade = await this.riskPerTrade(userId);
    return this.analysis.analyse(symbol, parseTimeframe(timeframe), {
      withCalibration: calibration !== 'false',
      riskPerTrade,
    });
  }

  @Get(':symbol/forecast')
  @ApiOperation({ summary: 'Next-candle forecast only' })
  forecast(@Param('symbol') symbol: string, @Query('timeframe') timeframe?: string) {
    return this.analysis.forecast(symbol, parseTimeframe(timeframe));
  }

  @Get(':symbol/candles')
  @ApiOperation({
    summary: 'Per-candle anatomy with the prediction made at each bar and what actually followed',
  })
  candleHistory(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('lookback', new DefaultValuePipe(30), ParseIntPipe) lookback?: number,
  ) {
    return this.analysis.candleHistory(symbol, parseTimeframe(timeframe), lookback ?? 30);
  }

  @Post('signals/batch')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Score many symbols at once' })
  batch(
    @Body()
    body: {
      symbols: string[];
      timeframe?: string;
      minConfidence?: number;
      includeWait?: boolean;
    },
  ) {
    return this.analysis.batchSignals(body.symbols ?? [], parseTimeframe(body.timeframe), {
      minConfidence: body.minConfidence,
      includeWait: body.includeWait,
    });
  }

  /**
   * Recently issued signals — the record, not just what is still open.
   *
   * This used to return only `ACTIVE` signals inside their validity window,
   * which meant a signal vanished the moment it did anything interesting. A
   * setup that reached its target, got stopped out or expired simply
   * disappeared from the feed, so the dashboard could only ever show what had
   * not resolved yet and the engine looked like it had issued almost nothing.
   *
   * Everything unarchived is returned instead, with its status, so the feed
   * reads as a history with outcomes. `?status=live` restores the old
   * behaviour for callers that genuinely want only actionable setups.
   */
  @Get('signals/recent')
  @ApiOperation({ summary: 'Recently issued signals, with their outcomes' })
  async recentSignals(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('assetClass') assetClass?: string,
    @Query('status') status?: string,
    @Query('minConfidence') minConfidence?: string,
  ) {
    const now = new Date();
    const liveOnly = status === 'live';
    const floor = Number(minConfidence);

    const signals = await this.prisma.signal.findMany({
      where: {
        // Archived rows are kept for the precedent check but are not feed
        // material — they are weeks past resolution by the time they get here.
        archivedAt: null,
        // `live` means tradeable right now: still ACTIVE, still inside its
        // validity window. Anything cancelled, invalidated, expired or closed
        // out is history — useful on the signals page, wrong on a dashboard
        // where every row reads as a call to act.
        ...(liveOnly ? { status: 'ACTIVE', validUntil: { gt: now } } : {}),
        ...(Number.isFinite(floor) && floor > 0 ? { confidence: { gte: floor } } : {}),
        ...(assetClass ? { assetClass: assetClass as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit ?? 20, 100),
      include: { instrument: { select: { name: true, sector: true } } },
    });

    // Newest first, but anything still open floats above the resolved history:
    // an open position is the only thing on this list that still needs a
    // decision. Ordering purely by confidence (as before) buried a fresh signal
    // under an older, more confident one, which is backwards for a feed.
    const open = new Set<string>(OPEN_STATUSES);
    const isOpen = (row: { status: string; validUntil: Date | null }) =>
      open.has(row.status) && (row.validUntil === null || row.validUntil > now);

    signals.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));

    // ── One shape for stored and live signals ────────────────────
    //
    // The database stores the take-profits as three nullable columns; the
    // engine, the socket broadcast and the whole client type model use a
    // `targets` array. The signals feed merges rows from this endpoint with
    // rows pushed over the socket into a single list, so a row read back from
    // the database rendered its target column as "—" while an identical
    // freshly-pushed signal rendered a price — the targets were stored
    // correctly and displayed nowhere.
    //
    // Reshaped here rather than in the client, because every consumer of this
    // endpoint has the same problem and the API is what defines the contract.
    const withTargets = signals.map((signal) => ({
      ...signal,
      targets: [signal.target1, signal.target2, signal.target3]
        .map((price, index) => ({
          level: (index + 1) as 1 | 2 | 3,
          price: price === null || price === undefined ? null : Number(price),
        }))
        .filter((target): target is { level: 1 | 2 | 3; price: number } => target.price !== null),
    }));

    return { signals: withTargets };
  }

  @Public()
  @Get('engine/config')
  @ApiOperation({
    summary: 'Engine tuning constants — factor weights, thresholds, confidence cap',
  })
  async engineConfig() {
    // Exposed so the methodology is inspectable rather than a black box.
    return this.ai.get('/config');
  }

  private async riskPerTrade(userId?: string): Promise<number> {
    if (!userId) return 1;
    const preferences = await this.prisma.userPreferences
      .findUnique({ where: { userId }, select: { riskPerTradePercent: true } })
      .catch(() => null);
    return preferences ? Number(preferences.riskPerTradePercent) : 1;
  }
}
