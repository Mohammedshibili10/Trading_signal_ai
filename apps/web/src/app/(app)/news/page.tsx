'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Newspaper } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/market/primitives';
import { endpoints } from '@/lib/api';
import { ASSET_CLASSES } from '@/lib/constants';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AssetClass, NewsItem } from '@/types';

const IMPACT_TONE = {
  HIGH: 'border-l-bear',
  MEDIUM: 'border-l-neutral-signal',
  LOW: 'border-l-border',
} as const;

export default function NewsPage() {
  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>('ALL');

  const { data, isLoading } = useQuery({
    queryKey: ['news', assetClass],
    queryFn: async () =>
      (
        await endpoints.news.list({
          assetClass: assetClass === 'ALL' ? undefined : assetClass,
          limit: 60,
        })
      ).data as NewsItem[],
    refetchInterval: 5 * 60_000,
  });

  const items = data ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Market news</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Headlines classified by a finance-tuned sentiment model. News mostly confirms what price
          is already doing — treat it as supporting evidence, not a trigger.
        </p>
      </div>

      <Tabs value={assetClass} onValueChange={(value) => setAssetClass(value as AssetClass | 'ALL')}>
        <TabsList>
          <TabsTrigger value="ALL">All</TabsTrigger>
          {ASSET_CLASSES.filter((item) => item.key !== 'INVESTMENT').map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.short}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Newspaper}
          title="No news yet"
          description="The ingest job polls RSS feeds every 10 minutes. If the API has only just started, give it a moment."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer">
              <Card
                className={cn(
                  'border-l-2 transition-colors hover:border-primary/40',
                  IMPACT_TONE[item.impact],
                )}
              >
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        item.stance === 'BULLISH'
                          ? 'bull'
                          : item.stance === 'BEARISH'
                            ? 'bear'
                            : 'secondary'
                      }
                    >
                      {item.stance.toLowerCase()}
                    </Badge>
                    {item.impact === 'HIGH' && <Badge variant="neutral">high impact</Badge>}
                    <span className="text-[11px] text-muted-foreground">
                      {item.source} · {formatRelative(item.publishedAt)}
                    </span>
                    {item.symbols.length > 0 && (
                      <div className="flex gap-1">
                        {item.symbols.slice(0, 3).map((symbol) => (
                          <Badge key={symbol} variant="outline">
                            {symbol}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                  </div>

                  <h2 className="mt-2 text-[14px] font-medium leading-snug">{item.headline}</h2>

                  {item.summary && (
                    <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                      {item.summary}
                    </p>
                  )}

                  {item.whyItMatters && (
                    <p className="mt-2 border-t border-border pt-2 text-[12px] leading-relaxed text-muted-foreground">
                      <span className="font-medium text-foreground">Why it matters: </span>
                      {item.whyItMatters}
                    </p>
                  )}
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
