import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private available = false;

  /**
   * In-flight requests, keyed by cache key.
   *
   * Request coalescing: when 50 watchlist subscribers ask for the same quote
   * within the same tick, exactly one upstream call is made and the rest await
   * its promise. Without this a popular symbol produces a thundering herd
   * against the provider and gets us rate-limited.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('redisUrl') ?? 'redis://localhost:6379';

    this.client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 3000)),
    });

    this.client.on('ready', () => {
      this.available = true;
      this.logger.log('redis connected');
    });
    this.client.on('error', (error: Error) => {
      if (this.available) this.logger.warn(`redis error: ${error.message}`);
      this.available = false;
    });
    this.client.on('close', () => {
      this.available = false;
    });

    // Cache is an optimisation, never a hard dependency. A Redis outage should
    // degrade latency, not take the API down — every method below falls
    // through to the source when the client is unavailable.
    void this.client.connect().catch((error: Error) => {
      this.logger.warn(`redis unavailable, running without cache: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /** Raw client, for the few places that need it (pub/sub, BullMQ). */
  get raw(): Redis {
    return this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.available) return null;
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.available) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
    } catch {
      /* cache writes are best-effort */
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.available || keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch {
      /* ignore */
    }
  }

  /** Delete by pattern. Uses SCAN, never KEYS — KEYS blocks the server. */
  async delPattern(pattern: string): Promise<number> {
    if (!this.available) return 0;
    let deleted = 0;
    try {
      let cursor = '0';
      do {
        const [next, found] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (found.length > 0) {
          deleted += await this.client.del(...found);
        }
      } while (cursor !== '0');
    } catch {
      /* ignore */
    }
    return deleted;
  }

  /**
   * Read-through cache with request coalescing.
   *
   * The single most important method in the API's hot path — every quote,
   * candle series and analysis goes through it.
   */
  async wrap<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = produce()
      .then(async (value) => {
        if (value !== null && value !== undefined) {
          await this.set(key, value, ttlSeconds);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Fixed-window counter. Used for per-user quotas on expensive endpoints. */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.available) return 0;
    try {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, ttlSeconds);
      return count;
    } catch {
      return 0;
    }
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    if (!this.available) return;
    try {
      await this.client.publish(channel, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }
}
