import type { PrismaService } from '../prisma/prisma.service';

/**
 * May this setup be issued as a new signal?
 *
 * The scan is stateless: it looks at the market and reports what it sees. That
 * is the right design for analysis and the wrong one for issuing, because the
 * market does not change just because a signal was cancelled. Ten minutes after
 * the engine ends a setup the data still says what it said, so the next scan
 * re-derives the same conclusion and hands back the very signal the engine had
 * just rejected — and the rejection is what carried the information.
 *
 * So the decision to *issue* needs the memory the analysis deliberately lacks.
 * This module is that memory, and it is one module rather than two because the
 * manual scan and the autonomous scanner previously each had their own copy of
 * the check and the copies had already drifted apart.
 */

/** Bar length per stored timeframe, used to scale the cooldown. */
const TIMEFRAME_MS: Record<string, number> = {
  M1: 60_000,
  M3: 180_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN1: 2_592_000_000,
};

/**
 * A cooldown is counted in bars, not in hours.
 *
 * "Wait six hours" means something entirely different on a 1-minute chart than
 * on a daily one. Six bars is the same statement in both places: enough new
 * information for the conclusion to be genuinely re-derived rather than merely
 * repeated.
 */
const COOLDOWN_BARS = 6;
const COOLDOWN_MIN_MS = 30 * 60_000;
const COOLDOWN_MAX_MS = 5 * 86_400_000;

/**
 * How far price must travel before the same direction counts as a new setup.
 *
 * Measured in R — the signal's own risk distance — rather than in percent,
 * because 0.5% is an enormous move for an intraday forex setup and noise for a
 * daily crypto one. R normalises across every instrument and timeframe for
 * free, and it is the unit the setup was already sized in.
 */
const MATERIAL_MOVE_R = 0.75;

/** Fallback when the prior signal has no usable stop to measure risk from. */
const MATERIAL_MOVE_PERCENT = 1.5;

/**
 * How many engine-ended signals on one instrument and timeframe constitute a
 * whipsaw. At three, the instrument is chopping and the engine is being sawn
 * back and forth by it; the correct response is to stand down rather than to
 * keep paying for the lesson.
 */
const WHIPSAW_LIMIT = 3;

/** Statuses that mean a signal is still live. */
export const OPEN_STATUSES = ['ACTIVE', 'HIT_T1', 'HIT_T2'] as const;

/** Statuses where the engine ended the signal on its own terms. */
export const ENGINE_ENDED_STATUSES = ['CANCELLED', 'INVALID'] as const;

export type SuppressionReason = 'ALREADY_OPEN' | 'COOLDOWN' | 'WHIPSAW' | 'PRECEDENT';

export interface ReissueRequest {
  symbol: string;
  /** Prisma timeframe enum value, e.g. `H1`. */
  timeframe: string;
  action: 'BUY' | 'SELL';
  entry: number | null;
  stopLoss: number | null;
}

export interface ReissueAllowed {
  allow: true;
  /** The signal this one replaces, when it is a genuine re-entry. */
  supersedesId: string | null;
  note: string | null;
}

export interface ReissueSuppressed {
  allow: false;
  reason: SuppressionReason;
  symbol: string;
  action: string;
  /** Short label for the UI. */
  label: string;
  /** Why, in the words the user should read. */
  detail: string;
  until: Date | null;
  priorSignalId: string | null;
}

export type ReissueVerdict = ReissueAllowed | ReissueSuppressed;

/** Cooldown length for a timeframe, in milliseconds. */
export function cooldownMsFor(timeframe: string): number {
  const bar = TIMEFRAME_MS[timeframe] ?? 86_400_000;
  return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, bar * COOLDOWN_BARS));
}

/** The instant a signal ended now may be re-issued from. */
export function cooldownUntilFor(timeframe: string, from: Date = new Date()): Date {
  return new Date(from.getTime() + cooldownMsFor(timeframe));
}

function humanDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * Has price moved far enough that this is a genuinely different setup?
 *
 * The question the whole guard turns on. A cancelled BUY and a fresh BUY at the
 * same price, on the same timeframe, is the cancelled signal wearing a new id.
 * The same BUY a full risk-unit lower is a different trade with a different
 * stop and a different payoff, and refusing it would mean the engine could
 * never re-enter anything it had once stood down from.
 */
