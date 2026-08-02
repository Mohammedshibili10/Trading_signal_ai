import {
  Body, Controller, Delete, ForbiddenException, Get, Injectable, Module,
  NotFoundException, Param, Post, Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { CurrentUser } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';

class StrategyDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() universe?: string[];
  @IsOptional() @IsArray() symbols?: string[];
  @IsOptional() @IsString() timeframe?: string;
  /** Condition trees from the no-code builder. Shape is validated by the engine. */
  entry!: Record<string, unknown>;
  exit!: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(0.1) riskPerTradePercent?: number;
  @IsOptional() @IsNumber() stopLossPercent?: number;
  @IsOptional() @IsNumber() takeProfitPercent?: number;
  @IsOptional() @IsBoolean() useAtrStop?: boolean;
  @IsOptional() @IsNumber() atrMultiplier?: number;
}

const TIMEFRAME_MAP = {
  '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '4h': 'H4', '1D': 'D1', '1W': 'W1', '1M': 'MN1',
} as const;

@Injectable()
class StrategiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly ai: AiClientService,
  ) {}

  list(userId: string) {
    return this.prisma.strategy.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { backtests: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  }

  async detail(userId: string, id: string) {
    const strategy = await this.prisma.strategy.findUnique({
      where: { id },
      include: { backtests: { orderBy: { createdAt: 'desc' }, take: 5 } },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (strategy.userId !== userId) throw new ForbiddenException('This strategy is not yours');
    return strategy;
  }

  create(userId: string, dto: StrategyDto) {
    return this.prisma.strategy.create({
      data: {
        userId,
        name: dto.name.trim(),
        description: dto.description ?? '',
        universe: (dto.universe ?? ['EQUITY']) as never,
        symbols: dto.symbols ?? [],
        timeframe: TIMEFRAME_MAP[(dto.timeframe ?? '1D') as keyof typeof TIMEFRAME_MAP] ?? 'D1',
        entryRules: dto.entry as never,
        exitRules: dto.exit as never,
        riskPerTradePercent: dto.riskPerTradePercent ?? 1,
        stopLossPercent: dto.stopLossPercent,
        takeProfitPercent: dto.takeProfitPercent,
        useAtrStop: dto.useAtrStop ?? false,
        atrMultiplier: dto.atrMultiplier ?? 2,
      },
    });
  }

  async update(userId: string, id: string, dto: StrategyDto) {
    await this.detail(userId, id);
    return this.prisma.strategy.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        description: dto.description ?? '',
        universe: (dto.universe ?? ['EQUITY']) as never,
        symbols: dto.symbols ?? [],
        timeframe: TIMEFRAME_MAP[(dto.timeframe ?? '1D') as keyof typeof TIMEFRAME_MAP] ?? 'D1',
        entryRules: dto.entry as never,
        exitRules: dto.exit as never,
        riskPerTradePercent: dto.riskPerTradePercent ?? 1,
        stopLossPercent: dto.stopLossPercent,
        takeProfitPercent: dto.takeProfitPercent,
        useAtrStop: dto.useAtrStop ?? false,
        atrMultiplier: dto.atrMultiplier ?? 2,
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.detail(userId, id);
    await this.prisma.strategy.delete({ where: { id } });
    return { message: 'Strategy deleted' };
  }

  /**
   * Backtest one strategy on one symbol.
   *
   * The engine fills on the next bar's open and charges costs on both legs —
   * see docs/trading-concepts.md §12 for why those two rules exist.
   */
  async backtest(
    userId: string,
    id: string,
    options: { symbol?: string; initialCapital?: number } = {},
  ) {
    const strategy = await this.detail(userId, id);

    const symbol = options.symbol ?? strategy.symbols[0];
    if (!symbol) {
      throw new NotFoundException('Add at least one symbol to the strategy before backtesting');
    }

    const timeframe = (Object.entries(TIMEFRAME_MAP).find(
      ([, value]) => value === strategy.timeframe,
    )?.[0] ?? '1D') as never;

    const { candles } = await this.marketData.getCandles(symbol, timeframe, 1500);
    if (candles.length < 100) {
      throw new NotFoundException(
        `Only ${candles.length} bars available for ${symbol}. A backtest needs at least 100.`,
      );
    }

    const result = await this.ai.post<BacktestResult>('/backtest', {
      strategy: {
        id: strategy.id,
        entry: strategy.entryRules,
        exit: strategy.exitRules,
        riskPerTradePercent: Number(strategy.riskPerTradePercent),
        stopLossPercent: strategy.stopLossPercent ? Number(strategy.stopLossPercent) : null,
        takeProfitPercent: strategy.takeProfitPercent ? Number(strategy.takeProfitPercent) : null,
        useAtrStop: strategy.useAtrStop,
        atrMultiplier: Number(strategy.atrMultiplier),
      },
      candles,
      symbol,
      initialCapital: options.initialCapital ?? 1_000_000,
    });

    if (result.totalTrades > 0) {
      await this.prisma.backtest.create({
        data: {
          strategyId: strategy.id,
          symbol,
          fromDate: new Date(result.from),
          toDate: new Date(result.to),
          initialCapital: result.initialCapital,
          finalCapital: result.finalCapital,
          totalReturn: result.totalReturn,
          cagr: result.cagr,
          winRate: result.winRate,
          profitFactor: Math.min(result.profitFactor, 999),
          sharpeRatio: result.sharpeRatio,
          sortinoRatio: result.sortinoRatio,
          maxDrawdown: result.maxDrawdown,
          expectancy: result.expectancy,
          totalTrades: result.totalTrades,
          winningTrades: result.winningTrades,
          losingTrades: result.losingTrades,
          equityCurve: result.equityCurve as never,
          trades: result.trades as never,
          monthlyReturns: result.monthlyReturns as never,
          warnings: result.warnings as never,
        },
      }).catch(() => undefined);
    }

    return result;
  }
}

interface BacktestResult {
  from: string; to: string; initialCapital: number; finalCapital: number;
  totalReturn: number; cagr: number; winRate: number; profitFactor: number;
  sharpeRatio: number; sortinoRatio: number; maxDrawdown: number; expectancy: number;
  totalTrades: number; winningTrades: number; losingTrades: number;
  equityCurve: unknown; trades: unknown; monthlyReturns: unknown; warnings: string[];
}

@ApiTags('strategies')
@Controller('strategies')
class StrategiesController {
  constructor(private readonly strategies: StrategiesService) {}

  @Get() list(@CurrentUser('id') userId: string) { return this.strategies.list(userId); }

  @Get(':id')
  @ApiOperation({ summary: 'Strategy with recent backtests' })
  detail(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.strategies.detail(userId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a no-code strategy' })
  create(@CurrentUser('id') userId: string, @Body() dto: StrategyDto) {
    return this.strategies.create(userId, dto);
  }

  @Put(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: StrategyDto) {
    return this.strategies.update(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.strategies.remove(userId, id);
  }

  @Post(':id/backtest')
  @ApiOperation({ summary: 'Run a walk-forward backtest with costs and slippage' })
  backtest(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { symbol?: string; initialCapital?: number },
  ) {
    return this.strategies.backtest(userId, id, body ?? {});
  }
}

@Module({
  imports: [MarketDataModule, AnalysisModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
})
export class StrategiesModule {}
