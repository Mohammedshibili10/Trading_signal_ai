'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Bell, Briefcase, CandlestickChart, Newspaper, Star, TrendingUp } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoTip } from '@/components/ui/tooltip';
import {
  ChangeIndicator,
  EmptyState,
  Private,
  QuoteRow,
  Section,
  StatCard,
} from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { ASSET_CLASSES, ASSET_CLASS_MAP, horizonFor } from '@/lib/constants';
import { statusMeta } from '@/lib/signal-status';
import { formatCompactINR, formatPercent, formatPrice, formatRelative, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setActiveAssetClass } from '@/store/slices/ui-slice';
import type { AssetClass, NewsItem, Quote, TradeSignal, Watchlist } from '@/types';

/**
 * Confidence a signal must carry to reach the dashboard.
 *
 * The engine refuses to issue anything below 45, and the scanner will not push
 * a notification below 62 — the bar for interrupting someone. The dashboard is
 * the same kind of surface: it is glanced at and trusted, not searched. So it
 * uses the same 62 rather than inventing a third threshold, and everything
 * between 45 and 62 stays on the signals page where it can be read in context.
 */
const DASHBOARD_MIN_CONFIDENCE = 62;

export default function DashboardPage() {
  const dispatch = useAppDispatch();
  const assetClass = useAppSelector((state) => state.ui.activeAssetClass);
  const user = useAppSelector((state) => state.auth.user);

  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: async () => (await endpoints.portfolio.summary()).data,
    staleTime: 30_000,
  });

  const indices = useQuery({
    queryKey: ['indices'],
    queryFn: async () => (await endpoints.instruments.indices()).data as { indices: Quote[] },
    refetchInterval: 30_000,
  });

  const overview = useQuery({
    queryKey: ['overview', assetClass],
    queryFn: async () => (await endpoints.instruments.overview(assetClass)).data,
    staleTime: 60_000,
  });

  // The dashboard shows only what can still be acted on.
  //
  // Every row here reads as "take this trade", so a cancelled, invalidated,
  // expired or closed-out setup does not belong: by the time it shows an
  // outcome the decision it describes has already been made. The full record,
  // outcomes included, lives on the signals page where it is the point.
  const signals = useQuery({
    queryKey: ['signals', 'recent', 'actionable'],
    queryFn: async () =>
      (
        await endpoints.analysis.recentSignals(6, undefined, {
          status: 'live',
          minConfidence: DASHBOARD_MIN_CONFIDENCE,
        })
      ).data as { signals: TradeSignal[] },
    staleTime: 60_000,
  });

  const watchlists = useQuery({
    queryKey: ['watchlists'],
    queryFn: async () => (await endpoints.watchlists.list()).data as Watchlist[],
    staleTime: 30_000,
  });

  const news = useQuery({
    queryKey: ['news', 'dashboard'],
    queryFn: async () => (await endpoints.news.list({ limit: 5 })).data as NewsItem[],
    staleTime: 5 * 60_000,
  });

  const summary = portfolio.data?.summary;
  const defaultWatchlist = watchlists.data?.find((list) => list.isDefault) ?? watchlists.data?.[0];

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      {/* Greeting */}
      <div>
        {/*
          suppressHydrationWarning on this node only.
          The greeting depends on the current hour, so a server render at
          11:59:59 IST and a client hydration at 12:00:01 legitimately produce
          different text. Deferring it to an effect would trade a mismatch that
          happens twice a day for a visible flash on every single load, so the
          narrow suppression is the better trade — and it is scoped to the one
          element whose content is genuinely time-dependent.
        */}
        <h1 className="text-xl font-semibold tracking-tight" suppressHydrationWarning>
          {greeting()}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Here&apos;s where your portfolio and the markets stand right now.
        </p>
      </div>

      {/* Portfolio summary */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Portfolio value"
          value={formatCompactINR(summary?.currentValue ?? 0)}
          loading={portfolio.isLoading}
          privateValue
          hint={summary ? `${summary.holdingsCount} holdings` : undefined}
        />
        <StatCard
          label="Today's P&L"
          value={formatCompactINR(summary?.dayPnl ?? 0)}
          changePercent={summary?.dayPnlPercent}
          loading={portfolio.isLoading}
          privateValue
        />
        <StatCard
          label="Total P&L"
          value={formatCompactINR(summary?.totalPnl ?? 0)}
          changePercent={summary?.totalPnlPercent}
          loading={portfolio.isLoading}
          privateValue
        />
        <StatCard
          label="Invested"
          value={formatCompactINR(summary?.totalInvested ?? 0)}
          loading={portfolio.isLoading}
          privateValue
          hint={
            summary?.bestPerformer
              ? `Best: ${summary.bestPerformer.symbol} ${formatPercent(summary.bestPerformer.pnlPercent)}`
              : undefined
          }
        />
      </div>

      {/* Indices strip */}
      <Section title="Indian indices" href="/markets">
        {indices.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(indices.data?.indices ?? []).slice(0, 6).map((index) => (
              <Link key={index.symbol} href={`/markets/${index.symbol}`}>
                <Card className="p-4 transition-colors hover:border-primary/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{index.name}</p>
                      <p className="mt-1 text-lg font-semibold tabular font-mono">
                        {formatPrice(index.price, { kind: 'INDEX', withSymbol: false })}
                      </p>
                    </div>
                    <ChangeIndicator
                      percent={index.changePercent}
                      className="shrink-0 text-[13px]"
                    />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Left column */}
        <div className="flex flex-col gap-8 lg:col-span-2">
          {/* AI signals */}
          <Section
            title="AI signals"
            description="Probability-based ideas. Every one shows its measured hit-rate."
            href="/signals"
          >
            {signals.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : (signals.data?.signals?.length ?? 0) === 0 ? (
              <EmptyState
                icon={CandlestickChart}
                title="Nothing actionable right now"
                description={
                  `This panel shows only live setups at ${DASHBOARD_MIN_CONFIDENCE}+ confidence. ` +
                  'The engine returns WAIT when nothing clears its reward:risk and confidence ' +
                  "floors — a normal and frequent result. Signals that have since been hit, " +
                  'stopped or cancelled are kept on the signals page.'
                }
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href="/signals">See all signals</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href="/scanners">Run a scanner</Link>
                    </Button>
                  </div>
                }
              />
            ) : (
              <div className="space-y-2">
                {signals.data!.signals.map((signal) => (
                  <SignalCard key={signal.id} signal={signal} />
                ))}
              </div>
            )}
          </Section>

          {/* Market overview */}
          <Section title="Markets" href="/markets">
            <Tabs
              value={assetClass}
              onValueChange={(value) => dispatch(setActiveAssetClass(value as AssetClass))}
            >
              <TabsList>
                {ASSET_CLASSES.map((item) => (
                  <TabsTrigger key={item.key} value={item.key}>
                    {item.short}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Card>
                <CardContent className="p-2 pt-3">
                  <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-bull">
                    Top gainers
                  </p>
                  {overview.isLoading ? (
                    <div className="space-y-1 p-2">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={index} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : (
                    (overview.data?.gainers ?? []).slice(0, 5).map((quote: Quote) => (
                      <QuoteRow key={quote.symbol} quote={quote} />
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-2 pt-3">
                  <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-bear">
                    Top losers
                  </p>
                  {overview.isLoading ? (
                    <div className="space-y-1 p-2">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <Skeleton key={index} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : (
                    (overview.data?.losers ?? []).slice(0, 5).map((quote: Quote) => (
                      <QuoteRow key={quote.symbol} quote={quote} />
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </Section>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-8">
          <Section title="Watchlist" href="/watchlist">
            <Card>
              <CardContent className="p-2 pt-2">
                {watchlists.isLoading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <Skeleton key={index} className="h-10 w-full" />
                    ))}
                  </div>
                ) : !defaultWatchlist || defaultWatchlist.items.length === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      icon={Star}
                      title="Nothing on your watchlist"
                      description="Add instruments to track them here."
                      action={
                        <Button asChild size="sm" variant="outline">
                          <Link href="/markets">Browse markets</Link>
                        </Button>
                      }
                    />
                  </div>
                ) : (
                  defaultWatchlist.items
                    .slice(0, 7)
                    .map((item) =>
                      item.quote ? (
                        <QuoteRow key={item.id} quote={item.quote} showClass />
                      ) : null,
                    )
                )}
              </CardContent>
            </Card>
          </Section>

          <Section title="Market news" href="/news">
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {news.isLoading ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton key={index} className="h-12 w-full" />
                    ))}
                  </div>
                ) : (news.data?.length ?? 0) === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      icon={Newspaper}
                      title="No news yet"
                      description="The ingest job polls every 10 minutes. Give it a moment after first start."
                    />
                  </div>
                ) : (
                  news.data!.map((item) => (
                    <a
                      key={item.id}
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block px-4 py-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-1.5 size-1.5 shrink-0 rounded-full',
                            item.stance === 'BULLISH'
                              ? 'bg-bull'
                              : item.stance === 'BEARISH'
                                ? 'bg-bear'
                                : 'bg-muted-foreground',
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-[13px] leading-snug">{truncate(item.headline, 110)}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {item.source} · {formatRelative(item.publishedAt)}
                          </p>
                        </div>
                      </div>
                    </a>
                  ))
                )}
              </CardContent>
            </Card>
          </Section>

          <Section title="Quick actions">
            <div className="grid grid-cols-2 gap-2">
              <QuickAction href="/portfolio" icon={Briefcase} label="Portfolio" />
              <QuickAction href="/risk" icon={TrendingUp} label="Position size" />
              <QuickAction href="/alerts" icon={Bell} label="Alerts" />
              <QuickAction href="/assistant" icon={CandlestickChart} label="Ask AI" />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function SignalCard({ signal }: { signal: TradeSignal }) {
  const isBuy = signal.action === 'BUY';
  const isSell = signal.action === 'SELL';
  const meta = ASSET_CLASS_MAP[signal.assetClass];
  const horizon = horizonFor(signal.horizon, signal.timeframe);

  return (
    <Link href={`/markets/${signal.symbol}`}>
      <Card className="p-4 transition-colors hover:border-primary/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={isBuy ? 'bull' : isSell ? 'bear' : 'neutral'}>{signal.action}</Badge>
              <span className="text-[14px] font-semibold">{signal.symbol}</span>
              {meta && (
                <Badge variant="outline" className={meta.chip}>
                  {meta.short}
                </Badge>
              )}
              {/* What kind of trade this is — the horizon leads, the bar it was
                  read on follows, because "Swing" is the actionable fact and
                  "H1" is only how it was derived. */}
              <InfoTip content={`${horizon.description} Typical hold: ${horizon.holding.toLowerCase()}.`}>
                <Badge variant="outline">{horizon.label}</Badge>
              </InfoTip>
              <span className="text-[11px] text-muted-foreground">{signal.timeframe}</span>
              {/* The feed now carries resolved signals too, so an outcome that
                  is no longer live has to say so — an unlabelled stopped-out
                  setup reads as a live call to take it. */}
              {signal.status && signal.status !== 'ACTIVE' && (
                <Badge
                  variant={statusMeta(signal.status).variant}
                  title={statusMeta(signal.status).hint}
                >
                  {statusMeta(signal.status).short}
                </Badge>
              )}
            </div>
            <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
              {signal.reasons?.[0] ?? signal.explanation}
            </p>
            {signal.createdAt && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {formatRelative(signal.createdAt)}
              </p>
            )}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[11px] text-muted-foreground">Confidence</p>
            <p className="text-lg font-semibold tabular">{Math.round(signal.confidence)}</p>
            <Progress
              value={signal.confidence}
              className="mt-1 w-16"
              size="sm"
              indicatorClassName={isBuy ? 'bg-bull' : isSell ? 'bg-bear' : 'bg-primary'}
            />
          </div>
        </div>

        {signal.entry && (
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-[12px]">
            <Metric label="Entry" value={formatPrice(signal.entry, { withSymbol: false })} />
            <Metric
              label="Stop"
              value={formatPrice(signal.stopLoss, { withSymbol: false })}
              className="text-bear"
            />
            <Metric label="R:R" value={`${signal.riskRewardRatio.toFixed(2)}:1`} />
          </div>
        )}
      </Card>
    </Link>
  );
}

function Metric({
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
      <p className={cn('tabular font-mono font-medium', className)}>{value}</p>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-4 text-center transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-[12px] font-medium">{label}</span>
    </Link>
  );
}

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
