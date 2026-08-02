'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Calculator, Shield, TrendingDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsListUnderline, TabsTriggerUnderline } from '@/components/ui/tabs';
import { EmptyState, Private, StatCard } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { RISK_DEFAULTS } from '@/lib/constants';
import { formatCompactINR, formatNumber, formatPercent, formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setCapital, setRiskPerTrade, tradingHalted } from '@/store/slices/risk-slice';
import type { MonteCarloResult, PortfolioRisk, PositionSizeResult } from '@/types';

export default function RiskPage() {
  const risk = useAppSelector((state) => state.risk);
  const halt = tradingHalted(risk);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Risk</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Position sizing, exposure and the distribution of outcomes. Sizing is the only part of a
          trade you fully control.
        </p>
      </div>

      {halt.halted && (
        <Card className="border-bear/40 bg-bear/5">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bear" />
            <div>
              <p className="text-[13px] font-medium text-bear">Trading halted</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{halt.reason}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="size">
        <TabsListUnderline>
          <TabsTriggerUnderline value="size">Position size</TabsTriggerUnderline>
          <TabsTriggerUnderline value="limits">Limits</TabsTriggerUnderline>
          <TabsTriggerUnderline value="portfolio">Portfolio risk</TabsTriggerUnderline>
          <TabsTriggerUnderline value="montecarlo">Monte Carlo</TabsTriggerUnderline>
        </TabsListUnderline>

        <TabsContent value="size">
          <PositionSizer />
        </TabsContent>
        <TabsContent value="limits">
          <Limits />
        </TabsContent>
        <TabsContent value="portfolio">
          <PortfolioRiskPanel />
        </TabsContent>
        <TabsContent value="montecarlo">
          <MonteCarloPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── Position sizing ──────────────────────────────────────────── */

function PositionSizer() {
  const risk = useAppSelector((state) => state.risk);

  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [capital, setCapitalInput] = useState(String(risk.capital));
  const [riskPercent, setRiskPercentInput] = useState(String(risk.riskPerTradePercent));
  const [lotSize, setLotSize] = useState('');

  const calculate = useMutation({
    mutationFn: async () =>
      (
        await endpoints.risk.positionSize({
          capital: Number(capital),
          riskPercent: Number(riskPercent),
          entry: Number(entry),
          stopLoss: Number(stop),
          ...(target ? { target: Number(target) } : {}),
          ...(lotSize ? { lotSize: Number(lotSize) } : {}),
        })
      ).data as PositionSizeResult,
  });

  const valid =
    Number(entry) > 0 &&
    Number(stop) > 0 &&
    Number(entry) !== Number(stop) &&
    Number(capital) > 0 &&
    Number(riskPercent) > 0;

  const result = calculate.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Capital" value={capital} onChange={setCapitalInput} prefix="₹" />
            <Field label="Risk %" value={riskPercent} onChange={setRiskPercentInput} suffix="%" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Entry" value={entry} onChange={setEntry} />
            <Field label="Stop loss" value={stop} onChange={setStop} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Target (optional)" value={target} onChange={setTarget} />
            <Field label="Lot size (F&O)" value={lotSize} onChange={setLotSize} />
          </div>

          <Button
            onClick={() => calculate.mutate()}
            disabled={!valid}
            loading={calculate.isPending}
            className="mt-1"
          >
            <Calculator /> Calculate
          </Button>

          {calculate.isError && (
            <p className="text-[12px] text-bear">{(calculate.error as Error).message}</p>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Size follows from the stop, not the other way round. A wider stop means a smaller
            position for the same rupee risk — that is the whole mechanism.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          {!result ? (
            <EmptyState
              icon={Shield}
              title="No calculation yet"
              description="Enter an entry and a stop to size the position against your risk budget."
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Position size
                </p>
                <p className="mt-1 text-3xl font-semibold tabular">
                  {formatNumber(result.quantity, 0)}
                  <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">
                    units
                  </span>
                </p>
                {result.lots ? (
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {result.lots} lot{result.lots === 1 ? '' : 's'}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                <Metric label="Position value" value={<Private>{formatCompactINR(result.positionValue)}</Private>} />
                <Metric label="% of capital" value={formatPercent(result.positionPercentOfCapital, { signed: false })} />
                <Metric
                  label="Risk amount"
                  value={<Private>{formatCompactINR(result.riskAmount)}</Private>}
                  className="text-bear"
                />
                <Metric label="Risk per unit" value={formatPrice(result.riskPerUnit)} />
                {result.rewardAtTarget !== null && result.rewardAtTarget !== undefined && (
                  <Metric
                    label="Reward at target"
                    value={<Private>{formatCompactINR(result.rewardAtTarget)}</Private>}
                    className="text-bull"
                  />
                )}
                {result.riskRewardRatio !== null && result.riskRewardRatio !== undefined && (
                  <Metric
                    label="Reward : risk"
                    value={`${result.riskRewardRatio.toFixed(2)}:1`}
                    className={result.riskRewardRatio >= RISK_DEFAULTS.minRiskReward ? 'text-bull' : 'text-neutral-signal'}
                  />
                )}
              </div>

              {result.warnings.length > 0 && (
                <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
                  {result.warnings.map((warning) => (
                    <li key={warning} className="flex gap-2 text-[12px] text-neutral-signal">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Limits ───────────────────────────────────────────────────── */

function Limits() {
  const dispatch = useAppDispatch();
  const risk = useAppSelector((state) => state.risk);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Today"
          value={formatPercent(risk.realisedTodayPercent)}
          hint={`Limit ${risk.dailyLossLimitPercent}%`}
        />
        <StatCard
          label="This week"
          value={formatPercent(risk.realisedWeekPercent)}
          hint={`Limit ${risk.weeklyLossLimitPercent}%`}
        />
        <StatCard
          label="Drawdown"
          value={formatPercent(-Math.abs(risk.currentDrawdownPercent), { signed: false })}
          hint={`Limit ${risk.maxDrawdownPercent}%`}
        />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-6 p-4">
          <div>
            <div className="flex items-baseline justify-between">
              <Label>Capital</Label>
              <span className="tabular font-mono text-[13px]">
                <Private>{formatCompactINR(risk.capital)}</Private>
              </span>
            </div>
            <Input
              type="number"
              min="0"
              step="1000"
              value={risk.capital}
              onChange={(event) => dispatch(setCapital(Number(event.target.value)))}
              className="mt-2"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <Label>Risk per trade</Label>
              <span className="tabular font-mono text-[13px]">
                {risk.riskPerTradePercent.toFixed(2)}% ·{' '}
                <Private>
                  {formatCompactINR((risk.capital * risk.riskPerTradePercent) / 100)}
                </Private>
              </span>
            </div>
            <Slider
              value={[risk.riskPerTradePercent]}
              min={0.1}
              max={5}
              step={0.1}
              onValueChange={([value]) => dispatch(setRiskPerTrade(value))}
              className="mt-3"
            />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Capped at 5%. Above 2% a run of six losers — entirely normal at a 55% win rate —
              takes a third of the account.
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[13px] font-medium">Why these exist</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Loss limits are decided before the day starts, when the decision is cheap. The
              purpose is to stop the third revenge trade, not the first loss — and that decision
              cannot be made well at the moment it is needed.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Portfolio risk ───────────────────────────────────────────── */

function PortfolioRiskPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['portfolio-risk'],
    queryFn: async () => (await endpoints.portfolio.risk()).data as PortfolioRisk,
    retry: false,
    staleTime: 60_000,
  });

  if (isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Portfolio risk unavailable"
        description={(error as Error)?.message ?? 'Add holdings to see exposure and VaR.'}
      />
    );
  }

  if (!data || data.portfolioValue <= 0) {
    return (
      <EmptyState
        icon={Shield}
        title="No portfolio to measure"
        description="Record holdings and this shows VaR, concentration, correlation warnings and sector exposure."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="1-day VaR (95%)"
          value={<Private>{formatCompactINR(data.valueAtRisk95)}</Private>}
          hint="Exceeded about one day in twenty"
        />
        <StatCard label="Annual volatility" value={formatPercent(data.volatilityAnnual, { signed: false })} />
        <StatCard label="Sharpe" value={data.sharpe === null ? '—' : data.sharpe.toFixed(2)} />
        <StatCard
          label="Max drawdown"
          value={formatPercent(-Math.abs(data.maxDrawdown), { signed: false })}
        />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-[13px] font-medium">Diversification</p>
              <span className="tabular font-mono text-[13px]">{data.diversificationScore.toFixed(0)}/100</span>
            </div>
            <Progress
              value={data.diversificationScore}
              className="mt-2"
              indicatorClassName={
                data.diversificationScore >= 60
                  ? 'bg-bull'
                  : data.diversificationScore >= 35
                    ? 'bg-neutral-signal'
                    : 'bg-bear'
              }
            />
          </div>

          {data.sectorExposure.length > 0 && (
            <div className="border-t border-border pt-3">
              <p className="text-[13px] font-medium">Sector exposure</p>
              <ul className="mt-2 flex flex-col gap-2">
                {data.sectorExposure.slice(0, 8).map((row) => (
                  <li key={row.sector} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-[12px]">{row.sector}</span>
                    <Progress value={row.percent} size="sm" className="w-24" />
                    <span className="w-12 shrink-0 text-right tabular font-mono text-[12px]">
                      {row.percent.toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.correlationWarnings.length > 0 && (
            <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
              {data.correlationWarnings.map((warning) => (
                <li key={warning} className="flex gap-2 text-[12px] text-neutral-signal">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {warning}
                </li>
              ))}
            </ul>
          )}

          {data.recommendations.length > 0 && (
            <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
              {data.recommendations.map((item) => (
                <li key={item} className="text-[12px] text-muted-foreground">
                  · {item}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Monte Carlo ──────────────────────────────────────────────── */

function MonteCarloPanel() {
  const risk = useAppSelector((state) => state.risk);

  const [winRate, setWinRate] = useState('55');
  const [averageWin, setAverageWin] = useState('2');
  const [averageLoss, setAverageLoss] = useState('1');
  const [trades, setTrades] = useState('100');

  /**
   * A synthetic trade series from the user's stated edge.
   *
   * Simulating from win rate and payoff rather than asking for a trade log
   * means the tool answers the question people actually have — "is this edge
   * survivable?" — before they have a hundred trades to analyse.
   */
  const tradeReturns = useMemo(() => {
    const count = 200;
    const wins = Math.round((Number(winRate) / 100) * count);
    const winSize = (Number(averageWin) * risk.riskPerTradePercent) / 100;
    const lossSize = (Number(averageLoss) * risk.riskPerTradePercent) / 100;

    return Array.from({ length: count }, (_, index) => (index < wins ? winSize : -lossSize));
  }, [winRate, averageWin, averageLoss, risk.riskPerTradePercent]);

  const run = useMutation({
    mutationFn: async () =>
      (
        await endpoints.risk.monteCarlo({
          tradeReturns,
          startingCapital: risk.capital,
          simulations: 2000,
          horizon: Number(trades),
        })
      ).data as MonteCarloResult,
  });

  const result = run.data;
  const expectancy =
    (Number(winRate) / 100) * Number(averageWin) - (1 - Number(winRate) / 100) * Number(averageLoss);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Win rate %" value={winRate} onChange={setWinRate} />
            <Field label="Avg win (R)" value={averageWin} onChange={setAverageWin} />
            <Field label="Avg loss (R)" value={averageLoss} onChange={setAverageLoss} />
            <Field label="Trades" value={trades} onChange={setTrades} />
          </div>

          <div
            className={cn(
              'rounded-lg border p-3 text-[12px]',
              expectancy > 0 ? 'border-bull/30 bg-bull/5' : 'border-bear/30 bg-bear/5',
            )}
          >
            Expectancy{' '}
            <span className="tabular font-mono font-medium">
              {expectancy > 0 ? '+' : ''}
              {expectancy.toFixed(3)}R
            </span>{' '}
            per trade.{' '}
            {expectancy > 0
              ? 'Positive — the question is whether the drawdowns along the way are survivable.'
              : 'Negative — no position size makes this profitable. Fix the edge first.'}
          </div>

          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={Number(trades) < 5}>
            <TrendingDown /> Run 2,000 simulations
          </Button>

          {run.isError && <p className="text-[12px] text-bear">{(run.error as Error).message}</p>}
        </CardContent>
      </Card>

      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Median outcome"
              value={<Private>{formatCompactINR(result.percentiles.p50)}</Private>}
            />
            <StatCard
              label="Probability of profit"
              value={formatPercent(result.probabilityOfProfit * 100, { signed: false })}
            />
            <StatCard
              label="Probability of ruin"
              value={formatPercent(result.probabilityOfRuin * 100, { signed: false })}
            />
            <StatCard
              label="Median max drawdown"
              value={formatPercent(-Math.abs(result.medianMaxDrawdown * 100), { signed: false })}
            />
          </div>

          <Card>
            <CardContent className="p-4">
              <p className="text-[13px] font-medium">Outcome distribution</p>
              <ul className="mt-3 flex flex-col gap-2">
                {(
                  [
                    ['Worst 5%', result.percentiles.p5],
                    ['25th', result.percentiles.p25],
                    ['Median', result.percentiles.p50],
                    ['75th', result.percentiles.p75],
                    ['Best 5%', result.percentiles.p95],
                  ] as const
                ).map(([label, value]) => (
                  <li key={label} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{label}</span>
                    <Progress
                      value={Math.max(0, (value / result.percentiles.p95) * 100)}
                      size="sm"
                      className="flex-1"
                      indicatorClassName={value >= result.startingCapital ? 'bg-bull' : 'bg-bear'}
                    />
                    <span className="w-20 shrink-0 text-right tabular font-mono text-[12px]">
                      <Private>{formatCompactINR(value)}</Private>
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-4 border-t border-border pt-3 text-[12px] leading-relaxed text-muted-foreground">
                {result.summary}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                The spread is the point, not the median. Two systems with identical expectancy can
                have entirely different worst cases, and the worst case is what decides whether you
                are still trading the system when it works.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/* ── Shared bits ──────────────────────────────────────────────── */

function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          type="number"
          step="any"
          min="0"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(prefix && 'pl-6', suffix && 'pr-7')}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[14px] font-medium tabular', className)}>{value}</p>
    </div>
  );
}
