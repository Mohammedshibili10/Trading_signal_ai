import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisService } from '../analysis/analysis.service';
import { Public } from '../common/decorators';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';
import { prioritise } from '../market-data/asset-priority';
import type { ProviderCandle, Timeframe } from '../market-data/providers/provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const SCANNER_KEYS = [
  'INTRADAY',
  'SWING',
  'BREAKOUT',
  'HIGH_VOLUME',
  'MOMENTUM',
  'GAP_UP',
  'GAP_DOWN',
  'STRONG_FUNDAMENTALS',
  'OVERSOLD',
  'OVERBOUGHT',
] as const;

export type ScannerKey = (typeof SCANNER_KEYS)[number];

/** Which asset classes each scan makes sense for. A gap scan on 24×7 crypto does not. */
const SCANNER_CLASSES: Record<ScannerKey, string[]> = {
  INTRADAY: ['EQUITY', 'FOREX', 'CRYPTO'],
  SWING: ['EQUITY', 'CRYPTO'],
  BREAKOUT: ['EQUITY', 'FOREX', 'CRYPTO'],
  HIGH_VOLUME: ['EQUITY', 'CRYPTO'],
  MOMENTUM: ['EQUITY', 'FOREX', 'CRYPTO'],
  GAP_UP: ['EQUITY'],
  GAP_DOWN: ['EQUITY'],
  STRONG_FUNDAMENTALS: ['EQUITY'],
  OVERSOLD: ['EQUITY', 'FOREX', 'CRYPTO'],
  OVERBOUGHT: ['EQUITY', 'FOREX', 'CRYPTO'],
};

/** The scan timeframe. Intraday scans read 15m bars, everything else daily. */
const SCANNER_TIMEFRAME: Record<ScannerKey, Timeframe> = {
  INTRADAY: '15m',
  SWING: '1D',
  BREAKOUT: '1D',
  HIGH_VOLUME: '1D',
  MOMENTUM: '1D',
  GAP_UP: '1D',
  GAP_DOWN: '1D',
  STRONG_FUNDAMENTALS: '1D',
  OVERSOLD: '1D',
  OVERBOUGHT: '1D',
};

/** How wide the universe goes. Beyond this the scan takes longer than it is worth. */
const UNIVERSE_CAP = 60;
/** How many rows get an AI signal attached. Each one is a full pipeline run. */
const SIGNAL_ENRICH_CAP = 10;

interface Metrics {
  price: number;
  changePercent: number;
  volume: number;
  volumeRatio: number;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  atrPercent: number | null;
  /** Highest high / lowest low of the prior 20 bars, excluding the current one. */
  priorHigh20: number | null;
  priorLow20: number | null;
  gapPercent: number;
  /** Close-to-close return over the last 20 bars, in percent. */
  momentum20: number | null;
  bars: number;
}

export interface ScannerRow {
  symbol: string;
  name: string;
  assetClass: string;
  price: number;
  changePercent: number;
  volume: number;
  volumeRatio: number;
  score: number;
  matched: string[];
  signal: 'BUY' | 'SELL' | 'HOLD' | 'WAIT';
  rsi: number | null;
  note: string;
}

/**
 * Market scanners.
 *
 * The filters run here in TypeScript rather than in the analysis engine, and
 * that is deliberate: a scan touches sixty instruments, and sixty full pipeline
 * runs (each of which does candle anatomy, SMC, pattern detection and a nine
 * group blend) costs seconds of CPU to answer a question that RSI, a volume
 * ratio and a twenty-bar high already answer.
 *
 * The engine is then asked for a real signal on the handful of rows that
 * survive, so the expensive analysis is spent only where it changes the answer.
 */
@Injectable()
export class ScannersService {
  private readonly logger = new Logger(ScannersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly analysis: AnalysisService,
    private readonly redis: RedisService,
  ) {}

  catalogue() {
    return SCANNER_KEYS.map((key) => ({
      key,
      assetClasses: SCANNER_CLASSES[key],
      timeframe: SCANNER_TIMEFRAME[key],
    }));
  }

