'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { endpoints } from '@/lib/api';
import { ASSET_CLASS_MAP } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { AssetClass } from '@/types';

interface Result {
  symbol: string;
  name: string;
  assetClass: AssetClass;
}

/**
 * Inline instrument picker.
 *
 * Distinct from the ⌘K palette: this one returns a symbol to the caller rather
 * than navigating, so it can be dropped into "add to watchlist", "record a
 * trade" and the strategy builder.
 */
export function SymbolSearch({
  onSelect,
  placeholder = 'Search symbol…',
  assetClass,
  className,
}: {
  onSelect: (symbol: string) => void;
  placeholder?: string;
  assetClass?: AssetClass;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: results = [] } = useQuery({
    queryKey: ['symbol-search', query, assetClass],
    queryFn: async () => (await endpoints.market.search(query, assetClass)).data as Result[],
    enabled: query.trim().length >= 1,
    staleTime: 60_000,
  });

  // Close on outside click — a dropdown that only closes on Escape feels stuck.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const choose = (symbol: string) => {
    onSelect(symbol);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Enter' && results[0]) choose(results[0].symbol);
        }}
        placeholder={placeholder}
        className="h-8 w-full pl-8 text-[13px] sm:w-56"
      />

      {open && query.trim().length >= 1 && (
        <div className="absolute right-0 top-9 z-40 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
              No match for &ldquo;{query}&rdquo;
            </p>
          ) : (
            results.map((result) => {
              const meta = ASSET_CLASS_MAP[result.assetClass];
              return (
                <button
                  key={result.symbol}
                  type="button"
                  onClick={() => choose(result.symbol)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{result.symbol}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{result.name}</p>
                  </div>
                  {meta && (
                    <Badge variant="outline" className={cn('shrink-0', meta.chip)}>
                      {meta.short}
                    </Badge>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
