/**
 * Parsing a Redis connection string without leaking it.
 *
 * Two things go wrong here and both did, in production, on the first deploy.
 *
 * The first is that `new URL()` throws `ERR_INVALID_URL` with the offending
 * string attached as `input:` — so a malformed connection string prints the
 * password straight into the deploy log, where it is retained, searchable and
 * often shared in a screenshot while asking for help. A parse failure must
 * never quote the credential back.
 *
 * The second is that decomposing a URL into host, port and password quietly
 * discards the scheme, and the scheme is what carries TLS. A `rediss://` host
 * reached over a plaintext socket does not fail with a helpful message; it
 * fails as a connection reset, which reads like a network problem.
 */

export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Present only for `rediss://`. ioredis enables TLS on any non-null value. */
  tls?: Record<string, never>;
}

/** A connection string with the credential replaced, safe for logs. */
export function redactRedisUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username.slice(0, 2) + '***';
    return url.toString();
  } catch {
    // Unparseable, so show only the shape: everything up to the first colon,
    // which is the scheme or the stray command someone pasted.
    const head = raw.trim().split(/[\s:]/, 1)[0] ?? '';
    return `${head.slice(0, 24)}… (${raw.length} chars)`;
  }
}

/**
 * Parse a Redis URL into connection fields, preserving TLS.
 *
 * Throws with a message that explains the likely cause and never contains the
 * credential.
 */
export function parseRedisUrl(raw: string): RedisConnection {
  const value = raw.trim();

  // The commonest mistake by a wide margin: hosted Redis dashboards show a
  // ready-to-run shell command, and the whole line gets pasted into the
  // environment variable rather than just the URL inside it.
  const embedded = value.match(/\brediss?:\/\/\S+/);
  if (embedded && !/^rediss?:\/\//.test(value)) {
    throw new Error(
      'REDIS_URL looks like a shell command rather than a URL. ' +
        'Use only the part starting at "redis://" or "rediss://" — drop any ' +
        '"redis-cli", flags such as --tls, and the -u that precedes the URL.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `REDIS_URL is not a valid URL (got ${redactRedisUrl(value)}). ` +
        'Expected redis://user:password@host:port or rediss://… for TLS.',
    );
  }

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `REDIS_URL must use the redis:// or rediss:// scheme, not "${url.protocol}".`,
    );
  }

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    // Redis 6 ACLs need the username; managed providers commonly use "default".
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    // Restores what decomposing the URL threw away. Upstash and most managed
    // Redis providers are TLS-only, and without this the socket is plaintext.
    ...(url.protocol === 'rediss:' ? { tls: {} as Record<string, never> } : {}),
  };
}
