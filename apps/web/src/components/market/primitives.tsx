'use client';

import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  changeTextClass,
  directionOf,
  formatCompact,
  formatPercent,
  formatPrice,
  formatVolume,
} from '@/lib/format';
import { ASSET_CLASS_MAP } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useAppSelector } from '@/store/hooks';
import type { Quote, Stance } from '@/types';

/** Masks amounts when privacy mode is on, for screen sharing. */
export function Private({ children }: { children: React.ReactNode }) {
  const privacyMode = useAppSelector((state) => state.ui.privacyMode);
  if (!privacyMode) return <>{children}</>;
  return <span className="select-none rounded bg-muted px-2 text-transparent">••••••</span>;
}

export function ChangeIndicator({
  value,
  percent,
  className,
  showIcon = true,
}: {
  value?: number | null;
  percent?: number | null;
  className?: string;
  showIcon?: boolean;
}) {
  const reference = percent ?? value ?? 0;
  const direction = directionOf(reference);
  const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;

  return (
    <span
      className={cn('inline-flex items-center gap-0.5 tabular font-mono', changeTextClass(reference), className)}
    >
      {showIcon && <Icon className="size-3.5 shrink-0" />}
      {value !== undefined && value !== null && <span>{formatPrice(Math.abs(value), { withSymbol: false })}</span>}
      {percent !== undefined && percent !== null && (
        <span className={value !== undefined && value !== null ? 'opacity-80' : undefined}>
          {value !== undefined && value !== null ? '(' : ''}
          {formatPercent(percent)}
          {value !== undefined && value !== null ? ')' : ''}
        </span>
      )}
    </span>
  );
}

export function StanceBadge({ stance, label }: { stance: Stance; label?: string }) {
  const variant = stance === 'BULLISH' ? 'bull' : stance === 'BEARISH' ? 'bear' : 'neutral';
  return <Badge variant={variant}>{label ?? stance.charAt(0) + stance.slice(1).toLowerCase()}</Badge>;
}

/** Headline metric tile. Used across the dashboard and portfolio. */
export function StatCard({
  label,
  value,
  change,
  changePercent,
  hint,
  loading,
  privateValue = false,
}: {
  label: string;
  value: React.ReactNode;
  change?: number | null;
  changePercent?: number | null;
  hint?: string;
  loading?: boolean;
  privateValue?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>

      {loading ? (
        <Skeleton className="mt-2 h-7 w-28" />
      ) : (
        <p className="mt-1.5 text-[22px] font-semibold leading-tight tabular">
          {privateValue ? <Private>{value}</Private> : value}
        </p>
      )}

      {!loading && (change !== undefined || changePercent !== undefined) && (
        <div className="mt-1 text-[13px]">
          <ChangeIndicator value={change ?? undefined} percent={changePercent ?? undefined} />
        </div>
      )}

      {hint && !loading && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** One instrument row. The workhorse of markets, watchlist and scanners. */
export function QuoteRow({ quote, showClass = false }: { quote: Quote; showClass?: boolean }) {
  const meta = ASSET_CLASS_MAP[quote.assetClass];

  return (
    <Link
      href={`/markets/${quote.symbol}`}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/60"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{quote.symbol}</span>
          {showClass && meta && (
            <Badge variant="outline" className={cn('shrink-0', meta.chip)}>
              {meta.short}
            </Badge>
          )}
          {quote.stale && (
            <Badge variant="secondary" className="shrink-0" title="Last known price — live feed unavailable">
              stale
            </Badge>
          )}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{quote.name}</p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-[13px] font-medium tabular font-mono">
          {formatPrice(quote.price, { kind: quote.kind, currency: quote.currency })}
        </p>
        <div className="text-[11px]">
          <ChangeIndicator percent={quote.changePercent} showIcon={false} />
        </div>
      </div>
    </Link>
  );
}

/** Table-style row with more columns, for the markets page. */
export function QuoteTableRow({ quote }: { quote: Quote }) {
  return (
    <tr className="border-b border-border transition-colors hover:bg-muted/40">
      <td className="px-3 py-2.5">
        <Link href={`/markets/${quote.symbol}`} className="block">
          <p className="text-[13px] font-medium">{quote.symbol}</p>
          <p className="truncate text-[11px] text-muted-foreground">{quote.name}</p>
        </Link>
      </td>
      <td className="px-3 py-2.5 text-right tabular font-mono text-[13px]">
        {formatPrice(quote.price, { kind: quote.kind, currency: quote.currency })}
      </td>
      <td className="px-3 py-2.5 text-right text-[13px]">
        <ChangeIndicator percent={quote.changePercent} showIcon={false} />
      </td>
      <td className="hidden px-3 py-2.5 text-right tabular font-mono text-[13px] text-muted-foreground sm:table-cell">
        {formatVolume(quote.volume)}
      </td>
      <td className="hidden px-3 py-2.5 text-right tabular font-mono text-[13px] text-muted-foreground md:table-cell">
        {quote.marketCap ? formatCompact(quote.marketCap, quote.currency) : '—'}
      </td>
    </tr>
  );
}

/** Consistent empty state. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      {Icon && (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      )}
      <div>
        <p className="text-[14px] font-medium">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Section wrapper with an optional "View more" link, per the brief. */
export function Section({
  title,
  description,
  href,
  action,
  children,
}: {
  title: string;
  description?: string;
  href?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {action ??
          (href && (
            <Link
              href={href}
              className="shrink-0 text-[13px] font-medium text-primary hover:underline"
            >
              View more
            </Link>
          ))}
      </div>
      {children}
    </section>
  );
}
