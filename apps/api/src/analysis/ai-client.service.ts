import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * HTTP client for the FastAPI analysis service.
 *
 * The AI service is stateless and holds no user data, so this is the only place
 * that knows how to reach it. Two behaviours matter:
 *
 * - **Circuit breaking.** After repeated failures the client stops trying for a
 *   cool-off period. Without it, an AI outage turns every dashboard request
 *   into a 45-second timeout and the whole API becomes unresponsive.
 * - **No silent fallback.** If analysis is unavailable, the caller is told so.
 *   Returning a neutral/empty analysis would be indistinguishable from a real
 *   "no signal" result, which is exactly the kind of thing a user would trade on.
 */
@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly COOL_OFF_MS = 30_000;

  constructor(private readonly config: ConfigService) {}

  get baseUrl(): string {
    return this.config.get<string>('ai.url') ?? 'http://localhost:8000';
  }

  private get token(): string {
    return this.config.get<string>('ai.token') ?? '';
  }

  private get timeoutMs(): number {
    return this.config.get<number>('ai.timeoutMs') ?? 45_000;
  }

  get isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  async post<T>(path: string, body: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.isCircuitOpen) {
      throw new ServiceUnavailableException(
        'The analysis service is temporarily unavailable. Retrying shortly.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // 4xx means we sent something wrong — that is not a service failure and
        // must not count toward the circuit breaker.
        if (response.status >= 400 && response.status < 500) {
          let detail = text;
          try {
            detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
          } catch {
            /* keep raw text */
          }
          throw new HttpException(detail || 'Invalid analysis request', response.status);
        }
        throw new Error(`AI service returned ${response.status}: ${text.slice(0, 200)}`);
      }

      this.consecutiveFailures = 0;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= AiClientService.FAILURE_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + AiClientService.COOL_OFF_MS;
        this.logger.error(
          `AI service circuit opened after ${this.consecutiveFailures} failures — ` +
            `pausing calls for ${AiClientService.COOL_OFF_MS / 1000}s`,
        );
      }

      const message = (error as Error).name === 'AbortError'
        ? `Analysis timed out after ${(options.timeoutMs ?? this.timeoutMs) / 1000}s`
        : (error as Error).message;

      this.logger.warn(`POST ${path} failed: ${message}`);
      throw new ServiceUnavailableException(
        `Analysis service unavailable: ${message}. Check that the AI service is running at ${this.baseUrl}.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness, for the health endpoint and admin panel. */
  async health(): Promise<{ reachable: boolean; detail: string; circuitOpen: boolean }> {
    try {
      const result = await this.get<{ status: string; version: string }>('/health');
      return {
        reachable: result.status === 'ok',
        detail: `v${result.version}`,
        circuitOpen: this.isCircuitOpen,
      };
    } catch (error) {
      return {
        reachable: false,
        detail: (error as Error).message,
        circuitOpen: this.isCircuitOpen,
      };
    }
  }
}
