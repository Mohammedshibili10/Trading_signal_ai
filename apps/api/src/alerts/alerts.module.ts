import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

import { CurrentUser } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { PrismaService } from '../prisma/prisma.service';

const ALERT_TYPES = [
  'PRICE_ABOVE', 'PRICE_BELOW', 'PERCENT_CHANGE', 'VOLUME_SPIKE',
  'RSI_ABOVE', 'RSI_BELOW', 'AI_SIGNAL', 'PATTERN', 'STOP_LOSS',
] as const;

class CreateAlertDto {
  @IsString() symbol!: string;
  @IsEnum(ALERT_TYPES) type!: (typeof ALERT_TYPES)[number];
  @IsOptional() @IsNumber() threshold?: number;
  @IsOptional() @IsArray() channels?: Array<'PUSH' | 'EMAIL' | 'IN_APP'>;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsBoolean() isRepeating?: boolean;
}

/** Types that are meaningless without a numeric threshold. */
const NEEDS_THRESHOLD = new Set([
  'PRICE_ABOVE', 'PRICE_BELOW', 'PERCENT_CHANGE', 'RSI_ABOVE', 'RSI_BELOW', 'STOP_LOSS',
]);

const MAX_ALERTS = 50;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {}

  async list(userId: string) {
    return this.prisma.alert.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: { instrument: { select: { name: true, assetClass: true } } },
    });
  }

  async create(userId: string, dto: CreateAlertDto) {
    if (NEEDS_THRESHOLD.has(dto.type) && (dto.threshold === undefined || dto.threshold === null)) {
      throw new BadRequestException(`A ${dto.type} alert needs a threshold value`);
    }

    const count = await this.prisma.alert.count({ where: { userId, isActive: true } });
    if (count >= MAX_ALERTS) {
      throw new BadRequestException(`You can have at most ${MAX_ALERTS} active alerts`);
    }

    const instrument = await this.marketData.findInstrument(dto.symbol);

    // Reject alerts that would fire the instant they are created — almost
    // always a mistake (setting "price above" below the current price).
    if (dto.type === 'PRICE_ABOVE' || dto.type === 'PRICE_BELOW') {
      const quote = await this.marketData.getQuoteOrLastKnown(instrument.symbol);
      if (quote && dto.threshold !== undefined) {
        const alreadyTrue =
          dto.type === 'PRICE_ABOVE' ? quote.price >= dto.threshold : quote.price <= dto.threshold;
        if (alreadyTrue) {
          throw new BadRequestException(
            `${instrument.symbol} is already at ${quote.price}, so this alert would trigger immediately.`,
          );
        }
      }
    }

    return this.prisma.alert.create({
      data: {
        userId,
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        type: dto.type,
        threshold: dto.threshold,
        channels: dto.channels?.length ? dto.channels : ['IN_APP'],
        note: dto.note,
        isRepeating: dto.isRepeating ?? false,
      },
    });
  }

  async toggle(userId: string, id: string, isActive: boolean) {
    const result = await this.prisma.alert.updateMany({
      where: { id, userId },
      data: { isActive, ...(isActive ? { triggeredAt: null } : {}) },
    });
    if (result.count === 0) throw new NotFoundException('Alert not found');
    return { message: isActive ? 'Alert enabled' : 'Alert paused' };
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.alert.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('Alert not found');
    return { message: 'Alert deleted' };
  }

  /**
   * Evaluate every active alert. Called by the scheduled job, not by requests.
   *
   * Groups by symbol so one quote lookup serves every alert on that instrument.
   */
  async evaluate(): Promise<{ checked: number; triggered: number }> {
    const alerts = await this.prisma.alert.findMany({
      where: {
        isActive: true,
        OR: [
          { triggeredAt: null },
          // Repeating alerts become eligible again after their cooldown.
          { isRepeating: true },
        ],
      },
      include: { user: { select: { id: true } } },
    });

    if (alerts.length === 0) return { checked: 0, triggered: 0 };

    const symbols = [...new Set(alerts.map((a) => a.symbol))];
    const quotes = await this.marketData.getQuotes(symbols);
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

    let triggered = 0;

    for (const alert of alerts) {
      const quote = bySymbol.get(alert.symbol);
      if (!quote || quote.stale) continue;

      if (alert.isRepeating && alert.triggeredAt) {
        const elapsed = Date.now() - alert.triggeredAt.getTime();
        if (elapsed < alert.cooldownMinutes * 60_000) continue;
      }

      const threshold = alert.threshold ? Number(alert.threshold) : null;
      let fired = false;
      let message = '';

      switch (alert.type) {
        case 'PRICE_ABOVE':
          fired = threshold !== null && quote.price >= threshold;
          message = `${alert.symbol} is at ${quote.price}, above your ${threshold} alert`;
          break;
        case 'PRICE_BELOW':
          fired = threshold !== null && quote.price <= threshold;
          message = `${alert.symbol} is at ${quote.price}, below your ${threshold} alert`;
          break;
        case 'PERCENT_CHANGE':
          fired = threshold !== null && Math.abs(quote.changePercent) >= Math.abs(threshold);
          message = `${alert.symbol} moved ${quote.changePercent.toFixed(2)}% today`;
          break;
        case 'STOP_LOSS':
          fired = threshold !== null && quote.price <= threshold;
          message = `${alert.symbol} hit your stop level of ${threshold} (now ${quote.price})`;
          break;
        default:
          // RSI, volume, pattern and AI-signal alerts are evaluated by the
          // analysis job, which already has the indicator series in hand.
          continue;
      }

      if (!fired) continue;
      triggered += 1;

      await this.prisma.$transaction([
        this.prisma.alert.update({
          where: { id: alert.id },
          data: { triggeredAt: new Date(), ...(alert.isRepeating ? {} : { isActive: false }) },
        }),
        this.prisma.notification.create({
          data: {
            userId: alert.userId,
            title: `Alert: ${alert.symbol}`,
            body: message,
            kind: 'ALERT',
            symbol: alert.symbol,
            link: `/markets/${alert.symbol}`,
          },
        }),
      ]);
    }

    return { checked: alerts.length, triggered };
  }
}

@ApiTags('alerts')
@Controller('alerts')
class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Your alerts' })
  list(@CurrentUser('id') userId: string) {
    return this.alerts.list(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an alert' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateAlertDto) {
    return this.alerts.create(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Enable or pause an alert' })
  toggle(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.alerts.toggle(userId, id, body.isActive);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an alert' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.alerts.remove(userId, id);
  }
}

@Module({
  imports: [MarketDataModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
