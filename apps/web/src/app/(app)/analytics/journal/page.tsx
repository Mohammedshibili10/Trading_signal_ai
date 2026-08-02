'use client';

import { useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AnalyticsGate,
  AnalyticsShell,
  fmtHours,
  fmtR,
  useAnalytics,
  type JournalRow,
} from '@/components/analytics/shared';
import { formatPrice, formatRelative } from '@/lib/format';
import { OUTCOME_VARIANT, statusMeta, type SignalOutcome } from '@/lib/signal-status';
import { cn } from '@/lib/utils';



export default function TradeJournalPage() {
  const query = useAnalytics();
  const [filter, setFilter] = useState<'ALL' | SignalOutcome>('ALL');

  return (
    <AnalyticsShell
      title="Trade Journal"
      description="Every signal in full: entry, stop, target, what it actually did, and the engine's own account of why."
    >
      <AnalyticsGate query={query}>
        {(data) => {
          const count = (outcome: SignalOutcome) =>
            data.journal.filter((r) => r.outcome === outcome).length;

          const rows =
            filter === 'ALL' ? data.journal : data.journal.filter((r) => r.outcome === filter);

          return (
            <div className="flex flex-col gap-4">
              <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
                <TabsList>
                  <TabsTrigger value="ALL">All ({data.journal.length})</TabsTrigger>
                  <TabsTrigger value="WIN">Wins ({count('WIN')})</TabsTrigger>
                  {/* Stop-outs only. A cancelled setup never cost anything and
                      does not belong in the same column as one that did. */}
                  <TabsTrigger value="LOSS">Stop loss ({count('LOSS')})</TabsTrigger>
                  <TabsTrigger value="ACTIVE">Active ({count('ACTIVE')})</TabsTrigger>
                  <TabsTrigger value="CANCELLED">Cancelled ({count('CANCELLED')})</TabsTrigger>
                  <TabsTrigger value="INVALID">Invalid ({count('INVALID')})</TabsTrigger>
                </TabsList>
              </Tabs>

              {rows.length === 0 ? (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[13px] text-muted-foreground">
                      No trades match this filter.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="flex flex-col gap-3">
                  {rows.map((row) => (
                    <JournalEntry key={row.id} row={row} />
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </AnalyticsGate>
    </AnalyticsShell>
  );
}

function JournalEntry({ row }: { row: JournalRow }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={row.action === 'BUY' ? 'bull' : 'bear'}>{row.action}</Badge>
              <Link
                href={`/markets/${row.symbol}`}
                className="text-[14px] font-semibold hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {row.symbol}
              </Link>
              <Badge variant="secondary">{row.timeframe}</Badge>
              <Badge variant={OUTCOME_VARIANT[row.outcome]}>{row.outcome.toLowerCase()}</Badge>
              {row.confidence !== null && (
                <span className="text-[11px] text-muted-foreground">
                  conf {row.confidence.toFixed(0)}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatRelative(row.createdAt)}
              {row.holdingHours !== null && ` · held ${fmtHours(row.holdingHours)}`}
              {row.barsHeld !== null && ` · ${row.barsHeld} bars`}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <p
              className={cn(
                'text-lg font-semibold tabular',
                row.realisedR === null
                  ? 'text-muted-foreground'
                  : row.realisedR >= 0
                    ? 'text-bull'
                    : 'text-bear',
              )}
            >
              {fmtR(row.realisedR)}
            </p>
            {row.returnPercent !== null && (
              <p className="text-[11px] text-muted-foreground">
                {row.returnPercent >= 0 ? '+' : ''}
                {row.returnPercent.toFixed(2)}% of capital
              </p>
            )}
          </div>
        </button>

        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-5">
          <Cell label="Entry" value={formatPrice(row.entry, { withSymbol: false })} />
          <Cell
            label="Stop"
            value={formatPrice(row.stopLoss, { withSymbol: false })}
            className="text-bear"
          />
          <Cell
            label="Target"
            value={formatPrice(row.takeProfit, { withSymbol: false })}
            className="text-bull"
          />
          <Cell label="R:R" value={row.riskReward === null ? '—' : `${row.riskReward.toFixed(2)}:1`} />
          <Cell
            label="MAE / MFE"
            value={
              row.maeR === null ? '—' : `${row.maeR.toFixed(2)} / ${(row.mfeR ?? 0).toFixed(2)}`
            }
          />
        </div>

        {open && (
          <div className="mt-3 border-t border-border pt-3">
            {row.analysis ? (
              <>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  AI analysis
                </p>
                <p className="mt-1 text-[13px] leading-relaxed">{row.analysis}</p>
              </>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                {row.outcome === 'ACTIVE'
                  ? 'Still open — the post-mortem runs once it resolves.'
                  : 'Awaiting review. Post-mortems run every ten minutes.'}
              </p>
            )}

            {row.causes.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {row.causes.map((cause) => (
                  <li key={cause.reason} className="text-[12px] leading-relaxed text-muted-foreground">
                    · <span className="text-foreground">{cause.reason.replace(/_/g, ' ').toLowerCase()}</span>{' '}
                    — {cause.detail}
                  </li>
                ))}
              </ul>
            )}

            {row.captureRatio !== null && row.captureRatio > 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Captured {(row.captureRatio * 100).toFixed(0)}% of the move that was available
                before the trade resolved.
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {open ? 'Hide analysis' : 'Show analysis'}
        </button>
      </CardContent>
    </Card>
  );
}

function Cell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[13px] font-medium tabular font-mono', className)}>{value}</p>
    </div>
  );
}
