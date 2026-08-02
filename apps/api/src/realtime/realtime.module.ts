import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Interval } from '@nestjs/schedule';
import type { Server, Socket } from 'socket.io';

import { BinanceStreamService } from '../market-data/binance-stream.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataService } from '../market-data/market-data.service';

/** Max symbols one socket may subscribe to. */
const MAX_SUBSCRIPTIONS = 60;

/**
 * Live quote streaming.
 *
 * Push rather than poll: clients subscribe to symbols and the server broadcasts
 * on a timer. One upstream fetch per symbol serves every subscriber, which is
 * the whole point — 200 users watching RELIANCE is one provider call, not 200.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  /** socketId → subscribed symbols */
  private readonly subscriptions = new Map<string, Set<string>>();

  /** Symbols served by the Binance socket, so polling can skip them. */
  private readonly streamed = new Set<string>();

  constructor(
    private readonly marketData: MarketDataService,
    private readonly binanceStream: BinanceStreamService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Bridge the venue socket to the client socket.
   *
   * Crypto prices arrive from Binance push-to-push with no polling anywhere in
   * the path — a book change in Singapore reaches the browser in one hop
   * instead of waiting out a five-second timer.
   */
  async onModuleInit(): Promise<void> {
    this.binanceStream.onTick((tick) => {
      this.streamed.add(tick.symbol);
      // Only serialise for symbols someone is actually watching. A liquid pair
      // ticks many times a second and nobody is looking at most of them.
      const room = `quote:${tick.symbol}`;
      if (!this.server?.sockets?.adapter?.rooms?.has(room)) return;

      this.server.to(room).emit('tick', {
        symbol: tick.symbol,
        price: tick.price,
        bid: tick.bid,
        ask: tick.ask,
        at: tick.at,
        source: 'binance-ws',
      });
    });

    this.binanceStream.onBar((bar) => {
      // A closed bar means the analysis for that timeframe is now stale. The
      // cache was already dropped by the stream service; this tells any open
      // client to refetch rather than wait for its own poll.
      this.server?.to(`quote:${bar.symbol}`).emit('bar', bar);
    });

    await this.binanceStream.start();
  }

  async handleConnection(client: Socket): Promise<void> {
    // Authentication is optional here — quotes are public data, and requiring a
    // token would break the marketing/landing views. An authenticated socket
    // gets its user id attached for future per-user channels.
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace('Bearer ', '');

    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
          secret: this.config.get<string>('jwt.accessSecret'),
        });
        client.data.userId = payload.sub;
        void client.join(`user:${payload.sub}`);
      } catch {
        // Invalid token — continue as anonymous rather than dropping them.
      }
    }

    this.subscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket): void {
    this.subscriptions.delete(client.id);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { symbols: string[] },
  ): { subscribed: string[]; rejected?: string } {
    const set = this.subscriptions.get(client.id) ?? new Set<string>();
    const incoming = (payload?.symbols ?? []).map((s) => s.toUpperCase().trim()).filter(Boolean);

    for (const symbol of incoming) {
      if (set.size >= MAX_SUBSCRIPTIONS) {
        return {
          subscribed: [...set],
          rejected: `Subscription limit of ${MAX_SUBSCRIPTIONS} symbols reached`,
        };
      }
      set.add(symbol);
      void client.join(`quote:${symbol}`);
    }

    this.subscriptions.set(client.id, set);
    return { subscribed: [...set] };
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { symbols: string[] },
  ): { subscribed: string[] } {
    const set = this.subscriptions.get(client.id) ?? new Set<string>();
    for (const symbol of payload?.symbols ?? []) {
      const normalised = symbol.toUpperCase().trim();
      set.delete(normalised);
      void client.leave(`quote:${normalised}`);
    }
    return { subscribed: [...set] };
  }

  /**
   * Broadcast loop.
   *
   * Only fetches symbols someone is actually watching. The market data service
   * caches and coalesces, so this is cheap even with many subscribers.
   */
  @Interval(5000)
  async broadcastQuotes(): Promise<void> {
    if (!this.server) return;

    const watched = new Set<string>();
    for (const set of this.subscriptions.values()) {
      for (const symbol of set) {
        // Streamed symbols already push on every change; polling them too
        // would spend provider quota to send staler data than the client has.
        if (this.streamed.has(symbol)) continue;
        watched.add(symbol);
      }
    }
    if (watched.size === 0) return;

    const symbols = [...watched].slice(0, 200);

    try {
      const quotes = await this.marketData.getQuotes(symbols);
      for (const quote of quotes) {
        this.server.to(`quote:${quote.symbol}`).emit('quote', quote);
      }
    } catch (error) {
      this.logger.debug(`broadcast failed: ${(error as Error).message}`);
    }
  }

  /** Push a notification to one user. Called by the alerts job. */
  notifyUser(userId: string, notification: Record<string, unknown>): void {
    this.server?.to(`user:${userId}`).emit('notification', notification);
  }

  /** Push a new signal to everyone watching that symbol. */
  broadcastSignal(symbol: string, signal: Record<string, unknown>): void {
    this.server?.to(`quote:${symbol.toUpperCase()}`).emit('signal', signal);
  }
}

@Module({
  // JwtModule is needed to verify the optional handshake token. Registered
  // locally rather than relying on AuthModule so the gateway has no dependency
  // on the auth controller surface.
  imports: [
    MarketDataModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
