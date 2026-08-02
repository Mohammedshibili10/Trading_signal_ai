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

  @Get('signals/recent')
  @ApiOperation({ summary: 'Recently issued signals' })
  async recentSignals(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('assetClass') assetClass?: string,
  ) {
    const signals = await this.prisma.signal.findMany({
      where: {
        status: 'ACTIVE',
        validUntil: { gt: new Date() },
        ...(assetClass ? { assetClass: assetClass as never } : {}),
      },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(limit ?? 20, 100),
      include: { instrument: { select: { name: true, sector: true } } },
    });
    return { signals };
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
