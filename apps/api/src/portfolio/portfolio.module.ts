import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { CurrentUser } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';

class AddTransactionDto {
  @IsString() symbol!: string;
  @IsEnum(['BUY', 'SELL']) type!: 'BUY' | 'SELL';
  @IsNumber() @Min(0.00000001) quantity!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) charges?: number;
  @IsOptional() @IsString() notes?: string;
}

@Injectable()
class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly ai: AiClientService,
  ) {}

  async summary(userId: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { userId },
      include: {
        instrument: {
          select: { name: true, assetClass: true, kind: true, sector: true, currency: true },
        },
      },
    });

    if (holdings.length === 0) {
      return {
        summary: {
          totalInvested: 0, currentValue: 0, totalPnl: 0, totalPnlPercent: 0,
          dayPnl: 0, dayPnlPercent: 0, realisedPnl: 0, holdingsCount: 0,
          bestPerformer: null, worstPerformer: null,
        },
        holdings: [],
      };
    }

    const quotes = await this.marketData.getQuotes(holdings.map((h) => h.symbol));
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

    let totalInvested = 0;
    let currentValue = 0;
    let dayPnl = 0;
    let realisedPnl = 0;

    const enriched = holdings.map((holding) => {
      const quote = bySymbol.get(holding.symbol);
      const quantity = Number(holding.quantity);
      const averagePrice = Number(holding.averagePrice);
      // Fall back to cost basis when a quote is unavailable, so an outage shows
      // a flat position rather than wiping the portfolio value to zero.
      const price = quote?.price ?? averagePrice;

      const invested = quantity * averagePrice;
      const value = quantity * price;
      const pnl = value - invested;
      const positionDayChange = quote ? quantity * quote.change : 0;

      totalInvested += invested;
      currentValue += value;
      dayPnl += positionDayChange;
      realisedPnl += Number(holding.realisedPnl);

      return {
        id: holding.id,
        symbol: holding.symbol,
        name: holding.instrument.name,
        assetClass: holding.instrument.assetClass,
        kind: holding.instrument.kind,
        sector: holding.instrument.sector,
        currency: holding.instrument.currency,
        quantity,
        averagePrice,
        currentPrice: price,
        invested,
        currentValue: value,
        pnl,
        pnlPercent: invested > 0 ? (pnl / invested) * 100 : 0,
        dayChange: positionDayChange,
        dayChangePercent: quote?.changePercent ?? 0,
        allocationPercent: 0, // filled below, once the total is known
        stale: quote?.stale ?? !quote,
      };
    });

    for (const holding of enriched) {
      holding.allocationPercent = currentValue > 0 ? (holding.currentValue / currentValue) * 100 : 0;
    }

    const ranked = [...enriched].sort((a, b) => b.pnlPercent - a.pnlPercent);
    const totalPnl = currentValue - totalInvested;
    const previousValue = currentValue - dayPnl;

    return {
      summary: {
        totalInvested,
        currentValue,
        totalPnl,
        totalPnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
        dayPnl,
        dayPnlPercent: previousValue > 0 ? (dayPnl / previousValue) * 100 : 0,
        realisedPnl,
        holdingsCount: enriched.length,
        bestPerformer: ranked[0]
          ? { symbol: ranked[0].symbol, pnlPercent: ranked[0].pnlPercent }
          : null,
        worstPerformer: ranked.at(-1)
          ? { symbol: ranked.at(-1)!.symbol, pnlPercent: ranked.at(-1)!.pnlPercent }
          : null,
      },
      holdings: enriched.sort((a, b) => b.currentValue - a.currentValue),
    };
  }

  /**
   * Record a trade and fold it into the position.
   *
   * Buys move the weighted average cost. Sells realise P&L against that average
   * and leave the average untouched — which is how Indian brokers report it and
   * how capital gains are actually computed.
   */
  async addTransaction(userId: string, dto: AddTransactionDto) {
    const instrument = await this.marketData.findInstrument(dto.symbol);

    return this.prisma.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          userId,
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          type: dto.type,
          quantity: dto.quantity,
          price: dto.price,
          charges: dto.charges ?? 0,
          notes: dto.notes,
        },
      });

      const existing = await tx.holding.findUnique({
        where: { userId_instrumentId: { userId, instrumentId: instrument.id } },
      });

      if (dto.type === 'BUY') {
        if (!existing) {
          return tx.holding.create({
            data: {
              userId,
              instrumentId: instrument.id,
              symbol: instrument.symbol,
              quantity: dto.quantity,
              averagePrice: dto.price,
            },
          });
        }

        const oldQuantity = Number(existing.quantity);
        const oldAverage = Number(existing.averagePrice);
        const newQuantity = oldQuantity + dto.quantity;
        const newAverage = (oldQuantity * oldAverage + dto.quantity * dto.price) / newQuantity;

        return tx.holding.update({
          where: { id: existing.id },
          data: { quantity: newQuantity, averagePrice: newAverage },
        });
      }

      // SELL
      if (!existing) {
        throw new NotFoundException(`You do not hold ${instrument.symbol}`);
      }

      const heldQuantity = Number(existing.quantity);
      if (dto.quantity > heldQuantity + 1e-8) {
        throw new NotFoundException(
          `You hold ${heldQuantity} ${instrument.symbol}, cannot sell ${dto.quantity}`,
        );
      }

      const averagePrice = Number(existing.averagePrice);
      const realised = (dto.price - averagePrice) * dto.quantity - (dto.charges ?? 0);
      const remaining = heldQuantity - dto.quantity;

      if (remaining <= 1e-8) {
        // Position fully closed. Delete the holding but keep the realised P&L
        // on the transaction log, which is the permanent record.
        await tx.holding.delete({ where: { id: existing.id } });
        return { closed: true, realisedPnl: realised };
      }

      return tx.holding.update({
        where: { id: existing.id },
        data: {
          quantity: remaining,
          realisedPnl: Number(existing.realisedPnl) + realised,
        },
      });
    });
  }

  async transactions(userId: string) {
    return this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { executedAt: 'desc' },
      take: 200,
      include: { instrument: { select: { name: true, assetClass: true } } },
    });
  }

  async deleteHolding(userId: string, id: string) {
    const result = await this.prisma.holding.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('Holding not found');
    return { message: 'Holding removed' };
  }

  /** Portfolio risk, computed by the AI service from real return series. */
  async risk(userId: string) {
    const { holdings } = await this.summary(userId);
    if (holdings.length === 0) {
      return { portfolioValue: 0, recommendations: ['Add holdings to see portfolio risk.'] };
    }

    // Daily returns per holding, for correlation and volatility.
    const returnsBySymbol: Record<string, number[]> = {};
    await Promise.all(
      holdings.map(async (holding) => {
        try {
          const { candles } = await this.marketData.getCandles(holding.symbol, '1D', 260);
          if (candles.length < 30) return;
          const returns: number[] = [];
          for (let i = 1; i < candles.length; i++) {
            const previous = candles[i - 1].close;
            if (previous > 0) returns.push((candles[i].close - previous) / previous);
          }
          returnsBySymbol[holding.symbol] = returns;
        } catch {
          /* a missing series just drops that symbol from the correlation matrix */
        }
      }),
    );

    // NIFTY 50 as the benchmark for beta.
    let benchmarkReturns: number[] | undefined;
    try {
      const { candles } = await this.marketData.getCandles('NIFTY50', '1D', 260);
      benchmarkReturns = candles.slice(1).map((candle, i) => {
        const previous = candles[i].close;
        return previous > 0 ? (candle.close - previous) / previous : 0;
      });
    } catch {
      /* beta is reported as null without a benchmark */
    }

    return this.ai.post('/risk/portfolio', {
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        currentValue: h.currentValue,
        sector: h.sector,
        assetClass: h.assetClass,
      })),
      returnsBySymbol,
      benchmarkReturns,
    });
  }
}

@ApiTags('portfolio')
@Controller('portfolio')
class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  @ApiOperation({ summary: 'Holdings with live P&L' })
  summary(@CurrentUser('id') userId: string) {
    return this.portfolio.summary(userId);
  }

  @Get('risk')
  @ApiOperation({ summary: 'VaR, correlation, concentration and diversification' })
  risk(@CurrentUser('id') userId: string) {
    return this.portfolio.risk(userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Transaction history' })
  transactions(@CurrentUser('id') userId: string) {
    return this.portfolio.transactions(userId);
  }

  @Post('transactions')
  @ApiOperation({ summary: 'Record a buy or sell' })
  addTransaction(@CurrentUser('id') userId: string, @Body() dto: AddTransactionDto) {
    return this.portfolio.addTransaction(userId, dto);
  }

  @Delete('holdings/:id')
  @ApiOperation({ summary: 'Remove a holding' })
  deleteHolding(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.portfolio.deleteHolding(userId, id);
  }
}

@Module({
  imports: [MarketDataModule, AnalysisModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
