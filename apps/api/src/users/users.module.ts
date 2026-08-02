import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Patch,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CurrentUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

class NotificationPreferencesDto {
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() priceAlerts?: boolean;
  @IsOptional() @IsBoolean() signalAlerts?: boolean;
  @IsOptional() @IsBoolean() newsAlerts?: boolean;
}

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) avatarUrl?: string;
}

class UpdatePreferencesDto {
  @IsOptional() @IsEnum(['dark', 'light', 'system']) theme?: string;
  @IsOptional() @IsEnum(['EQUITY', 'FOREX', 'CRYPTO', 'INVESTMENT']) defaultAssetClass?: string;
  @IsOptional() @IsEnum(['INR', 'USD']) baseCurrency?: string;

  @IsOptional() @IsNumber() @Min(0) capital?: number;

  // Hard ceilings mirror the risk engine. A UI that lets someone set 50% risk
  // per trade is not a risk management tool.
  @IsOptional() @IsNumber() @Min(0.1) @Max(5) riskPerTradePercent?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(20) dailyLossLimitPercent?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(40) weeklyLossLimitPercent?: number;
  @IsOptional() @IsNumber() @Min(2) @Max(60) maxDrawdownPercent?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  notifications?: NotificationPreferencesDto;
}

@Injectable()
class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { preferences: true, subscription: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const { passwordHash: _ignored, ...safe } = user;
    return safe;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { ...(dto.name ? { name: dto.name.trim() } : {}), ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}) },
      include: { preferences: true },
    });
    const { passwordHash: _ignored, ...safe } = user;
    return safe;
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const { notifications, ...scalar } = dto;

    // Built explicitly rather than spread, so an added DTO field can never
    // silently reach the database without being considered here.
    const data = {
      ...(scalar.theme !== undefined ? { theme: scalar.theme } : {}),
      ...(scalar.defaultAssetClass !== undefined
        ? { defaultAssetClass: scalar.defaultAssetClass as never }
        : {}),
      ...(scalar.baseCurrency !== undefined ? { baseCurrency: scalar.baseCurrency as never } : {}),
      ...(scalar.capital !== undefined ? { capital: scalar.capital } : {}),
      ...(scalar.riskPerTradePercent !== undefined
        ? { riskPerTradePercent: scalar.riskPerTradePercent }
        : {}),
      ...(scalar.dailyLossLimitPercent !== undefined
        ? { dailyLossLimitPercent: scalar.dailyLossLimitPercent }
        : {}),
      ...(scalar.weeklyLossLimitPercent !== undefined
        ? { weeklyLossLimitPercent: scalar.weeklyLossLimitPercent }
        : {}),
      ...(scalar.maxDrawdownPercent !== undefined
        ? { maxDrawdownPercent: scalar.maxDrawdownPercent }
        : {}),
      ...this.mapNotifications(notifications),
    };

    return this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Flatten the nested notifications object onto the flat schema columns. */
  private mapNotifications(notifications?: NotificationPreferencesDto) {
    if (!notifications) return {};
    return {
      ...(notifications.email !== undefined ? { emailNotifications: notifications.email } : {}),
      ...(notifications.push !== undefined ? { pushNotifications: notifications.push } : {}),
      ...(notifications.priceAlerts !== undefined ? { priceAlerts: notifications.priceAlerts } : {}),
      ...(notifications.signalAlerts !== undefined ? { signalAlerts: notifications.signalAlerts } : {}),
      ...(notifications.newsAlerts !== undefined ? { newsAlerts: notifications.newsAlerts } : {}),
    };
  }

  async notifications(userId: string, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { marked: result.count };
  }
}

@ApiTags('users')
@Controller('users')
class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Full profile with preferences and subscription' })
  profile(@CurrentUser('id') userId: string) {
    return this.users.profile(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update name or avatar' })
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Update preferences and risk parameters' })
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.users.updatePreferences(userId, dto);
  }

  @Get('me/notifications')
  @ApiOperation({ summary: 'Recent notifications' })
  notifications(@CurrentUser('id') userId: string) {
    return this.users.notifications(userId, false);
  }

  @Patch('me/notifications/read')
  @ApiOperation({ summary: 'Mark all notifications read' })
  markRead(@CurrentUser('id') userId: string) {
    return this.users.markAllRead(userId);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
