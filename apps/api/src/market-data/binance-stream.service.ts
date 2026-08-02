import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Binance combined-stream endpoint. Public, no key, no auth handshake. */
const STREAM_BASE = 'wss://stream.binance.com:9443/stream';

/** Reconnect backoff, capped. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Binance disconnects any socket held for 24 hours. Recycling ahead of that
 * turns a surprise disconnect into a planned one.
 */
const RECYCLE_MS = 23 * 60 * 60 * 1000;

/** Streams to open per symbol. */
const KLINE_INTERVALS = ['1m', '5m', '15m', '1h'] as const;

export interface LiveTick {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  at: number;
}

export interface ClosedBar {
  symbol: string;
  interval: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
  takerBuyVolume: number;
}

type TickHandler = (tick: LiveTick) => void;
type BarHandler = (bar: ClosedBar) => void;

/**
 * Binance WebSocket streams.
 *
 * Replaces polling for crypto. The REST path fetched a quote every five
 * seconds per symbol; the socket pushes every book-ticker change, which on a
 * liquid pair is many times a second, and costs one connection rather than
 * N × 12 requests a minute.
 *
 * Two stream types are consumed:
 *
 * **bookTicker** — best bid and ask on every change. This is the live price,
 * and it is the tightest one available: the last *trade* price can sit stale
 * for seconds on a quiet pair while the book has moved.
 *
 * **kline** — a bar per interval, updating continuously and flagged when it
 * closes. Only closed bars are acted on. Acting on a forming bar means
 * analysing a candle that can still reverse before it prints, which is the
 * single most common way a live system produces signals that vanish on reload.
 *
 * On a bar close the cached candle series for that symbol and timeframe is
 * invalidated, so the next analysis reads fresh data instead of waiting out a
 * TTL. That is what makes the engine genuinely event-driven rather than merely
 * fast at polling.
 */
@Injectable()
export class BinanceStreamService implements OnModuleDestroy {
  private readonly logger = new Logger('BinanceStream');

  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private recycleTimer: NodeJS.Timeout | null = null;
  private closing = false;

  /** Binance pair → our instrument symbol. */
  private readonly pairToSymbol = new Map<string, string>();
  private subscribed: string[] = [];

  private readonly tickHandlers = new Set<TickHandler>();
  private readonly barHandlers = new Set<BarHandler>();

