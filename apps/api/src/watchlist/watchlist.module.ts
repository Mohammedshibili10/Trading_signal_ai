import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';

class CreateWatchlistDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
}

class AddItemDto {
  @IsString() @MinLength(1) @MaxLength(30) symbol!: string;
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

/** Free-tier ceilings. Kept here rather than in the UI so they're enforceable. */
const MAX_WATCHLISTS = 10;
const MAX_ITEMS_PER_LIST = 100;

@Injectable()
class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {}

  /**
   * All of a user's watchlists, each item hydrated with a live quote.
   *
   * Quotes are fetched in one batch across every list rather than per item —
   * the market data service coalesces duplicates, so a symbol on three lists
   * costs one upstream call.
   */
  async list(userId: string) {
    const watchlists = await this.prisma.watchlist.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            instrument: {
              select: { name: true, assetClass: true, kind: true, exchange: true, currency: true },
            },
          },
        },
      },
    });

    const symbols = [...new Set(watchlists.flatMap((w) => w.items.map((i) => i.symbol)))];
    const quotes = await this.marketData.getQuotes(symbols);
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

    return watchlists.map((watchlist) => ({
      id: watchlist.id,
      name: watchlist.name,
      isDefault: watchlist.isDefault,
      createdAt: watchlist.createdAt,
      items: watchlist.items.map((item) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.instrument.name,
        assetClass: item.instrument.assetClass,
        note: item.note,
        addedAt: item.addedAt,
        quote: bySymbol.get(item.symbol) ?? null,
      })),
    }));
  }

  async create(userId: string, name: string) {
    const count = await this.prisma.watchlist.count({ where: { userId } });
    if (count >= MAX_WATCHLISTS) {
      throw new BadRequestException(`You can have at most ${MAX_WATCHLISTS} watchlists`);
    }

    return this.prisma.watchlist.create({
      data: { userId, name: name.trim(), isDefault: count === 0, sortOrder: count },
    });
  }

  async rename(userId: string, id: string, name: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.watchlist.update({ where: { id }, data: { name: name.trim() } });
  }

  async remove(userId: string, id: string) {
    const watchlist = await this.assertOwnership(userId, id);
    if (watchlist.isDefault) {
      throw new BadRequestException('The default watchlist cannot be deleted');
    }
    await this.prisma.watchlist.delete({ where: { id } });
    return { message: 'Watchlist deleted' };
  }

  async addItem(userId: string, watchlistId: string, dto: AddItemDto) {
    await this.assertOwnership(userId, watchlistId);

    // Rejects unknown symbols with a helpful message.
    const instrument = await this.marketData.findInstrument(dto.symbol);

    const count = await this.prisma.watchlistItem.count({ where: { watchlistId } });
    if (count >= MAX_ITEMS_PER_LIST) {
      throw new BadRequestException(`A watchlist can hold at most ${MAX_ITEMS_PER_LIST} instruments`);
    }

    const existing = await this.prisma.watchlistItem.findUnique({
      where: { watchlistId_instrumentId: { watchlistId, instrumentId: instrument.id } },
    });
    if (existing) throw new BadRequestException(`${instrument.symbol} is already on this watchlist`);

    return this.prisma.watchlistItem.create({
      data: {
        watchlistId,
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        note: dto.note,
        sortOrder: count,
      },
    });
  }

  async removeItem(userId: string, watchlistId: string, itemId: string) {
    await this.assertOwnership(userId, watchlistId);
    const result = await this.prisma.watchlistItem.deleteMany({ where: { id: itemId, watchlistId } });
    if (result.count === 0) throw new NotFoundException('Item not found on this watchlist');
    return { message: 'Removed' };
  }

  /**
   * Every mutation goes through this.
   *
   * Without it, knowing a watchlist id would be enough to modify someone else's
   * list — the classic broken-object-level-authorisation bug.
   */
  private async assertOwnership(userId: string, watchlistId: string) {
    const watchlist = await this.prisma.watchlist.findUnique({ where: { id: watchlistId } });
    if (!watchlist) throw new NotFoundException('Watchlist not found');
    if (watchlist.userId !== userId) throw new ForbiddenException('This watchlist is not yours');
    return watchlist;
  }
}

@ApiTags('watchlist')
@Controller('watchlists')
class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  @ApiOperation({ summary: 'All watchlists with live quotes' })
  list(@CurrentUser('id') userId: string) {
    return this.watchlist.list(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a watchlist' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateWatchlistDto) {
    return this.watchlist.create(userId, dto.name);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a watchlist' })
  rename(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateWatchlistDto,
  ) {
    return this.watchlist.rename(userId, id, dto.name);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a watchlist' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.watchlist.remove(userId, id);
  }

  @Post(':id/items')
  @ApiOperation({ summary: 'Add an instrument' })
  addItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddItemDto,
  ) {
    return this.watchlist.addItem(userId, id, dto);
  }

  @Delete(':id/items/:itemId')
  @ApiOperation({ summary: 'Remove an instrument' })
  removeItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.watchlist.removeItem(userId, id, itemId);
  }
}

@Module({
  imports: [MarketDataModule],
  controllers: [WatchlistController],
  providers: [WatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
