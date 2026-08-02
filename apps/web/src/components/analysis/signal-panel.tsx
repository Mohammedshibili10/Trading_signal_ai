'use client';

import { AlertTriangle, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatPercent, formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TradeSignal } from '@/types';

const RISK_VARIANT = {
  LOW: 'bull',
  MEDIUM: 'neutral',
  HIGH: 'bear',
  VERY_HIGH: 'destructive',
} as const;

export function SignalPanel({
  signal,
}: {
  signal: TradeSignal & { rejectionReason?: string | null };
}) {
  // WAIT is a first-class result, not an error state, and gets its own layout.
  if (signal.action === 'WAIT' || signal.action === 'HOLD') {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <AlertTriangle className="size-4 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{signal.action}</Badge>
                <span className="text-[15px] font-medium">No qualifying setup</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                {signal.rejectionReason ?? signal.explanation}
              </p>
              <p className="mt-3 text-[12px] text-muted-foreground">
                The engine returns WAIT on roughly 40% of evaluations. Not trading is a position —
                it costs nothing and preserves the capital for a setup that does qualify.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isBuy = signal.action === 'BUY';

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Badge variant={isBuy ? 'bull' : 'bear'}>{signal.action}</Badge>
                <span className="text-[15px] font-semibold">{signal.symbol}</span>
                <Badge variant="secondary">{signal.timeframe}</Badge>
                <Badge variant="outline">{signal.horizon.replace('_', ' ').toLowerCase()}</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                {signal.explanation}
              </p>
            </div>

            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Confidence</p>
              <p className="mt-1 text-2xl font-semibold tabular">
                {signal.confidence.toFixed(0)}
              </p>
              <Progress
                value={signal.confidence}
                max={85}
                className="mt-1.5 w-24"
                indicatorClassName={isBuy ? 'bg-bull' : 'bg-bear'}
              />
            </div>
          </div>

          {/* Levels */}
          <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
            <Level label="Entry" value={formatPrice(signal.entry, { withSymbol: false })} />
            <Level
              label="Stop loss"
              value={formatPrice(signal.stopLoss, { withSymbol: false })}
              sub={`${formatPercent(signal.riskPercent, { signed: false })} risk`}
              className="text-bear"
            />
            <Level label="Reward : risk" value={`${signal.riskRewardRatio.toFixed(2)} : 1`} />
            <Level
              label="Suggested size"
              value={`${signal.suggestedAllocationPercent.toFixed(1)}%`}
              sub="of capital"
            />
          </div>

          {signal.entryZone && (
            <p className="mt-3 text-[12px] text-muted-foreground">
              Entry zone {formatPrice(signal.entryZone.low, { withSymbol: false })} –{' '}
              {formatPrice(signal.entryZone.high, { withSymbol: false })} — exact fills are a
              backtest fiction, so the engine quotes a band.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Targets */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-muted-foreground" />
            <p className="text-[13px] font-medium">Targets</p>
          </div>

          <div className="mt-3 flex flex-col gap-3">
            {signal.targets.map((target) => (
              <div key={target.level} className="flex items-center gap-3">
                <Badge variant="outline" className="shrink-0">
                  T{target.level}
                </Badge>
                <span className="w-24 shrink-0 tabular font-mono text-[13px] font-medium">
                  {formatPrice(target.price, { withSymbol: false })}
                </span>
                <span className="w-16 shrink-0 text-[12px] text-muted-foreground">
                  {target.rr.toFixed(2)}R
                </span>
                <div className="flex-1">
                  <Progress
                    value={target.probability * 100}
                    size="sm"
                    indicatorClassName={isBuy ? 'bg-bull' : 'bg-bear'}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-[12px] tabular text-muted-foreground">
                  {(target.probability * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            Probability falls with distance. Any system quoting the same confidence for T3 as T1
            isn&apos;t modelling anything.
          </p>
        </CardContent>
      </Card>

      {/* Risk grade */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Risk level</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Composite of stop distance, volatility regime and confidence — not stop distance alone.
            </p>
          </div>
          <Badge variant={RISK_VARIANT[signal.riskLevel]}>
            {signal.riskLevel.replace('_', ' ')}
          </Badge>
        </CardContent>
      </Card>

      {/* Reasons */}
      {signal.reasons?.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Ranked reasons
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {signal.reasons.map((reason, index) => (
                <li key={index} className="text-[13px] leading-relaxed text-muted-foreground">
                  {reason}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Level({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[15px] font-semibold tabular font-mono', className)}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
