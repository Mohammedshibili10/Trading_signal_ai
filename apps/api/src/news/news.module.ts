import {
  Controller,
  DefaultValuePipe,
  Get,
  Injectable,
  Logger,
  Module,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

import { AnalysisModule } from '../analysis/analysis.module';
import { AiClientService } from '../analysis/ai-client.service';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * RSS sources. Free, reliable, no rate limits, and legally safe to summarise
 * with attribution. Only headline, summary, link, source and timestamp are
 * stored — full article text is never copied. See docs/data-sources.md §5.
 */
const FEEDS: Array<{ url: string; source: string; assetClasses: string[] }> = [
  { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', source: 'Economic Times', assetClasses: ['EQUITY'] },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml', source: 'Moneycontrol', assetClasses: ['EQUITY'] },
  { url: 'https://www.moneycontrol.com/rss/business.xml', source: 'Moneycontrol', assetClasses: ['EQUITY'] },
  { url: 'https://www.business-standard.com/rss/markets-106.rss', source: 'Business Standard', assetClasses: ['EQUITY'] },
  { url: 'https://www.livemint.com/rss/markets', source: 'Mint', assetClasses: ['EQUITY'] },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk', assetClasses: ['CRYPTO'] },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph', assetClasses: ['CRYPTO'] },
  { url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet', assetClasses: ['FOREX'] },
];

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiClientService,
  ) {}

  async list(options: { symbol?: string; assetClass?: string; limit?: number } = {}) {
    const limit = Math.min(options.limit ?? 30, 100);

    return this.prisma.newsItem.findMany({
      where: {
        ...(options.symbol ? { symbols: { has: options.symbol.toUpperCase() } } : {}),
        ...(options.assetClass ? { assetClasses: { has: options.assetClass as never } } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Poll every feed, classify new items, store them.
   *
   * Run by a scheduled job on a 10-minute cadence. Deduplicated on a URL hash
   * because RSS feeds repeat items across polls constantly.
   */
  async ingest(): Promise<{ fetched: number; stored: number }> {
    let fetched = 0;
    let stored = 0;

    const results = await Promise.allSettled(FEEDS.map((feed) => this.fetchFeed(feed)));

    const candidates: Array<{
      fingerprint: string;
      headline: string;
      summary: string;
      url: string;
      source: string;
      publishedAt: Date;
      assetClasses: string[];
    }> = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        fetched += result.value.length;
        candidates.push(...result.value);
      }
    }

    if (candidates.length === 0) return { fetched, stored };

    // Skip anything already stored before spending classification effort on it.
    const existing = await this.prisma.newsItem.findMany({
      where: { fingerprint: { in: candidates.map((c) => c.fingerprint) } },
      select: { fingerprint: true },
    });
    const known = new Set(existing.map((e) => e.fingerprint));
    const fresh = candidates.filter((c) => !known.has(c.fingerprint));

    if (fresh.length === 0) return { fetched, stored };

    let classified: ClassifiedItem[] = [];
    try {
      const response = await this.ai.post<{ items: ClassifiedItem[] }>('/sentiment', {
        items: fresh.map((item) => ({
          headline: item.headline,
          summary: item.summary,
          source: item.source,
          ageHours: (Date.now() - item.publishedAt.getTime()) / 3_600_000,
        })),
      });
      classified = response.items ?? [];
    } catch {
      // Store unclassified rather than dropping the news entirely — the
      // headlines are still useful, they just carry no stance.
      this.logger.warn('sentiment classification unavailable; storing news unclassified');
    }

    for (const [index, item] of fresh.entries()) {
      const sentiment = classified[index];
      try {
        await this.prisma.newsItem.create({
          data: {
            fingerprint: item.fingerprint,
            headline: item.headline,
            summary: item.summary.slice(0, 1000),
            url: item.url,
            source: item.source,
            publishedAt: item.publishedAt,
            symbols: this.extractSymbols(`${item.headline} ${item.summary}`),
            assetClasses: item.assetClasses as never,
            stance: (sentiment?.stance as never) ?? 'NEUTRAL',
            confidence: sentiment?.confidence ?? 0,
            impact: sentiment?.impact ?? 'LOW',
            whyItMatters: sentiment?.whyItMatters,
            expectedImpact: sentiment?.expectedImpact,
            model: sentiment?.model,
          },
        });
        stored += 1;
      } catch {
        /* duplicate fingerprint from a concurrent run */
      }
    }

    await this.redis.delPattern('news:*');
    this.logger.log(`news ingest: ${fetched} fetched, ${stored} new`);
    return { fetched, stored };
  }

  private async fetchFeed(feed: { url: string; source: string; assetClasses: string[] }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingIntelligence/1.0)' },
      });
      if (!response.ok) return [];

      const xml = await response.text();
      const parsed = this.parser.parse(xml) as RssDocument;
      const items = parsed?.rss?.channel?.item ?? [];
      const list = Array.isArray(items) ? items : [items];

      return list.slice(0, 25).map((item) => {
        const link = String(item.link ?? '').trim();
        return {
          fingerprint: createHash('sha256').update(link || String(item.title)).digest('hex'),
          headline: this.clean(String(item.title ?? '')),
          summary: this.clean(String(item.description ?? '')).slice(0, 600),
          url: link,
          source: feed.source,
          publishedAt: this.parseDate(item.pubDate),
          assetClasses: feed.assetClasses,
        };
      }).filter((item) => item.headline && item.url);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Strip HTML and collapse whitespace — RSS descriptions are full of markup. */
  private clean(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseDate(value: unknown): Date {
    if (!value) return new Date();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  /**
   * Crude symbol extraction: match known tickers appearing as whole words.
   *
   * Deliberately conservative — a false symbol association would feed the wrong
   * sentiment into that instrument's analysis, which is worse than missing it.
   */
  private extractSymbols(text: string): string[] {
    const upper = text.toUpperCase();
    const found = new Set<string>();

    for (const symbol of KNOWN_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(upper)) found.add(symbol);
    }
    return [...found].slice(0, 6);
  }
}

/** Headline names only. Broad matching produces more noise than signal. */
const KNOWN_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL',
  'ITC', 'LT', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI',
  'ASIANPAINT', 'WIPRO', 'HCLTECH', 'ADANIENT', 'TATAMOTORS', 'TATASTEEL',
  'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'ONGC', 'NTPC', 'POWERGRID',
  'NIFTY50', 'BANKNIFTY', 'SENSEX', 'BTC', 'ETH', 'SOL', 'XRP', 'USDINR',
];

interface ClassifiedItem {
  stance?: string;
  confidence?: number;
  impact?: string;
  whyItMatters?: string;
  expectedImpact?: string;
  model?: string;
}

interface RssDocument {
  rss?: {
    channel?: {
      item?: Array<{ title?: unknown; link?: unknown; description?: unknown; pubDate?: unknown }>;
    };
  };
}

@ApiTags('news')
@Controller('news')
class NewsController {
  constructor(private readonly news: NewsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Market news with AI sentiment classification' })
  list(
    @Query('symbol') symbol?: string,
    @Query('assetClass') assetClass?: string,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit?: number,
  ) {
    return this.news.list({ symbol, assetClass, limit });
  }
}

@Module({
  imports: [AnalysisModule],
  controllers: [NewsController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