  async run(
    key: string,
    assetClass = 'EQUITY',
    limit = 25,
    options: { withSignals?: boolean } = {},
  ): Promise<{
    scanner: string;
    assetClass: string;
    timeframe: Timeframe;
    results: ScannerRow[];
    scanned: number;
    asOf: string;
    degraded: string | null;
  }> {
    const scanner = key.toUpperCase() as ScannerKey;
    if (!SCANNER_KEYS.includes(scanner)) {
      throw new BadRequestException(
        `Unknown scanner "${key}". Available: ${SCANNER_KEYS.join(', ')}.`,
      );
    }

    const klass = assetClass.toUpperCase();
    if (!SCANNER_CLASSES[scanner].includes(klass)) {
      throw new BadRequestException(
        `The ${scanner} scan does not apply to ${klass}. It covers ${SCANNER_CLASSES[scanner].join(', ')}.`,
      );
    }

    const withSignals = options.withSignals ?? true;
    const capped = Math.min(Math.max(limit, 1), 50);

    // Cached as a whole. A scan is identical for every user, and the underlying
    // quotes and candles are themselves cached, so this mostly avoids repeating
    // the arithmetic on a page that refetches every minute.
    return this.redis.wrap(
      `scan:${scanner}:${klass}:${capped}:${withSignals ? 'sig' : 'raw'}`,
      60,
      async () => {
        const timeframe = SCANNER_TIMEFRAME[scanner];
        const universe = await this.universe(scanner, klass);

        const rows = await Promise.all(
          universe.map(async (instrument) => {
            try {
              const metrics = await this.metricsFor(instrument.symbol, timeframe);
              if (!metrics) return null;
              const graded = this.grade(scanner, metrics, instrument.symbol);
              if (!graded) return null;

              return {
                symbol: instrument.symbol,
                name: instrument.name,
                assetClass: instrument.assetClass as string,
                price: metrics.price,
                changePercent: round(metrics.changePercent, 2),
                volume: Math.round(metrics.volume),
                volumeRatio: round(metrics.volumeRatio, 2),
                score: graded.score,
                matched: graded.matched,
                signal: 'WAIT' as ScannerRow['signal'],
                rsi: metrics.rsi === null ? null : round(metrics.rsi, 1),
                note: graded.note,
              } satisfies ScannerRow;
            } catch {
              // One unreachable symbol must not empty the scan.
              return null;
            }
          }),
        );

        const results = rows
          .filter((row): row is ScannerRow => row !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, capped);

        let degraded: string | null = null;

        if (withSignals && results.length > 0) {
          try {
            const top = results.slice(0, SIGNAL_ENRICH_CAP);
            const batch = (await this.analysis.batchSignals(
              top.map((row) => row.symbol),
              timeframe,
              // Enrichment only — this call exists to fill in an action column,
              // not to issue signals. Persisting here would add rows to the
              // feed every time someone opened a scan.
              { includeWait: true, persist: false },
            )) as unknown as {
              signals?: Array<{ symbol: string; action: ScannerRow['signal'] }>;
            };

            const bySymbol = new Map(
              (batch.signals ?? []).map((signal) => [signal.symbol, signal.action]),
            );
            for (const row of results) {
              row.signal = bySymbol.get(row.symbol) ?? 'WAIT';
            }
          } catch (error) {
            // The scan itself is still valid — it just cannot say what the
            // engine would do. Saying so beats showing every row as WAIT, which
            // would read as "the engine rejected all of these".
            degraded = 'Signals unavailable — the analysis service did not respond.';
            this.logger.warn(`signal enrichment failed: ${(error as Error).message}`);
          }
        }

        return {
          scanner,
          assetClass: klass,
          timeframe,
          results,
          scanned: universe.length,
          asOf: new Date().toISOString(),
          degraded,
        };
      },
    );
  }

