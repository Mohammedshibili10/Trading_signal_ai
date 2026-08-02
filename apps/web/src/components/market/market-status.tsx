'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { endpoints } from '@/lib/api';
import { cn } from '@/lib/utils';

export type MarketState = 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';

export interface MarketStatus {
  exchange: string;
  name: string;
  timezone: string;
  state: MarketState;
  isOpen: boolean;
  tradeable: boolean;
  label: string;
  localTime: string;
  nextChange: string | null;
  nextChangeLabel: string | null;
  holidaysUnknown: boolean;
  note: string;
}

/** The four states, with the dot colour each is described by. */
const STATE_META: Record<
  MarketState,
  { dot: string; text: string; variant: 'bull' | 'bear' | 'neutral' | 'secondary'; label: string }
> = {
  OPEN: { dot: 'bg-bull', text: 'text-bull', variant: 'bull', label: 'Market Open' },
  CLOSED: { dot: 'bg-bear', text: 'text-bear', variant: 'bear', label: 'Market Closed' },
  PRE_MARKET: {
    dot: 'bg-neutral-signal',
    text: 'text-neutral-signal',
    variant: 'neutral',
    label: 'Pre-Market',
  },
  AFTER_HOURS: {
    dot: 'bg-chart-4',
    text: 'text-chart-4',
    variant: 'neutral',
    label: 'After-Hours',
  },
};

/**
 * Countdown to an absolute instant.
 *
 * The instant comes from the server and the client only does arithmetic on it.
 * Recomputing "is the market open" in the browser would mean a second copy of
 * the holiday and DST rules, which is exactly the duplication that let a
 * forex bug live in two files at once.
 *
 * Ticks locally rather than polling — a countdown that refetched every second
 * would issue 3,600 requests an hour to display a number the client can
 * already derive.
 */
function useCountdown(target: string | null, serverTime?: string): string | null {
  /**
   * The countdown is computed in an effect, never during render.
   *
   * An earlier version called `Date.now()` in the render body. That is a
   * guaranteed hydration mismatch: the server renders the remaining time at
   * one instant, the browser re-renders it at another, and React finds two
   * different strings for the same node. It is the second bullet in Next.js's
   * own hydration-error list, and the fix is not to suppress the warning but
   * to stop rendering a time-dependent value on the server at all.
   *
   * `null` on the first paint means callers render no countdown until the
   * client takes over — which is correct, because the server genuinely does
   * not know what time it is on the user's screen.
   */
  const [display, setDisplay] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setDisplay(null);
      return;
    }

    // Offset between the server's clock and this machine's. A browser several
    // minutes out would otherwise count down against a correct instant and
    // show a confidently wrong number.
    const skew = serverTime ? new Date(serverTime).getTime() - Date.now() : 0;
    const targetMs = new Date(target).getTime();

    const tick = () => {
      const remaining = targetMs - (Date.now() + skew);
      if (remaining <= 0) {
        setDisplay(null);
        return;
      }

      const totalSeconds = Math.floor(remaining / 1000);
      const days = Math.floor(totalSeconds / 86_400);
      const hours = Math.floor((totalSeconds % 86_400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      setDisplay(
        days > 0
          ? `${days}d ${hours}h`
          : hours > 0
            ? `${hours}h ${String(minutes).padStart(2, '0')}m`
            : `${minutes}m ${String(seconds).padStart(2, '0')}s`,
      );
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target, serverTime]);

  return display;
}

/** Compact badge — for the topbar and instrument headers. */
export function MarketStatusBadge({
  status,
  serverTime,
  showCountdown = true,
}: {
  status?: MarketStatus;
  serverTime?: string;
  showCountdown?: boolean;
}) {
  const countdown = useCountdown(status?.nextChange ?? null, serverTime);
  if (!status) return null;

  const meta = STATE_META[status.state];

  return (
    <Badge variant={meta.variant} title={`${status.name} · ${status.note}`}>
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          meta.dot,
          status.state === 'OPEN' && 'animate-pulse',
        )}
        aria-hidden
      />
      {meta.label}
      {showCountdown && countdown && (
        <span className="opacity-70">
          · {status.nextChangeLabel?.toLowerCase()} in {countdown}
        </span>
      )}
    </Badge>
  );
}

