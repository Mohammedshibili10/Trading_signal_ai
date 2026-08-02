'use client';

import Link from 'next/link';

import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface HeatmapItem {
  symbol: string;
  name: string;
  changePercent: number;
  price: number;
  marketCap?: number | null;
}

/**
 * Market heatmap.
 *
 * Colour encodes magnitude in five steps rather than a continuous gradient —
 * a smooth ramp looks impressive and is unreadable, because nobody can tell
 * -1.2% from -1.6% by shade. Five bands map to decisions: flat, mild, strong.
 */
function band(change: number): string {
  if (change >= 3) return 'bg-bull text-bull-foreground';
  if (change >= 1) return 'bg-bull/60 text-bull-foreground';
  if (change > 0.15) return 'bg-bull/25 text-foreground';
  if (change <= -3) return 'bg-bear text-bear-foreground';
  if (change <= -1) return 'bg-bear/60 text-bear-foreground';
  if (change < -0.15) return 'bg-bear/25 text-foreground';
  return 'bg-muted text-muted-foreground';
}

export function Heatmap({ items }: { items: HeatmapItem[] }) {
  if (items.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border">
        <p className="text-[13px] text-muted-foreground">No data for this category yet.</p>
      </div>
    );
  }

  // Largest movers first so the eye lands on what actually moved.
  const sorted = [...items].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
      {sorted.map((item) => (
        <Link
          key={item.symbol}
          href={`/markets/${item.symbol}`}
          title={`${item.name} · ${formatPercent(item.changePercent)}`}
          className={cn(
            'flex aspect-4/3 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 text-center transition-opacity hover:opacity-85',
            band(item.changePercent),
          )}
        >
          <span className="w-full truncate text-[11px] font-semibold leading-tight">
            {item.symbol}
          </span>
          <span className="text-[11px] tabular font-mono opacity-90">
            {formatPercent(item.changePercent, { decimals: 1 })}
          </span>
        </Link>
      ))}
    </div>
  );
}
