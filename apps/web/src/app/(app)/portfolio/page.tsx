'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Briefcase, Plus, Trash2 } from 'lucide-react';

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
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsListUnderline, TabsTriggerUnderline } from '@/components/ui/tabs';
import { ChangeIndicator, EmptyState, Private, Section, StatCard } from '@/components/market/primitives';
import { SymbolSearch } from '@/components/market/symbol-search';
import { AllocationChart } from '@/components/portfolio/allocation-chart';
import { endpoints } from '@/lib/api';
import { formatCompactINR, formatDate, formatPercent, formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Holding, PortfolioSummary } from '@/types';

export default function PortfolioPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio'],
    queryFn: async () =>
      (await endpoints.portfolio.summary()).data as {
        summary: PortfolioSummary;
        holdings: Holding[];
      },
    refetchInterval: 30_000,
  });

  const transactions = useQuery({
    queryKey: ['transactions'],
    queryFn: async () => (await endpoints.portfolio.transactions()).data,
    staleTime: 60_000,
  });

  const removeHolding = useMutation({
    mutationFn: (id: string) => endpoints.portfolio.deleteHolding(id),
    onSuccess: () => {
      toast.success('Holding removed');
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const summary = data?.summary;
  const holdings = data?.holdings ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Holdings, P&amp;L and allocation, priced live.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus /> Record a trade
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Current value"
          value={formatCompactINR(summary?.currentValue ?? 0)}
          loading={isLoading}
          privateValue
        />
        <StatCard
          label="Total P&L"
          value={formatCompactINR(summary?.totalPnl ?? 0)}
          changePercent={summary?.totalPnlPercent}
          loading={isLoading}
          privateValue
        />
        <StatCard
          label="Today"
          value={formatCompactINR(summary?.dayPnl ?? 0)}
          changePercent={summary?.dayPnlPercent}
          loading={isLoading}
          privateValue
        />
        <StatCard
          label="Invested"
          value={formatCompactINR(summary?.totalInvested ?? 0)}
          loading={isLoading}
          privateValue
          hint={summary ? `${summary.holdingsCount} holdings` : undefined}
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-80 w-full rounded-xl" />
      ) : holdings.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No holdings yet"
          description="Record a trade to start tracking P&L, allocation and portfolio risk."
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus /> Record a trade
            </Button>
          }
        />
      ) : (
        <Tabs defaultValue="holdings">
          <TabsListUnderline>
            <TabsTriggerUnderline value="holdings">Holdings</TabsTriggerUnderline>
            <TabsTriggerUnderline value="allocation">Allocation</TabsTriggerUnderline>
            <TabsTriggerUnderline value="transactions">Transactions</TabsTriggerUnderline>
          </TabsListUnderline>

          <TabsContent value="holdings">
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-medium">Instrument</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Avg cost</th>
                        <th className="px-3 py-2 text-right font-medium">Price</th>
                        <th className="px-3 py-2 text-right font-medium">Value</th>
                        <th className="px-3 py-2 text-right font-medium">P&amp;L</th>
                        <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                          Weight
                        </th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((holding) => (
                        <tr
                          key={holding.id}
                          className="group border-b border-border last:border-0 hover:bg-muted/40"
                        >
                          <td className="px-3 py-2.5">
                            <Link href={`/markets/${holding.symbol}`}>
                              <p className="font-medium">{holding.symbol}</p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {holding.name}
                              </p>
                            </Link>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular font-mono">
                            {holding.quantity}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular font-mono">
                            {formatPrice(holding.averagePrice, { withSymbol: false })}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular font-mono">
                            {formatPrice(holding.currentPrice, { withSymbol: false })}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular font-mono">
                            <Private>{formatCompactINR(holding.currentValue)}</Private>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Private>
                              <span
                                className={cn(
                                  'tabular font-mono',
                                  holding.pnl >= 0 ? 'text-bull' : 'text-bear',
                                )}
                              >
                                {formatCompactINR(holding.pnl)}
                              </span>
                            </Private>
                            <p className="text-[11px]">
                              <ChangeIndicator percent={holding.pnlPercent} showIcon={false} />
                            </p>
                          </td>
                          <td className="hidden px-3 py-2.5 text-right sm:table-cell">
                            <span className="tabular font-mono text-muted-foreground">
                              {holding.allocationPercent.toFixed(1)}%
                            </span>
                            <Progress
                              value={holding.allocationPercent}
                              size="sm"
                              className="ml-auto mt-1 w-14"
                            />
                          </td>
                          <td className="px-2">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="opacity-0 group-hover:opacity-100"
                              onClick={() => removeHolding.mutate(holding.id)}
                              aria-label={`Remove ${holding.symbol}`}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {summary?.bestPerformer && summary?.worstPerformer && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Card>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Best performer
                      </p>
                      <p className="mt-0.5 text-[14px] font-medium">
                        {summary.bestPerformer.symbol}
                      </p>
                    </div>
                    <ChangeIndicator percent={summary.bestPerformer.pnlPercent} />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Worst performer
                      </p>
                      <p className="mt-0.5 text-[14px] font-medium">
                        {summary.worstPerformer.symbol}
                      </p>
                    </div>
                    <ChangeIndicator percent={summary.worstPerformer.pnlPercent} />
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="allocation">
            <AllocationChart holdings={holdings} />
          </TabsContent>

          <TabsContent value="transactions">
            <Card>
              <CardContent className="p-0">
                {transactions.isLoading ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <Skeleton key={index} className="h-10 w-full" />
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {(transactions.data ?? []).map(
                      (transaction: {
                        id: string;
                        symbol: string;
                        type: string;
                        quantity: number;
                        price: number;
                        charges: number;
                        executedAt: string;
                      }) => (
                        <div key={transaction.id} className="flex items-center gap-3 px-4 py-3">
                          <Badge variant={transaction.type === 'BUY' ? 'bull' : 'bear'}>
                            {transaction.type}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-medium">{transaction.symbol}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {formatDate(transaction.executedAt, true)}
                            </p>
                          </div>
                          <div className="text-right text-[12px]">
                            <p className="tabular font-mono">
                              {transaction.quantity} ×{' '}
                              {formatPrice(transaction.price, { withSymbol: false })}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              charges {formatPrice(transaction.charges)}
                            </p>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <AddTransactionDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddTransactionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState('');
  const [type, setType] = useState<'BUY' | 'SELL'>('BUY');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [charges, setCharges] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      endpoints.portfolio.addTransaction({
        symbol,
        type,
        quantity: Number(quantity),
        price: Number(price),
        charges: charges ? Number(charges) : 0,
      }),
    onSuccess: () => {
      toast.success('Trade recorded');
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      onOpenChange(false);
      setSymbol('');
      setQuantity('');
      setPrice('');
      setCharges('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const valid = symbol && Number(quantity) > 0 && Number(price) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record a trade</DialogTitle>
          <DialogDescription>
            Buys move the weighted average cost; sells realise P&amp;L against it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Instrument</Label>
            {symbol ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline">{symbol}</Badge>
                <button
                  type="button"
                  onClick={() => setSymbol('')}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  change
                </button>
              </div>
            ) : (
              <SymbolSearch onSelect={setSymbol} className="w-full" />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(value) => setType(value as 'BUY' | 'SELL')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BUY">Buy</SelectItem>
                  <SelectItem value="SELL">Sell</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qty">Quantity</Label>
              <Input
                id="qty"
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price">Price</Label>
              <Input
                id="price"
                type="number"
                min="0"
                step="any"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="charges">Charges</Label>
              <Input
                id="charges"
                type="number"
                min="0"
                step="any"
                placeholder="0"
                value={charges}
                onChange={(event) => setCharges(event.target.value)}
              />
            </div>
          </div>

          {valid && (
            <p className="text-[12px] text-muted-foreground">
              Total {formatPrice(Number(quantity) * Number(price) + Number(charges || 0))}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!valid}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
