import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { parseRedisUrl } from './redis/redis-url';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { MarketDataModule } from './market-data/market-data.module';
import { AnalysisModule } from './analysis/analysis.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { AlertsModule } from './alerts/alerts.module';
import { NewsModule } from './news/news.module';
import { StrategiesModule } from './strategies/strategies.module';
import { ScannersModule } from './scanners/scanners.module';
import { RiskModule } from './risk/risk.module';
import { InvestModule } from './invest/invest.module';
import { AssistantModule } from './assistant/assistant.module';
import { AdminModule } from './admin/admin.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notifications.service';
import { JobsModule } from './jobs/jobs.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Root .env is shared by all three services so there is one source of
      // truth rather than three drifting copies.
      envFilePath: ['.env', '../../.env'],
      cache: true,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('rateLimit.ttl') ?? 60) * 1000,
            limit: config.get<number>('rateLimit.limit') ?? 120,
          },
        ],
      }),
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Parsed rather than hand-decomposed: `new URL()` throws with the
        // whole connection string attached, which put the Redis password into
        // the deploy log the first time this was misconfigured. It also drops
        // the scheme, and the scheme is what carries TLS.
        const redis = parseRedisUrl(config.get<string>('redisUrl') ?? 'redis://localhost:6379');
        return {
          connection: {
            ...redis,
            // BullMQ requires this; without it workers throw on reconnect.
            maxRetriesPerRequest: null,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
          },
        };
      },
    }),

    ScheduleModule.forRoot(),

    PrismaModule,
    RedisModule,

    AuthModule,
    UsersModule,
    InstrumentsModule,
    MarketDataModule,
    AnalysisModule,
    WatchlistModule,
    PortfolioModule,
    AlertsModule,
    NewsModule,
    StrategiesModule,
    ScannersModule,
    RiskModule,
    InvestModule,
    AssistantModule,
    AdminModule,
    RealtimeModule,
    NotificationsModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    // Rate limiting applies to every route. Auth endpoints tighten it further
    // with their own @Throttle decorators.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
