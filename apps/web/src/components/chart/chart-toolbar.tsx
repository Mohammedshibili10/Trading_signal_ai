'use client';

import { AreaChart, BarChart3, CandlestickChart, LineChart, SlidersHorizontal } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { TIMEFRAMES_BY_CLASS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  clearIndicators,
  setChartType,
  toggleAnnotation,
  toggleOverlay,
  togglePane,
  type OverlayKey,
  type PaneKey,
} from '@/store/slices/chart-slice';
import type { AssetClass, Timeframe } from '@/types';

const CHART_TYPES = [
  { key: 'candlestick', label: 'Candles', icon: CandlestickChart },
  { key: 'line', label: 'Line', icon: LineChart },
  { key: 'area', label: 'Area', icon: AreaChart },
  { key: 'bar', label: 'Bars', icon: BarChart3 },
] as const;

const OVERLAYS: Array<{ key: OverlayKey; label: string }> = [
  { key: 'ema20', label: 'EMA 20' },
  { key: 'ema50', label: 'EMA 50' },
  { key: 'ema200', label: 'EMA 200' },
  { key: 'sma50', label: 'SMA 50' },
];

const PANES: Array<{ key: PaneKey; label: string }> = [{ key: 'volume', label: 'Volume' }];

/**
 * Chart annotations from the analysis engine.
 *
 * Levels and the trade plan are on by default because they are what a chart is
 * being read *for*. Structure and patterns are off — they are dense, and a
 * first-time chart covered in order blocks reads as decoration.
 */
const ANNOTATIONS: Array<{
  key: 'showLevels' | 'showSignals' | 'showPatterns' | 'showSmc';
  label: string;
  hint: string;
}> = [
  { key: 'showLevels', label: 'Support & resistance', hint: 'Tested levels, strongest five' },
  { key: 'showSignals', label: 'Trade plan', hint: 'Entry, stop, targets and the risk/reward bands' },
  { key: 'showPatterns', label: 'Patterns', hint: 'Chart patterns and reliable candlesticks' },
  { key: 'showSmc', label: 'Market structure', hint: 'Order blocks, fair value gaps, BOS/CHoCH' },
];

/**
 * Chart controls.
 *
 * Indicators are off by default and live behind a popover. The brief asks for
 * them "only when needed" — an empty chart is the readable one, and a toolbar
 * showing fifteen toggles at once is the thing that makes trading software feel
 * like a cockpit.
 */
export function ChartToolbar({
  assetClass,
  timeframe,
  onTimeframeChange,
}: {
  assetClass: AssetClass;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
}) {
  const dispatch = useAppDispatch();
  const chart = useAppSelector((state) => state.chart);

  const available = TIMEFRAMES_BY_CLASS[assetClass] ?? TIMEFRAMES_BY_CLASS.EQUITY;
  const activeIndicators = chart.overlays.length + (chart.panes.length - 1);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Timeframes */}
      <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {available.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onTimeframeChange(option)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
              timeframe === option
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <Separator orientation="vertical" className="hidden h-6 sm:block" />

      {/* Chart type */}
      <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {CHART_TYPES.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => dispatch(setChartType(option.key))}
              title={option.label}
              aria-label={option.label}
              className={cn(
                'rounded-md p-1.5 transition-colors',
                chart.chartType === option.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </button>
          );
        })}
      </div>

      <div className="ml-auto">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal />
              Indicators
              {activeIndicators > 0 && (
                <Badge variant="default" className="ml-0.5">
                  {activeIndicators}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>

          <PopoverContent align="end" className="w-64">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-medium">Overlays</p>
              {activeIndicators > 0 && (
                <button
                  type="button"
                  onClick={() => dispatch(clearIndicators())}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-2.5">
              {OVERLAYS.map((overlay) => (
                <div key={overlay.key} className="flex items-center gap-2">
                  <Checkbox
                    id={overlay.key}
                    checked={chart.overlays.includes(overlay.key)}
                    onCheckedChange={() => dispatch(toggleOverlay(overlay.key))}
                  />
                  <Label htmlFor={overlay.key} className="cursor-pointer font-normal">
                    {overlay.label}
                  </Label>
                </div>
              ))}
            </div>

            <Separator className="my-3" />
            <p className="text-[13px] font-medium">Panes</p>
            <div className="mt-3 flex flex-col gap-2.5">
              {PANES.map((pane) => (
                <div key={pane.key} className="flex items-center gap-2">
                  <Checkbox
                    id={pane.key}
                    checked={chart.panes.includes(pane.key)}
                    onCheckedChange={() => dispatch(togglePane(pane.key))}
                  />
                  <Label htmlFor={pane.key} className="cursor-pointer font-normal">
                    {pane.label}
                  </Label>
                </div>
              ))}
            </div>

            <Separator className="my-3" />
            <p className="text-[13px] font-medium">Analysis on chart</p>
            <div className="mt-3 flex flex-col gap-3">
              {ANNOTATIONS.map((annotation) => (
                <div key={annotation.key} className="flex items-start gap-2">
                  <Checkbox
                    id={annotation.key}
                    className="mt-0.5"
                    checked={chart[annotation.key]}
                    onCheckedChange={() => dispatch(toggleAnnotation(annotation.key))}
                  />
                  <Label htmlFor={annotation.key} className="cursor-pointer font-normal leading-tight">
                    {annotation.label}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {annotation.hint}
                    </span>
                  </Label>
                </div>
              ))}
            </div>

            <Separator className="my-3" />
            <div className="flex items-center gap-2">
              <Checkbox
                id="logScale"
                checked={chart.logScale}
                onCheckedChange={() => dispatch(toggleAnnotation('logScale'))}
              />
              <Label htmlFor="logScale" className="cursor-pointer font-normal">
                Logarithmic scale
              </Label>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
