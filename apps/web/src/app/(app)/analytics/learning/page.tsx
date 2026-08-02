'use client';

import { useQuery } from '@tanstack/react-query';
import { Brain, Check, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/market/primitives';
import { AnalyticsShell } from '@/components/analytics/shared';
import { endpoints } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const REASON_LABELS: Record<string, string> = {
  TREND_MISREAD: 'Incorrect trend identification',
  WEAK_STRUCTURE: 'Weak market structure',
  FALSE_BREAKOUT: 'False breakout',
  LIQUIDITY_TRAP: 'Liquidity trap',
  NEWS_IMPACT: 'News impact',
  LOW_VOLUME: 'Low volume',
  POOR_TIMING: 'Poor entry timing',
  HIGH_VOLATILITY: 'High market volatility',
  HTF_CONFLICT: 'Conflicting higher-timeframe trend',
  STOP_TOO_TIGHT: 'Stop too tight',
  TARGET_TOO_FAR: 'Target too far',
  UNCLEAR: 'No single cause identifiable',
  UNREVIEWED: 'Not yet reviewed',
};

interface WeightChange {
  group: string;
  baseWeight: number;
  proposedWeight: number;
  driftPercent: number;
  rationale: string;
}

interface Proposal {
  id: string;
  validated: boolean;
  applied: boolean;
  reason: string;
  edge: string | number | null;
  tradesAnalysed: number;
  holdoutSize: number;
  changes: WeightChange[];
  createdAt: string;
}

interface PerformanceData {
  summary: { closed: number; wins: number; losses: number; winRate: number | null };
  failureBreakdown: Array<{ reason: string; count: number; share: number }>;
  activeWeights: { proposedWeights: Record<string, number>; reason: string } | null;
  proposals: Proposal[];
}

/**
 * What the engine has learned — and, more importantly, what it tried to learn
 * and could not confirm.
 *
 * The rejected proposals are the more informative half. They are the record of
 * patterns that looked real on the trades they were fitted to and did not
 * survive contact with trades they were not.
 */
export default function AiLearningPage() {
  const query = useQuery({
    queryKey: ['performance'],
    queryFn: async () => (await endpoints.performance.read()).data as PerformanceData,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  return (
    <AnalyticsShell
      title="AI Learning"
      description="What the engine has concluded from its own realised results, and every weight change it has proposed — applied or rejected."
    >
      {query.isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : query.isError ? (
        <EmptyState
          title="Learning record unavailable"
          description={(query.error as Error)?.message ?? 'Could not load the record.'}
        />
      ) : !query.data || query.data.summary.closed === 0 ? (
        <EmptyState
          icon={Brain}
          title="Nothing to learn from yet"
          description="The engine adjusts nothing until at least 40 signals have resolved, and no weight change is applied until it beats the current weights on trades it was not fitted to. Until then it runs its documented defaults — which is the correct behaviour, not a gap."
        />
      ) : (
        <LearningContent data={query.data} />
      )}
    </AnalyticsShell>
  );
}

function LearningContent({ data }: { data: PerformanceData }) {
  const preventable = new Set(['HTF_CONFLICT', 'WEAK_STRUCTURE', 'LOW_VOLUME', 'POOR_TIMING']);
  const totalLosses = data.summary.losses || 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Recurring mistakes */}
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Recurring mistakes</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Losses grouped by the cause the post-mortem identified.
          </p>

          {data.failureBreakdown.length === 0 ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              No losses have been diagnosed yet.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {data.failureBreakdown.map((row) => (
                <li key={row.reason}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px]">
                      {REASON_LABELS[row.reason] ?? row.reason}
                      {preventable.has(row.reason) && (
                        <Badge variant="neutral" className="ml-2">
                          visible before entry
                        </Badge>
                      )}
                    </span>
                    <span className="shrink-0 tabular font-mono text-[12px] text-muted-foreground">
                      {row.count} · {((row.count / totalLosses) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <Progress
                    value={(row.count / totalLosses) * 100}
                    size="sm"
                    className="mt-1.5"
                    indicatorClassName={
                      preventable.has(row.reason) ? 'bg-neutral-signal' : 'bg-bear'
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Weights in force */}
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Weights in force</p>
          {data.activeWeights ? (
            <>
              <ul className="mt-3 flex flex-col gap-2">
                {Object.entries(data.activeWeights.proposedWeights)
                  .sort(([, a], [, b]) => b - a)
                  .map(([group, weight]) => (
                    <li key={group} className="flex items-center gap-3">
                      <span className="w-40 shrink-0 text-[12px]">
                        {group.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <Progress value={weight * 100} max={25} size="sm" className="flex-1" />
                      <span className="w-12 shrink-0 text-right tabular font-mono text-[12px]">
                        {(weight * 100).toFixed(1)}%
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
                {data.activeWeights.reason}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
              The engine defaults are in force. No proposal has passed validation — expected until
              enough trades resolve to prove a change helps on data it was not fitted to.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Proposal history */}
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Proposal history</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            Rejections are kept deliberately. A proposal that fitted the past and failed on unseen
            trades is the most useful thing this page records — it is the pattern that was not real.
          </p>

          {data.proposals.length === 0 ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              No proposals yet. At least 40 resolved trades are needed before weights are touched.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {data.proposals.map((proposal) => (
                <li key={proposal.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {proposal.applied ? (
                        <Badge variant="bull">
                          <Check className="size-3" /> applied
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <X className="size-3" /> rejected
                        </Badge>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {formatDate(proposal.createdAt, true)}
                      </span>
                    </div>
                    <span className="tabular font-mono text-[11px] text-muted-foreground">
                      {proposal.tradesAnalysed} fitted · {proposal.holdoutSize} holdout
                      {proposal.edge !== null &&
                        ` · edge ${Number(proposal.edge) >= 0 ? '+' : ''}${Number(proposal.edge).toFixed(3)}`}
                    </span>
                  </div>

                  {(proposal.changes ?? []).length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {proposal.changes.slice(0, 5).map((change) => (
                        <li key={change.group} className="text-[11px] text-muted-foreground">
                          {change.group.replace(/_/g, ' ').toLowerCase()}{' '}
                          {(change.baseWeight * 100).toFixed(1)}% →{' '}
                          {(change.proposedWeight * 100).toFixed(1)}%{' '}
                          <span
                            className={cn(
                              change.driftPercent >= 0 ? 'text-bull' : 'text-bear',
                            )}
                          >
                            ({change.driftPercent >= 0 ? '+' : ''}
                            {change.driftPercent.toFixed(1)}%)
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {proposal.reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">How the learning is constrained</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <li>
              · Every rate is a Beta-Binomial posterior against a 50% prior with 30 pseudo-
              observations, so a dozen trades move nothing and three hundred move a lot.
            </li>
            <li>· No weight moves more than ±35% from its base, ever.</li>
            <li>· Weights renormalise to sum to 1.0, or every probability the engine reports would shift scale.</li>
            <li>
              · Nothing applies until it beats the current weights on a chronologically held-out
              quarter of the record. Random splits leak information across time and would validate
              almost anything.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
