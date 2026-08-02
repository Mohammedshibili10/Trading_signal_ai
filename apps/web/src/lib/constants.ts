import type { AssetClass, ScannerKey, Timeframe } from '@/types';

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Alphaline';
export const APP_TAGLINE = 'AI trading intelligence for Indian markets, forex & crypto';

/* ── Asset classes ───────────────────────────────────────── */

export interface AssetClassMeta {
  key: AssetClass;
  label: string;
  short: string;
  description: string;
  currency: 'INR' | 'USD';
  /** Tailwind classes for the category chip. */
  chip: string;
  accent: string;
}

export const ASSET_CLASSES: AssetClassMeta[] = [
  {
    key: 'EQUITY',
    label: 'Indian Stocks',
    short: 'Stocks',
    description: 'NSE & BSE listed equities and indices',
    currency: 'INR',
    chip: 'bg-chart-1/12 text-chart-1 border-chart-1/25',
    accent: 'var(--chart-1)',
  },
  {
    key: 'FOREX',
    label: 'Forex',
    short: 'Forex',
    description: 'Currency pairs including INR crosses',
    currency: 'USD',
    chip: 'bg-chart-2/12 text-chart-2 border-chart-2/25',
    accent: 'var(--chart-2)',
  },
  {
    key: 'CRYPTO',
    label: 'Crypto',
    short: 'Crypto',
    description: 'Digital assets, traded 24×7',
    currency: 'USD',
    chip: 'bg-chart-4/12 text-chart-4 border-chart-4/25',
    accent: 'var(--chart-4)',
  },
  {
    key: 'INVESTMENT',
    label: 'Investment',
    short: 'Invest',
    description: 'Mutual funds, ETFs, gold & bonds',
    currency: 'INR',
    chip: 'bg-chart-3/12 text-chart-3 border-chart-3/25',
    accent: 'var(--chart-3)',
  },
];

export const ASSET_CLASS_MAP = Object.fromEntries(
  ASSET_CLASSES.map((a) => [a.key, a]),
) as Record<AssetClass, AssetClassMeta>;

/* ── Timeframes ──────────────────────────────────────────── */

export interface TimeframeMeta {
  key: Timeframe;
  label: string;
  /** Roughly how long one bar covers, in seconds. */
  seconds: number;
  /** Which horizons this timeframe is sensible for. */
  horizon: 'INTRADAY' | 'SWING' | 'POSITIONAL' | 'LONG_TERM';
}

export const TIMEFRAMES: TimeframeMeta[] = [
  { key: '1m', label: '1m', seconds: 60, horizon: 'INTRADAY' },
  { key: '5m', label: '5m', seconds: 300, horizon: 'INTRADAY' },
  { key: '15m', label: '15m', seconds: 900, horizon: 'INTRADAY' },
  { key: '30m', label: '30m', seconds: 1800, horizon: 'INTRADAY' },
  { key: '1h', label: '1H', seconds: 3600, horizon: 'SWING' },
  { key: '4h', label: '4H', seconds: 14400, horizon: 'SWING' },
  { key: '1D', label: '1D', seconds: 86400, horizon: 'POSITIONAL' },
  { key: '1W', label: '1W', seconds: 604800, horizon: 'LONG_TERM' },
  { key: '1M', label: '1M', seconds: 2592000, horizon: 'LONG_TERM' },
];

/** Sensible defaults per category — intraday forex, daily for funds. */
export const DEFAULT_TIMEFRAME: Record<AssetClass, Timeframe> = {
  EQUITY: '1D',
  FOREX: '1h',
  CRYPTO: '1h',
  INVESTMENT: '1D',
};

export const TIMEFRAMES_BY_CLASS: Record<AssetClass, Timeframe[]> = {
  EQUITY: ['5m', '15m', '1h', '1D', '1W', '1M'],
  FOREX: ['1m', '5m', '15m', '1h', '4h', '1D'],
  CRYPTO: ['5m', '15m', '1h', '4h', '1D', '1W'],
  INVESTMENT: ['1D', '1W', '1M'],
};

/* ── Indian market reference data ────────────────────────── */

export const INDIAN_INDICES = [
  { symbol: 'NIFTY50', name: 'NIFTY 50' },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank' },
  { symbol: 'SENSEX', name: 'BSE SENSEX' },
  { symbol: 'NIFTYIT', name: 'NIFTY IT' },
  { symbol: 'NIFTYAUTO', name: 'NIFTY Auto' },
  { symbol: 'NIFTYPHARMA', name: 'NIFTY Pharma' },
  { symbol: 'NIFTYFMCG', name: 'NIFTY FMCG' },
  { symbol: 'NIFTYMETAL', name: 'NIFTY Metal' },
];

