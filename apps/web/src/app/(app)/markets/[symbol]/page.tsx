'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, Plus, Radio } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tabs,
  TabsContent,
  TabsListUnderline,
  TabsTriggerUnderline,
} from '@/components/ui/tabs';
import { PriceChart, type ChartMarker, type ChartOverlay, type ChartPriceLine } from '@/components/chart/price-chart';
import type { ChartSegment, ChartZone } from '@/components/chart/chart-primitives';
import {
  candlestickMarkers,
  dedupeMarkers,
  liquidityZones,
  patternPriceLines,
  patternSegments,
  priceActionMarkers,
  signalPriceLines,
  signalZones,
  smcMarkers,
  smcZones,
  trendlineSegments,
} from '@/components/chart/chart-marks';
import { ChartToolbar } from '@/components/chart/chart-toolbar';
import { ChartLegend } from '@/components/chart/chart-legend';
import { CandleHistoryTable, ForecastPanel } from '@/components/analysis/forecast-panel';
import { SignalPanel } from '@/components/analysis/signal-panel';
import { TechnicalPanel } from '@/components/analysis/technical-panel';
import { StructurePanel } from '@/components/analysis/structure-panel';
import {
  ConfluencePanel,
  type ChecklistResult,
  type ConfluenceResult,
} from '@/components/analysis/confluence-panel';
import { NoTradePanel, noTradeReasons } from '@/components/analysis/no-trade-panel';
import {
  AdvancedPatternsPanel,
  type ElliottResult,
  type HarmonicPattern,
} from '@/components/analysis/advanced-patterns-panel';
import { ChangeIndicator } from '@/components/market/primitives';
import {
  MarketClosedBanner,
  MarketStatusBadge,
  useSymbolMarketStatus,
} from '@/components/market/market-status';
import { endpoints } from '@/lib/api';
import { useLiveQuote } from '@/lib/realtime';
import { ASSET_CLASS_MAP, DEFAULT_TIMEFRAME } from '@/lib/constants';
import { formatCompact, formatPrice, formatVolume } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppSelector } from '@/store/hooks';
import type { AssetClass, Candle, Quote, Timeframe, TradeSignal } from '@/types';