  /** Latest tick per symbol, for anything that wants a synchronous read. */
  private readonly latest = new Map<string, LiveTick>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('marketData.binanceStream') !== 'false';
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      symbols: [...this.pairToSymbol.values()],
      streams: this.subscribed.length,
      lastTicks: this.latest.size,
    };
  }

  onTick(handler: TickHandler): () => void {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }

  onBar(handler: BarHandler): () => void {
    this.barHandlers.add(handler);
    return () => this.barHandlers.delete(handler);
  }

  lastTick(symbol: string): LiveTick | undefined {
    return this.latest.get(symbol.toUpperCase());
  }

  /**
   * Open (or reopen) streams for every active crypto instrument.
   *
   * Called at boot and whenever the watched set changes. Binance caps a single
   * connection at 1024 streams, which is far beyond anything this platform
   * will subscribe to, so one connection carries everything.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Binance streaming disabled by configuration');
      return;
    }

    const instruments = await this.prisma.instrument.findMany({
      where: { assetClass: 'CRYPTO', isActive: true },
      select: { symbol: true, providerSymbols: true },
      take: 60,
    });

    if (instruments.length === 0) {
      this.logger.debug('no crypto instruments to stream');
      return;
    }

    this.pairToSymbol.clear();
    const streams: string[] = [];

    for (const instrument of instruments) {
      const override = (instrument.providerSymbols as Record<string, string | null> | null)
        ?.binance;
      const pair = (
        override ?? `${instrument.symbol.toUpperCase().replace('USDT', '')}USDT`
      ).toUpperCase();

      this.pairToSymbol.set(pair, instrument.symbol);

      const lower = pair.toLowerCase();
      streams.push(`${lower}@bookTicker`);
      for (const interval of KLINE_INTERVALS) streams.push(`${lower}@kline_${interval}`);
    }

    this.subscribed = streams;
    this.connect();
  }

  private connect(): void {
    if (this.closing || this.subscribed.length === 0) return;

    this.teardown();

    const url = `${STREAM_BASE}?streams=${this.subscribed.join('/')}`;
    this.logger.log(
      `connecting — ${this.pairToSymbol.size} symbols, ${this.subscribed.length} streams`,
    );

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.scheduleReconnect(`construct failed: ${(error as Error).message}`);
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.logger.log('connected');
      // Pre-empt the venue's own 24-hour cut.
      this.recycleTimer = setTimeout(() => this.connect(), RECYCLE_MS);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        this.handle(JSON.parse(raw.toString()) as CombinedMessage);
      } catch {
        // A single malformed frame must not take the connection down.
      }
    });

    // Binance sends pings; ws answers automatically, but an explicit pong on
    // ping makes the intent visible and survives a library default changing.
    socket.on('ping', (data) => socket.pong(data));

    socket.on('close', (code) => this.scheduleReconnect(`closed (${code})`));
    socket.on('error', (error) => this.scheduleReconnect(`error: ${error.message}`));
  }

  private handle(message: CombinedMessage): void {
    const payload = message?.data;
    if (!payload) return;

    // bookTicker frames carry no event type; klines do.
    if (payload.e === 'kline' && payload.k) {
      if (!payload.k.x) return; // still forming — ignore until it closes
      const symbol = this.pairToSymbol.get(payload.k.s);
      if (!symbol) return;

      const bar: ClosedBar = {
        symbol,
        interval: payload.k.i,
        time: Math.floor(payload.k.t / 1000),
        open: Number(payload.k.o),
        high: Number(payload.k.h),
        low: Number(payload.k.l),
        close: Number(payload.k.c),
        volume: Number(payload.k.v),
        trades: Number(payload.k.n),
        takerBuyVolume: Number(payload.k.V),
      };

      void this.invalidate(symbol, bar.interval);
      for (const handler of this.barHandlers) {
        try {
          handler(bar);
        } catch (error) {
          this.logger.debug(`bar handler failed: ${(error as Error).message}`);
        }
      }
      return;
    }

    if (payload.s && payload.b && payload.a) {
      const symbol = this.pairToSymbol.get(payload.s);
      if (!symbol) return;

      const bid = Number(payload.b);
      const ask = Number(payload.a);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const tick: LiveTick = {
        symbol,
        price: (bid + ask) / 2,
        bid,
        ask,
        at: Date.now(),
      };

      this.latest.set(symbol, tick);
      for (const handler of this.tickHandlers) {
        try {
          handler(tick);
        } catch (error) {
          this.logger.debug(`tick handler failed: ${(error as Error).message}`);
        }
      }
    }
  }

  /**
   * Drop the cached series a closed bar has just invalidated.
   *
   * This is the point of consuming klines at all: without it the engine would
   * keep serving a cached series for the rest of its TTL after new information
   * has demonstrably arrived.
   */
  private async invalidate(symbol: string, interval: string): Promise<void> {
    const timeframe = ({ '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h' } as Record<string, string>)[
      interval
    ];
    if (!timeframe) return;

    try {
      await Promise.all([
        this.redis.delPattern(`candles:${symbol}:${timeframe}:*`),
        this.redis.delPattern(`analysis:${symbol}:${timeframe}:*`),
        this.redis.delPattern(`gated:${symbol}:${timeframe}:*`),
        this.redis.delPattern(`confluence:${symbol}:*`),
      ]);
    } catch (error) {
      this.logger.debug(`invalidate failed for ${symbol} ${timeframe}: ${(error as Error).message}`);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closing) return;
    this.teardown();

    this.logger.warn(`${reason} — reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    // Exponential backoff so a venue outage does not become a reconnect storm.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      // Terminating a socket that is still CONNECTING makes ws emit 'error',
      // and the listeners were just removed — an 'error' with no listener is
      // a thrown exception in Node, so shutting down mid-connect took the
      // whole process with it. A no-op listener keeps teardown a teardown.
      this.socket.on('error', () => {});
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.terminate();
      }
      this.socket = null;
    }
  }

  onModuleDestroy(): void {
    this.closing = true;
    this.teardown();
  }
}

interface CombinedMessage {
  stream?: string;
  data?: {
    e?: string;
    s?: string;
    /** bookTicker: best bid price / best ask price. */
    b?: string;
    a?: string;
    k?: {
      t: number;
      s: string;
      i: string;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
      n: number;
      /** Taker buy base volume. */
      V: string;
      /** Is this kline closed? */
      x: boolean;
    };
  };
}
