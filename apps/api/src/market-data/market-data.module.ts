import { Module } from '@nestjs/common';

import { BinanceStreamService } from './binance-stream.service';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { AmfiProvider } from './providers/amfi.provider';
import { BinanceProvider } from './providers/binance.provider';
import { FrankfurterProvider } from './providers/frankfurter.provider';
import { SimulatedProvider } from './providers/simulated.provider';
import { YahooProvider } from './providers/yahoo.provider';

@Module({
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    BinanceStreamService,
    YahooProvider,
    BinanceProvider,
    FrankfurterProvider,
    AmfiProvider,
    SimulatedProvider,
  ],
  exports: [MarketDataService, BinanceStreamService, AmfiProvider],
})
export class MarketDataModule {}