export default function SymbolPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();

  const chartState = useAppSelector((state) => state.chart);
  const [timeframe, setTimeframe] = useState<Timeframe | null>(null);

  const quoteQuery = useQuery({
    queryKey: ['quote', symbol],
    queryFn: async () => (await endpoints.market.quote(symbol)).data as Quote,
    // The socket carries the live price; this is the first-paint value and the
    // fallback if the gateway is unreachable.
    refetchInterval: 30_000,
  });

  // Socket price wins when it arrives, REST value until then.
  const { quote: liveQuote, status: feedStatus } = useLiveQuote(symbol, quoteQuery.data);

  // Exchange-resolved market status, so a holiday or a pre-market session is
  // reported as what it is rather than lumped into "closed".
  const market = useSymbolMarketStatus(symbol);
  const quote = { ...quoteQuery, data: liveQuote };

  // Default the timeframe to something sensible for the category — 1D for
  // equities, 1h for forex and crypto — but let an explicit choice win.
  const effectiveTimeframe: Timeframe =
    timeframe ?? (quote.data ? DEFAULT_TIMEFRAME[quote.data.assetClass as AssetClass] : '1D');

  const isIntraday = ['1m', '5m', '15m', '30m', '1h'].includes(effectiveTimeframe);

  const candles = useQuery({
    queryKey: ['candles', symbol, effectiveTimeframe],
    queryFn: async () =>
      (await endpoints.market.candles(symbol, effectiveTimeframe, 400)).data as {
        candles: Candle[];
        source: string;
      },
    enabled: Boolean(quote.data),
    staleTime: 30_000,
    // An intraday bar is forming while you watch it; a daily one is not.
    refetchInterval: isIntraday ? 60_000 : false,
  });

  const analysis = useQuery({
    queryKey: ['analysis', symbol, effectiveTimeframe],
    queryFn: async () => (await endpoints.analysis.full(symbol, effectiveTimeframe)).data,
    enabled: Boolean(quote.data),
    staleTime: 60_000,
    // Re-analysing on every tick would be pointless — the engine is bar-based,
    // and the API caches for 60s regardless. Once a minute intraday matches the
    // rate at which the answer can actually change.
    refetchInterval: isIntraday ? 90_000 : false,
    retry: false,
  });

  /**
   * The strict read: every timeframe, plus the six-condition checklist.
   *
   * Its own query rather than part of the main analysis because it fetches ten
   * timeframes and takes materially longer — folding it in would make the chart
   * wait on work the chart does not need.
   */
  const confluence = useQuery({
    queryKey: ['confluence', symbol, effectiveTimeframe],
    queryFn: async () =>
      (await endpoints.confluence.gatedSignal(symbol, effectiveTimeframe)).data as {
        confluence: ConfluenceResult;
        checklist: ChecklistResult;
        signal: TradeSignal & { gatedBy?: string; explanation?: string };
        session?: {
          allowed?: boolean;
          reason?: string;
          label?: string;
          nextWindow?: string | null;
        };
        noTradeZone?: {
          blocked?: boolean;
          zones?: Array<{
            key: string;
            label: string;
            detail: string;
            guidance: string;
            severity: string;
          }>;
        };
        correlation?: { blocked?: boolean; summary?: string };
        confluenceGate: {
          gated: boolean;
          originalAction: string;
          originalConfidence: number;
          confidenceMultiplier: number;
        };
      },
    enabled: Boolean(quote.data),
    staleTime: 2 * 60_000,
    retry: false,
  });

  const candleHistory = useQuery({
    queryKey: ['candle-history', symbol, effectiveTimeframe],
    queryFn: async () =>
      (await endpoints.analysis.candleHistory(symbol, effectiveTimeframe, 40)).data,
    enabled: Boolean(quote.data),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const overlays: ChartOverlay[] = useMemo(() => {
    const series = candles.data?.candles ?? [];
    if (series.length === 0) return [];

    const closes = series.map((candle) => candle.close);
    const times = series.map((candle) => candle.time);
    const out: ChartOverlay[] = [];

    const ema = (period: number) => {
      const alpha = 2 / (period + 1);
      let value = closes[0];
      return closes.map((close, index) => {
        value = index === 0 ? close : close * alpha + value * (1 - alpha);
        return { time: times[index], value: index < period ? NaN : value };
      });
    };

    const sma = (period: number) =>
      closes.map((_, index) => ({
        time: times[index],
        value:
          index < period - 1
            ? NaN
            : closes.slice(index - period + 1, index + 1).reduce((sum, x) => sum + x, 0) / period,
      }));

    if (chartState.overlays.includes('ema20')) out.push({ key: 'ema20', label: 'EMA 20', colour: '#22d3ee', data: ema(20) });
    if (chartState.overlays.includes('ema50')) out.push({ key: 'ema50', label: 'EMA 50', colour: '#a78bfa', data: ema(50) });
    if (chartState.overlays.includes('ema200')) out.push({ key: 'ema200', label: 'EMA 200', colour: '#f59e0b', data: ema(200) });
    if (chartState.overlays.includes('sma50')) out.push({ key: 'sma50', label: 'SMA 50', colour: '#60a5fa', data: sma(50) });

    return out;
  }, [candles.data, chartState.overlays]);

  const meta = quote.data ? ASSET_CLASS_MAP[quote.data.assetClass as AssetClass] : undefined;
  const signal: TradeSignal | undefined = analysis.data?.signal;

  /**
   * Everything the engine found, translated onto the chart.
   *
   * Each group is gated on its own toggle so the chart can be read at whatever
   * density suits the question being asked — a beginner checking a trade plan
   * and someone reading order flow want very different charts.
   */
  const marks = useMemo(() => {
    const series = candles.data?.candles ?? [];
    const firstBar = series[0]?.time ?? 0;

    const zones: ChartZone[] = [];
    const segments: ChartSegment[] = [];
    const lines: ChartPriceLine[] = [];
    const rawMarkers: ChartMarker[] = [];

    if (chartState.showSignals && signal) {
      lines.push(...signalPriceLines(signal));
      zones.push(...signalZones(signal, firstBar));
    }

    if (chartState.showSmc) {
      zones.push(...smcZones(analysis.data?.smc));
      zones.push(...liquidityZones(analysis.data?.smc));
      rawMarkers.push(...smcMarkers(analysis.data?.smc));
    }

    if (chartState.showPatterns) {
      segments.push(...patternSegments(analysis.data?.chartPatterns));
      lines.push(...patternPriceLines(analysis.data?.chartPatterns));
      rawMarkers.push(...candlestickMarkers(analysis.data?.candlestickPatterns));
    }

    if (chartState.showLevels) {
      segments.push(...trendlineSegments(analysis.data?.priceAction));
      rawMarkers.push(...priceActionMarkers(analysis.data?.priceAction));
    }

    return { zones, segments, lines, markers: dedupeMarkers(rawMarkers) };
  }, [
    analysis.data,
    signal,
    candles.data,
    chartState.showSignals,
    chartState.showSmc,
    chartState.showPatterns,
    chartState.showLevels,
  ]);

  if (quote.isError) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h1 className="text-lg font-semibold">Unknown symbol</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          &ldquo;{symbol}&rdquo; isn&apos;t in the covered universe — Indian equities, forex, crypto
          and Indian investment products.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {quote.isLoading ? (
            <>
              <Skeleton className="h-7 w-40" />
              <Skeleton className="mt-2 h-9 w-56" />
            </>
          ) : quote.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{quote.data.symbol}</h1>
                {meta && (
                  <Badge variant="outline" className={meta.chip}>
                    {meta.label}
                  </Badge>
                )}
                <Badge variant="secondary">{quote.data.exchange}</Badge>
                <MarketStatusBadge
                  status={market.data}
                  serverTime={market.data?.serverTime}
                  showCountdown={false}
                />
                {quote.data.stale && (
                  <Badge variant="neutral" title="Live feed unavailable — showing the last known price">
                    <AlertTriangle className="size-3" /> stale
                  </Badge>
                )}
                <Badge
                  variant={feedStatus === 'live' ? 'bull' : 'secondary'}
                  title={
                    feedStatus === 'live'
                      ? 'Streaming over WebSocket'
                      : 'Socket unavailable — falling back to polling every 30s'
                  }
                >
                  <Radio className={cn('size-3', feedStatus === 'live' && 'animate-pulse')} />
                  {feedStatus === 'live' ? 'live' : 'polling'}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{quote.data.name}</p>

              <div className="mt-3 flex flex-wrap items-baseline gap-3">
                <span className="text-3xl font-semibold tabular font-mono">
                  {formatPrice(quote.data.price, {
                    kind: quote.data.kind,
                    currency: quote.data.currency,
                  })}
                </span>
                <ChangeIndicator
                  value={quote.data.change}
                  percent={quote.data.changePercent}
                  className="text-[15px]"
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Source: {quote.data.source}
              </p>
            </>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="outline">
            <Plus /> Watchlist
          </Button>
          <Button size="sm" variant="outline">
            <Bell /> Alert
          </Button>
        </div>
      </div>

      {/* Day stats */}
      {quote.data && (
        <Card>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Open" value={formatPrice(quote.data.open, { kind: quote.data.kind, withSymbol: false })} />
            <Stat label="High" value={formatPrice(quote.data.high, { kind: quote.data.kind, withSymbol: false })} />
            <Stat label="Low" value={formatPrice(quote.data.low, { kind: quote.data.kind, withSymbol: false })} />
            <Stat label="Prev close" value={formatPrice(quote.data.previousClose, { kind: quote.data.kind, withSymbol: false })} />
            <Stat label="Volume" value={formatVolume(quote.data.volume)} />
            <Stat label="52w high" value={quote.data.yearHigh ? formatPrice(quote.data.yearHigh, { kind: quote.data.kind, withSymbol: false }) : '—'} />
            <Stat
              label={quote.data.marketCap ? 'Market cap' : '52w low'}
              value={
                quote.data.marketCap
                  ? formatCompact(quote.data.marketCap, quote.data.currency)
                  : quote.data.yearLow
                    ? formatPrice(quote.data.yearLow, { kind: quote.data.kind, withSymbol: false })
                    : '—'
              }
            />
          </CardContent>
        </Card>
      )}

      <MarketClosedBanner status={market.data} serverTime={market.data?.serverTime} />

      {/* Chart */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <ChartToolbar
            assetClass={(quote.data?.assetClass as AssetClass) ?? 'EQUITY'}
            timeframe={effectiveTimeframe}
            onTimeframeChange={setTimeframe}
          />

          {candles.isLoading ? (
            <Skeleton className="mt-3 h-[420px] w-full" />
          ) : (candles.data?.candles.length ?? 0) === 0 ? (
            <div className="flex h-[420px] items-center justify-center">
              <p className="text-[13px] text-muted-foreground">
                No candles available for this timeframe.
              </p>
            </div>
          ) : (
            <div className="mt-3">
              <PriceChart
                candles={candles.data!.candles}
                type={chartState.chartType}
                overlays={overlays}
                levels={chartState.showLevels ? (analysis.data?.priceAction?.levels ?? []) : []}
                markers={marks.markers}
                priceLines={marks.lines}
                zones={marks.zones}
                segments={marks.segments}
                showVolume={chartState.panes.includes('volume')}
                timeframe={effectiveTimeframe}
                logScale={chartState.logScale}
                live={isIntraday}
                height={420}
              />

              <ChartLegend
                signal={chartState.showSignals ? signal : undefined}
                showSmc={chartState.showSmc}
                showPatterns={chartState.showPatterns}
                showLevels={chartState.showLevels}
                analysing={analysis.isFetching}
              />

              <p className="mt-2 text-[11px] text-muted-foreground">
                {candles.data!.candles.length} bars · source {candles.data!.source}
                {analysis.data?.asOf ? ` · analysed ${new Date(analysis.data.asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST` : ''}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Analysis */}
      {analysis.isError ? (
        <Card className="border-neutral-signal/30 bg-neutral-signal/5">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-neutral-signal" />
            <div>
              <p className="text-[13px] font-medium">Analysis unavailable</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {(analysis.error as Error)?.message ??
                  'The analysis service is not reachable. Start it with `npm run ai`.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="forecast">
          <TabsListUnderline>
            <TabsTriggerUnderline value="forecast">Forecast</TabsTriggerUnderline>
            <TabsTriggerUnderline value="signal">Signal</TabsTriggerUnderline>
            <TabsTriggerUnderline value="technical">Technical</TabsTriggerUnderline>
            <TabsTriggerUnderline value="structure">Structure</TabsTriggerUnderline>
            <TabsTriggerUnderline value="confluence">Confluence</TabsTriggerUnderline>
            <TabsTriggerUnderline value="advanced">Harmonics &amp; Elliott</TabsTriggerUnderline>
            <TabsTriggerUnderline value="candles">Candle log</TabsTriggerUnderline>
          </TabsListUnderline>

          <TabsContent value="forecast">
            {analysis.isLoading ? (
              <AnalysisSkeleton />
            ) : analysis.data?.forecast ? (
              <ForecastPanel forecast={analysis.data.forecast} price={analysis.data.price} />
            ) : null}
          </TabsContent>

          <TabsContent value="signal">
            {analysis.isLoading ? <AnalysisSkeleton /> : signal ? <SignalPanel signal={signal} /> : null}
          </TabsContent>

          <TabsContent value="technical">
            {analysis.isLoading ? (
              <AnalysisSkeleton />
            ) : analysis.data?.technical ? (
              <TechnicalPanel technical={analysis.data.technical} />
            ) : null}
          </TabsContent>

          <TabsContent value="structure">
            {analysis.isLoading ? (
              <AnalysisSkeleton />
            ) : analysis.data ? (
              <StructurePanel
                priceAction={analysis.data.priceAction}
                smc={analysis.data.smc}
                chartPatterns={analysis.data.chartPatterns}
                candlestickPatterns={analysis.data.candlestickPatterns}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="confluence">
            {/* The rejection, stated plainly, above the detail that supports it. */}
            {confluence.data?.signal?.action === 'WAIT' && (
              <div className="mb-4">
                <NoTradePanel
                  gatedBy={confluence.data.signal.gatedBy}
                  headline={
                    confluence.data.signal.explanation ||
                    confluence.data.confluence?.summary ||
                    'No setup currently clears the engine’s floors.'
                  }
                  reasons={noTradeReasons(confluence.data)}
                  nextWindow={confluence.data.session?.nextWindow}
                  originalAction={confluence.data.confluenceGate?.originalAction}
                  confidence={confluence.data.confluenceGate?.originalConfidence}
                />
              </div>
            )}

            <ConfluencePanel
              confluence={confluence.data?.confluence}
              checklist={confluence.data?.checklist}
              loading={confluence.isLoading}
              error={(confluence.error as Error)?.message}
            />
          </TabsContent>

          <TabsContent value="advanced">
            {analysis.isLoading ? (
              <AnalysisSkeleton />
            ) : (
              <AdvancedPatternsPanel
                harmonics={analysis.data?.harmonicPatterns as HarmonicPattern[] | undefined}
                elliott={analysis.data?.elliott as ElliottResult | undefined}
              />
            )}
          </TabsContent>

          <TabsContent value="candles">
            {candleHistory.isLoading ? (
              <AnalysisSkeleton />
            ) : candleHistory.data ? (
              <CandleHistoryTable
                candles={candleHistory.data.candles}
                summary={candleHistory.data.summary}
              />
            ) : (
              <p className="py-8 text-center text-[13px] text-muted-foreground">
                Needs at least 100 bars of history.
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium tabular font-mono">{value}</p>
    </div>
  );
}

function AnalysisSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-44 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
