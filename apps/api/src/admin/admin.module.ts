import {
  Body, Controller, DefaultValuePipe, Get, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { CurrentUser, Roles } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

class UpdateUserDto {
  @IsOptional() @IsEnum(['USER', 'PRO', 'ADMIN']) role?: 'USER' | 'PRO' | 'ADMIN';
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiClientService,
  ) {}

  /** Platform-wide counts for the admin dashboard. */
  async analytics() {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);

    const [
      totalUsers, activeUsers, newUsersWeek, instruments,
      signalsToday, activeAlerts, newsItems, strategies,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { lastLoginAt: { gte: weekAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.instrument.count({ where: { isActive: true } }),
      this.prisma.signal.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.alert.count({ where: { isActive: true } }),
      this.prisma.newsItem.count({ where: { publishedAt: { gte: dayAgo } } }),
      this.prisma.strategy.count(),
    ]);

    const byAssetClass = await this.prisma.instrument.groupBy({
      by: ['assetClass'],
      where: { isActive: true },
      _count: true,
    });

    const signalBreakdown = await this.prisma.signal.groupBy({
      by: ['action'],
      where: { createdAt: { gte: weekAgo } },
      _count: true,
    });

    return {
      users: { total: totalUsers, activeThisWeek: activeUsers, newThisWeek: newUsersWeek },
      content: { instruments, newsItemsToday: newsItems, strategies },
      signals: {
        today: signalsToday,
        breakdownThisWeek: signalBreakdown.map((row) => ({
          action: row.action,
          count: row._count,
        })),
      },
      alerts: { active: activeAlerts },
      instrumentsByAssetClass: byAssetClass.map((row) => ({
        assetClass: row.assetClass,
        count: row._count,
      })),
    };
  }

  /** Data provider health — which feeds are failing and how slow they are. */
  async providers() {
    const [health, ai] = await Promise.all([
      this.prisma.providerHealth.findMany({ orderBy: { provider: 'asc' } }),
      this.ai.health(),
    ]);

    return {
      marketData: health,
      aiService: { ...ai, url: this.ai.baseUrl },
      cache: { available: this.redis.isAvailable },
    };
  }

  async users(query: string | undefined, limit: number, offset: number) {
    const where = query
      ? {
          OR: [
            { email: { contains: query, mode: 'insensitive' as const } },
            { name: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: Math.min(limit, 100),
        select: {
          id: true, email: true, name: true, role: true, isActive: true,
          emailVerified: true, provider: true, createdAt: true, lastLoginAt: true,
          subscription: { select: { tier: true, status: true } },
          _count: { select: { holdings: true, alerts: true, strategies: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, offset, limit };
  }

  async updateUser(adminId: string, userId: string, dto: UpdateUserDto) {
    if (adminId === userId && dto.isActive === false) {
      // Locking yourself out of the admin panel is not a recoverable mistake
      // through the UI.
      throw new NotFoundException('You cannot deactivate your own account');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { ...(dto.role ? { role: dto.role } : {}), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
      select: { id: true, email: true, role: true, isActive: true },
    });

    // Deactivating must take effect now, not when the access token expires.
    if (dto.isActive === false) {
      await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'admin.user_updated',
        resource: 'user',
        resourceId: userId,
        metadata: dto as never,
      },
    });

    return user;
  }

  auditLogs(limit: number) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { user: { select: { email: true, name: true } } },
    });
  }

  async clearCache(pattern: string) {
    const deleted = await this.redis.delPattern(pattern || '*');
    return { deleted, pattern: pattern || '*' };
  }
}

@ApiTags('admin')
@Controller('admin')
// Every route here requires ADMIN. RolesGuard treats ADMIN as a superset, so
// this single decorator is the whole access policy for the module.
@Roles('ADMIN')
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Platform analytics' })
  analytics() { return this.admin.analytics(); }

  @Get('providers')
  @ApiOperation({ summary: 'Market data and AI service health' })
  providers() { return this.admin.providers(); }

  @Get('users')
  @ApiOperation({ summary: 'User management' })
  users(
    @Query('q') query?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.admin.users(query, limit ?? 50, offset ?? 0);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Change a role or deactivate an account' })
  updateUser(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    // The acting admin comes from the verified token, never from the request
    // body — otherwise the self-deactivation guard would be trivially bypassed.
    return this.admin.updateUser(adminId, id, dto);
  }

  @Get('logs')
  @ApiOperation({ summary: 'Audit log' })
  logs(@Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number) {
    return this.admin.auditLogs(limit ?? 100);
  }

  @Patch('cache')
  @ApiOperation({ summary: 'Clear cache keys by pattern' })
  clearCache(@Body() body: { pattern?: string }) {
    return this.admin.clearCache(body?.pattern ?? '*');
  }
}

@Module({
  imports: [AnalysisModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
