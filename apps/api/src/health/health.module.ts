import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller('health')
class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiClientService,
  ) {}

  /** Liveness. Must stay cheap — orchestrators hit it constantly. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  }

  /**
   * Readiness. Checks dependencies.
   *
   * Redis being down is reported but does not fail readiness — the cache is an
   * optimisation and the API works without it. Postgres down does fail, because
   * nothing works without it.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe with dependency status' })
  async ready() {
    const [database, ai] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => ({ ok: true, detail: 'connected' }))
        .catch((error: Error) => ({ ok: false, detail: error.message })),
      this.ai.health(),
    ]);

    const ready = database.ok;

    return {
      status: ready ? 'ready' : 'degraded',
      checks: {
        database,
        redis: {
          ok: this.redis.isAvailable,
          detail: this.redis.isAvailable ? 'connected' : 'unavailable — running without cache',
          required: false,
        },
        aiService: {
          ok: ai.reachable,
          detail: ai.reachable ? ai.detail : `unreachable: ${ai.detail}`,
          circuitOpen: ai.circuitOpen,
          required: false,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({
  imports: [AnalysisModule],
  controllers: [HealthController],
})
export class HealthModule {}
