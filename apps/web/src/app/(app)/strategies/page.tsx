'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, Plus, Trash2, Wrench, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, Private, StatCard } from '@/components/market/primitives';
import { SymbolSearch } from '@/components/market/symbol-search';
import { endpoints } from '@/lib/api';
import { formatCompactINR, formatDate, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BacktestResult, ConditionOperator, StrategyCondition } from '@/types';

/** What the no-code builder can express. Each maps to an engine primitive. */
const INDICATORS = [
  { value: 'RSI', label: 'RSI', defaultParams: { period: 14 }, defaultValue: 30 },
  { value: 'EMA', label: 'EMA', defaultParams: { period: 20 }, defaultValue: 'PRICE' },
  { value: 'SMA', label: 'SMA', defaultParams: { period: 50 }, defaultValue: 'PRICE' },
  { value: 'MACD', label: 'MACD', defaultParams: {}, defaultValue: 0 },
  { value: 'PRICE', label: 'Price', defaultParams: {}, defaultValue: 'EMA:20' },
  { value: 'VOLUME', label: 'Volume ratio', defaultParams: {}, defaultValue: 1.5 },
  { value: 'ADX', label: 'ADX', defaultParams: { period: 14 }, defaultValue: 25 },
] as const;

const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: 'GT', label: 'is above' },
  { value: 'LT', label: 'is below' },
  { value: 'CROSSES_ABOVE', label: 'crosses above' },
  { value: 'CROSSES_BELOW', label: 'crosses below' },
];

interface StrategyRow {
  id: string;
  name: string;
  description: string;
  timeframe: string;
  symbols: string[];
  updatedAt: string;
  backtests?: Array<{ id: string; createdAt: string; result?: BacktestResult }>;
}

