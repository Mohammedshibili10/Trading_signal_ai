'use client';

import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { TradeSignal } from '@/types';

/**
 * What the marks on the chart mean.
 *
 * A chart covered in coloured bands and arrows with no key is decoration. This
 * is deliberately keyed off the same toggles that draw the marks, so the legend
 * can never describe something that isn't on screen.
 */
export function ChartLegend({
  signal,
  showSmc,
  showPatterns,
  showLevels,
  analysing,
}: {
  signal?: TradeSignal;
  showSmc: boolean;
  showPatterns: boolean;
  showLevels: boolean;
  analysing?: boolean;
}) {
  const items: Array<{ colour: string; label: string; style?: 'line' | 'dashed' | 'box' }> = [];

  if (signal && signal.action !== 'WAIT' && signal.action !== 'HOLD') {
    items.push({ colour: '#6366f1', label: 'Entry', style: 'line' });
    items.push({ colour: '#ef4444', label: 'Stop', style: 'dashed' });
    items.push({ colour: '#22c55e', label: `Targets (${signal.targets?.length ?? 0})`, style: 'dashed' });
  }

  if (showSmc) {
    items.push({ colour: 'rgba(34,197,94,0.5)', label: 'Order block', style: 'box' });
    items.push({ colour: 'rgba(34,211,238,0.5)', label: 'Fair value gap', style: 'box' });
    items.push({ colour: 'rgba(250,204,21,0.5)', label: 'Liquidity', style: 'box' });
  }

  if (showPatterns) {
    items.push({ colour: '#f59e0b', label: 'Pattern outline', style: 'line' });
  }

  if (showLevels) {
    items.push({ colour: 'rgba(34,197,94,0.6)', label: 'Support / resistance', style: 'dashed' });
  }

  if (items.length === 0 && !analysing) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              'shrink-0',
              item.style === 'box' ? 'size-2.5 rounded-[2px] border' : 'h-0 w-4 border-t-2',
              item.style === 'dashed' && 'border-dashed',
            )}
            style={
              item.style === 'box'
                ? { backgroundColor: item.colour, borderColor: item.colour }
                : { borderColor: item.colour }
            }
          />
          {item.label}
        </span>
      ))}

      {analysing && (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Re-analysing
        </span>
      )}
    </div>
  );
}
