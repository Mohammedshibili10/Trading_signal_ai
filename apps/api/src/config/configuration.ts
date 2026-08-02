/**
 * Typed configuration, loaded once at boot.
 *
 * Everything has a working default so the stack runs with no `.env` at all.
 * The one exception is JWT secrets in production — see `validate()`, which
 * refuses to boot rather than silently signing tokens with a dev key.
 */

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  redisUrl: string;

  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };

  cookie: {
    domain: string;
    secure: boolean;
    sameSite: 'lax' | 'none' | 'strict';
  };

  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    enabled: boolean;
  };

  mail: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
    enabled: boolean;
  };

  marketData: {
    providers: string[];
    alphaVantageKey: string;
    finnhubKey: string;
    quoteCacheTtl: number;
    /** 'false' disables Binance WebSocket streaming and falls back to polling. */
    binanceStream: string;
    candleCacheTtl: number;
  };

  news: {
    providers: string[];
    newsApiKey: string;
  };

  ai: {
    url: string;
    token: string;
    timeoutMs: number;
  };

  notifications: {
    /** Bot token from @BotFather. Empty disables the Telegram channel entirely. */
    telegramBotToken: string;
  };

  autoscan: {
    /** 'false' turns off autonomous background scanning. */
    enabled: string;
    /** Minutes between scan passes. */
    intervalMinutes: number;
  };

  rateLimit: {
    ttl: number;
    limit: number;
  };
}

/**
 * Connection strings that are correct locally and certainly wrong in
 * production. Matched exactly rather than by hostname: running Postgres on
 * localhost beside the app on a single VPS is a legitimate deployment, and a
 * blanket "localhost is forbidden" rule would reject it. What is never
 * legitimate is shipping with the development *credentials*.
 */
const DEV_CONNECTIONS = new Set([
  'postgresql://tip:tip_password@localhost:5432/tip?schema=public',
  'redis://localhost:6379',
]);

const DEV_SECRETS = new Set([
  'dev-access-secret-change-me-in-production',
  'dev-refresh-secret-change-me-in-production',
  'dev-ai-service-token-change-me',
]);

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default (): AppConfig => {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const isProd = nodeEnv === 'production';

  /**
   * Cross-site cookies need `none`; same-site deployments should keep `lax`.
   *
   * The refresh token rides in a cookie, and the browser decides whether to
   * send it by comparing *registrable domains* — not origins. A frontend on
   * vercel.app calling an API on onrender.com is cross-site, so a `lax` cookie
   * is stored and then never sent again: login appears to work and the session
   * dies at the first refresh, which is a miserable thing to debug.
   *
   * Serving both from one parent domain (app.example.com + api.example.com
   * with COOKIE_DOMAIN=.example.com) makes them same-site, and `lax` is then
   * the better choice because it keeps the CSRF protection that `none` gives up.
   */
  const sameSite = ((): 'lax' | 'none' | 'strict' => {
    const raw = (process.env.COOKIE_SAMESITE ?? '').toLowerCase();
    return raw === 'none' || raw === 'strict' || raw === 'lax' ? raw : 'lax';
  })();

  return {
    nodeEnv,
    // `PORT` first: every managed host — Render, Railway, Fly, Heroku — assigns
    // a port and expects the process to bind exactly that one. Reading only
    // API_PORT meant binding 4000 while the platform watched a different port,
    // and the deploy fails its health check for a reason nothing logs.
    port: int(process.env.PORT ?? process.env.API_PORT, 4000),
    corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:3000']),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgresql://tip:tip_password@localhost:5432/tip?schema=public',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me-in-production',
      refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me-in-production',
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
    },

    cookie: {
      // Empty in production means a host-only cookie scoped to the API's own
      // domain, which is what a managed host wants. Defaulting to 'localhost'
      // there would scope the cookie to a domain the browser will never match,
      // so it is set, returned, and then silently ignored forever.
      domain: process.env.COOKIE_DOMAIN ?? (isProd ? '' : 'localhost'),
      // 'none' forces Secure — browsers reject the combination otherwise, and
      // the cookie is silently dropped rather than rejected loudly.
      secure: isProd || sameSite === 'none',
      sameSite,
    },

    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      callbackUrl:
        process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:4000/api/v1/auth/google/callback',
      enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },

    mail: {
      host: process.env.SMTP_HOST ?? '',
      port: int(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER ?? '',
      password: process.env.SMTP_PASSWORD ?? '',
      from: process.env.MAIL_FROM ?? 'AI Trading Intelligence <no-reply@example.com>',
      enabled: Boolean(process.env.SMTP_HOST),
    },

    marketData: {
      providers: list(process.env.MARKET_DATA_PROVIDERS, ['yahoo', 'simulated']),
      alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY ?? '',
      finnhubKey: process.env.FINNHUB_API_KEY ?? '',
      quoteCacheTtl: int(process.env.QUOTE_CACHE_TTL, 15),
      binanceStream: process.env.BINANCE_STREAM ?? 'true',
      candleCacheTtl: int(process.env.CANDLE_CACHE_TTL, 300),
    },

    news: {
      providers: list(process.env.NEWS_PROVIDERS, ['rss']),
      newsApiKey: process.env.NEWSAPI_KEY ?? '',
    },

    notifications: {
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    },

    autoscan: {
      enabled: process.env.AUTOSCAN_ENABLED ?? 'true',
      intervalMinutes: int(process.env.AUTOSCAN_INTERVAL_MINUTES, 5),
    },

    ai: {
      url: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
      token: process.env.AI_SERVICE_TOKEN ?? 'dev-ai-service-token-change-me',
      // The full analysis with calibration is genuinely slow on a cold cache.
      timeoutMs: int(process.env.AI_TIMEOUT_MS, 45_000),
    },

    rateLimit: {
      ttl: int(process.env.RATE_LIMIT_TTL, 60),
      limit: int(process.env.RATE_LIMIT_LIMIT, 120),
    },
  };
};

/**
 * Fail fast on unsafe production configuration.
 *
 * A dev JWT secret in production is a total authentication bypass for anyone
 * who has read the repository — which, for a public template, is everyone.
 * Refusing to boot is the only responsible behaviour.
 */
export function validateProductionConfig(config: AppConfig): void {
  if (config.nodeEnv !== 'production') return;

  const problems: string[] = [];

  if (DEV_SECRETS.has(config.jwt.accessSecret)) {
    problems.push('JWT_ACCESS_SECRET is still the development default');
  }
  if (DEV_SECRETS.has(config.jwt.refreshSecret)) {
    problems.push('JWT_REFRESH_SECRET is still the development default');
  }
  if (DEV_SECRETS.has(config.ai.token)) {
    problems.push('AI_SERVICE_TOKEN is still the development default');
  }
  if (config.jwt.accessSecret === config.jwt.refreshSecret) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  }
  if (DEV_CONNECTIONS.has(config.databaseUrl)) {
    problems.push(
      'DATABASE_URL is still the local development database ' +
        '(localhost with the dev credentials) — set it to your managed Postgres URL',
    );
  }
  if (DEV_CONNECTIONS.has(config.redisUrl)) {
    problems.push(
      'REDIS_URL is still the local development instance — set it to your managed Redis URL',
    );
  }
  if (config.jwt.accessSecret.length < 32) {
    problems.push('JWT_ACCESS_SECRET must be at least 32 characters');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nGenerate secrets with: openssl rand -base64 48`,
    );
  }
}