export default function StrategiesPage() {
  const queryClient = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: async () => (await endpoints.strategies.list()).data as StrategyRow[],
  });

  const remove = useMutation({
    mutationFn: (id: string) => endpoints.strategies.remove(id),
    onSuccess: () => {
      toast.success('Strategy deleted');
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      setSelected(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const backtest = useMutation({
    mutationFn: (id: string) => endpoints.strategies.backtest(id),
    onSuccess: (response, id) => {
      toast.success('Backtest complete');
      setSelected(id);
      queryClient.setQueryData(['backtest', id], (response.data as { result: BacktestResult }).result ?? response.data);
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = strategies.data ?? [];
  const activeResult = selected
    ? (queryClient.getQueryData(['backtest', selected]) as BacktestResult | undefined)
    : undefined;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Strategies</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Build rules without code, then backtest them with costs included. A backtest is a
            hypothesis, not a forecast.
          </p>
        </div>
        <Button size="sm" onClick={() => setBuilderOpen(true)}>
          <Plus /> New strategy
        </Button>
      </div>

      {strategies.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No strategies yet"
          description="Define entry and exit conditions from indicators, price and volume. The backtester applies brokerage, STT and slippage — results without costs are fiction."
          action={
            <Button size="sm" onClick={() => setBuilderOpen(true)}>
              <Plus /> New strategy
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((strategy) => (
            <Card key={strategy.id} className="group">
              <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium">{strategy.name}</p>
                    <Badge variant="secondary">{strategy.timeframe}</Badge>
                    {strategy.symbols.length > 0 && (
                      <Badge variant="outline">{strategy.symbols.length} symbols</Badge>
                    )}
                  </div>
                  {strategy.description && (
                    <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">
                      {strategy.description}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Updated {formatDate(strategy.updatedAt)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={backtest.isPending && backtest.variables === strategy.id}
                    onClick={() => backtest.mutate(strategy.id)}
                  >
                    <Play /> Backtest
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => remove.mutate(strategy.id)}
                    aria-label={`Delete ${strategy.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {activeResult && <BacktestReport result={activeResult} />}

      <StrategyBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
    </div>
  );
}

/* ── Builder ──────────────────────────────────────────────────── */

function StrategyBuilder({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [timeframe, setTimeframe] = useState('1D');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [entry, setEntry] = useState<StrategyCondition[]>([
    { id: 'e1', indicator: 'RSI', params: { period: 14 }, operator: 'LT', value: 30 },
  ]);
  const [exit, setExit] = useState<StrategyCondition[]>([
    { id: 'x1', indicator: 'RSI', params: { period: 14 }, operator: 'GT', value: 70 },
  ]);

  const create = useMutation({
    mutationFn: () =>
      endpoints.strategies.create({
        name,
        description,
        timeframe,
        symbols,
        universe: ['EQUITY'],
        entry: { logic: 'AND', conditions: entry },
        exit: { logic: 'OR', conditions: exit },
        riskPerTradePercent: 1,
        useAtrStop: true,
        atrMultiplier: 2,
      }),
    onSuccess: () => {
      toast.success('Strategy saved');
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      onOpenChange(false);
      setName('');
      setDescription('');
      setSymbols([]);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const valid = name.trim().length > 1 && entry.length > 0 && exit.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New strategy</DialogTitle>
          <DialogDescription>
            Entry conditions are ANDed; any exit condition closes the position.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s-name">Name</Label>
              <Input
                id="s-name"
                placeholder="RSI mean reversion"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Timeframe</Label>
              <Select value={timeframe} onValueChange={setTimeframe}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['15m', '1h', '4h', '1D', '1W'].map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="s-desc">Description</Label>
            <Input
              id="s-desc"
              placeholder="What this is meant to capture"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Symbols</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {symbols.map((symbol) => (
                <Badge key={symbol} variant="outline" className="gap-1">
                  {symbol}
                  <button
                    type="button"
                    onClick={() => setSymbols((current) => current.filter((s) => s !== symbol))}
                    aria-label={`Remove ${symbol}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <SymbolSearch
              onSelect={(symbol) =>
                setSymbols((current) => (current.includes(symbol) ? current : [...current, symbol]))
              }
              className="w-full"
            />
            <p className="text-[11px] text-muted-foreground">
              Leave empty to run across the whole equity universe.
            </p>
          </div>

          <ConditionEditor label="Entry — all must be true" conditions={entry} onChange={setEntry} />
          <ConditionEditor label="Exit — any closes the trade" conditions={exit} onChange={setExit} />
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Save strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConditionEditor({
  label,
  conditions,
  onChange,
}: {
  label: string;
  conditions: StrategyCondition[];
  onChange: (conditions: StrategyCondition[]) => void;
}) {
  function update(id: string, patch: Partial<StrategyCondition>) {
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>

      {conditions.map((condition) => (
        <div key={condition.id} className="flex items-center gap-2">
          <Select
            value={condition.indicator}
            onValueChange={(value) => {
              const meta = INDICATORS.find((i) => i.value === value)!;
              update(condition.id, { indicator: value, params: { ...meta.defaultParams }, value: meta.defaultValue });
            }}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INDICATORS.map((indicator) => (
                <SelectItem key={indicator.value} value={indicator.value}>
                  {indicator.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {'period' in condition.params && (
            <Input
              type="number"
              min="2"
              max="400"
              className="w-16"
              value={String(condition.params.period)}
              onChange={(event) =>
                update(condition.id, { params: { ...condition.params, period: Number(event.target.value) } })
              }
            />
          )}

          <Select
            value={condition.operator}
            onValueChange={(value) => update(condition.id, { operator: value as ConditionOperator })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPERATORS.map((operator) => (
                <SelectItem key={operator.value} value={operator.value}>
                  {operator.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            className="w-24"
            value={String(condition.value)}
            onChange={(event) => {
              const raw = event.target.value;
              const numeric = Number(raw);
              update(condition.id, { value: raw !== '' && Number.isFinite(numeric) ? numeric : raw });
            }}
          />

          {conditions.length > 1 && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onChange(conditions.filter((c) => c.id !== condition.id))}
              aria-label="Remove condition"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      ))}

      <Button
        size="sm"
        variant="ghost"
        className="w-fit"
        onClick={() =>
          onChange([
            ...conditions,
            {
              id: `c${Date.now()}`,
              indicator: 'RSI',
              params: { period: 14 },
              operator: 'LT',
              value: 30,
            },
          ])
        }
      >
        <Plus /> Add condition
      </Button>
    </div>
  );
}

/* ── Backtest report ──────────────────────────────────────────── */

function BacktestReport({ result }: { result: BacktestResult }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">Backtest</h2>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total return"
          value={formatPercent(result.totalReturn)}
          hint={`CAGR ${formatPercent(result.cagr)}`}
        />
        <StatCard
          label="Win rate"
          value={formatPercent(result.winRate * 100, { signed: false })}
          hint={`${result.winningTrades}W / ${result.losingTrades}L`}
        />
        <StatCard
          label="Max drawdown"
          value={formatPercent(-Math.abs(result.maxDrawdown), { signed: false })}
          hint={`${result.maxDrawdownDuration} bars to recover`}
        />
        <StatCard
          label="Profit factor"
          value={result.profitFactor.toFixed(2)}
          hint={`Sharpe ${result.sharpeRatio.toFixed(2)}`}
        />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Final capital" value={<Private>{formatCompactINR(result.finalCapital)}</Private>} />
            <Metric label="Trades" value={String(result.totalTrades)} />
            <Metric label="Expectancy" value={formatPercent(result.expectancy)} />
            <Metric label="Avg hold" value={`${result.averageHoldingBars.toFixed(0)} bars`} />
          </div>

          {result.warnings.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
              {result.warnings.map((warning) => (
                <li key={warning} className="text-[12px] text-neutral-signal">
                  · {warning}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
            Backtest ≠ live. Slippage, partial fills and market impact are modelled roughly;
            psychology is not modelled at all. A curve that only looks good with one parameter set
            is a curve that was fitted, not found.
          </p>
        </CardContent>
      </Card>

      {result.trades.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Symbol</th>
                    <th className="px-3 py-2 text-left font-medium">Side</th>
                    <th className="px-3 py-2 text-right font-medium">Entry</th>
                    <th className="px-3 py-2 text-right font-medium">Exit</th>
                    <th className="px-3 py-2 text-right font-medium">P&amp;L</th>
                    <th className="hidden px-3 py-2 text-left font-medium sm:table-cell">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(0, 60).map((trade, index) => (
                    <tr key={index} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-medium">{trade.symbol}</td>
                      <td className="px-3 py-2">
                        <Badge variant={trade.side === 'LONG' ? 'bull' : 'bear'}>{trade.side}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular font-mono">
                        {trade.entryPrice.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular font-mono">
                        {trade.exitPrice.toFixed(2)}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular font-mono',
                          trade.pnl >= 0 ? 'text-bull' : 'text-bear',
                        )}
                      >
                        {formatPercent(trade.pnlPercent)}
                      </td>
                      <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                        {trade.exitReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[14px] font-medium tabular">{value}</p>
    </div>
  );
}
