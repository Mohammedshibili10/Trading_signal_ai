'use client';

import { AlertTriangle, Check, Minus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { InfoTip } from '@/components/ui/tooltip';
import { formatPercent, formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CalibrationReport, CandleForecast, ForecastFactor } from '@/types';

/**
 * The next-candle forecast.
 *
 * Deliberately shows probability and confidence as two separate numbers. They
 * answer different questions — "which way?" and "how much should you trust
 * that?" — and collapsing them into one figure is how prediction UIs end up
 * sounding certain about nothing.
 */
export function ForecastPanel({
  forecast,
  price,
}: {
  forecast: CandleForecast & {
    calibrationVerdict?: string;
    summary?: string;
    rawScore?: number;
  };
  price: number;
}) {
  const { anatomy } = forecast;
  const directional = Math.max(forecast.probUp, forecast.probDown);
  const bullish = forecast.bias === 'BULLISH';
  const bearish = forecast.bias === 'BEARISH';

  return (
    <div className="flex flex-col gap-4">
      {/* Headline */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Next candle
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <Badge variant={bullish ? 'bull' : bearish ? 'bear' : 'neutral'}>
                  {forecast.bias}
                </Badge>
                {forecast.bias !== 'NEUTRAL' && (
                  <span className="text-2xl font-semibold tabular">
                    {(directional * 100).toFixed(0)}%
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Expected move {formatPercent(forecast.expectedMovePercent)} · 1σ range{' '}
                {formatPrice(forecast.expectedRange.low, { withSymbol: false })}–
                {formatPrice(forecast.expectedRange.high, { withSymbol: false })}
              </p>
            </div>

            <div className="text-right">
              <InfoTip content="How much the engine trusts this read — falls when factors disagree, data is thin, or volatility is extreme. Hard-capped at 85.">
                <p className="cursor-help text-[11px] font-medium uppercase tracking-wide text-muted-foreground underline decoration-dotted">
                  Confidence
                </p>
              </InfoTip>
              <p className="mt-1 text-2xl font-semibold tabular">
                {forecast.confidence.toFixed(0)}
              </p>
              <Progress
                value={forecast.confidence}
                max={85}
                className="mt-1.5 w-24"
                indicatorClassName={bullish ? 'bg-bull' : bearish ? 'bg-bear' : 'bg-primary'}
              />
            </div>
          </div>

          {/* Probability split */}
          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted">
            <div className="bg-bull" style={{ width: `${forecast.probUp * 100}%` }} />
            <div className="bg-muted-foreground/30" style={{ width: `${forecast.probFlat * 100}%` }} />
            <div className="bg-bear" style={{ width: `${forecast.probDown * 100}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
            <span className="text-bull">Up {(forecast.probUp * 100).toFixed(0)}%</span>
            <span>Flat {(forecast.probFlat * 100).toFixed(0)}%</span>
            <span className="text-bear">Down {(forecast.probDown * 100).toFixed(0)}%</span>
          </div>

          {forecast.summary && (
            <p className="mt-4 border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
              {forecast.summary}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Calibration — the number that makes the others mean something */}
      <CalibrationCard
        calibration={forecast.calibration}
        verdict={forecast.calibrationVerdict}
      />

      {/* This candle's anatomy */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Current candle
          </p>
          <p className="mt-1 text-[15px] font-medium">{anatomy.classification}</p>

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Metric label="Body" value={`${(anatomy.bodyPercent * 100).toFixed(0)}%`} hint="of total range" />
            <Metric label="Upper wick" value={`${(anatomy.upperWickPercent * 100).toFixed(0)}%`} />
            <Metric label="Lower wick" value={`${(anatomy.lowerWickPercent * 100).toFixed(0)}%`} />
            <Metric
              label="Close position"
              value={anatomy.closeLocation.toFixed(2)}
              hint="−1 low … +1 high"
            />
            <Metric label="Range vs ATR" value={`${anatomy.rangeVsAtr.toFixed(2)}×`} />
            <Metric label="Volume" value={`${anatomy.volumeRatio.toFixed(2)}×`} hint="vs 20-bar avg" />
            <Metric
              label="Effort vs result"
              value={anatomy.effortVsResult === 'CONFIRMING' ? 'Confirming' : anatomy.effortVsResult === 'DIVERGENT' ? 'Divergent' : 'Neutral'}
              className={anatomy.effortVsResult === 'DIVERGENT' ? 'text-neutral-signal' : undefined}
            />
            <Metric label="Gap" value={formatPercent(anatomy.gapPercent)} />
          </div>

          {(anatomy.isClimactic || anatomy.isInside || anatomy.isOutside) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {anatomy.isClimactic && (
                <Badge variant="neutral">
                  <AlertTriangle className="size-3" /> Climactic — often exhaustion
                </Badge>
              )}
              {anatomy.isInside && <Badge variant="secondary">Inside bar</Badge>}
              {anatomy.isOutside && <Badge variant="secondary">Outside bar</Badge>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Factor breakdown */}
      <Card>
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Why — every factor, including the ones arguing against
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {[...forecast.factors]
              .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
              .map((factor) => (
                <FactorRow key={factor.group} factor={factor} />
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Invalidation */}
      <Card className="border-neutral-signal/30 bg-neutral-signal/5">
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-neutral-signal" />
          <div>
            <p className="text-[13px] font-medium">What would prove this wrong</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {forecast.invalidation.note}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FactorRow({ factor }: { factor: ForecastFactor }) {
  const magnitude = Math.abs(factor.score) * 100;
  const positive = factor.score > 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium">{factor.label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          weight {(factor.weight * 100).toFixed(0)}%
        </span>
      </div>

      {/* Bidirectional bar: left of centre is bearish, right is bullish. */}
      <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border" />
        <div
          className={cn('absolute top-0 h-full', positive ? 'bg-bull' : 'bg-bear')}
          style={{
            width: `${magnitude / 2}%`,
            left: positive ? '50%' : undefined,
            right: positive ? undefined : '50%',
          }}
        />
      </div>

      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{factor.detail}</p>
    </div>
  );
}

function CalibrationCard({
  calibration,
  verdict,
}: {
  calibration: CalibrationReport | null;
  verdict?: string;
}) {
  if (!calibration) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4">
          <p className="text-[13px] font-medium">Not yet calibrated</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {verdict ??
              'Too few scored bars on this instrument to measure the engine against reality. Treat the confidence as provisional.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const edge = calibration.hitRate - 0.5;
  const hasEdge = Math.abs(edge) > 0.02;

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <InfoTip content="The engine re-ran itself over past bars using only the data available at each one, then compared against what actually happened.">
              <p className="cursor-help text-[11px] font-medium uppercase tracking-wide text-muted-foreground underline decoration-dotted">
                Measured performance
              </p>
            </InfoTip>
            <p className="mt-1 text-xl font-semibold tabular">
              {(calibration.hitRate * 100).toFixed(1)}%
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                over {calibration.samples} bars
              </span>
            </p>
          </div>

          <Badge variant={hasEdge && edge > 0 ? 'bull' : hasEdge ? 'bear' : 'secondary'}>
            {hasEdge ? `${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}pt vs coin flip` : 'no measurable edge'}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-3">
          <Metric
            label="High confidence"
            value={
              calibration.highConfidenceSamples >= 10
                ? `${(calibration.highConfidenceHitRate * 100).toFixed(0)}%`
                : '—'
            }
            hint={`${calibration.highConfidenceSamples} calls`}
          />
          <Metric
            label="Brier score"
            value={calibration.brierScore.toFixed(3)}
            hint="0.25 = coin flip"
          />
          <Metric
            label="Calibration error"
            value={`${(calibration.calibrationError * 100).toFixed(1)}pt`}
            hint="predicted vs actual"
          />
        </div>

        {calibration.buckets.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-[11px] text-muted-foreground">
              Predicted vs actual, by confidence bucket
            </p>
            <div className="flex flex-col gap-1.5">
              {calibration.buckets.map((bucket) => (
                <div key={bucket.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-muted-foreground">{bucket.label}</span>
                  <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 bg-primary/25"
                      style={{ width: `${bucket.predicted * 100}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 border-r-2 border-foreground"
                      style={{ width: `${bucket.actual * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular font-mono text-muted-foreground">
                    {(bucket.predicted * 100).toFixed(0)} → {(bucket.actual * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {verdict && <p className="mt-3 text-[12px] text-muted-foreground">{verdict}</p>}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[13px] font-medium tabular', className)}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Per-bar prediction log — including the misses. */
export function CandleHistoryTable({
  candles,
  summary,
}: {
  candles: Array<{
    anatomy: { time: number; classification: string; volumeRatio: number };
    description: string;
    predicted: string | null;
    confidence: number | null;
    actual: string | null;
    correct: boolean | null;
    actualChangePercent?: number;
  }>;
  summary?: { scored: number; correct: number; hitRate: number | null; note: string };
}) {
  return (
    <div className="flex flex-col gap-3">
      {summary && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-[13px] text-muted-foreground">{summary.note}</p>
            {summary.hitRate !== null && (
              <Badge variant={summary.hitRate > 0.5 ? 'bull' : 'secondary'}>
                {(summary.hitRate * 100).toFixed(0)}% correct
              </Badge>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[32rem] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Candle</th>
                  <th className="px-3 py-2 text-left font-medium">Predicted</th>
                  <th className="px-3 py-2 text-right font-medium">Conf.</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-center font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {[...candles].reverse().map((row) => (
                  <tr
                    key={row.anatomy.time}
                    className="border-b border-border last:border-0 hover:bg-muted/40"
                  >
                    <td className="max-w-56 px-3 py-2">
                      <p className="truncate font-medium">{row.anatomy.classification}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(row.anatomy.time * 1000).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                        })}{' '}
                        · vol {row.anatomy.volumeRatio.toFixed(1)}×
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      {row.predicted ? (
                        <span className={row.predicted === 'UP' ? 'text-bull' : 'text-bear'}>
                          {row.predicted}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular font-mono text-muted-foreground">
                      {row.confidence?.toFixed(0) ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular font-mono">
                      {row.actualChangePercent !== undefined ? (
                        <span
                          className={
                            row.actualChangePercent > 0
                              ? 'text-bull'
                              : row.actualChangePercent < 0
                                ? 'text-bear'
                                : 'text-muted-foreground'
                          }
                        >
                          {formatPercent(row.actualChangePercent)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {row.correct === null ? (
                        <Minus className="mx-auto size-3.5 text-muted-foreground" />
                      ) : row.correct ? (
                        <Check className="mx-auto size-3.5 text-bull" />
                      ) : (
                        <X className="mx-auto size-3.5 text-bear" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
