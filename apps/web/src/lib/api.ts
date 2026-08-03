import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import type { ApiError } from '@/types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

/**
 * The access token lives in memory only.
 *
 * Redux holds it for the app, and this module keeps its own reference so the
 * interceptor doesn't need to reach into the store (which would create a
 * circular import). It is deliberately never written to localStorage — the
 * refresh token is in an httpOnly cookie, and putting the access token in
 * storage would hand both to any XSS.
 */
let accessToken: string | null = null;
let onUnauthorised: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when refresh fails — the app uses this to clear state and redirect. */
export function setUnauthorisedHandler(handler: () => void): void {
  onUnauthorised = handler;
}

export const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  // Required so the refresh cookie is sent.
  withCredentials: true,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

/**
 * Single-flight refresh.
 *
 * When several requests 401 at once — which is the normal case, since a page
 * fires many in parallel — only one refresh call is made and the rest wait on
 * it. Without this, N concurrent 401s produce N refresh calls, and because the
 * API rotates refresh tokens, all but the first would be treated as token reuse
 * and log the user out.
 */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ accessToken: string }>(
        `${BASE_URL}/auth/refresh`,
        {},
        { withCredentials: true },
      )
      .then((response) => {
        const token = response.data.accessToken;
        setAccessToken(token);
        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiError>) => {
    const original = error.config as InternalAxiosRequestConfig & { _retried?: boolean };
    const status = error.response?.status;

    const isAuthEndpoint =
      original?.url?.includes('/auth/login') ||
      original?.url?.includes('/auth/register') ||
      original?.url?.includes('/auth/refresh');

    if (status === 401 && original && !original._retried && !isAuthEndpoint) {
      original._retried = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch {
        setAccessToken(null);
        onUnauthorised?.();
      }
    }

    return Promise.reject(normaliseError(error));
  },
);

export interface NormalisedError extends Error {
  status: number;
  details?: Record<string, string[]>;
}

/** Turn an Axios failure into something a component can render directly. */
function normaliseError(error: AxiosError<ApiError>): NormalisedError {
  const status = error.response?.status ?? 0;
  const payload = error.response?.data;

  let message = 'Something went wrong. Please try again.';

  if (payload?.message) {
    message = Array.isArray(payload.message) ? payload.message[0] : payload.message;
  } else if (error.code === 'ECONNABORTED') {
    message = 'The request timed out. The analysis engine may be busy — try again in a moment.';
  } else if (!error.response) {
    message = 'Cannot reach the server. Check that the API is running.';
  } else if (status === 429) {
    message = 'Too many requests. Please slow down for a moment.';
  } else if (status >= 500) {
    message = 'The server ran into a problem. Please try again shortly.';
  }

  const normalised = new Error(message) as NormalisedError;
  normalised.status = status;
  normalised.details = payload?.details;
  return normalised;
}

/* ── Typed endpoint helpers ──────────────────────────────────── */

