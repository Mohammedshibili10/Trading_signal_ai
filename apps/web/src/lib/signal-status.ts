/**
 * How a signal's status is presented.
 *
 * Mirrors the classification the API uses, and exists for the same reason: the
 * mapping had been written inline wherever a badge was needed, and each copy
 * fell back to "green if it isn't STOPPED". That painted cancelled and invalid
 * setups as successes on one page while the analytics counted them as losses on
 * another, which is the worst of both.
 *
 * The rule, in one line: **only STOPPED is a loss.**
 */

export type SignalOutcome = 'ACTIVE' | 'WIN' | 'LOSS' | 'CANCELLED' | 'INVALID' | 'EXPIRED';

export type BadgeTone = 'bull' | 'bear' | 'secondary' | 'neutral' | 'outline';

export interface StatusMeta {
  label: string;
  /** Short form, for tight spaces. */
  short: string;
  variant: BadgeTone;
  /** What the status actually means, for a tooltip. */
  hint: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  ACTIVE: {
    label: 'Active',
    short: 'active',
    variant: 'neutral',
    hint: 'Live — price has not resolved it yet.',
  },
  HIT_T1: {
    label: 'Target 1 hit',
    short: 'T1',
    variant: 'bull',
    hint: 'First target reached; the position is still open.',
  },
  HIT_T2: {
    label: 'Target 2 hit',
    short: 'T2',
    variant: 'bull',
    hint: 'Second target reached; the position is still open.',
  },
  HIT_T3: {
    label: 'Target 3 hit',
    short: 'T3',
    variant: 'bull',
    hint: 'Final target reached. Closed as a win.',
  },
  STOPPED: {
    label: 'Stop loss',
    short: 'stopped',
    variant: 'bear',
    hint: 'Price traded through the stop. This is the only status that counts as a loss.',
  },
  CANCELLED: {
    label: 'Cancelled',
    short: 'cancelled',
    variant: 'secondary',
    hint: 'Closed early by the engine because the reasoning stopped holding — not a stop-out, and not counted as a loss.',
  },
  INVALID: {
    label: 'Invalid',
    short: 'invalid',
    variant: 'secondary',
    hint: 'The setup broke before the entry ever filled. There was never a position, so there was never a loss.',
  },
  EXPIRED: {
    label: 'Expired',
    short: 'expired',
    variant: 'outline',
    hint: 'The validity window ran out without the entry filling.',
  },
};

const FALLBACK: StatusMeta = {
  label: 'Unknown',
  short: 'unknown',
  variant: 'outline',
  hint: '',
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { ...FALLBACK, label: status, short: status.toLowerCase() };
}

/** Only a stop-out is a loss. Everything else the engine ended is its own thing. */
export function isLoss(status: string): boolean {
  return status === 'STOPPED';
}

export function outcomeOf(status: string): SignalOutcome {
  if (status.startsWith('HIT_')) return 'WIN';
  if (status === 'STOPPED') return 'LOSS';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'INVALID') return 'INVALID';
  if (status === 'EXPIRED') return 'EXPIRED';
  return 'ACTIVE';
}

export const OUTCOME_VARIANT: Record<SignalOutcome, BadgeTone> = {
  WIN: 'bull',
  LOSS: 'bear',
  ACTIVE: 'neutral',
  CANCELLED: 'secondary',
  INVALID: 'secondary',
  EXPIRED: 'outline',
};
