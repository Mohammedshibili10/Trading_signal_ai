'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Radar, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChangeIndicator, EmptyState } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { ASSET_CLASSES, SCANNERS } from '@/lib/constants';
import { formatPrice, formatRelative, formatVolume } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AssetClass, ScannerKey, ScannerResult } from '@/types';

interface ScanResponse {
  scanner: ScannerKey;
  assetClass: AssetClass;
  timeframe: string;
  results: ScannerResult[];
  scanned: number;
  asOf: string;
  degraded: string | null;
}

export default function ScannersPage() {
  const [scanner, setScanner] = useState<ScannerKey>('BREAKOUT');
  const [assetClass, setAssetClass] = useState<AssetClass>('EQUITY');

  const definition = SCANNERS.find((item) => item.key === scanner)!;
  // Switching to a scan that doesn't cover the current category would 400.
  const effectiveClass = definition.classes.includes(assetClass) ? assetClass : definition.classes[0];

  const scan = useQuery({
    queryKey: ['scan', scanner, effectiveClass],
    queryFn: async () =>
      (await endpoints.scanners.run(scanner, effectiveClass, 30)).data as ScanResponse,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Scanners</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Filters run across the universe, then the engine scores what survives. Every row shows
            why it matched.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => scan.refetch()}
          loading={scan.isFetching}
        >
          <RefreshCw /> Rescan
        </Button>
      </div>

      {/* Scanner picker */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SCANNERS.map((item) => {
          const active = item.key === scanner;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setScanner(item.key)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                active
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border hover:border-primary/30 hover:bg-muted/40',
              )}
            >
              <p className={cn('text-[13px] font-medium', active && 'text-primary')}>{item.label}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* Category */}
      <Tabs
        value={effectiveClass}
        onValueChange={(value) => setAssetClass(value as AssetClass)}
      >
        <TabsList>
          {ASSET_CLASSES.filter((item) => definition.classes.includes(item.key)).map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.short}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {scan.data?.degraded && (
        <Card className="border-neutral-signal/30 bg-neutral-signal/5">
          <CardContent className="flex items-start gap-2.5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-neutral-signal" />
            <p className="text-[12px] text-muted-foreground">{scan.data.degraded}</p>
          </CardContent>
        </Card>
      )}

      {scan.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title="Scan failed"
          description={(scan.error as Error)?.message ?? 'Could not reach the API.'}
        />
      ) : scan.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : (scan.data?.results.length ?? 0) === 0 ? (
        <EmptyState
          icon={Radar}
          title="Nothing matched"
          description={`${definition.label} found no qualifying instruments in ${scan.data?.scanned ?? 0} scanned. An empty scan is a real answer — the setup isn't there right now.`}
        />
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Instrument</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-right font-medium">Change</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Vol ×</th>
                      <th className="hidden px-3 py-2 text-right font-medium md:table-cell">RSI</th>
                      <th className="px-3 py-2 text-right font-medium">Signal</th>
                      <th className="px-3 py-2 text-right font-medium">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.data!.results.map((row) => (
                      <ScannerRow key={row.symbol} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <p className="text-[11px] text-muted-foreground">
            {scan.data!.results.length} of {scan.data!.scanned} scanned on{' '}
            {scan.data!.timeframe} · {formatRelative(scan.data!.asOf)}. Signals are attached to the
            top rows only — each one is a full engine run.
          </p>
        </>
      )}
    </div>
  );
}

function ScannerRow({ row }: { row: ScannerResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/40"
        onClick={() => setExpanded((value) => !value)}
      >
        <td className="px-3 py-2.5">
          <Link
            href={`/markets/${row.symbol}`}
            className="block"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="font-medium">{row.symbol}</p>
            <p className="truncate text-[11px] text-muted-foreground">{row.name}</p>
          </Link>
        </td>
        <td className="px-3 py-2.5 text-right tabular font-mono">
          {formatPrice(row.price, { withSymbol: false })}
        </td>
        <td className="px-3 py-2.5 text-right">
          <ChangeIndicator percent={row.changePercent} showIcon={false} />
        </td>
        <td className="hidden px-3 py-2.5 text-right tabular font-mono text-muted-foreground sm:table-cell">
          {row.volumeRatio ? `${row.volumeRatio.toFixed(1)}×` : '—'}
        </td>
        <td className="hidden px-3 py-2.5 text-right tabular font-mono md:table-cell">
          <span
            className={cn(
              row.rsi === null
                ? 'text-muted-foreground'
                : row.rsi >= 70
                  ? 'text-bear'
                  : row.rsi <= 30
                    ? 'text-bull'
                    : 'text-muted-foreground',
            )}
          >
            {row.rsi === null ? '—' : row.rsi.toFixed(0)}
          </span>
        </td>
        <td className="px-3 py-2.5 text-right">
          <Badge
            variant={
              row.signal === 'BUY' ? 'bull' : row.signal === 'SELL' ? 'bear' : 'secondary'
            }
          >
            {row.signal}
          </Badge>
        </td>
        <td className="px-3 py-2.5">
          <div className="ml-auto flex w-16 items-center gap-1.5">
            <span className="tabular font-mono text-[12px]">{row.score}</span>
            <Progress value={row.score} size="sm" className="w-8" />
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-border bg-muted/25">
          <td colSpan={7} className="px-3 py-2.5">
            <ul className="flex flex-col gap-1">
              {row.matched.map((reason) => (
                <li key={reason} className="text-[12px] text-muted-foreground">
                  · {reason}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Volume {formatVolume(row.volume)}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
