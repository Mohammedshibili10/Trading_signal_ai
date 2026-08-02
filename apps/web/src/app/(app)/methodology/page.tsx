'use client';

import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { endpoints } from '@/lib/api';
import { cn } from '@/lib/utils';

interface EngineConfig {
  weights?: Record<string, number>;
  confidenceCap?: number;
  minRiskReward?: number;
  minConfidence?: number;
  minBars?: number;
  version?: string;
}

/** Display names and the reason each group earns its weight. */
const GROUPS: Array<{ key: string; label: string; why: string }> = [
  { key: 'TREND', label: 'Trend', why: 'The highest-information single input. Most setups fail because they fight it.' },
  { key: 'INDICATORS', label: 'Indicators', why: 'Normalised within the group so momentum is not counted four times.' },
  { key: 'PRICE_ACTION', label: 'Price action', why: 'Tested levels, breaks and retests — what price actually did.' },
  { key: 'MARKET_STRUCTURE', label: 'Market structure', why: 'Order blocks, fair value gaps, BOS/CHoCH, premium/discount.' },
  { key: 'CANDLESTICK', label: 'Candlestick', why: 'Capped at 10% because measured reliability rarely justifies more.' },
  { key: 'VOLUME', label: 'Volume', why: 'Confirmation of effort behind a move. Dropped for spot forex.' },
  { key: 'VOLATILITY', label: 'Volatility', why: 'Sets stop distance and position size, not direction.' },
  { key: 'NEWS', label: 'News', why: 'Sentiment with decay — a three-day-old headline is not today’s driver.' },
  { key: 'FUNDAMENTALS', label: 'Fundamentals', why: 'Equity and funds only; irrelevant to a currency pair on a 15-minute chart.' },
];

const REJECTIONS = [
  'Reward:risk at the first target is below 1.5',
  'Confidence is below 45',
  'The stop would sit more than 8% away',
  'Fewer than 60 bars of history are available',
  'Trend and market structure directly contradict each other',
];

export default function MethodologyPage() {
  const config = useQuery({
    queryKey: ['engine-config'],
    queryFn: async () => (await endpoints.analysis.engineConfig()).data as EngineConfig,
    staleTime: 30 * 60_000,
    retry: false,
  });

  const weights = config.data?.weights;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Methodology</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          How a number gets produced, and what it is and isn&apos;t claiming. Every weight below is
          read live from the running engine, so this page cannot drift from the code.
        </p>
      </div>

      <Section title="Per-candle anatomy">
        <p>
          Every bar is measured before anything tries to name it — body and wick shares, close
          location in range, range against ATR, volume ratio, gap, inside/outside, climax, and
          Wyckoff effort-versus-result.
        </p>
        <p>
          These exist for <em>every</em> bar, not just the ~5% that match a named pattern, and they
          carry more information than the label does. &ldquo;Wide-range bullish bar closing in the
          top 10% of its range on 2.4× volume&rdquo; is a description; &ldquo;marubozu&rdquo; is a
          name for it.
        </p>
      </Section>

      <Section title="Nine weighted factor groups">
        <p>
          Each group produces a score from −1 to +1. Those are blended by the weights below. Two
          rules do the heavy lifting: correlated indicators are grouped rather than counted
          separately, and unavailable groups are <strong>dropped with their weight
          redistributed</strong> — never scored as neutral, which would drag the blend toward zero
          and fake a balanced read.
        </p>

        {config.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              {GROUPS.map((group) => {
                const weight = weights?.[group.key];
                const percent = weight === undefined ? null : weight * (weight <= 1 ? 100 : 1);
                return (
                  <div key={group.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-medium">{group.label}</span>
                      <span className="tabular font-mono text-[13px]">
                        {percent === null ? '—' : `${percent.toFixed(0)}%`}
                      </span>
                    </div>
                    {percent !== null && (
                      <Progress value={percent} max={25} size="sm" className="mt-1.5" />
                    )}
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {group.why}
                    </p>
                  </div>
                );
              })}
              {!weights && (
                <p className="text-[12px] text-muted-foreground">
                  Weights are unavailable — the analysis service is not reachable. Start it with{' '}
                  <code>npm run ai</code>.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </Section>

      <Section title="Candlestick patterns are weighted honestly">
        <p>
          Bulkowski&apos;s testing across 103 patterns found most single-candle patterns resolve at
          52–56% — statistically a coin flip — and that the <strong>hanging man resolves as a
          bullish continuation about 59% of the time</strong>, the opposite of the textbook.
        </p>
        <p>
          So patterns are scored from measured behaviour, context multipliers are anchored on the{' '}
          <em>edge over random</em> rather than the raw percentage (a 50% pattern stays 50% however
          good the setup looks), and the whole group is capped.
        </p>
      </Section>

      <Section title="Calibration">
        <p>
          The engine re-runs itself over roughly the last 125 closed bars using only the data
          available at each bar, then compares its calls against what actually happened. It reports
          hit-rate, per-bucket reliability, calibration error and Brier score, and fits a monotone
          correction that pulls future probabilities toward measured reality.
        </p>
        <Card className="border-border bg-muted/30">
          <CardContent className="p-3.5">
            <p className="font-mono text-[12px]">
              Confidence 71 · measured hit-rate 63% over 250 bars · Brier 0.213
            </p>
          </CardContent>
        </Card>
        <p>
          With fewer than 100 scored samples it reports <em>not yet calibrated</em> rather than an
          unearned number. Confidence is hard-capped
          {config.data?.confidenceCap ? ` at ${config.data.confidenceCap}` : ''} — there is no market
          state in which this engine should claim near-certainty.
        </p>
      </Section>

      <Section title="WAIT is a real answer">
        <p>No signal is issued when any of these is true:</p>
        <ul className="flex flex-col gap-1.5">
          {REJECTIONS.map((rule) => (
            <li key={rule} className="flex gap-2 text-[13px]">
              <span className="text-muted-foreground">·</span>
              {rule}
            </li>
          ))}
        </ul>
        <p>
          On typical daily data the engine returns <Badge variant="neutral">WAIT</Badge> roughly 40%
          of the time, with the reason stated. That is the system working, not failing.
        </p>
      </Section>

      <Section title="Explanations cannot disagree with the arithmetic">
        <p>
          Reasons are ranked by <code>|score × weight|</code> — literally the terms that drove the
          number — and <strong>contradicting factors are always included</strong> by the same rule.
          When a language model key is configured it rephrases those factors into prose; it is
          forbidden from introducing claims or altering numbers. Without a key the same facts come
          back as templates.
        </p>
      </Section>

      <Section title="What this does not claim">
        <ul className="flex flex-col gap-2">
          {[
            'No guaranteed profits, and no "100% accurate" signals.',
            'Probabilities are calibrated historical frequencies, not promises. 65% confidence means that in similar past setups the call resolved correctly about 65% of the time — and that it will be wrong roughly a third of the time.',
            'Calibration is backward-looking. When a market’s character changes, measured hit-rates lag reality.',
            'No order-flow data — no L2 book, no options chain, no intraday FII/DII flows.',
            'Backtest ≠ live. Slippage, partial fills, market impact and psychology are not in the numbers.',
          ].map((item) => (
            <li key={item} className="flex gap-2 text-[13px] leading-relaxed">
              <span className="text-muted-foreground">·</span>
              {item}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          This is analysis software, not investment advice, and not a substitute for a
          SEBI-registered adviser.
        </p>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]">
        {children}
      </div>
    </section>
  );
}