  /**
   * The instruments a scan looks at.
   *
   * The fundamentals scan orders by the stored investment score so the universe
   * is already the interesting end of the list; everything else takes a stable
   * alphabetical slice.
   */
  private async universe(scanner: ScannerKey, assetClass: string) {
    if (scanner === 'STRONG_FUNDAMENTALS') {
      const rated = await this.prisma.fundamentals.findMany({
        where: { investmentScore: { not: null } },
        orderBy: { investmentScore: 'desc' },
        take: UNIVERSE_CAP,
        select: { instrument: { select: { symbol: true, name: true, assetClass: true, isActive: true } } },
      });
      return rated
        .map((row) => row.instrument)
        .filter((instrument) => instrument?.isActive)
        .map((instrument) => ({
          symbol: instrument.symbol,
          name: instrument.name,
          assetClass: instrument.assetClass as string,
          // Already ranked by investment score, so tier is informational here.
          tier: 1 as const,
          weight: 0,
          reason: 'Ranked by fundamental score',
        }));
    }

    const instruments = await this.prisma.instrument.findMany({
      where: {
        isActive: true,
        assetClass: assetClass as never,
        // Indices are not tradeable instruments; they belong on the dashboard,
        // not in a list of setups.
        kind: { not: 'INDEX' },
      },
      take: UNIVERSE_CAP * 2,
      select: {
        symbol: true,
        name: true,
        assetClass: true,
        fundamentals: { select: { marketCap: true } },
      },
    });

    // Ranked by liquidity and consequence rather than alphabetically. The old
    // ordering meant a scan capped at sixty names never reached anything past
    // the letter H.
    const marketCaps = new Map(
      instruments
        .filter((item) => item.fundamentals?.marketCap)
        .map((item) => [item.symbol, Number(item.fundamentals!.marketCap)]),
    );

    return prioritise(
      instruments.map((instrument) => ({
        symbol: instrument.symbol,
        name: instrument.name,
        assetClass: instrument.assetClass as string,
      })),
      marketCaps,
    ).slice(0, UNIVERSE_CAP);
  }

