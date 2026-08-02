'use client';

import Link from 'next/link';
import { Ban, CheckCircle2, Clock, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  AnalyticsGate,
  AnalyticsShell,
  Metric,
  SampleWarning,
  fmtPct,
  fmtR,
  useAnalytics,
} from '@/components/analytics/shared';
import { formatPrice, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const OUTCOMES = [
  { key: 'WIN', label: 'Take profit hit', icon: CheckCircle2, tone: 'text-bull' },
  { key: 'LOSS', label: 'Stop loss hit', icon: XCircle, tone: 'text-bear' },
  { key: 'ACTIVE', label: 'Still active', icon: Clock, tone: 'text-neutral-signal' },
  { key: 'CANCELLED', label: 'Cancelled before entry', icon: Ban, tone: 'text-muted-foreground' },
] as const;

export default function BacktestingPage() {
  const query = useAnalytics();

  return (
    <AnalyticsShell
      title="Backtesting"
      description="Every issued signal replayed against what the market actually did afterwards. Not a simulation over invented setups — the record of real signals resolved against real bars."
    >
      <AnalyticsGate query={query}>
        {(data) => {
          const counts = {
            WIN: data.journal.filter((r) => r.outcome === 'WIN').length,
            LOSS: data.journal.filter((r) => r.outcome === 'LOSS').length,
            ACTIVE: data.journal.filter((r) => r.outcome === 'ACTIVE').length,
            CANCELLED: data.journal.filter((r) => r.outcome === 'CANCELLED').length,
          };

          return (
            <div className="flex flex-col gap-4">
              <SampleWarning closed={data.summary.closed} />

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {OUTCOMES.map((outcome) => {
                  const Icon = outcome.icon;
                  return (
                    <Card key={outcome.key} className="p-4">
                      <div className="flex items-center gap-2">
                        <Icon className={cn('size-4', outcome.tone)} />
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {outcome.label}
                        </p>
                      </div>
                      <p className="mt-1.5 text-[22px] font-semibold leading-tight tabular">
                        {counts[outcome.key]}
                      </p>
                    </Card>
                  );
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Win rate"
                  value={fmtPct(data.summary.winRate)}
                  hint="of closed trades"
                />
                <Metric
                  label="Success rate"
                  value={fmtPct(data.summary.successRate)}
                  hint="of all issued, incl. cancelled"
                />
                <Metric
                  label="Net result"
                  value={fmtR(data.summary.netProfitR)}
                  tone={data.summary.netProfitR >= 0 ? 'bull' : 'bear'}
                />
                <Metric
                  label="Profit factor"
                  value={
                    data.summary.profitFactor === null
                      ? '—'
                      : data.summary.profitFactor.toFixed(2)
                  }
                />
              </div>

              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 text-left font-medium">Signal</th>
                          <th className="px-3 py-2 text-left font-medium">Result</th>
                          <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                            Entry → Exit
                          </th>
                          <th className="px-3 py-2 text-right font-medium">R</th>
                          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">
                            MAE / MFE
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.journal.slice(0, 60).map((row) => (
                          <tr key={row.id} className="border-b border-border last:border-0">
                            <td className="px-3 py-2.5">
                              <Link
                                href={`/markets/${row.symbol}`}
                                className="font-medium hover:underline"
                              >
                                {row.symbol}
                              </Link>
                              <p className="text-[11px] text-muted-foreground">
                                {row.action} · {row.timeframe} · {formatRelative(row.createdAt)}
                              </p>
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge
                                variant={
                                  row.outcome === 'WIN'
                                    ? 'bull'
                                    : row.outcome === 'LOSS'
                                      ? 'bear'
                                      : row.outcome === 'ACTIVE'
                                        ? 'neutral'
                                        : 'secondary'
                                }
                              >
                                {row.status.replace('HIT_T', 'T').toLowerCase()}
                              </Badge>
                            </td>
                            <td className="hidden px-3 py-2.5 text-right tabular font-mono text-[12px] text-muted-foreground sm:table-cell">
                              {formatPrice(row.entry, { withSymbol: false })}
                              {row.exit !== null &&
                                ` → ${formatPrice(row.exit, { withSymbol: false })}`}
                            </td>
                            <td
                              className={cn(
                                'px-3 py-2.5 text-right tabular font-mono',
                                row.realisedR === null
                                  ? 'text-muted-foreground'
                                  : row.realisedR >= 0
                                    ? 'text-bull'
                                    : 'text-bear',
                              )}
                            >
                              {fmtR(row.realisedR)}
                            </td>
                            <td className="hidden px-3 py-2.5 text-right tabular font-mono text-[12px] text-muted-foreground md:table-cell">
                              {row.maeR === null
                                ? '—'
                                : `${row.maeR.toFixed(2)} / ${(row.mfeR ?? 0).toFixed(2)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <p className="text-[13px] font-medium">What is and is not modelled</p>
                  <ul className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    <li>
                      · Stops are checked against actual bar lows and highs, so a bar that touches
                      both the stop and a target resolves as the stop — the pessimistic read,
                      because the optimistic one is how a backtest lies to itself.
                    </li>
                    <li>
                      · MAE and MFE are measured from the real bars between entry and resolution,
                      not inferred from the outcome.
                    </li>
                    <li>
                      · Slippage, partial fills and market impact are{' '}
                      <strong className="text-foreground">not</strong> modelled. Live results will
                      be worse than these figures, particularly on the faster timeframes.
                    </li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          );
        }}
      </AnalyticsGate>
    </AnalyticsShell>
  );
}