export const NSE_SECTORS = [
  'Banking & Financial Services',
  'Information Technology',
  'Oil & Gas',
  'FMCG',
  'Automobile',
  'Pharmaceuticals',
  'Metals & Mining',
  'Infrastructure',
  'Power & Utilities',
  'Telecom',
  'Cement',
  'Chemicals',
  'Consumer Durables',
  'Real Estate',
  'Media & Entertainment',
];

/** Headline currency pairs — INR crosses first, then majors. */
export const FOREX_PAIRS = [
  'USDINR',
  'EURINR',
  'GBPINR',
  'JPYINR',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'EURGBP',
];

export const CRYPTO_SYMBOLS = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'ADA',
  'DOGE',
  'AVAX',
  'MATIC',
  'DOT',
  'LINK',
  'TON',
];

/* ── Scanners ────────────────────────────────────────────── */

export const SCANNERS: Array<{
  key: ScannerKey;
  label: string;
  description: string;
  classes: AssetClass[];
}> = [
  {
    key: 'INTRADAY',
    label: 'Intraday movers',
    description: 'Liquid names with clean intraday trend and above-average range',
    classes: ['EQUITY', 'FOREX', 'CRYPTO'],
  },
  {
    key: 'SWING',
    label: 'Swing setups',
    description: 'Multi-day continuation patterns near a defined risk level',
    classes: ['EQUITY', 'CRYPTO'],
  },
  {
    key: 'BREAKOUT',
    label: 'Breakouts',
    description: 'Price clearing a tested resistance with volume expansion',
    classes: ['EQUITY', 'FOREX', 'CRYPTO'],
  },
  {
    key: 'HIGH_VOLUME',
    label: 'High volume',
    description: 'Volume more than 2× the 20-day average',
    classes: ['EQUITY', 'CRYPTO'],
  },
  {
    key: 'MOMENTUM',
    label: 'Momentum',
    description: 'Strong ADX with aligned RSI and MACD',
    classes: ['EQUITY', 'FOREX', 'CRYPTO'],
  },
  {
    key: 'GAP_UP',
    label: 'Gap up',
    description: 'Opened materially above the previous close',
    classes: ['EQUITY'],
  },
  {
    key: 'GAP_DOWN',
    label: 'Gap down',
    description: 'Opened materially below the previous close',
    classes: ['EQUITY'],
  },
  {
    key: 'STRONG_FUNDAMENTALS',
    label: 'Strong fundamentals',
    description: 'High ROCE, low debt, consistent profit growth',
    classes: ['EQUITY'],
  },
  {
    key: 'OVERSOLD',
    label: 'Oversold',
    description: 'RSI below 30 with signs of stabilising',
    classes: ['EQUITY', 'FOREX', 'CRYPTO'],
  },
  {
    key: 'OVERBOUGHT',
    label: 'Overbought',
    description: 'RSI above 70 and extended from the mean',
    classes: ['EQUITY', 'FOREX', 'CRYPTO'],
  },
];

/* ── Risk defaults ───────────────────────────────────────── */

export const RISK_DEFAULTS = {
  capital: 500000,
  riskPerTradePercent: 1,
  dailyLossLimitPercent: 3,
  weeklyLossLimitPercent: 6,
  maxDrawdownPercent: 15,
  minRiskReward: 1.5,
};

/** Long-run nominal return assumptions used by the investment calculators. */
export const RETURN_ASSUMPTIONS = [
  { key: 'equity_mf', label: 'Equity mutual fund', rate: 12 },
  { key: 'index_etf', label: 'Index ETF (NIFTY 50)', rate: 11 },
  { key: 'hybrid', label: 'Hybrid / balanced', rate: 9 },
  { key: 'debt', label: 'Debt fund', rate: 7 },
  { key: 'gold', label: 'Gold', rate: 8 },
  { key: 'bonds', label: 'Government bonds', rate: 7 },
  { key: 'fd', label: 'Fixed deposit', rate: 6.5 },
];

export const DEFAULT_INFLATION = 6;

/* ── UI ──────────────────────────────────────────────────── */

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

/** Shown once, in the footer and on every signal surface. Not dismissible. */
export const DISCLAIMER =
  'Analysis and probabilities are generated from historical data and may be wrong. ' +
  'Nothing here is investment advice, and no outcome is guaranteed. Trade your own plan.';
