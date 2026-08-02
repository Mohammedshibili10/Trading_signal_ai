'use client';

import { AlertTriangle, Check, Layers, Minus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/market/primitives';
import { cn } from '@/lib/utils';

export interface TimeframeRead {
  timeframe: string;
  weight: number;
  bars: number;
  stance: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendScore: number;
  trendDirection: string;
  trendStrength: number;
  structureScore: number;
  structureEvent: string | null;
  momentumScore: number;
  price: number;
  note: string;
}

export interface ConfluenceResult {
  verdict: string;
  aligned: boolean;
  allowSignal: boolean;
  alignmentScore: number;
  trendAgreement: number;
  structureAgreement: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timeframes: TimeframeRead[];
  unavailable: string[];
  conflicts: string[];
  summary: string;
  reasons: string[];
}

export interface ChecklistItem {
  key: string;
  label: string;
  passed: boolean;
  unavailable: boolean;
  detail: string;
}

export interface ChecklistResult {
  checks: ChecklistItem[];
  passed: number;
  applicable: number;
  clears: boolean;
  criticalFailures: string[];
  summary: string;
}

/**
 * Multi-timeframe agreement and the pre-trade checklist.
 *
 * The design intent is that a rejection is as legible as an approval. Most of
 * the time this panel is explaining why there is no trade, and if that reads as
 * an error state rather than an answer, people will go looking for a setup
 * somewhere the software isn't watching.
 */
export function ConfluencePanel({
  confluence,
  checklist,
  loading,
  error,
}: {
  confluence?: ConfluenceResult;
  checklist?: ChecklistResult;
  loading?: boolean;
  error?: string;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !confluence) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Confluence unavailable"
        description={
          error ??
          'Multi-timeframe confirmation needs at least two timeframes with usable history.'
        }
      />
    );
  }

  const bullish = confluence.bias === 'BULLISH';
  const bearish = confluence.bias === 'BEARISH';

  return (
    <div className="flex flex-col gap-4">
      {/* Verdict */}
      <Card
        className={cn(
          confluence.allowSignal
            ? bullish
              ? 'border-bull/30 bg-bull/5'
              : 'border-bear/30 bg-bear/5'
            : 'border-neutral-signal/30 bg-neutral-signal/5',
        )}
      >
        <CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Layers className="size-4 text-muted-foreground" />
                <Badge variant={bullish ? 'bull' : bearish ? 'bear' : 'neutral'}>
                  {confluence.verdict.replace(/_/g, ' ').toLowerCase()}
                </Badge>
                <span className="text-[12px] text-muted-foreground">
                  {confluence.timeframes.length} timeframes read
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed">{confluence.summary}</p>
            </div>

            <div className="shrink-0 text-right">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Alignment</p>
              <p className="text-2xl font-semibold tabular">
                {confluence.alignmentScore.toFixed(0)}
              </p>
              <Progress
                value={confluence.alignmentScore}
                size="sm"
                className="mt-1 w-24"
                indicatorClassName={
                  confluence.alignmentScore >= 72
                    ? 'bg-bull'
                    : confluence.alignmentScore >= 55
                      ? 'bg-neutral-signal'
                      : 'bg-bear'
                }
              />
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <Metric label="Trend agreement" value={`${confluence.trendAgreement.toFixed(0)}%`} />
            <Metric
              label="Structure agreement"
              value={`${confluence.structureAgreement.toFixed(0)}%`}
            />
            <Metric
              label="Signal allowed"
              value={confluence.allowSignal ? 'Yes' : 'No'}
              className={confluence.allowSignal ? 'text-bull' : 'text-neutral-signal'}
            />
          </div>

          {confluence.conflicts.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
              {confluence.conflicts.map((conflict) => (
                <li key={conflict} className="flex gap-2 text-[12px] leading-relaxed text-neutral-signal">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {conflict}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Per-timeframe ladder */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">TF</th>
                  <th className="px-3 py-2 text-left font-medium">Read</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Weight</th>
                  <th className="px-3 py-2 text-left font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {/* Heaviest first — the timeframes that decide the verdict on top. */}
                {[...confluence.timeframes]
                  .sort((a, b) => b.weight - a.weight)
                  .map((read) => (
                    <tr key={read.timeframe} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5 font-medium tabular font-mono">{read.timeframe}</td>
                      <td className="px-3 py-2.5">
                        <Badge
                          variant={
                            read.stance === 'BULLISH'
                              ? 'bull'
                              : read.stance === 'BEARISH'
                                ? 'bear'
                                : 'secondary'
                          }
                        >
                          {read.stance.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular font-mono text-muted-foreground sm:table-cell">
                        {read.weight.toFixed(2)}×
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{read.note}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {confluence.unavailable.length > 0 && (
            <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              No usable history on {confluence.unavailable.join(', ')} — these do not vote rather
              than voting neutral, which would drag the alignment score toward conflict.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Checklist */}
      {checklist && checklist.checks.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-medium">Pre-trade checklist</p>
              <Badge variant={checklist.clears ? 'bull' : 'neutral'}>
                {checklist.passed}/{checklist.applicable} confirmed
              </Badge>
            </div>

            <ul className="mt-3 flex flex-col gap-2.5">
              {checklist.checks.map((check) => {
                const Icon = check.unavailable ? Minus : check.passed ? Check : X;
                return (
                  <li key={check.key} className="flex gap-2.5">
                    <Icon
                      className={cn(
                        'mt-0.5 size-3.5 shrink-0',
                        check.unavailable
                          ? 'text-muted-foreground'
                          : check.passed
                            ? 'text-bull'
                            : 'text-bear',
                      )}
                    />
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'text-[13px]',
                          check.unavailable && 'text-muted-foreground',
                        )}
                      >
                        {check.label}
                        {check.unavailable && (
                          <span className="ml-1.5 text-[11px]">(not available)</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                        {check.detail}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>

            <p
              className={cn(
                'mt-3 border-t border-border pt-3 text-[12px] leading-relaxed',
                checklist.clears ? 'text-bull' : 'text-neutral-signal',
              )}
            >
              {checklist.summary}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({
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
      <p className={cn('mt-0.5 text-[14px] font-medium tabular', className)}>{value}</p>
    </div>
  );
}
