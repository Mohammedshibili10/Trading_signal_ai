import {
  Controller,
  DefaultValuePipe,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
class InstrumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly redis: RedisService,
  ) {}

  async list(assetClass?: string, sector?: string, limit = 100, offset = 0) {
    const where = {
      isActive: true,
      ...(assetClass ? { assetClass: assetClass as never } : {}),
      ...(sector ? { sector } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.instrument.findMany({
        where,
        orderBy: { symbol: 'asc' },
        skip: offset,
        take: Math.min(limit, 200),
      }),
      this.prisma.instrument.count({ where }),
    ]);

    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async detail(symbol: string) {
    const instrument = await this.prisma.instrument.findUnique({
      where: { symbol: symbol.toUpperCase() },
      include: { fundamentals: true },
    });
    if (!instrument) throw new NotFoundException(`Unknown symbol "${symbol}"`);
    return instrument;
  }

  /**
   * Market overview: indices, top gainers and losers per category.
   *
   * Heavily cached — it fans out across the whole active universe, and every
   * dashboard load hits it.
   */
  async overview(assetClass = 'EQUITY') {
    return this.redis.wrap(`overview:${assetClass}`, 60, async () => {
      const instruments = await this.prisma.instrument.findMany({
        where: { isActive: true, assetClass: assetClass as never },
        take: 60,
        orderBy: { symbol: 'asc' },
        select: { symbol: true },
      });

      const quotes = await this.marketData.getQuotes(instruments.map((i) => i.symbol));
      const ranked = [...quotes].sort((a, b) => b.changePercent - a.changePercent);

      return {
        assetClass,
        isOpen: this.marketData.isMarketOpen(assetClass),
        gainers: ranked.slice(0, 8),
        losers: ranked.slice(-8).reverse(),
        mostActive: [...quotes].sort((a, b) => b.volume - a.volume).slice(0, 8),
        total: quotes.length,
        // Heatmap payload: everything, so the client can lay it out however it
        // likes without a second round trip.
        heatmap: quotes.map((q) => ({
          symbol: q.symbol,
          name: q.name,
          changePercent: q.changePercent,
          price: q.price,
          marketCap: q.marketCap ?? null,
          sector: null,
        })),
      };
    });
  }

  async indices() {
    return this.redis.wrap('indices', 60, async () => {
      const indices = await this.prisma.instrument.findMany({
        where: { kind: 'INDEX', isActive: true },
        orderBy: { symbol: 'asc' },
        select: { symbol: true },
      });
      return { indices: await this.marketData.getQuotes(indices.map((i) => i.symbol)) };
    });
  }

  async sectors() {
    const rows = await this.prisma.instrument.groupBy({
      by: ['sector'],
      where: { assetClass: 'EQUITY', isActive: true, sector: { not: null } },
      _count: true,
    });
    return rows
      .map((row) => ({ sector: row.sector as string, count: row._count }))
      .sort((a, b) => b.count - a.count);
  }
}

@ApiTags('instruments')
@Controller('instruments')
class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse the instrument universe' })
  list(
    @Query('assetClass') assetClass?: string,
    @Query('sector') sector?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.instruments.list(assetClass, sector, limit, offset);
  }

  @Public()
  @Get('overview')
  @ApiOperation({ summary: 'Gainers, losers, most active and heatmap for a category' })
  overview(@Query('assetClass') assetClass?: string) {
    return this.instruments.overview(assetClass ?? 'EQUITY');
  }

  @Public()
  @Get('indices')
  @ApiOperation({ summary: 'Indian index quotes' })
  indices() {
    return this.instruments.indices();
  }

  @Public()
  @Get('sectors')
  @ApiOperation({ summary: 'NSE sectors with instrument counts' })
  sectors() {
    return this.instruments.sectors();
  }

  @Public()
  @Get(':symbol')
  @ApiOperation({ summary: 'Instrument detail with fundamentals' })
  detail(@Param('symbol') symbol: string) {
    return this.instruments.detail(symbol);
  }
}

@Module({
  imports: [MarketDataModule],
  controllers: [InstrumentsController],
  providers: [InstrumentsService],
  exports: [InstrumentsService],
})
export class InstrumentsModule {}