  /** Indicators computed from cached candles. Nothing here calls a provider directly. */
  private async metricsFor(symbol: string, timeframe: Timeframe): Promise<Metrics | null> {
    const { candles } = await this.marketData.getCandles(symbol, timeframe, 120);
    if (candles.length < 25) return null;

    const closes = candles.map((candle) => candle.close);
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const window = candles.slice(-21, -1);
    const averageVolume = mean(window.map((candle) => candle.volume));

    return {
      price: last.close,
      changePercent: previous.close > 0 ? ((last.close - previous.close) / previous.close) * 100 : 0,
      volume: last.volume,
      volumeRatio: averageVolume > 0 ? last.volume / averageVolume : 0,
      rsi: rsi(closes, 14),
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      atrPercent: atrPercent(candles, 14),
      priorHigh20: window.length ? Math.max(...window.map((candle) => candle.high)) : null,
      priorLow20: window.length ? Math.min(...window.map((candle) => candle.low)) : null,
      gapPercent: previous.close > 0 ? ((last.open - previous.close) / previous.close) * 100 : 0,
      momentum20:
        closes.length >= 21 && closes[closes.length - 21] > 0
          ? ((last.close - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
          : null,
      bars: candles.length,
    };
  }

  /**
   * Score one instrument against one scan.
   *
   * Returns null when the row does not qualify at all. Scores are 0…100 and
   * measure how well the row matches the *intent* of the scan, not how good the
   * trade is — that is the signal engine's job.
   */
  private grade(
    scanner: ScannerKey,
    m: Metrics,
    symbol: string,
  ): { score: number; matched: string[]; note: string } | null {
    const matched: string[] = [];
    let score = 0;

    const trendUp = m.ema20 !== null && m.ema50 !== null && m.ema20 > m.ema50;
    const trendDown = m.ema20 !== null && m.ema50 !== null && m.ema20 < m.ema50;
    const aboveEma20 = m.ema20 !== null && m.price > m.ema20;

    switch (scanner) {
      case 'INTRADAY': {
        if (Math.abs(m.changePercent) < 0.4) return null;
        score = Math.min(45, Math.abs(m.changePercent) * 9);
        matched.push(`${m.changePercent >= 0 ? 'Up' : 'Down'} ${Math.abs(m.changePercent).toFixed(2)}% on the bar`);

        if (m.volumeRatio >= 1.2) {
          score += Math.min(30, m.volumeRatio * 12);
          matched.push(`Volume ${m.volumeRatio.toFixed(1)}× the 20-bar average`);
        }
        if ((m.changePercent > 0 && trendUp) || (m.changePercent < 0 && trendDown)) {
          score += 20;
          matched.push('Move is with the short-term trend, not against it');
        }
        break;
      }

      case 'SWING': {
        if (m.momentum20 === null || m.atrPercent === null) return null;
        // A swing setup is a trend that has paused, not one that has run away.
        const pullback = m.ema20 !== null && Math.abs((m.price - m.ema20) / m.ema20) * 100 < m.atrPercent * 1.5;
        if (!(trendUp || trendDown) || !pullback) return null;

        score = 40 + Math.min(25, Math.abs(m.momentum20));
        matched.push(trendUp ? 'EMA 20 above EMA 50 — uptrend intact' : 'EMA 20 below EMA 50 — downtrend intact');
        matched.push('Price within 1.5 ATR of the EMA 20 — a pause, not an extension');

        if (m.rsi !== null && m.rsi > 40 && m.rsi < 65) {
          score += 15;
          matched.push(`RSI ${m.rsi.toFixed(0)} — room in both directions`);
        }
        break;
      }

      case 'BREAKOUT': {
        if (m.priorHigh20 === null || m.priorLow20 === null) return null;
        const up = m.price > m.priorHigh20;
        const down = m.price < m.priorLow20;
        if (!up && !down) return null;

        const distance = up
          ? ((m.price - m.priorHigh20) / m.priorHigh20) * 100
          : ((m.priorLow20 - m.price) / m.priorLow20) * 100;

        score = 45 + Math.min(20, distance * 6);
        matched.push(up ? 'Cleared the 20-bar high' : 'Broke the 20-bar low');

        if (m.volumeRatio >= 1.5) {
          score += 25;
          matched.push(`Volume ${m.volumeRatio.toFixed(1)}× average confirms the break`);
        } else {
          // Stated, not hidden — an unconfirmed breakout is the classic trap.
          matched.push('No volume expansion — breakouts without it fail often');
          score -= 10;
        }
        break;
      }

      case 'HIGH_VOLUME': {
        if (m.volumeRatio < 2) return null;
        score = Math.min(85, m.volumeRatio * 22);
        matched.push(`Volume ${m.volumeRatio.toFixed(1)}× the 20-bar average`);
        if (Math.abs(m.changePercent) > 1) {
          score += 12;
          matched.push(`Price moved ${m.changePercent.toFixed(2)}% with it`);
        } else {
          matched.push('Volume without price movement — often distribution or absorption');
        }
        break;
      }

      case 'MOMENTUM': {
        if (m.momentum20 === null || m.rsi === null) return null;
        if (Math.abs(m.momentum20) < 4) return null;
        if (!(trendUp || trendDown)) return null;

        const aligned =
          (m.momentum20 > 0 && m.rsi > 55 && trendUp) || (m.momentum20 < 0 && m.rsi < 45 && trendDown);
        if (!aligned) return null;

        score = 45 + Math.min(35, Math.abs(m.momentum20) * 1.6);
        matched.push(`${m.momentum20 > 0 ? '+' : ''}${m.momentum20.toFixed(1)}% over 20 bars`);
        matched.push(`RSI ${m.rsi.toFixed(0)} agrees with the trend`);
        matched.push(trendUp ? 'Moving averages stacked bullish' : 'Moving averages stacked bearish');
        break;
      }

      case 'GAP_UP': {
        if (m.gapPercent < 0.75) return null;
        score = 40 + Math.min(40, m.gapPercent * 10);
        matched.push(`Opened ${m.gapPercent.toFixed(2)}% above the previous close`);
        if (m.changePercent > 0) {
          score += 15;
          matched.push('Held the gap through the bar');
        } else {
          matched.push('Gap faded during the bar — the fill is the risk');
        }
        break;
      }

      case 'GAP_DOWN': {
        if (m.gapPercent > -0.75) return null;
        score = 40 + Math.min(40, Math.abs(m.gapPercent) * 10);
        matched.push(`Opened ${Math.abs(m.gapPercent).toFixed(2)}% below the previous close`);
        if (m.changePercent < 0) {
          score += 15;
          matched.push('Continued lower through the bar');
        } else {
          matched.push('Recovered off the open — possible exhaustion gap');
        }
        break;
      }

      case 'STRONG_FUNDAMENTALS': {
        // The universe is already ranked by investment score; the technical read
        // only decides ordering within it.
        score = 55;
        matched.push('Ranks in the top of the stored fundamental scores');
        if (trendUp) {
          score += 20;
          matched.push('Price trend agrees with the fundamental read');
        }
        if (aboveEma20) {
          score += 10;
          matched.push('Trading above its 20-bar average');
        }
        if (m.rsi !== null && m.rsi < 40) {
          score += 10;
          matched.push(`RSI ${m.rsi.toFixed(0)} — a quality name that has pulled back`);
        }
        break;
      }

      case 'OVERSOLD': {
        if (m.rsi === null || m.rsi > 32) return null;
        score = 50 + (32 - m.rsi) * 2.5;
        matched.push(`RSI ${m.rsi.toFixed(0)}`);
        if (m.changePercent > 0) {
          score += 15;
          matched.push('Closed up — the first sign of stabilising');
        } else {
          matched.push('Still falling — oversold is not a reversal on its own');
          score -= 10;
        }
        break;
      }

      case 'OVERBOUGHT': {
        if (m.rsi === null || m.rsi < 68) return null;
        score = 50 + (m.rsi - 68) * 2.5;
        matched.push(`RSI ${m.rsi.toFixed(0)}`);
        if (m.ema20 !== null) {
          const extension = ((m.price - m.ema20) / m.ema20) * 100;
          if (extension > 3) {
            score += 15;
            matched.push(`${extension.toFixed(1)}% above the EMA 20 — extended from the mean`);
          }
        }
        break;
      }
    }

    if (score <= 0) return null;

    return {
      score: Math.round(Math.min(100, Math.max(0, score))),
      matched,
      note: `${symbol} · ${matched[0] ?? 'matched the filter'}`,
    };
  }
}

/* ── Indicator maths ──────────────────────────────────────────── */

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * alpha + value * (1 - alpha);
  }
  return value;
}

/** Wilder's RSI — the smoothing matters, a simple average gives different numbers. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function atrPercent(candles: ProviderCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }

  const atr = mean(ranges.slice(-period));
  const price = candles[candles.length - 1].close;
  return price > 0 ? (atr / price) * 100 : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/* ── Controller ───────────────────────────────────────────────── */

@ApiTags('scanners')
@Controller('scanners')
class ScannersController {
  constructor(private readonly scanners: ScannersService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Available scanners and the categories each applies to' })
  catalogue() {
    return { scanners: this.scanners.catalogue() };
  }

  @Public()
  @Get(':key')
  @ApiOperation({ summary: 'Run a scan across a category' })
  run(
    @Param('key') key: string,
    @Query('assetClass') assetClass?: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('signals') signals?: string,
  ) {
    return this.scanners.run(key, assetClass ?? 'EQUITY', limit ?? 25, {
      withSignals: signals !== 'false',
    });
  }
}

@Module({
  imports: [MarketDataModule, AnalysisModule],
  controllers: [ScannersController],
  providers: [ScannersService],
  exports: [ScannersService],
})
export class ScannersModule {}
