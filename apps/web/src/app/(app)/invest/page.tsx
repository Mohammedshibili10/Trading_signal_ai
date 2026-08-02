'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PiggyBank, Plus, Target, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsListUnderline, TabsTriggerUnderline } from '@/components/ui/tabs';
import { EmptyState, Private, StatCard } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { DEFAULT_INFLATION, RETURN_ASSUMPTIONS } from '@/lib/constants';
import { formatCompactINR, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { GoalPlan, SipProjection } from '@/types';

export default function InvestPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Invest</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          SIP projections, goal planning and retirement maths — in rupees, with inflation taken
          seriously.
        </p>
      </div>

      <Tabs defaultValue="sip">
        <TabsListUnderline>
          <TabsTriggerUnderline value="sip">SIP calculator</TabsTriggerUnderline>
          <TabsTriggerUnderline value="goals">Goals</TabsTriggerUnderline>
          <TabsTriggerUnderline value="retirement">Retirement</TabsTriggerUnderline>
        </TabsListUnderline>

        <TabsContent value="sip">
          <SipCalculator />
        </TabsContent>
        <TabsContent value="goals">
          <Goals />
        </TabsContent>
        <TabsContent value="retirement">
          <Retirement />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── SIP ──────────────────────────────────────────────────────── */

function SipCalculator() {
  const [monthly, setMonthly] = useState(10000);
  const [years, setYears] = useState(15);
  const [returnRate, setReturnRate] = useState(12);
  const [stepUp, setStepUp] = useState(0);

  const projection = useQuery({
    queryKey: ['sip', monthly, years, returnRate, stepUp],
    queryFn: async () =>
      (
        await endpoints.invest.sip({
          monthlyAmount: monthly,
          years,
          expectedReturn: returnRate,
          stepUpPercent: stepUp,
          inflationRate: DEFAULT_INFLATION,
        })
      ).data as SipProjection,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const data = projection.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card>
        <CardContent className="flex flex-col gap-5 p-4">
          <SliderField
            label="Monthly investment"
            value={monthly}
            display={formatCompactINR(monthly)}
            min={500}
            max={200000}
            step={500}
            onChange={setMonthly}
          />
          <SliderField
            label="Duration"
            value={years}
            display={`${years} years`}
            min={1}
            max={40}
            step={1}
            onChange={setYears}
          />

          <div className="flex flex-col gap-1.5">
            <Label>Expected return</Label>
            <Select
              value={String(returnRate)}
              onValueChange={(value) => setReturnRate(Number(value))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETURN_ASSUMPTIONS.map((assumption) => (
                  <SelectItem key={assumption.key} value={String(assumption.rate)}>
                    {assumption.label} — {assumption.rate}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <SliderField
            label="Annual step-up"
            value={stepUp}
            display={stepUp === 0 ? 'None' : `${stepUp}% a year`}
            min={0}
            max={25}
            step={1}
            onChange={setStepUp}
          />

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Returns are assumptions, not forecasts. A 12% long-run equity number is a historical
            average across decades — no individual 15-year window is obliged to deliver it.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {projection.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : projection.isError ? (
          <EmptyState
            title="Calculator unavailable"
            description={(projection.error as Error)?.message ?? 'The analysis service is not reachable.'}
          />
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard
                label="Estimated value"
                value={<Private>{formatCompactINR(data.estimatedValue)}</Private>}
                hint={`after ${years} years`}
              />
              <StatCard
                label="You invest"
                value={<Private>{formatCompactINR(data.totalInvested)}</Private>}
              />
              <StatCard
                label="Wealth gain"
                value={<Private>{formatCompactINR(data.wealthGain)}</Private>}
                hint={`${((data.wealthGain / Math.max(1, data.totalInvested)) * 100).toFixed(0)}% over cost`}
              />
              <StatCard
                label="In today's money"
                value={<Private>{formatCompactINR(data.inflationAdjustedValue)}</Private>}
                hint={`at ${DEFAULT_INFLATION}% inflation`}
              />
            </div>

            <Card>
              <CardContent className="p-4">
                <p className="text-[13px] font-medium">Growth</p>
                <ul className="mt-3 flex flex-col gap-2">
                  {data.schedule
                    .filter((_, index, array) =>
                      // Every year is noise past ten; show a readable ladder.
                      array.length <= 12 ? true : index % Math.ceil(array.length / 10) === 0 || index === array.length - 1,
                    )
                    .map((row) => (
                      <li key={row.year} className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[12px] text-muted-foreground">
                          Yr {row.year}
                        </span>
                        <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted">
                          <div
                            className="absolute inset-y-0 left-0 bg-chart-1/25"
                            style={{ width: `${(row.value / data.estimatedValue) * 100}%` }}
                          />
                          <div
                            className="absolute inset-y-0 left-0 bg-chart-1/60"
                            style={{ width: `${(row.invested / data.estimatedValue) * 100}%` }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-right tabular font-mono text-[12px]">
                          <Private>{formatCompactINR(row.value)}</Private>
                        </span>
                      </li>
                    ))}
                </ul>
                <div className="mt-3 flex gap-4 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-chart-1/60" /> Invested
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-chart-1/25" /> Returns
                  </span>
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ── Goals ────────────────────────────────────────────────────── */

interface GoalRow {
  id: string;
  name: string;
  targetAmount: string | number;
  currentSavings: string | number;
  years: number;
  expectedReturn: string | number;
  plan: GoalPlan | null;
}

function Goals() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [savings, setSavings] = useState('');
  const [years, setYears] = useState('10');

  const goals = useQuery({
    queryKey: ['goals'],
    queryFn: async () => (await endpoints.invest.goals()).data as GoalRow[],
  });

  const create = useMutation({
    mutationFn: () =>
      endpoints.invest.createGoal({
        name,
        targetAmount: Number(target),
        currentSavings: Number(savings || 0),
        years: Number(years),
        expectedReturn: 12,
        inflationRate: DEFAULT_INFLATION,
      }),
    onSuccess: () => {
      toast.success('Goal created');
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      setName('');
      setTarget('');
      setSavings('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => endpoints.invest.deleteGoal(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goals'] }),
    onError: (error: Error) => toast.error(error.message),
  });

  const valid = name.trim().length > 0 && Number(target) >= 1000 && Number(years) >= 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">New goal</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-name">Goal</Label>
              <Input
                id="goal-name"
                placeholder="House down payment"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-target">Target (₹)</Label>
              <Input
                id="goal-target"
                type="number"
                min="1000"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-savings">Already saved (₹)</Label>
              <Input
                id="goal-savings"
                type="number"
                min="0"
                value={savings}
                onChange={(event) => setSavings(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-years">Years</Label>
              <Input
                id="goal-years"
                type="number"
                min="1"
                max="50"
                value={years}
                onChange={(event) => setYears(event.target.value)}
              />
            </div>
          </div>
          <Button
            size="sm"
            className="mt-3"
            disabled={!valid}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus /> Add goal
          </Button>
        </CardContent>
      </Card>

      {goals.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (goals.data ?? []).length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="A goal turns an amount and a deadline into the monthly number you actually need — adjusted for what that amount will be worth by then."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {goals.data!.map((goal) => {
            const plan = goal.plan;
            const progress =
              (Number(goal.currentSavings) / Math.max(1, Number(goal.targetAmount))) * 100;

            return (
              <Card key={goal.id} className="group">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium">{goal.name}</p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        <Private>{formatCompactINR(Number(goal.targetAmount))}</Private> in{' '}
                        {goal.years} years
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {plan && (
                        <Badge variant={plan.onTrack ? 'bull' : 'neutral'}>
                          {plan.onTrack ? 'on track' : 'short'}
                        </Badge>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => remove.mutate(goal.id)}
                        aria-label={`Delete ${goal.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  <Progress value={Math.min(100, progress)} className="mt-3" />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {progress.toFixed(0)}% funded
                  </p>

                  {plan && (
                    <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Monthly needed
                        </p>
                        <p className="mt-0.5 text-[14px] font-medium tabular">
                          <Private>{formatCompactINR(plan.requiredMonthly)}</Private>
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Inflation-adjusted target
                        </p>
                        <p className="mt-0.5 text-[14px] font-medium tabular">
                          <Private>{formatCompactINR(plan.inflationAdjustedTarget)}</Private>
                        </p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Retirement ───────────────────────────────────────────────── */

interface RetirementResult {
  corpusRequired: number;
  currentCorpusFutureValue: number;
  gap: number;
  monthlySipRequired: number;
  yearsToRetirement: number;
  monthlyExpensesAtRetirement: number;
  summary?: string;
}

function Retirement() {
  const [currentAge, setCurrentAge] = useState(30);
  const [retirementAge, setRetirementAge] = useState(60);
  const [expenses, setExpenses] = useState(50000);
  const [corpus, setCorpus] = useState(0);

  const result = useQuery({
    queryKey: ['retirement', currentAge, retirementAge, expenses, corpus],
    queryFn: async () =>
      (
        await endpoints.invest.retirement({
          currentAge,
          retirementAge,
          monthlyExpenses: expenses,
          currentCorpus: corpus,
          inflationRate: DEFAULT_INFLATION,
        })
      ).data as RetirementResult,
    enabled: retirementAge > currentAge,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card>
        <CardContent className="flex flex-col gap-5 p-4">
          <SliderField
            label="Current age"
            value={currentAge}
            display={`${currentAge}`}
            min={18}
            max={70}
            step={1}
            onChange={setCurrentAge}
          />
          <SliderField
            label="Retirement age"
            value={retirementAge}
            display={`${retirementAge}`}
            min={Math.max(currentAge + 1, 40)}
            max={75}
            step={1}
            onChange={setRetirementAge}
          />
          <SliderField
            label="Monthly expenses today"
            value={expenses}
            display={formatCompactINR(expenses)}
            min={10000}
            max={500000}
            step={5000}
            onChange={setExpenses}
          />
          <SliderField
            label="Corpus already saved"
            value={corpus}
            display={formatCompactINR(corpus)}
            min={0}
            max={50000000}
            step={100000}
            onChange={setCorpus}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {result.isLoading ? (
          <Skeleton className="h-56 w-full rounded-xl" />
        ) : result.isError ? (
          <EmptyState
            title="Calculator unavailable"
            description={(result.error as Error)?.message ?? 'The analysis service is not reachable.'}
          />
        ) : result.data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard
                label="Corpus required"
                value={<Private>{formatCompactINR(result.data.corpusRequired)}</Private>}
                hint={`in ${result.data.yearsToRetirement} years`}
              />
              <StatCard
                label="Monthly SIP needed"
                value={<Private>{formatCompactINR(result.data.monthlySipRequired)}</Private>}
              />
              <StatCard
                label="Expenses at retirement"
                value={<Private>{formatCompactINR(result.data.monthlyExpensesAtRetirement)}</Private>}
                hint="per month, in future rupees"
              />
              <StatCard
                label="Gap"
                value={<Private>{formatCompactINR(result.data.gap)}</Private>}
              />
            </div>

            <Card>
              <CardContent className="p-4">
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  {result.data.summary ??
                    `At ${DEFAULT_INFLATION}% inflation, ${formatCompactINR(expenses)} a month today becomes ${formatCompactINR(result.data.monthlyExpensesAtRetirement)} a month by the time you retire. That multiple — not the returns — is what makes starting early matter.`}
                </p>
              </CardContent>
            </Card>
          </>
        ) : (
          <EmptyState
            icon={PiggyBank}
            title="Set an age range"
            description="Retirement age must be later than your current age."
          />
        )}
      </div>
    </div>
  );
}

/* ── Shared ───────────────────────────────────────────────────── */

function SliderField({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  className,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        <span className="tabular font-mono text-[13px] font-medium">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  );
}
