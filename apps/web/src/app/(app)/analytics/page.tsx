'use client';

import { Card, CardContent } from '@/components/ui/card';
import {
  AnalyticsGate,
  AnalyticsShell,
  BarRow,
  Metric,
  SampleWarning,
  fmtHours,
  fmtPct,
  fmtR,
  useAnalytics,
} from '@/components/analytics/shared';

export default function AnalyticsDashboardPage() {
  const query = useAnalytics();

  return (
    <AnalyticsShell
      title="Backtesting & Analytics"
      description="Every signal the engine has issued, evaluated against what the market actually did. Nothing here is simulated or extrapolated."
    >
      <AnalyticsGate query={query}>
        {(data) => {
          const s = data.summary;
          const maxAsset = Math.max(1, ...data.assets.map((a) => Math.abs(a.netR)));
          const maxDist = Math.max(1, ...data.distribution.map((d) => d.count));

          return (
            <div className="flex flex-col gap-4">
              <SampleWarning closed={s.closed} />

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Total signals"
                  value={String(s.totalSignals)}
                  hint={`${s.closed} closed · ${s.active} active · ${s.cancelled} cancelled`}
                />
                <Metric
                  label="Win rate"
                  value={fmtPct(s.winRate)}
                  hint={`${s.wins}W / ${s.losses}L`}
                  tone={s.winRate !== null && s.winRate >= 0.5 ? 'bull' : undefined}
                />
                <Metric
                  label="Net profit"
                  value={fmtR(s.netProfitR)}
                  hint={`+${s.totalProfitR.toFixed(1)}R gross / −${s.totalLossR.toFixed(1)}R`}
                  tone={s.netProfitR >= 0 ? 'bull' : 'bear'}
                />
                <Metric
                  label="Profit factor"
                  value={s.profitFactor === null ? '—' : s.profitFactor.toFixed(2)}
                  hint={s.profitFactor === null ? 'no losses yet to divide by' : 'gross profit ÷ gross loss'}
                  tone={s.profitFactor !== null && s.profitFactor >= 1.5 ? 'bull' : undefined}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Success rate"
                  value={fmtPct(s.successRate)}
                  hint="of all issued, including cancelled"
                />
                <Metric
                  label="Avg reward:risk"
                  value={s.averageRiskReward === null ? '—' : `${s.averageRiskReward.toFixed(2)}:1`}
                />
                <Metric
                  label="Max drawdown"
                  value={`${s.maxDrawdownR.toFixed(1)}R`}
                  hint="peak to trough"
                  tone={s.maxDrawdownR > 0 ? 'bear' : undefined}
                />
                <Metric
                  label="Avg duration"
                  value={fmtHours(s.averageDurationHours)}
                  hint="issue to resolution"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Average profit"
                  value={fmtR(s.averageProfitR)}
                  hint="per winning trade"
                  tone={s.averageProfitR !== null ? 'bull' : undefined}
                />
                <Metric
                  label="Average loss"
                  value={s.averageLossR === null ? '—' : `−${s.averageLossR.toFixed(2)}R`}
                  hint="per losing trade"
                  tone={s.averageLossR !== null ? 'bear' : undefined}
                />
                <Metric
                  label="Payoff ratio"
                  value={s.payoffRatio === null ? '—' : s.payoffRatio.toFixed(2)}
                  hint="avg win ÷ avg loss"
                />
                <Metric
                  label="Break-even win rate"
                  value={
                    s.payoffRatio === null || s.payoffRatio <= 0
                      ? '—'
                      : `${(100 / (1 + s.payoffRatio)).toFixed(0)}%`
                  }
                  hint="what this payoff requires"
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[13px] font-medium">Performance by asset</p>
                    {data.assets.length === 0 ? (
                      <p className="mt-2 text-[12px] text-muted-foreground">No closed trades yet.</p>
                    ) : (
                      <ul className="mt-3 flex flex-col gap-2">
                        {data.assets.map((asset) => (
                          <BarRow
                            key={asset.name}
                            label={asset.name}
                            sub={`${asset.trades} trades · ${fmtPct(asset.winRate)} win`}
                            value={asset.netR}
                            max={maxAsset}
                            tone={asset.netR >= 0 ? 'bull' : 'bear'}
                            right={fmtR(asset.netR)}
                          />
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <p className="text-[13px] font-medium">Win / loss distribution</p>
                    <ul className="mt-3 flex flex-col gap-2">
                      {data.distribution.map((bucket) => (
                        <BarRow
                          key={bucket.label}
                          label={bucket.label}
                          value={bucket.count}
                          max={maxDist}
                          tone={bucket.label.startsWith('−') || bucket.label.startsWith('≤') ? 'bear' : 'bull'}
                          right={String(bucket.count)}
                        />
                      ))}
                    </ul>
                    <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                      A healthy distribution has losses clustered at −1R (stops honoured) and a tail
                      of winners beyond 2R. Losses worse than −1R mean slippage or gaps through the
                      stop.
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-4">
                  <p className="text-[13px] font-medium">Performance by timeframe</p>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-2 py-2 text-left font-medium">Timeframe</th>
                          <th className="px-2 py-2 text-right font-medium">Trades</th>
                          <th className="px-2 py-2 text-right font-medium">Win rate</th>
                          <th className="px-2 py-2 text-right font-medium">Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.timeframes.map((row) => (
                          <tr key={row.name} className="border-b border-border last:border-0">
                            <td className="px-2 py-2 font-medium tabular font-mono">{row.name}</td>
                            <td className="px-2 py-2 text-right tabular font-mono">{row.trades}</td>
                            <td className="px-2 py-2 text-right tabular font-mono">
                              {fmtPct(row.winRate)}
                            </td>
                            <td
                              className={`px-2 py-2 text-right tabular font-mono ${row.netR >= 0 ? 'text-bull' : 'text-bear'}`}
                            >
                              {fmtR(row.netR)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        }}
      </AnalyticsGate>
    </AnalyticsShell>
  );
}
