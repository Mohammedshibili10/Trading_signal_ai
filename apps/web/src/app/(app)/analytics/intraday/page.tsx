'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  AnalyticsGate,
  AnalyticsShell,
  SampleWarning,
  fmtHours,
  fmtPct,
  fmtR,
  useAnalytics,
} from '@/components/analytics/shared';
import { cn } from '@/lib/utils';

const STYLE_META: Record<string, { label: string; timeframes: string; note: string }> = {
  SCALPING: {
    label: 'Scalping',
    timeframes: '1m · 3m · 5m',
    note: 'Costs dominate at this speed. A strategy needs a much higher win rate here than the R multiples suggest, because spread and slippage are paid on every trade and the moves are small.',
  },
  INTRADAY: {
    label: 'Intraday',
    timeframes: '15m · 30m · 1h',
    note: 'Positions closed the same session. Session timing matters most in this band — the same setup behaves differently at the open and at midday.',
  },
  SWING: {
    label: 'Swing',
    timeframes: '4h · 1D',
    note: 'Multi-day holds. Overnight gap risk is real and is not modelled by the stop, so realised losses can exceed −1R.',
  },
  POSITIONAL: {
    label: 'Positional',
    timeframes: '1W · 1M',
    note: 'Weeks to months. Sample sizes here grow slowly, so these numbers stay uninformative for far longer than the others.',
  },
};

export default function IntradayAnalyticsPage() {
  const query = useAnalytics();

  return (
    <AnalyticsShell
      title="Intraday Analytics"
      description="The same engine behaves differently at different speeds. Each trading style is measured on its own rather than folded into one average."
    >
      <AnalyticsGate query={query}>
        {(data) => {
          const maxTrades = Math.max(1, ...data.styles.map((s) => s.trades));

          return (
            <div className="flex flex-col gap-4">
              <SampleWarning closed={data.summary.closed} />

              <div className="grid gap-3 sm:grid-cols-2">
                {data.styles.map((style) => {
                  const meta = STYLE_META[style.style];
                  const hasTrades = style.trades > 0;

                  return (
                    <Card key={style.style}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[14px] font-medium">{meta?.label ?? style.style}</p>
                            <p className="text-[11px] text-muted-foreground">{meta?.timeframes}</p>
                          </div>
                          <div className="text-right">
                            <p
                              className={cn(
                                'text-lg font-semibold tabular',
                                !hasTrades
                                  ? 'text-muted-foreground'
                                  : style.netR >= 0
                                    ? 'text-bull'
                                    : 'text-bear',
                              )}
                            >
                              {hasTrades ? fmtR(style.netR) : '—'}
                            </p>
                            <p className="text-[11px] text-muted-foreground">net</p>
                          </div>
                        </div>

                        {hasTrades ? (
                          <>
                            <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3">
                              <Stat label="Trades" value={String(style.trades)} />
                              <Stat label="Wins" value={String(style.wins)} className="text-bull" />
                              <Stat
                                label="Losses"
                                value={String(style.losses)}
                                className="text-bear"
                              />
                              <Stat label="Win rate" value={fmtPct(style.winRate)} />
                            </div>

                            <div className="mt-3">
                              <Progress
                                value={(style.winRate ?? 0) * 100}
                                size="sm"
                                indicatorClassName={
                                  (style.winRate ?? 0) >= 0.5 ? 'bg-bull' : 'bg-bear'
                                }
                              />
                            </div>

                            <p className="mt-2 text-[11px] text-muted-foreground">
                              Average hold {fmtHours(style.averageHoldHours)} ·{' '}
                              {((style.trades / maxTrades) * 100).toFixed(0)}% of activity
                            </p>
                          </>
                        ) : (
                          <p className="mt-3 border-t border-border pt-3 text-[12px] text-muted-foreground">
                            No closed trades in this band yet.
                          </p>
                        )}

                        {meta && (
                          <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                            {meta.note}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        }}
      </AnalyticsGate>
    </AnalyticsShell>
  );
}

function Stat({
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
      <p className={cn('mt-0.5 text-[13px] font-medium tabular', className)}>{value}</p>
    </div>
  );
}
