'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { BipolarMeter, Progress } from '@/components/ui/progress';
import { StanceBadge } from '@/components/market/primitives';
import { cn } from '@/lib/utils';
import type { TechnicalAnalysis } from '@/types';

const REGIME_TONE = {
  LOW: 'text-muted-foreground',
  NORMAL: 'text-foreground',
  HIGH: 'text-neutral-signal',
  EXTREME: 'text-bear',
} as const;

export function TechnicalPanel({ technical }: { technical: TechnicalAnalysis }) {
  const bullish = technical.indicators.filter((item) => item.stance === 'BULLISH').length;
  const bearish = technical.indicators.filter((item) => item.stance === 'BEARISH').length;
  const neutral = technical.indicators.length - bullish - bearish;

  return (
    <div className="flex flex-col gap-4">
      {/* Roll-up */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Technical score
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-2xl font-semibold tabular">
                  {technical.score > 0 ? '+' : ''}
                  {technical.score.toFixed(0)}
                </span>
                <StanceBadge stance={technical.stance} />
              </div>
            </div>

            <div className="flex gap-4 text-center">
              <Count label="Bullish" value={bullish} className="text-bull" />
              <Count label="Neutral" value={neutral} className="text-muted-foreground" />
              <Count label="Bearish" value={bearish} className="text-bear" />
            </div>
          </div>

          <BipolarMeter value={technical.score} className="mt-4" />

          <p className="mt-4 border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
            {technical.summary}
          </p>
        </CardContent>
      </Card>

      {/* Regime cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Trend</p>
            <p className="mt-1 text-[14px] font-medium">
              {technical.trend.direction.charAt(0) + technical.trend.direction.slice(1).toLowerCase()}
            </p>
            <Progress value={technical.trend.strength} max={60} className="mt-2" size="sm" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              ADX {technical.trend.strength.toFixed(0)} · MA stack {technical.trend.maStack.toLowerCase()}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Momentum</p>
            <p className="mt-1 text-[14px] font-medium">{technical.momentum.label}</p>
            <BipolarMeter value={technical.momentum.value} className="mt-2" />
            {technical.momentum.divergence && (
              <Badge
                variant={technical.momentum.divergence === 'BULLISH' ? 'bull' : 'bear'}
                className="mt-2"
              >
                {technical.momentum.divergence.toLowerCase()} divergence
              </Badge>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Volatility</p>
            <p className={cn('mt-1 text-[14px] font-medium', REGIME_TONE[technical.volatility.regime])}>
              {technical.volatility.regime.charAt(0) +
                technical.volatility.regime.slice(1).toLowerCase()}
            </p>
            <Progress value={technical.volatility.percentile} className="mt-2" size="sm" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              ATR {technical.volatility.atrPercent.toFixed(2)}% ·{' '}
              {technical.volatility.percentile.toFixed(0)}th percentile
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Volume</p>
            <p className="mt-1 text-[14px] font-medium">{technical.volume.ratio.toFixed(2)}×</p>
            <Progress
              value={Math.min(technical.volume.ratio * 33, 100)}
              className="mt-2"
              size="sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{technical.volume.label}</p>
          </CardContent>
        </Card>
      </div>

      {/* Indicator table */}
      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {technical.indicators.map((indicator) => (
              <div key={indicator.key} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{indicator.label}</span>
                    <StanceBadge stance={indicator.stance} />
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                    {indicator.note}
                  </p>
                </div>
                <span className="shrink-0 tabular font-mono text-[13px] font-medium">
                  {indicator.display}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Count({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div>
      <p className={cn('text-lg font-semibold tabular', className)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