function isMateriallyDifferent(
  candidateEntry: number | null,
  prior: { entry: number | null; stopLoss: number | null },
): { different: boolean; detail: string } {
  if (candidateEntry === null || prior.entry === null || prior.entry === 0) {
    // Without both prices there is no evidence of a change, and the guard's
    // job is to require evidence rather than to assume it.
    return { different: false, detail: 'no comparable entry price on the prior signal' };
  }

  const moved = Math.abs(candidateEntry - prior.entry);

  if (prior.stopLoss !== null && prior.stopLoss !== prior.entry) {
    const risk = Math.abs(prior.entry - prior.stopLoss);
    const movedR = moved / risk;
    return {
      different: movedR >= MATERIAL_MOVE_R,
      detail: `entry moved ${movedR.toFixed(2)}R from the cancelled setup (needs ${MATERIAL_MOVE_R}R)`,
    };
  }

  const movedPercent = (moved / prior.entry) * 100;
  return {
    different: movedPercent >= MATERIAL_MOVE_PERCENT,
    detail: `entry moved ${movedPercent.toFixed(2)}% from the cancelled setup (needs ${MATERIAL_MOVE_PERCENT}%)`,
  };
}

/**
 * Decide whether a candidate signal may be written.
 *
 * Checked in order of how conclusive each answer is: something already live
 * settles it outright, a whipsawing instrument overrides any single setup's
 * merits, and only then does the cooldown ask whether this particular setup has
 * actually changed.
 */
export async function assessReissue(
  prisma: PrismaService,
  request: ReissueRequest,
): Promise<ReissueVerdict> {
  const now = new Date();
  const { symbol, timeframe, action } = request;

  // ── 1. Already live ──────────────────────────────────────────
  const open = await prisma.signal.findFirst({
    where: {
      symbol,
      timeframe: timeframe as never,
      action: action as never,
      status: { in: OPEN_STATUSES as unknown as never[] },
      validUntil: { gt: now },
    },
    select: { id: true, createdAt: true },
  });

  if (open) {
    return {
      allow: false,
      reason: 'ALREADY_OPEN',
      symbol,
      action,
      label: 'Already open',
      detail: `A ${action} signal for ${symbol} on this timeframe is still live. A setup that persists across scans is one signal, not one per scan.`,
      until: null,
      priorSignalId: open.id,
    };
  }

  // ── 2. Whipsaw ───────────────────────────────────────────────
  //
  // Counted across both directions and including real stop-outs, because the
  // thing being detected is the instrument, not the trade. Flipping long to
  // short each time the last one fails would otherwise pass every other check,
  // since each flip looks like a legitimately new setup on its own.
  const whipsawSince = new Date(now.getTime() - cooldownMsFor(timeframe) * 2);
  const recentFailures = await prisma.signal.count({
    where: {
      symbol,
      timeframe: timeframe as never,
      status: { in: ['CANCELLED', 'INVALID', 'STOPPED'] as unknown as never[] },
      resolvedAt: { gte: whipsawSince },
    },
  });

  if (recentFailures >= WHIPSAW_LIMIT) {
    return {
      allow: false,
      reason: 'WHIPSAW',
      symbol,
      action,
      label: 'Choppy — standing down',
      detail: `${recentFailures} setups on ${symbol} have failed or been cancelled recently. The instrument is not trending cleanly on this timeframe, and re-entering into chop is how a run of small losses is made.`,
      until: new Date(now.getTime() + cooldownMsFor(timeframe)),
      priorSignalId: null,
    };
  }

  // ── 3. Cooldown on the same direction ────────────────────────
  const prior = await prisma.signal.findFirst({
    where: {
      symbol,
      timeframe: timeframe as never,
      action: action as never,
      status: { in: ENGINE_ENDED_STATUSES as unknown as never[] },
      cooldownUntil: { gt: now },
    },
    orderBy: { resolvedAt: 'desc' },
    select: {
      id: true,
      entry: true,
      stopLoss: true,
      cooldownUntil: true,
      invalidationReason: true,
      status: true,
    },
  });

  if (prior) {
    const verdict = isMateriallyDifferent(request.entry, {
      entry: prior.entry === null ? null : Number(prior.entry),
      stopLoss: prior.stopLoss === null ? null : Number(prior.stopLoss),
    });

    if (verdict.different) {
      // A real re-entry: same instrument and direction, but price has travelled
      // far enough that the stop, the payoff and the invalidation level are all
      // different numbers. Linked to its predecessor so the chain stays
      // auditable rather than looking like the guard simply failed.
      return {
        allow: true,
        supersedesId: prior.id,
        note: `Re-entry after a cancelled setup — ${verdict.detail}.`,
      };
    }

    const remaining = prior.cooldownUntil
      ? prior.cooldownUntil.getTime() - now.getTime()
      : 0;

    return {
      allow: false,
      reason: 'COOLDOWN',
      symbol,
      action,
      label: 'Recently cancelled',
      detail:
        `This ${action} setup on ${symbol} was ended by the engine` +
        (prior.invalidationReason ? ` (${prior.invalidationReason.toLowerCase().replace(/_/g, ' ')})` : '') +
        ` and price has not moved enough since for it to be a different trade — ${verdict.detail}. ` +
        `Re-issue possible in ${humanDuration(remaining)} if conditions change.`,
      until: prior.cooldownUntil,
      priorSignalId: prior.id,
    };
  }

  return { allow: true, supersedesId: null, note: null };
}
