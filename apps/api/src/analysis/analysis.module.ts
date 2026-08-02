import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module';
import { NotificationsModule } from '../notifications/notifications.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AiClientService } from './ai-client.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { ConfluenceService } from './confluence.service';
import { ReviewService } from './review.service';
import { AnalyticsService } from './analytics.service';
import { PrecedentService } from './precedent.service';

@Module({
  imports: [MarketDataModule, NotificationsModule, RealtimeModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    ConfluenceService,
    ReviewService,
    AnalyticsService,
    PrecedentService,
    AiClientService,
  ],
  exports: [
    AnalysisService,
    ConfluenceService,
    ReviewService,
    AnalyticsService,
    PrecedentService,
    AiClientService,
  ],
})
export class AnalysisModule {}
