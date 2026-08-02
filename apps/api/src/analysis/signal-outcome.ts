/**
 * What a signal's status means for reporting.
 *
 * Kept in one place because the mapping had been rewritten inline at half a
 * dozen call sites, each with its own `else` branch, and every one of those
 * branches ended in "otherwise it's a loss". That default is how a cancelled
 * setup — a trade the engine had the discipline to walk away from — ended up
 * counted and displayed as a stop-out.
 *
 * The rule that matters: **only price hitting the stop is a loss.** Everything
 * the engine ended on its own terms is a separate outcome, because reporting it
 * as a loss is wrong twice over. It misstates the record, and it poisons the
 * learning data with failures that never happened — which then teaches the
 * engine to avoid setups that never actually cost anything.
 */

export type SignalOutcome =
  | 'ACTIVE'
  | 'WIN'
  | 'LOSS'
  | 'CANCELLED'
  | 'INVALID'
  | 'EXPIRED';

/** Still live: price may yet resolve it either way. */
export const OPEN = ['ACTIVE', 'HIT_T1', 'HIT_T2'] as const;

/**
 * Resolved by price, and therefore countable as performance.
 *
 * This is the set every win-rate, expectancy and drawdown figure must be built
 * from. A signal the engine cancelled has no P&L to contribute, so including it
 * would drag the win rate down with trades that were never lost.
 */
export const PRICE_RESOLVED = ['HIT_T1', 'HIT_T2', 'HIT_T3', 'STOPPED'] as const;

/** Ended by the engine's judgement rather than by price. Never losses. */
export const ENGINE_ENDED = ['CANCELLED', 'INVALID'] as const;

/** Ended without a position and without a judgement. */
export const LAPSED = ['EXPIRED'] as const;

export function outcomeOf(status: string): SignalOutcome {
  if (status.startsWith('HIT_')) return 'WIN';
  // The single status that represents money actually lost.
  if (status === 'STOPPED') return 'LOSS';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'INVALID') return 'INVALID';
  if (status === 'EXPIRED') return 'EXPIRED';
  return 'ACTIVE';
}

/** May this signal contribute to win rate, expectancy and drawdown? */
export function countsAsPerformance(status: string): boolean {
  return (PRICE_RESOLVED as readonly string[]).includes(status);
}

/** Was this ended by the engine rather than by price? */
export function isEngineEnded(status: string): boolean {
  return (ENGINE_ENDED as readonly string[]).includes(status);
}

/**
 * Lifecycle stage, for display.
 *
 * Archiving is deliberately a timestamp rather than a status. A stopped trade
 * that gets archived is still a stopped trade — overwriting its status would
 * destroy the one fact the learning data needs most, so the stage is derived
 * from both instead.
 */
export type LifecycleStage = 'ACTIVE' | 'UPDATED' | 'CLOSED' | 'CANCELLED' | 'ARCHIVED';

export function lifecycleStageOf(
  status: string,
  archivedAt?: Date | string | null,
): LifecycleStage {
  if (archivedAt) return 'ARCHIVED';
  if (status === 'ACTIVE') return 'ACTIVE';
  // Partially resolved: a target has been taken and the position is still open.
  if (status === 'HIT_T1' || status === 'HIT_T2') return 'UPDATED';
  if (status === 'CANCELLED' || status === 'INVALID' || status === 'EXPIRED') return 'CANCELLED';
  return 'CLOSED';
}

/** Human label for a status, used anywhere the raw enum would leak to a user. */
export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  HIT_T1: 'Target 1 hit',
  HIT_T2: 'Target 2 hit',
  HIT_T3: 'Target 3 hit',
  STOPPED: 'Stop loss',
  EXPIRED: 'Expired unfilled',
  CANCELLED: 'Cancelled',
  INVALID: 'Invalid',
  ARCHIVED: 'Archived',
};
