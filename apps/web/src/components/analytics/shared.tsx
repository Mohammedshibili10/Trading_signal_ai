'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { cn } from '@/lib/utils';

/* ── Shapes ───────────────────────────────────────────────────── */

export interface AnalyticsSummary {
  totalSignals: number;
  closed: number;
  wins: number;
  losses: number;
  active: number;
  cancelled: number;
  winRate: number | null;
  successRate: number | null;
  averageRiskReward: number | null;
  totalProfitR: number;
  totalLossR: number;
  averageProfitR: number | null;
  averageLossR: number | null;
  payoffRatio: number | null;
  netProfitR: number;
  maxDrawdownR: number;
  profitFactor: number | null;
  averageDurationHours: number | null;
  meaningful: boolean;
}

export interface MethodRow {
  key: string;
  label: string;
  group: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitR: number;
  lossR: number;
  netR: number;
  reliability: number | null;
  reliable: boolean;
}

export interface StyleRow {
  style: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netR: number;
  averageHoldHours: number | null;
}

export interface GroupRow {
  name: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netR: number;
}

export interface JournalRow {
  id: string;
  symbol: string;
  assetClass: string;
  timeframe: string;
  action: string;
  status: string;
  // 'LOSS' means the stop was hit. Cancelled and invalid are separate
  // outcomes precisely so neither is ever reported as a loss.
  outcome: 'WIN' | 'LOSS' | 'ACTIVE' | 'CANCELLED' | 'INVALID' | 'EXPIRED';
  statusLabel: string;
  lifecycle: 'ACTIVE' | 'UPDATED' | 'CLOSED' | 'CANCELLED' | 'ARCHIVED';
  invalidationReason: string | null;
  confidence: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  exit: number | null;
  realisedR: number | null;
  returnPercent: number | null;
  riskReward: number | null;
  maeR: number | null;
  mfeR: number | null;
  captureRatio: number | null;
  barsHeld: number | null;
  holdingHours: number | null;
  primaryReason: string | null;
  analysis: string | null;
  causes: Array<{ reason: string; detail: string }>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AnalyticsData {
  summary: AnalyticsSummary;
  methods: MethodRow[];
  styles: StyleRow[];
  assets: GroupRow[];
  timeframes: GroupRow[];
  equityCurve: Array<{ time: string; symbol: string; r: number; equity: number; drawdown: number }>;
  distribution: Array<{ label: string; count: number }>;
  periods: Array<{
    key: string;
    label: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netR: number;
  }>;
  journal: JournalRow[];
}

/* ── Data ─────────────────────────────────────────────────────── */

/**
 * One query, shared by every subsection.
 *
 * All nine pages read from the same payload, so TanStack Query's cache means
 * navigating between them costs nothing after the first load.
 */
export function useAnalytics() {
  return useQuery({
    queryKey: ['analytics'],
    queryFn: async () => (await endpoints.performance.analytics()).data as AnalyticsData,
    refetchInterval: 2 * 60_000,
    retry: false,
  });
}

/* ── Chrome ───────────────────────────────────────────────────── */

export function AnalyticsShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * The state every one of these pages starts in.
 *
 * Rendered as an explanation rather than an error, because "no trades yet" is
 * the correct and expected state on a fresh install — and a page that looks
 * broken when it is merely empty teaches people to distrust it.
 */
export function AnalyticsGate({
  query,
  children,
}: {
  query: ReturnType<typeof useAnalytics>;
  children: (data: AnalyticsData) => React.ReactNode;
}) {
  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Analytics unavailable"
        description={(query.error as Error)?.message ?? 'Could not load the trade record.'}
      />
    );
  }

  const data = query.data;
  if (!data || data.summary.totalSignals === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No signals issued yet"
        description="The scanner runs every five minutes and issues a signal only when the multi-timeframe gate, the six-condition checklist and the confidence floor all pass. As soon as one resolves, it is backtested automatically and appears here."
      />
    );
  }

  return <>{children(data)}</>;
}

/** Shown above any aggregate computed from too few trades to mean anything. */
export function SampleWarning({ closed }: { closed: number }) {
  if (closed >= 40) return null;
  return (
    <Card className="border-neutral-signal/30 bg-neutral-signal/5">
      <CardContent className="flex items-start gap-2.5 p-3.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-neutral-signal" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {closed} closed trade{closed === 1 ? '' : 's'}. Below roughly 40, every figure on this
          page is dominated by sample size rather than by the strategy — a 70% win rate over ten
          trades and a 40% win rate over ten trades are the same evidence. The numbers are shown
          because hiding them would be worse, not because they are yet informative.
        </p>
      </CardContent>
    </Card>
  );
}

/* ── Small display pieces ─────────────────────────────────────── */

export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'bull' | 'bear' | 'neutral';
}) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-1.5 text-[22px] font-semibold leading-tight tabular',
          tone === 'bull' && 'text-bull',
          tone === 'bear' && 'text-bear',
          tone === 'neutral' && 'text-neutral-signal',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** A ranked bar row — used by every breakdown table on these pages. */
export function BarRow({
  label,
  value,
  max,
  right,
  tone,
  sub,
}: {
  label: string;
  value: number;
  max: number;
  right: string;
  tone?: 'bull' | 'bear' | 'neutral';
  sub?: string;
}) {
  return (
    <li className="flex items-center gap-3">
      <div className="w-40 shrink-0">
        <p className="truncate text-[12px]">{label}</p>
        {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      <Progress
        value={max > 0 ? (Math.abs(value) / max) * 100 : 0}
        size="sm"
        className="flex-1"
        indicatorClassName={
          tone === 'bull' ? 'bg-bull' : tone === 'bear' ? 'bg-bear' : 'bg-neutral-signal'
        }
      />
      <span className="w-20 shrink-0 text-right tabular font-mono text-[12px]">{right}</span>
    </li>
  );
}

export const fmtR = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;

export const fmtPct = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(0)}%`;

export const fmtHours = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '—';
  if (value < 24) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
};