export const endpoints = {
  auth: {
    login: (email: string, password: string) => api.post('/auth/login', { email, password }),
    register: (email: string, name: string, password: string) =>
      api.post('/auth/register', { email, name, password }),
    logout: () => api.post('/auth/logout'),
    me: () => api.get('/auth/me'),
    forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }),
    resetPassword: (token: string, password: string) =>
      api.post('/auth/reset-password', { token, password }),
    sessions: () => api.get('/auth/sessions'),
    googleUrl: () => `${BASE_URL}/auth/google`,
  },

  market: {
    search: (query: string, assetClass?: string) =>
      api.get('/market/search', { params: { q: query, assetClass } }),
    quote: (symbol: string) => api.get(`/market/quote/${symbol}`),
    quotes: (symbols: string[]) =>
      api.get('/market/quotes', { params: { symbols: symbols.join(',') } }),
    candles: (symbol: string, timeframe: string, limit = 300) =>
      api.get(`/market/candles/${symbol}`, { params: { timeframe, limit } }),
    status: () => api.get('/market/status'),
    /** Status for one instrument, resolved server-side to its exchange. */
    symbolStatus: (symbol: string) => api.get(`/market/status/${symbol}`),
  },

  instruments: {
    list: (params: { assetClass?: string; sector?: string; limit?: number; offset?: number }) =>
      api.get('/instruments', { params }),
    overview: (assetClass: string) => api.get('/instruments/overview', { params: { assetClass } }),
    indices: () => api.get('/instruments/indices'),
    sectors: () => api.get('/instruments/sectors'),
    detail: (symbol: string) => api.get(`/instruments/${symbol}`),
  },

  analysis: {
    full: (symbol: string, timeframe: string, calibration = true) =>
      api.get(`/analysis/${symbol}`, { params: { timeframe, calibration } }),
    forecast: (symbol: string, timeframe: string) =>
      api.get(`/analysis/${symbol}/forecast`, { params: { timeframe } }),
    candleHistory: (symbol: string, timeframe: string, lookback = 30) =>
      api.get(`/analysis/${symbol}/candles`, { params: { timeframe, lookback } }),
    batch: (symbols: string[], timeframe: string, minConfidence = 0) =>
      api.post('/analysis/signals/batch', { symbols, timeframe, minConfidence }),
    recentSignals: (
      limit = 20,
      assetClass?: string,
      options: { status?: 'live'; minConfidence?: number } = {},
    ) =>
      api.get('/analysis/signals/recent', {
        params: {
          limit,
          assetClass,
          status: options.status,
          minConfidence: options.minConfidence,
        },
      }),
    engineConfig: () => api.get('/analysis/engine/config'),
  },

  scanners: {
    catalogue: () => api.get('/scanners'),
    run: (key: string, assetClass = 'EQUITY', limit = 25, withSignals = true) =>
      api.get(`/scanners/${key}`, {
        params: { assetClass, limit, signals: withSignals ? 'true' : 'false' },
      }),
  },

  risk: {
    positionSize: (payload: {
      capital: number;
      riskPercent: number;
      entry: number;
      stopLoss: number;
      target?: number;
      lotSize?: number;
    }) => api.post('/risk/position-size', payload),
    kelly: (winRate: number, averageWin: number, averageLoss: number) =>
      api.post('/risk/kelly', { winRate, averageWin, averageLoss }),
    monteCarlo: (payload: {
      tradeReturns: number[];
      startingCapital: number;
      simulations?: number;
      horizon?: number;
    }) => api.post('/risk/monte-carlo', payload),
    atrStop: (entry: number, atr: number, multiplier?: number, long?: boolean) =>
      api.post('/risk/atr-stop', { entry, atr, multiplier, long }),
  },

  watchlists: {
    list: () => api.get('/watchlists'),
    create: (name: string) => api.post('/watchlists', { name }),
    rename: (id: string, name: string) => api.patch(`/watchlists/${id}`, { name }),
    remove: (id: string) => api.delete(`/watchlists/${id}`),
    addItem: (id: string, symbol: string, note?: string) =>
      api.post(`/watchlists/${id}/items`, { symbol, note }),
    removeItem: (id: string, itemId: string) => api.delete(`/watchlists/${id}/items/${itemId}`),
  },

  portfolio: {
    summary: () => api.get('/portfolio'),
    risk: () => api.get('/portfolio/risk'),
    transactions: () => api.get('/portfolio/transactions'),
    addTransaction: (payload: Record<string, unknown>) =>
      api.post('/portfolio/transactions', payload),
    deleteHolding: (id: string) => api.delete(`/portfolio/holdings/${id}`),
  },

  alerts: {
    list: () => api.get('/alerts'),
    create: (payload: Record<string, unknown>) => api.post('/alerts', payload),
    toggle: (id: string, isActive: boolean) => api.patch(`/alerts/${id}`, { isActive }),
    remove: (id: string) => api.delete(`/alerts/${id}`),
  },

  news: {
    list: (params: { symbol?: string; assetClass?: string; limit?: number }) =>
      api.get('/news', { params }),
  },

  confluence: {
    /** Multi-timeframe agreement — every timeframe read, conflicts named. */
    read: (symbol: string, horizon?: string, timeframe?: string) =>
      api.get(`/analysis/${symbol}/confluence`, { params: { horizon, timeframe } }),
    /** A signal that only exists if the timeframes and the checklist agree. */
    gatedSignal: (symbol: string, timeframe = '1D', horizon?: string, enforce = true) =>
      api.get(`/analysis/${symbol}/signal`, {
        params: { timeframe, horizon, enforce: enforce ? 'true' : 'false' },
      }),
  },

  performance: {
    /** Realised record: win rate, expectancy, drawdown, why losses lost. */
    read: () => api.get('/analysis/performance'),
    /** Full analytics payload — every subsection reads from this one call. */
    analytics: () => api.get('/analysis/analytics'),
  },

  telegram: {
    status: () => api.get('/notifications/telegram'),
    /** Omit chatId to have the server find it from recent messages to the bot. */
    link: (chatId?: string) => api.post('/notifications/telegram/link', chatId ? { chatId } : {}),
    test: () => api.post('/notifications/telegram/test'),
    unlink: () => api.delete('/notifications/telegram'),
  },

  strategies: {
    list: () => api.get('/strategies'),
    detail: (id: string) => api.get(`/strategies/${id}`),
    create: (payload: Record<string, unknown>) => api.post('/strategies', payload),
    update: (id: string, payload: Record<string, unknown>) => api.put(`/strategies/${id}`, payload),
    remove: (id: string) => api.delete(`/strategies/${id}`),
    backtest: (id: string, symbol?: string, initialCapital?: number) =>
      api.post(`/strategies/${id}/backtest`, { symbol, initialCapital }),
  },

  invest: {
    sip: (payload: Record<string, unknown>) => api.post('/invest/sip', payload),
    retirement: (payload: Record<string, unknown>) => api.post('/invest/retirement', payload),
    goals: () => api.get('/invest/goals'),
    createGoal: (payload: Record<string, unknown>) => api.post('/invest/goals', payload),
    deleteGoal: (id: string) => api.delete(`/invest/goals/${id}`),
  },

  assistant: {
    ask: (question: string, symbol?: string, sessionId?: string) =>
      api.post('/assistant/ask', { question, symbol, sessionId }),
    sessions: () => api.get('/assistant/sessions'),
    messages: (sessionId: string) => api.get('/assistant/messages', { params: { sessionId } }),
    status: () => api.get('/assistant/status'),
  },

  users: {
    me: () => api.get('/users/me'),
    updateProfile: (payload: Record<string, unknown>) => api.patch('/users/me', payload),
    updatePreferences: (payload: Record<string, unknown>) =>
      api.patch('/users/me/preferences', payload),
    notifications: () => api.get('/users/me/notifications'),
    markNotificationsRead: () => api.patch('/users/me/notifications/read'),
  },

  admin: {
    analytics: () => api.get('/admin/analytics'),
    providers: () => api.get('/admin/providers'),
    users: (params: { q?: string; limit?: number; offset?: number }) =>
      api.get('/admin/users', { params }),
    updateUser: (id: string, payload: Record<string, unknown>) =>
      api.patch(`/admin/users/${id}`, payload),
    logs: (limit = 100) => api.get('/admin/logs', { params: { limit } }),
  },
};
