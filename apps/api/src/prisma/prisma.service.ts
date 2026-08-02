import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        ...(process.env.PRISMA_LOG_QUERIES === '1'
          ? ([{ emit: 'event', level: 'query' }] as const)
          : []),
      ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$on('warn', (e: Prisma.LogEvent) => this.logger.warn(e.message));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$on('error', (e: Prisma.LogEvent) => this.logger.error(e.message));

    if (process.env.PRISMA_LOG_QUERIES === '1') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).$on('query', (e: Prisma.QueryEvent) => {
        if (e.duration > 200) {
          this.logger.warn(`slow query ${e.duration}ms: ${e.query.slice(0, 200)}`);
        }
      });
    }

    await this.$connect();
    this.logger.log('database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Prisma returns `Decimal` objects for money columns, which serialise to
   * `{"s":1,"e":3,"d":[...]}` over JSON — useless to the client.
   *
   * Every read path that returns money must go through this. It is a plain
   * recursive mapper rather than a global serialiser interceptor because the
   * conversion is lossy (Decimal → number) and should be an explicit decision
   * at each boundary, not an invisible default.
   */
  static toNumbers<T>(value: T): T {
    if (value === null || value === undefined) return value;

    if (Prisma.Decimal.isDecimal(value)) {
      return (value as Prisma.Decimal).toNumber() as unknown as T;
    }

    if (value instanceof Date) return value;

    if (Array.isArray(value)) {
      return value.map((item) => PrismaService.toNumbers(item)) as unknown as T;
    }

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = PrismaService.toNumbers(item);
      }
      return out as T;
    }

    return value;
  }
}