/**
 * The banner shown when signals are unavailable.
 *
 * States plainly what is and is not affected. A closed market does not stop
 * historical analysis or backtesting, and saying so prevents the page reading
 * as broken rather than as waiting.
 */
export function MarketClosedBanner({
  status,
  serverTime,
}: {
  status?: MarketStatus;
  serverTime?: string;
}) {
  const countdown = useCountdown(status?.nextChange ?? null, serverTime);
  if (!status || status.tradeable) return null;

  const meta = STATE_META[status.state];
  const extended = status.state === 'PRE_MARKET' || status.state === 'AFTER_HOURS';

  return (
    <Card className={cn('border-neutral-signal/30 bg-neutral-signal/5')}>
      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex items-start gap-3">
          <span
            className={cn('mt-1.5 size-2 shrink-0 rounded-full', meta.dot)}
            aria-hidden
          />
          <div>
            <p className="text-[13px] font-medium">
              {extended
                ? `${meta.label} — live signals are temporarily unavailable`
                : 'Market Closed — live signals are temporarily unavailable'}
            </p>
            <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
              {extended
                ? `${status.name} is in its ${meta.label.toLowerCase()} session. Prices print, but on thin volume in a session this engine's calibration was never measured against, so no signal is issued.`
                : `${status.label}. ${status.note}`}{' '}
              Historical analysis, backtesting and the trade journal all remain available, and live
              analysis resumes automatically when the market reopens.
            </p>
            {status.holidaysUnknown && (
              <p className="mt-1 text-[11px] text-neutral-signal">
                The holiday calendar for this year has not been loaded, so a market holiday could
                be reported as an ordinary closure.
              </p>
            )}
          </div>
        </div>

        {countdown && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {status.nextChangeLabel ?? 'Next session'}
            </p>
            <p className="tabular font-mono text-[15px] font-semibold">{countdown}</p>
            <p className="text-[11px] text-muted-foreground">
              {status.localTime} local · {status.timezone.split('/')[1]?.replace('_', ' ')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Status for one instrument, resolved server-side to its actual exchange. */
export function useSymbolMarketStatus(symbol: string | undefined) {
  return useQuery({
    queryKey: ['market-status', symbol],
    queryFn: async () =>
      (await endpoints.market.symbolStatus(symbol!)).data as MarketStatus & { serverTime: string },
    enabled: Boolean(symbol),
    // The countdown ticks locally; this only needs to catch the transition
    // itself and any holiday the client cannot know about.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** Every exchange at once — for the markets overview and the topbar. */
export function useAllMarketStatus() {
  return useQuery({
    queryKey: ['market-status-all'],
    queryFn: async () =>
      (await endpoints.market.status()).data as {
        exchanges: MarketStatus[];
        serverTime: string;
      },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** Full grid — one card per venue. */
export function MarketStatusGrid() {
  const { data, isLoading } = useAllMarketStatus();

  if (isLoading || !data) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.exchanges.map((status) => (
        <ExchangeCard key={status.exchange} status={status} serverTime={data.serverTime} />
      ))}
    </div>
  );
}

function ExchangeCard({ status, serverTime }: { status: MarketStatus; serverTime: string }) {
  const countdown = useCountdown(status.nextChange, serverTime);
  const meta = STATE_META[status.state];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  meta.dot,
                  status.state === 'OPEN' && 'animate-pulse',
                )}
                aria-hidden
              />
              <p className="truncate text-[13px] font-medium">{status.exchange}</p>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{status.name}</p>
          </div>
          <span className={cn('shrink-0 text-[12px] font-medium', meta.text)}>{meta.label}</span>
        </div>

        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2.5">
          <span className="tabular font-mono text-[12px] text-muted-foreground">
            {status.localTime} local
          </span>
          {countdown ? (
            <span className="tabular font-mono text-[12px]">
              {status.nextChangeLabel?.toLowerCase()} in {countdown}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {status.state === 'OPEN' && !status.nextChange ? 'never closes' : '—'}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
