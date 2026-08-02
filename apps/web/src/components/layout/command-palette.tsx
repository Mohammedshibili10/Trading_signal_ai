'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { endpoints } from '@/lib/api';
import { ASSET_CLASS_MAP } from '@/lib/constants';
import { ALL_NAV_ITEMS } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setCommandPaletteOpen } from '@/store/slices/ui-slice';
import type { AssetClass } from '@/types';

interface SearchResult {
  symbol: string;
  name: string;
  assetClass: AssetClass;
}

/**
 * Search and navigation in one surface.
 *
 * Instruments and pages share the result list because from the user's point of
 * view "get me to RELIANCE" and "get me to Settings" are the same intent.
 */
export function CommandPalette() {
  const open = useAppSelector((state) => state.ui.commandPaletteOpen);
  const dispatch = useAppDispatch();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHighlighted(0);
    }
  }, [open]);

  const { data: instruments = [], isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: async () => (await endpoints.market.search(query)).data as SearchResult[],
    // Below two characters the result set is meaningless and the request wasteful.
    enabled: open && query.trim().length >= 2,
    staleTime: 60_000,
  });

  const pages = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return ALL_NAV_ITEMS.slice(0, 6);
    return ALL_NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(term) || item.description.toLowerCase().includes(term),
    ).slice(0, 5);
  }, [query]);

  const results = useMemo(
    () => [
      ...instruments.map((item) => ({
        kind: 'instrument' as const,
        key: `i:${item.symbol}`,
        href: `/markets/${item.symbol}`,
        primary: item.symbol,
        secondary: item.name,
        assetClass: item.assetClass,
      })),
      ...pages.map((item) => ({
        kind: 'page' as const,
        key: `p:${item.href}`,
        href: item.href,
        primary: item.label,
        secondary: item.description,
        assetClass: undefined,
      })),
    ],
    [instruments, pages],
  );

  useEffect(() => setHighlighted(0), [results.length]);

  const go = (href: string) => {
    dispatch(setCommandPaletteOpen(false));
    router.push(href);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % Math.max(results.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((index) => (index - 1 + results.length) % Math.max(results.length, 1));
    } else if (event.key === 'Enter' && results[highlighted]) {
      event.preventDefault();
      go(results[highlighted].href);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setCommandPaletteOpen(next))}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 p-0" hideClose>
        <DialogTitle className="sr-only">Search</DialogTitle>

        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search instruments or jump to a page…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
          {isFetching && <span className="text-xs text-muted-foreground">…</span>}
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              {query.trim().length < 2
                ? 'Type at least two characters to search instruments.'
                : `Nothing matches "${query}".`}
            </p>
          ) : (
            results.map((result, index) => (
              <button
                key={result.key}
                type="button"
                onClick={() => go(result.href)}
                onMouseEnter={() => setHighlighted(index)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                  index === highlighted ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{result.primary}</p>
                  <p className="truncate text-xs text-muted-foreground">{result.secondary}</p>
                </div>

                {result.assetClass && (
                  <Badge
                    variant="outline"
                    className={ASSET_CLASS_MAP[result.assetClass]?.chip}
                  >
                    {ASSET_CLASS_MAP[result.assetClass]?.short}
                  </Badge>
                )}

                {index === highlighted && (
                  <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
