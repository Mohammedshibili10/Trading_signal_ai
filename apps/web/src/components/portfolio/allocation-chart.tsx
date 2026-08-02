'use client';

import { useMemo, useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/market/primitives';
import { CHART_COLORS } from '@/lib/constants';
import { formatCompactINR } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Holding } from '@/types';

type Dimension = 'instrument' | 'sector' | 'assetClass';

const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
  { key: 'instrument', label: 'Instrument' },
  { key: 'sector', label: 'Sector' },
  { key: 'assetClass', label: 'Asset class' },
];

interface Slice {
  key: string;
  value: number;
  percent: number;
  colour: string;
}

/**
 * Portfolio allocation.
 *
 * Drawn as SVG arcs rather than pulled in from a charting library: three
 * dimensions of a single donut is not worth 400 KB of ECharts on a page that
 * already ships a candlestick engine.
 *
 * The concentration warning is the point of the view — a donut that looks
 * pretty but doesn't say "42% of your book is one stock" isn't doing its job.
 */
export function AllocationChart({ holdings }: { holdings: Holding[] }) {
  const [dimension, setDimension] = useState<Dimension>('instrument');

  const slices = useMemo<Slice[]>(() => {
    if (holdings.length === 0) return [];

    const buckets = new Map<string, number>();
    for (const holding of holdings) {
      const key =
        dimension === 'instrument'
          ? holding.symbol
          : dimension === 'sector'
            ? (holding.sector ?? 'Unclassified')
            : holding.assetClass;
      buckets.set(key, (buckets.get(key) ?? 0) + holding.currentValue);
    }

    const total = [...buckets.values()].reduce((sum, value) => sum + value, 0);
    if (total <= 0) return [];

    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, value], index) => ({
        key,
        value,
        percent: (value / total) * 100,
        colour: CHART_COLORS[index % CHART_COLORS.length],
      }));
  }, [holdings, dimension]);

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const largest = slices[0];

  /**
   * Herfindahl index over the weights, rescaled to 0…100. 100 is everything in
   * one position; a 10-name equal-weight book scores 10.
   */
  const concentration = slices.reduce((sum, slice) => sum + (slice.percent / 100) ** 2, 0) * 100;

  if (slices.length === 0) {
    return (
      <EmptyState
        title="Nothing to allocate"
        description="Allocation appears once holdings have a market value."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 w-fit">
          {DIMENSIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setDimension(option.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                dimension === option.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-6 sm:flex-row sm:items-center">
          <Donut slices={slices} total={total} />

          <ul className="min-w-0 flex-1 space-y-2">
            {slices.slice(0, 10).map((slice) => (
              <li key={slice.key} className="flex items-center gap-2.5">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: slice.colour }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">{slice.key}</span>
                <span className="shrink-0 tabular font-mono text-[12px] text-muted-foreground">
                  {formatCompactINR(slice.value)}
                </span>
                <span className="w-12 shrink-0 text-right tabular font-mono text-[13px] font-medium">
                  {slice.percent.toFixed(1)}%
                </span>
              </li>
            ))}
            {slices.length > 10 && (
              <li className="pl-5 text-[11px] text-muted-foreground">
                +{slices.length - 10} more
              </li>
            )}
          </ul>
        </div>

        {largest && (
          <p
            className={cn(
              'mt-4 border-t border-border pt-3 text-[12px]',
              largest.percent >= 25 || concentration >= 30
                ? 'text-neutral-signal'
                : 'text-muted-foreground',
            )}
          >
            {largest.key} is {largest.percent.toFixed(1)}% of the book · concentration index{' '}
            {concentration.toFixed(0)}/100
            {largest.percent >= 25
              ? ' — a single position this large drives the portfolio more than the market does.'
              : concentration >= 30
                ? ' — the book is carried by a handful of names.'
                : ' — reasonably spread.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Donut built from stroke-dasharray arcs — no path maths, no library. */
function Donut({ slices, total }: { slices: Slice[]; total: number }) {
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="relative mx-auto size-40 shrink-0 sm:mx-0">
      <svg viewBox="0 0 160 160" className="size-full -rotate-90">
        {slices.map((slice) => {
          const length = (slice.percent / 100) * circumference;
          const dash = `${Math.max(0, length - 1.5)} ${circumference}`;
          const element = (
            <circle
              key={slice.key}
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke={slice.colour}
              strokeWidth="18"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            >
              <title>
                {slice.key} — {slice.percent.toFixed(1)}%
              </title>
            </circle>
          );
          offset += length;
          return element;
        })}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</span>
        <span className="text-[15px] font-semibold tabular">{formatCompactINR(total)}</span>
      </div>
    </div>
  );
}
