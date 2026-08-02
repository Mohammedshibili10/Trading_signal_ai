'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StanceBadge } from '@/components/market/primitives';
import { formatPercent, formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CandlestickPattern, ChartPattern, PriceActionAnalysis, SmcAnalysis } from '@/types';

const STATUS_VARIANT = {
  CONFIRMED: 'bull',
  FORMING: 'neutral',
  FAILED: 'bear',
} as const;

export function StructurePanel({
  priceAction,
  smc,
  chartPatterns,
  candlestickPatterns,
}: {
  priceAction: PriceActionAnalysis;
  smc: SmcAnalysis;
  chartPatterns: ChartPattern[];
  candlestickPatterns: CandlestickPattern[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Levels */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Support &amp; resistance
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">{priceAction.summary}</p>

          <div className="mt-4 flex flex-col gap-2.5">
            {priceAction.levels.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No significant levels detected.</p>
            ) : (
              priceAction.levels.map((level) => (
                <div key={`${level.kind}-${level.price}`} className="flex items-center gap-3">
                  <Badge variant={level.kind === 'SUPPORT' ? 'bull' : 'bear'} className="w-24 shrink-0 justify-center">
                    {level.kind.toLowerCase()}
                  </Badge>
                  <span className="w-24 shrink-0 tabular font-mono text-[13px] font-medium">
                    {formatPrice(level.price, { withSymbol: false })}
                  </span>
                  <span
                    className={cn(
                      'w-16 shrink-0 tabular font-mono text-[12px]',
                      level.distancePercent > 0 ? 'text-muted-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {formatPercent(level.distancePercent)}
                  </span>
                  <div className="flex-1">
                    <Progress value={level.strength} size="sm" />
                  </div>
                  <span className="w-28 shrink-0 truncate text-right text-[11px] text-muted-foreground">
                    {level.label}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Events */}
      {priceAction.events.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recent price action
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {priceAction.events.map((event, index) => (
                <div key={index} className="flex items-start gap-3">
                  <Badge
                    variant={event.stance === 'BULLISH' ? 'bull' : event.stance === 'BEARISH' ? 'bear' : 'neutral'}
                    className="shrink-0"
                  >
                    {event.type.replace('_', ' ').toLowerCase()}
                  </Badge>
                  <p className="flex-1 text-[13px] leading-relaxed text-muted-foreground">
                    {event.note}
                  </p>
                  <span className="shrink-0 text-[11px] tabular text-muted-foreground">
                    {event.confidence.toFixed(0)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Smart money */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Market structure
            </p>
            <StanceBadge stance={smc.bias} />
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{smc.summary}</p>

          {smc.premiumDiscount && (
            <div className="mt-4">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Discount {formatPrice(smc.premiumDiscount.rangeLow, { withSymbol: false })}</span>
                <span>Equilibrium</span>
                <span>Premium {formatPrice(smc.premiumDiscount.rangeHigh, { withSymbol: false })}</span>
              </div>
              <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-gradient-to-r from-bull/30 via-muted to-bear/30">
                <div
                  className="absolute top-0 h-full w-1 -translate-x-1/2 rounded bg-foreground"
                  style={{ left: `${smc.premiumDiscount.positionPercent}%` }}
                />
              </div>
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                Price sits at {smc.premiumDiscount.positionPercent.toFixed(0)}% of its range —{' '}
                {smc.premiumDiscount.zone.toLowerCase()}.
              </p>
            </div>
          )}

          {smc.structure.length > 0 && (
            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
              {smc.structure.slice(-4).map((event, index) => (
                <div key={index} className="flex items-start gap-2">
                  <Badge variant={event.direction === 'BULLISH' ? 'bull' : 'bear'} className="shrink-0">
                    {event.type}
                  </Badge>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{event.note}</p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <Count label="Order blocks" value={smc.orderBlocks.filter((b) => !b.mitigated).length} sub="unmitigated" />
            <Count label="Fair value gaps" value={smc.fairValueGaps.filter((g) => !g.filled).length} sub="unfilled" />
            <Count label="Liquidity swept" value={smc.liquidity.filter((l) => l.swept).length} sub="stop runs" />
          </div>
        </CardContent>
      </Card>

      {/* Chart patterns */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Chart patterns
          </p>
          {chartPatterns.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              No patterns matched on this timeframe.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {chartPatterns.map((pattern, index) => (
                <div key={index} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{pattern.name}</span>
                    <StanceBadge stance={pattern.stance} />
                    <Badge variant={STATUS_VARIANT[pattern.status]}>
                      {pattern.status.toLowerCase()}
                    </Badge>
                    <span className="ml-auto text-[11px] tabular text-muted-foreground">
                      fit {pattern.confidence.toFixed(0)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {pattern.note}
                  </p>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Confidence measures how cleanly the shape fits — not the odds of it working. Those
                come from the calibration layer.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Candlestick patterns */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Candlestick patterns
          </p>
          {candlestickPatterns.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              Nothing named on the latest bar.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {candlestickPatterns.map((pattern, index) => (
                <div key={index}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{pattern.name}</span>
                    <StanceBadge stance={pattern.stance} />
                    <span className="ml-auto text-[11px] tabular text-muted-foreground">
                      {pattern.reliability.toFixed(0)} in context
                      <span className="opacity-60"> · {pattern.baseReliability.toFixed(0)} base</span>
                    </span>
                  </div>
                  <Progress value={pattern.reliability} className="mt-1.5" size="sm" />
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {pattern.note}
                  </p>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Base reliability comes from measured performance, not textbook lore — several
                classic patterns test close to random, and the engine weights them accordingly.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Count({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular">{value}</p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}
