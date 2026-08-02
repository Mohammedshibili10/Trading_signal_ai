'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { getAccessToken } from '@/lib/api';
import type { Quote, TradeSignal } from '@/types';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';

/**
 * One socket for the whole tab.
 *
 * Each hook instance opening its own connection would mean a dashboard with a
 * watchlist, a heatmap and a signal feed holds three sockets to the same
 * gateway, each with its own subscription set and its own reconnect storm. The
 * module keeps one and reference-counts it.
 */
let socket: Socket | null = null;
let refCount = 0;

function acquire(): Socket {
  if (!socket) {
    socket = io(`${WS_URL}/realtime`, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      // Quotes are public, so an anonymous socket is valid. The token is sent
      // when we have one so the server can join the per-user channel that
      // carries alerts and notifications.
      auth: (cb) => cb({ token: getAccessToken() ?? undefined }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
  }
  refCount += 1;
  return socket;
}

function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && socket) {
    socket.disconnect();
    socket = null;
  }
}

export type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * Live quotes for a set of symbols.
 *
 * Returns a map keyed by symbol containing only what has arrived over the
 * socket — merge it over whatever the REST query returned rather than using it
 * alone, so the UI renders immediately instead of waiting up to five seconds
 * for the first broadcast.
 */
export function useLiveQuotes(symbols: string[]): {
  quotes: Record<string, Quote>;
  status: ConnectionState;
} {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [status, setStatus] = useState<ConnectionState>('connecting');

  // Sorted + joined so a re-render with an equivalent array does not tear the
  // subscription down and build it back up.
  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(','),
    [symbols],
  );

  useEffect(() => {
    if (!key) {
      setStatus('offline');
      return;
    }

    const list = key.split(',');
    const connection = acquire();

    const onQuote = (quote: Quote) => {
      setQuotes((current) => ({ ...current, [quote.symbol]: quote }));
    };
    const onConnect = () => {
      setStatus('live');
      connection.emit('subscribe', { symbols: list });
    };
    const onDisconnect = () => setStatus('offline');

    connection.on('quote', onQuote);
    connection.on('connect', onConnect);
    connection.on('disconnect', onDisconnect);
    connection.on('connect_error', onDisconnect);

    if (connection.connected) onConnect();

    return () => {
      if (connection.connected) connection.emit('unsubscribe', { symbols: list });
      connection.off('quote', onQuote);
      connection.off('connect', onConnect);
      connection.off('disconnect', onDisconnect);
      connection.off('connect_error', onDisconnect);
      release();
    };
  }, [key]);

  return { quotes, status };
}

/**
 * Live quote for a single symbol, merged over a REST-loaded fallback.
 *
 * The fallback is what makes this usable on first paint: the gateway broadcasts
 * on a five-second timer, so a socket-only value shows an empty header for up
 * to five seconds after navigation.
 */
export function useLiveQuote(
  symbol: string | undefined,
  fallback?: Quote,
): { quote: Quote | undefined; status: ConnectionState } {
  const symbols = useMemo(() => (symbol ? [symbol] : []), [symbol]);
  const { quotes, status } = useLiveQuotes(symbols);
  const live = symbol ? quotes[symbol.toUpperCase()] : undefined;

  return { quote: live ?? fallback, status };
}

/**
 * Signals pushed for symbols this socket is subscribed to.
 *
 * Newest first, capped — an unbounded array here is a memory leak on a page
 * left open all session.
 */
export function useLiveSignals(symbols: string[], cap = 30): {
  signals: TradeSignal[];
  status: ConnectionState;
  clear: () => void;
} {
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [status, setStatus] = useState<ConnectionState>('connecting');
  const capRef = useRef(cap);
  capRef.current = cap;

  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(','),
    [symbols],
  );

  useEffect(() => {
    if (!key) {
      setStatus('offline');
      return;
    }

    const list = key.split(',');
    const connection = acquire();

    const onSignal = (signal: TradeSignal) => {
      setSignals((current) => {
        // The gateway can re-emit while a signal is still valid; keyed by id so
        // a repeat updates in place instead of stacking duplicates.
        const without = current.filter((item) => item.id !== signal.id);
        return [signal, ...without].slice(0, capRef.current);
      });
    };
    const onConnect = () => {
      setStatus('live');
      connection.emit('subscribe', { symbols: list });
    };
    const onDisconnect = () => setStatus('offline');

    connection.on('signal', onSignal);
    connection.on('connect', onConnect);
    connection.on('disconnect', onDisconnect);
    connection.on('connect_error', onDisconnect);

    if (connection.connected) onConnect();

    return () => {
      connection.off('signal', onSignal);
      connection.off('connect', onConnect);
      connection.off('disconnect', onDisconnect);
      connection.off('connect_error', onDisconnect);
      release();
    };
  }, [key]);

  return { signals, status, clear: () => setSignals([]) };
}

/** Per-user notifications — alert triggers, signal pushes for followed symbols. */
export function useLiveNotifications(): {
  notifications: Array<Record<string, unknown> & { id?: string; title?: string; body?: string }>;
  status: ConnectionState;
} {
  const [notifications, setNotifications] = useState<
    Array<Record<string, unknown> & { id?: string; title?: string; body?: string }>
  >([]);
  const [status, setStatus] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const connection = acquire();

    const onNotification = (payload: Record<string, unknown>) => {
      setNotifications((current) => [payload, ...current].slice(0, 50));
    };
    const onConnect = () => setStatus('live');
    const onDisconnect = () => setStatus('offline');

    connection.on('notification', onNotification);
    connection.on('connect', onConnect);
    connection.on('disconnect', onDisconnect);
    connection.on('connect_error', onDisconnect);

    if (connection.connected) setStatus('live');

    return () => {
      connection.off('notification', onNotification);
      connection.off('connect', onConnect);
      connection.off('disconnect', onDisconnect);
      connection.off('connect_error', onDisconnect);
      release();
    };
  }, []);

  return { notifications, status };
}
