'use client';

import { AlertTriangle, Ban, Clock, Layers, Link2, Newspaper, TrendingDown, Volume2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Which icon reads as which kind of blocker. */
const GATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SESSION: Clock,
  NO_TRADE_ZONE: Ban,
  CORRELATION: Link2,
  CHECKLIST: AlertTriangle,
  MULTI_TIMEFRAME: Layers,
  CHOP: TrendingDown,
  ILLIQUID: Volume2,
  NEWS: Newspaper,
};

export interface NoTradeReason {
  key: string;
  label: string;
  detail: string;
  guidance?: string;
  severity?: 'BLOCKING' | 'CAUTION';
}

/**
 * "No Trade Opportunity", with the reasons.
 *
 * Shown whenever the engine declines. The design intent is that this reads as
 * an *answer*, not an error or an empty state — because it is the answer most
 * of the time, and if it looks like a failure people will go looking for a
 * setup somewhere the software isn't watching.
 *
 * Every reason carries what would change it. A rejection that cannot be acted
 * on is just a locked door.
 */
export function NoTradePanel({
  gatedBy,
  headline,
  reasons,
  nextWindow,
  confidence,
  originalAction,
}: {
  gatedBy?: string;
  headline: string;
  reasons: NoTradeReason[];
  nextWindow?: string | null;
  confidence?: number;
  originalAction?: string;
}) {
  const Icon = GATE_ICONS[gatedBy ?? ''] ?? Ban;
  const blocking = reasons.filter((r) => r.severity !== 'CAUTION');
  const cautions = reasons.filter((r) => r.severity === 'CAUTION');

  return (
    <Card className="border-neutral-signal/30 bg-neutral-signal/5">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-signal/12">
              <Icon className="size-4 text-neutral-signal" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold">No Trade Opportunity</h3>
              <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                {headline}
              </p>
            </div>
          </div>

          {gatedBy && (
            <Badge variant="neutral">{gatedBy.replace(/_/g, ' ').toLowerCase()}</Badge>
          )}
        </div>

        {/* What the engine would have done, had the gates passed. Shown because
            "rejected a 68-confidence BUY" and "found nothing" are very
            different states and should not look the same. */}
        {originalAction && originalAction !== 'WAIT' && (
          <p className="mt-3 rounded-lg border border-border bg-card/60 px-3 py-2 text-[12px] text-muted-foreground">
            The underlying read was{' '}
            <span className="font-medium text-foreground">{originalAction}</span>
            {confidence !== undefined && ` at ${confidence.toFixed(0)}/100`} before gating — the
            setup exists, the conditions to take it do not.
          </p>
        )}

        {blocking.length > 0 && (
          <ul className="mt-4 flex flex-col gap-3">
            {blocking.map((reason) => (
              <li key={reason.key} className="flex gap-2.5">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-signal" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{reason.label}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                    {reason.detail}
                  </p>
                  {reason.guidance && (
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">
                      → {reason.guidance}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {cautions.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Also noted
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {cautions.map((reason) => (
                <li key={reason.key} className="text-[12px] text-muted-foreground">
                  · <span className="text-foreground">{reason.label}</span> — {reason.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {nextWindow && (
          <p className="mt-4 flex items-center gap-1.5 border-t border-border pt-3 text-[12px] text-muted-foreground">
            <Clock className="size-3.5 shrink-0" />
            {nextWindow}
          </p>
        )}

        <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          On typical data the engine declines roughly 40% of the time. That is the filter working —
          the objective is signal quality, not signal count.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Build the reason list from a gated-signal response.
 *
 * Kept beside the component so every surface that needs to explain a rejection
 * derives the explanation the same way.
 */
export function noTradeReasons(data: {
  signal?: { action?: string; gatedBy?: string };
  session?: { allowed?: boolean; reason?: string; label?: string; nextWindow?: string | null };
  noTradeZone?: {
    blocked?: boolean;
    zones?: Array<{ key: string; label: string; detail: string; guidance: string; severity: string }>;
  };
  correlation?: { blocked?: boolean; summary?: string };
  checklist?: {
    clears?: boolean;
    checks?: Array<{ key: string; label: string; detail: string; passed: boolean; unavailable: boolean }>;
    summary?: string;
  };
  confluence?: { allowSignal?: boolean; summary?: string; conflicts?: string[] };
}): NoTradeReason[] {
  const reasons: NoTradeReason[] = [];

  if (data.session && data.session.allowed === false) {
    reasons.push({
      key: 'session',
      label: data.session.label ? `Market closed — ${data.session.label}` : 'Outside trading hours',
      detail: data.session.reason ?? 'The venue is not open.',
      severity: 'BLOCKING',
    });
  }

  for (const zone of data.noTradeZone?.zones ?? []) {
    reasons.push({
      key: `zone-${zone.key}`,
      label: zone.label,
      detail: zone.detail,
      guidance: zone.guidance,
      severity: zone.severity === 'BLOCKING' ? 'BLOCKING' : 'CAUTION',
    });
  }

  if (data.correlation?.blocked) {
    reasons.push({
      key: 'correlation',
      label: 'Correlated with open positions',
      detail: data.correlation.summary ?? '',
      severity: 'BLOCKING',
    });
  }

  // Only the checks that actually failed — a passing check is not a reason.
  for (const check of data.checklist?.checks ?? []) {
    if (check.passed || check.unavailable) continue;
    reasons.push({
      key: `check-${check.key}`,
      label: check.label,
      detail: check.detail,
      severity: 'BLOCKING',
    });
  }

  if (data.confluence && data.confluence.allowSignal === false) {
    for (const conflict of data.confluence.conflicts ?? []) {
      reasons.push({
        key: `conflict-${conflict.slice(0, 20)}`,
        label: 'Timeframes disagree',
        detail: conflict,
        severity: 'BLOCKING',
      });
    }
  }

  return reasons;
}
