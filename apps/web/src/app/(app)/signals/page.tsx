'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CandlestickChart, Radio, Scan } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { useLiveSignals } from '@/lib/realtime';
import { ASSET_CLASSES, ASSET_CLASS_MAP } from '@/lib/constants';
import { formatPercent, formatPrice, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { statusMeta } from '@/lib/signal-status';
import type { AssetClass, TradeSignal } from '@/types';

export default function SignalsPage() {
  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>('ALL');

  const stored = useQuery({
    queryKey: ['signals', assetClass],
    queryFn: async () =>
      (await endpoints.analysis.recentSignals(50, assetClass === 'ALL' ? undefined : assetClass))
        .data as { signals: TradeSignal[] },
    refetchInterval: 60_000,
  });

  const storedSignals = useMemo(() => stored.data?.signals ?? [], [stored.data]);

  /**
   * Subscribe to every symbol currently on the feed.
   *
   * The gateway pushes a signal to whoever is subscribed to that symbol, so
   * this keeps the list current without waiting for the sixty-second poll —
   * and re-scoring existing rows means a signal that gets stopped out updates
   * in place rather than sitting there looking valid.
   */
  const watched = useMemo(
    () => [...new Set(storedSignals.map((signal) => signal.symbol))],
    [storedSignals],
  );
  const { signals: pushed, status: feedStatus } = useLiveSignals(watched);

  /** Live pushes win over the stored copy of the same signal. */
  const signals = useMemo(() => {
    const byId = new Map(storedSignals.map((signal) => [signal.id, signal]));
    for (const signal of pushed) byId.set(signal.id, signal);

    return [...byId.values()]
      .filter((signal) => assetClass === 'ALL' || signal.assetClass === assetClass)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [storedSignals, pushed, assetClass]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AI signals</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            Probability-based trade ideas. Every one carries its measured hit-rate, and the engine
            issues nothing when no setup clears its floors.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={feedStatus === 'live' ? 'bull' : 'secondary'}>
            <Radio className={cn('size-3', feedStatus === 'live' && 'animate-pulse')} />
            {feedStatus === 'live' ? 'live' : 'polling'}
          </Badge>
          <ScanButton assetClass={assetClass} onDone={() => stored.refetch()} />
        </div>
      </div>

      <Tabs value={assetClass} onValueChange={(value) => setAssetClass(value as AssetClass | 'ALL')}>
        <TabsList>
          <TabsTrigger value="ALL">All</TabsTrigger>
          {ASSET_CLASSES.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.short}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {stored.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <EmptyState
          icon={CandlestickChart}
          title="No active signals"
          description="Signals are generated when a setup clears the reward-to-risk floor of 1.5:1 and a confidence of 45. On typical daily data the engine returns WAIT about 40% of the time — that's the system working, not failing. Run a scan to score the universe now."
          action={<ScanButton assetClass={assetClass} onDone={() => stored.refetch()} />}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {signals.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Score the universe on demand.
 *
 * The background job issues signals on its own schedule; this is for when
 * someone wants an answer now. Capped server-side at 40 symbols per batch.
 */
function ScanButton({
  assetClass,
  onDone,
}: {
  assetClass: AssetClass | 'ALL';
  onDone: () => void;
}) {
  const universe = useQuery({
    queryKey: ['scan-universe', assetClass],
    queryFn: async () =>
      (
        await endpoints.instruments.list({
          assetClass: assetClass === 'ALL' ? 'EQUITY' : assetClass,
          limit: 30,
        })
      ).data as { items: Array<{ symbol: string; kind: string }> },
    staleTime: 10 * 60_000,
  });

  const scan = useMutation({
    mutationFn: async () => {
      const symbols = (universe.data?.items ?? [])
        .filter((item) => item.kind !== 'INDEX')
        .map((item) => item.symbol)
        .slice(0, 25);

      if (symbols.length === 0) throw new Error('No instruments to scan');
      return (await endpoints.analysis.batch(symbols, '1D', 45)).data as {
        signals: TradeSignal[];
        scored: number;
        failed: number;
        withheld?: Array<{ symbol: string; label: string; detail: string }>;
      };
    },
    onSuccess: (result) => {
      const count = result.signals.length;
      const withheld = result.withheld ?? [];

      toast.success(
        count === 0
          ? `Scored ${result.scored} instruments — none cleared the floors. WAIT is the answer right now.`
          : `${count} signal${count === 1 ? '' : 's'} from ${result.scored} instruments`,
      );

      // Reported rather than dropped in silence. A scan that quietly withholds
      // a setup looks identical to one that found nothing, and the two mean
      // opposite things — the second is "no opportunity", the first is "this
      // one was already tried and it did not work".
      if (withheld.length > 0) {
        toast.info(
          `${withheld.length} setup${withheld.length === 1 ? '' : 's'} withheld`,
          {
            description: withheld
              .slice(0, 3)
              .map((item) => `${item.symbol} — ${item.detail}`)
              .join('\n'),
            duration: 10_000,
          },
        );
      }

      onDone();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Button size="sm" variant="outline" loading={scan.isPending} onClick={() => scan.mutate()}>
      <Scan /> Scan now
    </Button>
  );
}

function SignalRow({ signal }: { signal: TradeSignal }) {
  const isBuy = signal.action === 'BUY';
  const meta = ASSET_CLASS_MAP[signal.assetClass];
  const t1 = signal.targets?.[0];
  const calibration = signal.calibration;

  return (
    <Link href={`/markets/${signal.symbol}`}>
      <Card className="transition-colors hover:border-primary/40">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={isBuy ? 'bull' : 'bear'}>{signal.action}</Badge>
                <span className="text-[14px] font-semibold">{signal.symbol}</span>
                <span className="text-[12px] text-muted-foreground">{signal.name}</span>
                {meta && (
                  <Badge variant="outline" className={meta.chip}>
                    {meta.short}
                  </Badge>
                )}
                <Badge variant="secondary">{signal.timeframe}</Badge>
                {signal.status !== 'ACTIVE' && (
                  // Was: green for anything that was not a stop-out, which
                  // painted cancelled and invalid setups as wins.
                  <Badge
                    variant={statusMeta(signal.status).variant}
                    title={statusMeta(signal.status).hint}
                  >
                    {statusMeta(signal.status).short}
                  </Badge>
                )}
              </div>

              <p className="mt-1.5 line-clamp-2 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
                {signal.explanation}
              </p>

              <p className="mt-1 text-[11px] text-muted-foreground">
                {formatRelative(signal.createdAt)}
                {calibration && calibration.samples >= 100 ? (
                  <>
                    {' · '}
                    measured hit-rate {(calibration.hitRate * 100).toFixed(0)}% over{' '}
                    {calibration.samples} bars · Brier {calibration.brierScore.toFixed(3)}
                  </>
                ) : (
                  ' · not yet calibrated on this instrument'
                )}
              </p>
            </div>

            <div className="shrink-0 text-right">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Confidence</p>
              <p className="text-xl font-semibold tabular">{signal.confidence.toFixed(0)}</p>
              <Progress
                value={signal.confidence}
                max={85}
                size="sm"
                className="mt-1 w-20"
                indicatorClassName={isBuy ? 'bg-bull' : 'bg-bear'}
              />
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-5">
            <Cell label="Entry" value={formatPrice(signal.entry, { withSymbol: false })} />
            <Cell
              label="Stop"
              value={formatPrice(signal.stopLoss, { withSymbol: false })}
              className="text-bear"
            />
            <Cell
              label="Target 1"
              value={t1 ? formatPrice(t1.price, { withSymbol: false }) : '—'}
              className="text-bull"
            />
            <Cell label="R:R" value={`${signal.riskRewardRatio.toFixed(2)}:1`} />
            <Cell label="Risk" value={formatPercent(signal.riskPercent, { signed: false })} />
          </div>

          {signal.reasons.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
              {signal.reasons.slice(0, 3).map((reason) => (
                <li key={reason} className="text-[11px] text-muted-foreground">
                  · {reason}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function Cell({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-[13px] font-medium tabular font-mono', className)}>{value}</p>
    </div>
  );
}
