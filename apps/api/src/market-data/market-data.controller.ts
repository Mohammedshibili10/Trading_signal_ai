import { Controller, DefaultValuePipe, Get, ParseIntPipe, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators';
import { allStatuses } from './market-hours';
import { MarketDataService } from './market-data.service';
import type { Timeframe } from './providers/provider.interface';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'];

@ApiTags('market')
@Controller('market')
export class MarketDataController {
  constructor(private readonly marketData: MarketDataService) {}

  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Search instruments by symbol or name' })
  search(
    @Query('q') query: string,
    @Query('assetClass') assetClass?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.marketData.search(query ?? '', assetClass, limit);
  }

  @Public()
  @Get('quote/:symbol')
  @ApiOperation({ summary: 'Latest quote for one instrument' })
  getQuote(@Param('symbol') symbol: string) {
    return this.marketData.getQuote(symbol);
  }

  @Public()
  @Get('quotes')
  @ApiOperation({ summary: 'Batch quotes — comma-separated symbols' })
  async getQuotes(@Query('symbols') symbols: string) {
    const list = (symbols ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // Bound the batch so one request can't fan out into hundreds of upstream
      // calls.
      .slice(0, 50);

    return { quotes: await this.marketData.getQuotes(list) };
  }

  @Public()
  @Get('candles/:symbol')
  @ApiOperation({ summary: 'OHLCV series' })
  getCandles(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('limit', new DefaultValuePipe(300), ParseIntPipe) limit?: number,
  ) {
    const tf = TIMEFRAMES.includes(timeframe as Timeframe) ? (timeframe as Timeframe) : '1D';
    return this.marketData.getCandles(symbol, tf, limit ?? 300);
  }

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Live status for every exchange, with the next transition' })
  status() {
    // `serverTime` matters: the client renders its countdown against the
    // server's clock, not its own. A machine whose clock is minutes out would
    // otherwise show a confidently wrong countdown.
    return { exchanges: allStatuses(), serverTime: new Date().toISOString() };
  }

  @Public()
  @Get('status/:symbol')
  @ApiOperation({ summary: 'Market status for one instrument, resolved to its exchange' })
  async symbolStatus(@Param('symbol') symbol: string) {
    const status = await this.marketData.marketStatus(symbol);
    return { ...status, serverTime: new Date().toISOString() };
  }
}
