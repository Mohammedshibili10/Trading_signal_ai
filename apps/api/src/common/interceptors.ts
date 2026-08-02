import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { Observable, map, tap } from 'rxjs';

/** Logs method, path, status and duration. Flags anything slow. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const elapsed = Date.now() - started;
          const line = `${request.method} ${request.url} ${elapsed}ms`;
          if (elapsed > 2000) {
            this.logger.warn(`SLOW ${line}`);
          } else if (process.env.NODE_ENV !== 'production') {
            this.logger.log(line);
          }
        },
      }),
    );
  }
}

/**
 * Converts Prisma `Decimal` values to numbers on the way out.
 *
 * Applied globally because every money column in the schema is Decimal, and a
 * single missed conversion ships `{"s":1,"e":3,"d":[2500]}` to the browser.
 * Precision is preserved in the database, which is where it matters; the wire
 * format is display data.
 *
 * Depth is bounded — a cyclic object would otherwise hang the response thread
 * rather than fail, which is far harder to diagnose.
 */
@Injectable()
export class DecimalSerialiserInterceptor implements NestInterceptor {
  private static readonly MAX_DEPTH = 12;

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => DecimalSerialiserInterceptor.convert(value, 0)));
  }

  private static convert(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (depth > DecimalSerialiserInterceptor.MAX_DEPTH) return value;

    if (Prisma.Decimal.isDecimal(value)) {
      return (value as Prisma.Decimal).toNumber();
    }

    // Dates serialise correctly on their own; recursing into them yields junk.
    if (value instanceof Date || value instanceof Buffer) return value;

    if (Array.isArray(value)) {
      return value.map((item) => DecimalSerialiserInterceptor.convert(item, depth + 1));
    }

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = DecimalSerialiserInterceptor.convert(item, depth + 1);
      }
      return out;
    }

    return value;
  }
}
