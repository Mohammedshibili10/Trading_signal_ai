'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Star, Trash2, X } from 'lucide-react';

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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangeIndicator, EmptyState, Section } from '@/components/market/primitives';
import { SymbolSearch } from '@/components/market/symbol-search';
import { endpoints } from '@/lib/api';
import { ASSET_CLASS_MAP } from '@/lib/constants';
import { formatPrice, formatVolume } from '@/lib/format';
import Link from 'next/link';
import type { Watchlist } from '@/types';

export default function WatchlistPage() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const { data: watchlists, isLoading } = useQuery({
    queryKey: ['watchlists'],
    queryFn: async () => (await endpoints.watchlists.list()).data as Watchlist[],
    refetchInterval: 20_000,
  });

  const active =
    watchlists?.find((list) => list.id === activeId) ??
    watchlists?.find((list) => list.isDefault) ??
    watchlists?.[0];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['watchlists'] });

  const createList = useMutation({
    mutationFn: (name: string) => endpoints.watchlists.create(name),
    onSuccess: () => {
      toast.success('Watchlist created');
      setCreateOpen(false);
      setNewName('');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteList = useMutation({
    mutationFn: (id: string) => endpoints.watchlists.remove(id),
    onSuccess: () => {
      toast.success('Watchlist deleted');
      setActiveId(null);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addItem = useMutation({
    mutationFn: ({ id, symbol }: { id: string; symbol: string }) =>
      endpoints.watchlists.addItem(id, symbol),
    onSuccess: () => {
      toast.success('Added to watchlist');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeItem = useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      endpoints.watchlists.removeItem(id, itemId),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Watchlist</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Instruments you follow, priced live.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus /> New list
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : !watchlists || watchlists.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No watchlists yet"
          description="Create one to start tracking instruments."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Create a watchlist
            </Button>
          }
        />
      ) : (
        <>
          {watchlists.length > 1 && (
            <Tabs value={active?.id} onValueChange={setActiveId}>
              <TabsList>
                {watchlists.map((list) => (
                  <TabsTrigger key={list.id} value={list.id}>
                    {list.name}
                    <span className="ml-1 text-muted-foreground">{list.items.length}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}

          {active && (
            <Section
              title={active.name}
              description={`${active.items.length} instrument${active.items.length === 1 ? '' : 's'}`}
              action={
                <div className="flex items-center gap-2">
                  <SymbolSearch
                    placeholder="Add instrument…"
                    onSelect={(symbol) => addItem.mutate({ id: active.id, symbol })}
                  />
                  {!active.isDefault && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => deleteList.mutate(active.id)}
                      aria-label="Delete watchlist"
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              }
            >
              <Card>
                <CardContent className="p-0">
                  {active.items.length === 0 ? (
                    <div className="p-6">
                      <EmptyState
                        icon={Star}
                        title="This list is empty"
                        description="Use the search box above to add instruments."
                      />
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {active.items.map((item) => {
                        const quote = item.quote;
                        const meta = ASSET_CLASS_MAP[item.assetClass];

                        return (
                          <div
                            key={item.id}
                            className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                          >
                            <Link href={`/markets/${item.symbol}`} className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-medium">{item.symbol}</span>
                                {meta && (
                                  <Badge variant="outline" className={meta.chip}>
                                    {meta.short}
                                  </Badge>
                                )}
                              </div>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {item.name}
                              </p>
                            </Link>

                            {quote ? (
                              <>
                                <div className="hidden shrink-0 text-right sm:block">
                                  <p className="text-[11px] text-muted-foreground">Volume</p>
                                  <p className="text-[12px] tabular font-mono">
                                    {formatVolume(quote.volume)}
                                  </p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <p className="text-[13px] font-medium tabular font-mono">
                                    {formatPrice(quote.price, {
                                      kind: quote.kind,
                                      currency: quote.currency,
                                    })}
                                  </p>
                                  <div className="text-[11px]">
                                    <ChangeIndicator
                                      percent={quote.changePercent}
                                      showIcon={false}
                                    />
                                  </div>
                                </div>
                              </>
                            ) : (
                              <span className="text-[12px] text-muted-foreground">no quote</span>
                            )}

                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={() => removeItem.mutate({ id: active.id, itemId: item.id })}
                              aria-label={`Remove ${item.symbol}`}
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Section>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New watchlist</DialogTitle>
            <DialogDescription>Group instruments however you like.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="list-name">Name</Label>
            <Input
              id="list-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Swing candidates"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim()) createList.mutate(newName.trim());
              }}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={createList.isPending}
              disabled={!newName.trim()}
              onClick={() => createList.mutate(newName.trim())}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
