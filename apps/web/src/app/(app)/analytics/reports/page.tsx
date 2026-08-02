'use client';

import { Card, CardContent } from '@/components/ui/card';
import {
  AnalyticsGate,
  AnalyticsShell,
  BarRow,
  Metric,
  SampleWarning,
  fmtPct,
  fmtR,
  useAnalytics,
  type AnalyticsData,
} from '@/components/analytics/shared';
import { cn } from '@/lib/utils';

export default function ReportsPage() {
  const query = useAnalytics();

  return (
    <AnalyticsShell
      title="Reports"
      description="Roll-ups by period, the equity curve in R, and comparisons across assets and timeframes."
    >
      <AnalyticsGate query={query}>
        {(data) => (
          <div className="flex flex-col gap-4">
            <SampleWarning closed={data.summary.closed} />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.periods.map((period) => (
                <Metric
                  key={period.key}
                  label={period.label}
                  value={period.trades === 0 ? '—' : fmtR(period.netR)}
                  hint={
                    period.trades === 0
                      ? 'no closed trades'
                      : `${period.trades} trades · ${fmtPct(period.winRate)} win`
                  }
                  tone={period.trades === 0 ? undefined : period.netR >= 0 ? 'bull' : 'bear'}
                />
              ))}
            </div>

            <EquityCurve data={data} />

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4">
                  <p className="text-[13px] font-medium">By asset</p>
                  {data.assets.length === 0 ? (
                    <p className="mt-2 text-[12px] text-muted-foreground">No closed trades yet.</p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {data.assets.map((asset) => (
                        <BarRow
                          key={asset.name}
                          label={asset.name}
                          sub={`${asset.trades} trades`}
                          value={asset.netR}
                          max={Math.max(1, ...data.assets.map((a) => Math.abs(a.netR)))}
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
                  <p className="text-[13px] font-medium">By timeframe</p>
                  {data.timeframes.length === 0 ? (
                    <p className="mt-2 text-[12px] text-muted-foreground">No closed trades yet.</p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {data.timeframes.map((row) => (
                        <BarRow
                          key={row.name}
                          label={row.name}
                          sub={`${row.trades} trades · ${fmtPct(row.winRate)} win`}
                          value={row.netR}
                          max={Math.max(1, ...data.timeframes.map((r) => Math.abs(r.netR)))}
                          tone={row.netR >= 0 ? 'bull' : 'bear'}
                          right={fmtR(row.netR)}
                        />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </AnalyticsGate>
    </AnalyticsShell>
  );
}

/**
 * Cumulative R over time, drawn as an SVG polyline.
 *
 * In R rather than currency because R is position-size independent — it
 * describes the strategy, and a currency curve would mostly describe how much
 * capital happened to be allocated.
 */
function EquityCurve({ data }: { data: AnalyticsData }) {
  const points = data.equityCurve;

  if (points.length < 2) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Equity curve</p>
          <p className="mt-2 text-[12px] text-muted-foreground">
            At least two closed trades are needed to draw a curve.
          </p>
        </CardContent>
      </Card>
    );
  }

  const width = 900;
  const height = 220;
  const pad = 24;

  const equities = points.map((p) => p.equity);
  const min = Math.min(0, ...equities);
  const max = Math.max(0, ...equities);
  const span = max - min || 1;

  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${x(i)},${y(p.equity)}`).join(' ');
  const area = `${pad},${y(0)} ${line} ${x(points.length - 1)},${y(0)}`;
  const final = equities[equities.length - 1];
  const positive = final >= 0;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[13px] font-medium">Equity curve</p>
          <span
            className={cn('tabular font-mono text-[13px]', positive ? 'text-bull' : 'text-bear')}
          >
            {fmtR(final)} over {points.length} trades
          </span>
        </div>

        <div className="mt-3 overflow-x-auto">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[220px] w-full min-w-[560px]"
            preserveAspectRatio="none"
          >
            {/* Break-even line — the only reference that matters. */}
            <line
              x1={pad}
              x2={width - pad}
              y1={y(0)}
              y2={y(0)}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="4 4"
            />
            <polygon
              points={area}
              className={positive ? 'fill-bull/10' : 'fill-bear/10'}
            />
            <polyline
              points={line}
              fill="none"
              strokeWidth="2"
              className={positive ? 'stroke-bull' : 'stroke-bear'}
            />
          </svg>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Measured in R, not currency — R is independent of position size, so the curve describes
          the strategy rather than how much capital happened to be allocated. Max drawdown{' '}
          {data.summary.maxDrawdownR.toFixed(1)}R.
        </p>
      </CardContent>
    </Card>
  );
}
