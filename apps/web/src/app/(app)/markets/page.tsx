'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, QuoteTableRow, Section } from '@/components/market/primitives';
import { Heatmap } from '@/components/market/heatmap';
import { endpoints } from '@/lib/api';
import { ASSET_CLASSES } from '@/lib/constants';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setActiveAssetClass } from '@/store/slices/ui-slice';
import type { AssetClass, Quote } from '@/types';

export default function MarketsPage() {
  const dispatch = useAppDispatch();
  const assetClass = useAppSelector((state) => state.ui.activeAssetClass);
  const [filter, setFilter] = useState('');

  const overview = useQuery({
    queryKey: ['overview', assetClass],
    queryFn: async () => (await endpoints.instruments.overview(assetClass)).data,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const all: Quote[] = useMemo(() => {
    const data = overview.data;
    if (!data) return [];
    // The overview endpoint returns gainers/losers/mostActive as slices of the
    // same set; de-duplicate rather than showing a symbol three times.
    const seen = new Map<string, Quote>();
    for (const quote of [...(data.gainers ?? []), ...(data.losers ?? []), ...(data.mostActive ?? [])]) {
      seen.set(quote.symbol, quote);
    }
    return [...seen.values()];
  }, [overview.data]);

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const rows = term
      ? all.filter(
          (quote) =>
            quote.symbol.toLowerCase().includes(term) || quote.name.toLowerCase().includes(term),
        )
      : all;
    return [...rows].sort((a, b) => b.changePercent - a.changePercent);
  }, [all, filter]);

  const meta = ASSET_CLASSES.find((item) => item.key === assetClass);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Markets</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {meta?.description ?? 'Live prices across every covered category.'}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={assetClass}
          onValueChange={(value) => dispatch(setActiveAssetClass(value as AssetClass))}
        >
          <TabsList>
            {ASSET_CLASSES.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.short}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter this list…"
            className="pl-9"
          />
        </div>
      </div>

      <Section title="Heatmap" description="Sized by market cap where available, coloured by day change.">
        {overview.isLoading ? (
          <Skeleton className="h-56 w-full rounded-xl" />
        ) : (
          <Heatmap items={overview.data?.heatmap ?? []} />
        )}
      </Section>

      <Section title={`All ${meta?.label ?? ''}`.trim()}>
        <Card>
          <CardContent className="p-0">
            {overview.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <Skeleton key={index} className="h-11 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={Search}
                  title={filter ? 'Nothing matches that filter' : 'No instruments loaded'}
                  description={
                    filter
                      ? 'Try a different symbol or company name.'
                      : 'The provider chain returned no quotes for this category.'
                  }
                />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Instrument</TableHead>
                    <TableHead numeric>Price</TableHead>
                    <TableHead numeric>Change</TableHead>
                    <TableHead numeric className="hidden sm:table-cell">
                      Volume
                    </TableHead>
                    <TableHead numeric className="hidden md:table-cell">
                      Market cap
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((quote) => (
                    <QuoteTableRow key={quote.symbol} quote={quote} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
