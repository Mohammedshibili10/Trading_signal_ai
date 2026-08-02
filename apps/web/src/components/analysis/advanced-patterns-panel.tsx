'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface HarmonicPattern {
  name: string;
  kind: string;
  stance: 'BULLISH' | 'BEARISH';
  confidence: number;
  status: 'FORMING' | 'COMPLETE' | 'INVALIDATED';
  startTime: number;
  endTime: number;
  completion: number;
  invalidation: number;
  targets: number[];
  points: Array<{ time: number; price: number; label: string }>;
  ratios: Array<{ label: string; actual: number; ideal: number; window: [number, number] }>;
  note: string;
}

export interface WaveLabel {
  label: string;
  startTime: number;
  endTime: number;
  startPrice: number;
  endPrice: number;
  ratio: number | null;
  note: string;
}

export interface ElliottResult {
  count: {
    structure: 'IMPULSE' | 'CORRECTION';
    direction: string;
    position: string;
    waves: WaveLabel[];
    confidence: number;
    stance: string;
    expectation: string;
    invalidation: number | null;
    projection: number | null;
    rules: Array<{ rule: string; passed: boolean; detail: string }>;
    note: string;
  } | null;
  score: number;
  summary: string;
}

/**
 * Harmonics and Elliott.
 *
 * Both are shown with their measurements visible — the Fibonacci ratios a
 * harmonic actually hit, the three Elliott rules and whether each held. These
 * are the two most interpretive methods in the engine, and presenting a
 * conclusion without the working would be asking for trust the method has not
 * earned.
 */
export function AdvancedPatternsPanel({
  harmonics,
  elliott,
}: {
  harmonics?: HarmonicPattern[];
  elliott?: ElliottResult;
}) {
  const live = (harmonics ?? []).filter((p) => p.status !== 'INVALIDATED');

  return (
    <div className="flex flex-col gap-4">
      {/* Harmonics */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Harmonic patterns
          </p>

          {(harmonics ?? []).length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              No XABCD structure in the recent swings sits inside the Fibonacci windows for a
              Gartley, Bat, Butterfly, Crab, Shark or Cypher.
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              {harmonics!.map((pattern, index) => (
                <div
                  key={`${pattern.kind}-${index}`}
                  className={cn(
                    'rounded-lg border p-3',
                    pattern.status === 'INVALIDATED'
                      ? 'border-border opacity-60'
                      : pattern.stance === 'BULLISH'
                        ? 'border-bull/25 bg-bull/5'
                        : 'border-bear/25 bg-bear/5',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{pattern.name}</span>
                      <Badge
                        variant={
                          pattern.status === 'COMPLETE'
                            ? pattern.stance === 'BULLISH'
                              ? 'bull'
                              : 'bear'
                            : pattern.status === 'FORMING'
                              ? 'neutral'
                              : 'secondary'
                        }
                      >
                        {pattern.status.toLowerCase()}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular font-mono text-[12px]">
                        {pattern.confidence.toFixed(0)}/100
                      </span>
                      <Progress value={pattern.confidence} max={78} size="sm" className="w-16" />
                    </div>
                  </div>

                  <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Cell label="D (entry)" value={formatPrice(pattern.completion, { withSymbol: false })} />
                    <Cell
                      label="Invalid beyond"
                      value={formatPrice(pattern.invalidation, { withSymbol: false })}
                      className="text-bear"
                    />
                    {pattern.targets.slice(0, 2).map((target, i) => (
                      <Cell
                        key={i}
                        label={`Target ${i + 1}`}
                        value={formatPrice(target, { withSymbol: false })}
                        className="text-bull"
                      />
                    ))}
                  </div>

                  {/* The measurements, not just the label. */}
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2">
                    {pattern.ratios.map((ratio) => (
                      <span key={ratio.label} className="text-[11px] text-muted-foreground">
                        {ratio.label}{' '}
                        <span className="tabular font-mono text-foreground">
                          {ratio.actual.toFixed(3)}
                        </span>{' '}
                        <span className="opacity-70">(want {ratio.ideal.toFixed(3)})</span>
                      </span>
                    ))}
                  </div>

                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {pattern.note}
                  </p>
                </div>
              ))}
            </div>
          )}

          {live.length > 0 && (
            <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Confidence is capped at 78 here. Published win rates for harmonics cluster in the
              55–65% range under favourable conditions, before accounting for the discretion in
              choosing which swings count.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Elliott */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Elliott Wave
          </p>

          {!elliott?.count ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              {elliott?.summary ??
                'No wave count satisfies the three Elliott rules on these swings.'}
            </p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    elliott.count.stance === 'BULLISH'
                      ? 'bull'
                      : elliott.count.stance === 'BEARISH'
                        ? 'bear'
                        : 'neutral'
                  }
                >
                  {elliott.count.structure.toLowerCase()}
                </Badge>
                <Badge variant="secondary">
                  {elliott.count.position.replace(/_/g, ' ').toLowerCase()}
                </Badge>
                <span className="tabular font-mono text-[12px] text-muted-foreground">
                  {elliott.count.confidence.toFixed(0)}/100
                </span>
              </div>

              <p className="mt-2 text-[13px] leading-relaxed">{elliott.count.expectation}</p>

              {/* Waves */}
              <div className="mt-3 flex flex-col gap-1.5">
                {elliott.count.waves.map((wave) => (
                  <div key={wave.label} className="flex items-center gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium">
                      {wave.label}
                    </span>
                    <span className="tabular font-mono text-[12px]">
                      {formatPrice(wave.startPrice, { withSymbol: false })} →{' '}
                      {formatPrice(wave.endPrice, { withSymbol: false })}
                    </span>
                    {wave.ratio !== null && (
                      <span className="text-[11px] text-muted-foreground">
                        {wave.ratio.toFixed(2)}×
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {wave.note}
                    </span>
                  </div>
                ))}
              </div>

              {/* The three rules, shown so the count can be argued with. */}
              <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-2.5">
                {elliott.count.rules.map((rule) => (
                  <div key={rule.rule} className="flex gap-2">
                    <span
                      className={cn(
                        'mt-0.5 text-[11px]',
                        rule.passed ? 'text-bull' : 'text-bear',
                      )}
                    >
                      {rule.passed ? '✓' : '✗'}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12px]">{rule.rule}</p>
                      <p className="text-[11px] text-muted-foreground">{rule.detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              {elliott.count.invalidation !== null && (
                <p className="mt-2.5 text-[12px] text-muted-foreground">
                  Count breaks beyond{' '}
                  <span className="tabular font-mono text-bear">
                    {formatPrice(elliott.count.invalidation, { withSymbol: false })}
                  </span>
                </p>
              )}

              <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                {elliott.count.note}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Cell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[13px] font-medium tabular font-mono', className)}>{value}</p>
    </div>
  );
}
