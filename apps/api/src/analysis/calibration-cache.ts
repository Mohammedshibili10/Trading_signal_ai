import type { RedisService } from '../redis/redis.service';

/**
 * Cache for walk-forward calibration reports.
 *
 * Calibration re-runs the whole scoring pipeline over ~125 historical bars, and
 * it is essentially the entire cost of a calibrated analysis: measured on
 * RELIANCE 1D, 293ms without it and 24.8s with — 98.8% of the request. Paying
 * that on every call made the symbol page slow, and it is what limited the
 * autoscan to a handful of instruments per pass.
 *
 * The saving comes from a property of the measurement itself: **its answer only
 * changes when a new bar closes.** Scored bars, hit-rate, Brier score and the
 * fitted correction are all functions of closed history, so two requests
 * against the same last bar must produce the same report. Keying the cache on
 * that bar's timestamp is therefore not an approximation — it is exact, and it
 * is also *more* correct than the previous time-based TTL, which could serve a
 * report measured before the current bar closed.
 *
 * The engine rebuilds the report via `CalibrationReport.from_dict` and skips the
 * walk-forward entirely, so the numbers are the ones that were measured, not a
 * cheaper estimate of them.
 */

/** Roughly one bar, in seconds. Sets how long a report stays useful. */
const BAR_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1D': 86_400,
  '1W': 604_800,
  '1M': 2_592_000,
};

const HOUR = 3600;
const WEEK = 7 * 86_400;

/**
 * How long to keep a report.
 *
 * Correctness does not depend on this — the key changes when the bar changes,
 * so an entry can never be served for the wrong bar. The TTL only stops old
 * keys accumulating, so it is generous: a few bars' worth, bounded so an
 * intraday timeframe still keeps its report long enough to be worth having and
 * a monthly one does not sit in Redis forever.
 */
export function calibrationTtl(timeframe: string): number {
  const bar = BAR_SECONDS[timeframe] ?? 86_400;
  return Math.min(WEEK, Math.max(HOUR, bar * 3));
}

/**
 * Cache key for one instrument, timeframe and closed bar.
 *
 * `lastBarTime` is what makes this safe. Without it the key would name a
 * measurement without naming what it was measured on.
 */
export function calibrationKey(symbol: string, timeframe: string, lastBarTime: number): string {
  return `calib:${symbol}:${timeframe}:${lastBarTime}`;
}

/** The closed bar a report would be measured against, or null if unknowable. */
export function lastBarTime(candles: Array<{ time: number }>): number | null {
  const last = candles[candles.length - 1];
  return last && Number.isFinite(last.time) ? last.time : null;
}

/**
 * Pull the calibration report out of an engine response.
 *
 * The full analysis carries it on `forecast`, the confluence signal path also
 * echoes it on `signal`. Both are checked so one shape does not silently skip
 * the cache write and leave the expensive path running forever.
 */
export function extractCalibration(result: unknown): Record<string, unknown> | null {
  const root = result as {
    forecast?: { calibration?: Record<string, unknown> };
    signal?: { calibration?: Record<string, unknown> };
    calibration?: Record<string, unknown>;
  } | null;

  const report = root?.forecast?.calibration ?? root?.signal?.calibration ?? root?.calibration;
  if (!report || typeof report !== 'object') return null;

  // A report with no correction points cannot rebuild a calibrator. Caching it
  // would be worse than not caching: every later request would report itself as
  // calibrated while its probabilities went out uncorrected.
  if (!Array.isArray((report as { correction?: unknown }).correction)) return null;

  return report;
}

/** Read a cached report for this exact bar, if one was measured. */
export async function readCalibration(
  redis: RedisService,
  symbol: string,
  timeframe: string,
  candles: Array<{ time: number }>,
): Promise<Record<string, unknown> | null> {
  const bar = lastBarTime(candles);
  if (bar === null) return null;
  return redis.get<Record<string, unknown>>(calibrationKey(symbol, timeframe, bar));
}

/** Store a freshly measured report against the bar it was measured on. */
export async function writeCalibration(
  redis: RedisService,
  symbol: string,
  timeframe: string,
  candles: Array<{ time: number }>,
  result: unknown,
): Promise<void> {
  const bar = lastBarTime(candles);
  if (bar === null) return;

  const report = extractCalibration(result);
  if (!report) return;

  await redis.set(calibrationKey(symbol, timeframe, bar), report, calibrationTtl(timeframe));
}
