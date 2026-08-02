'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  AnalyticsGate,
  AnalyticsShell,
  SampleWarning,
  fmtPct,
  fmtR,
  useAnalytics,
} from '@/components/analytics/shared';
import { cn } from '@/lib/utils';

export default function StrategyPerformancePage() {
  const query = useAnalytics();

  return (
    <AnalyticsShell
      title="Strategy Performance"
      description="Each analysis method measured separately: how often it participated, how often it was right, and what it earned or cost."
    >
      <AnalyticsGate query={query}>
        {(data) => {
          const participating = data.methods.filter((m) => m.trades > 0);

          return (
            <div className="flex flex-col gap-4">
              <SampleWarning closed={data.summary.closed} />

              {participating.length === 0 ? (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[13px]">No method has participated in a closed trade yet.</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                      A method counts as participating when its factor group had a real directional
                      opinion that agreed with the trade taken. Neutral readings are excluded — if
                      every method were credited with every trade, all the reliability scores would
                      converge on the overall win rate and tell you nothing.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2 text-left font-medium">Method</th>
                            <th className="px-3 py-2 text-right font-medium">Trades</th>
                            <th className="px-3 py-2 text-right font-medium">Win rate</th>
                            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                              Profit
                            </th>
                            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                              Loss
                            </th>
                            <th className="px-3 py-2 text-right font-medium">Net</th>
                            <th className="px-3 py-2 text-right font-medium">Reliability</th>
                          </tr>
                        </thead>
                        <tbody>
                          {participating.map((method) => (
                            <tr key={method.key} className="border-b border-border last:border-0">
                              <td className="px-3 py-2.5">
                                <p className="font-medium">{method.label}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  from {method.group.replace(/_/g, ' ').toLowerCase()}
                                </p>
                              </td>
                              <td className="px-3 py-2.5 text-right tabular font-mono">
                                {method.trades}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular font-mono">
                                {fmtPct(method.winRate)}
                              </td>
                              <td className="hidden px-3 py-2.5 text-right tabular font-mono text-bull sm:table-cell">
                                +{method.profitR.toFixed(1)}R
                              </td>
                              <td className="hidden px-3 py-2.5 text-right tabular font-mono text-bear sm:table-cell">
                                −{method.lossR.toFixed(1)}R
                              </td>
                              <td
                                className={cn(
                                  'px-3 py-2.5 text-right tabular font-mono',
                                  method.netR >= 0 ? 'text-bull' : 'text-bear',
                                )}
                              >
                                {fmtR(method.netR)}
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="ml-auto flex w-24 items-center gap-2">
                                  <span className="tabular font-mono text-[12px]">
                                    {method.reliability === null
                                      ? '—'
                                      : method.reliability.toFixed(0)}
                                  </span>
                                  <Progress
                                    value={method.reliability ?? 0}
                                    size="sm"
                                    className="flex-1"
                                    indicatorClassName={
                                      (method.reliability ?? 0) >= 55 ? 'bg-bull' : 'bg-bear'
                                    }
                                  />
                                  {!method.reliable && (
                                    <Badge variant="secondary" title="Fewer than 20 trades">
                                      thin
                                    </Badge>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-4">
                  <p className="text-[13px] font-medium">Reading this table</p>
                  <ul className="mt-2 flex flex-col gap-2 text-[12px] leading-relaxed text-muted-foreground">
                    <li>
                      <strong className="text-foreground">Reliability</strong> is the win rate shrunk
                      toward 50% by sample size, so a method with three wins out of three scores in
                      the fifties rather than at 100. It converges on the raw win rate as evidence
                      accumulates.
                    </li>
                    <li>
                      <strong className="text-foreground">Thin</strong> marks fewer than 20
                      participations. Those rows are shown but should not drive any decision.
                    </li>
                    <li>
                      Several methods share a factor group — order blocks, fair value gaps and
                      liquidity sweeps all sit inside market structure — so their trade counts
                      overlap by design. They are listed separately because &ldquo;market structure
                      worked&rdquo; is far less actionable than knowing which part of it did.
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
