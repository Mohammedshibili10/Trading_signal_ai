/**
 * Shared domain contract.
 *
 * These shapes are the wire format between the Next.js client, the NestJS API
 * and the FastAPI analysis service. Mirrored in:
 *   - apps/api/src/common/contracts.ts
 *   - services/ai/app/schemas.py
 * Keep the three in sync when changing anything here.
 */

/* ── Instruments ─────────────────────────────────────────── */

/** The four categories the platform covers. Nothing else is supported. */
export type AssetClass = 'EQUITY' | 'FOREX' | 'CRYPTO' | 'INVESTMENT';

export type InstrumentKind =
  | 'STOCK' // NSE / BSE listed equity
  | 'INDEX' // NIFTY 50, BANKNIFTY, SENSEX…
  | 'FOREX' // USDINR, EURUSD…
  | 'CRYPTO' // BTC, ETH…
  | 'MUTUAL_FUND'
  | 'ETF'
  | 'GOLD'
  | 'BOND';

export type Exchange = 'NSE' | 'BSE' | 'FX' | 'CRYPTO' | 'AMFI';

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  kind: InstrumentKind;
  exchange: Exchange;
  currency: 'INR' | 'USD';
  sector?: string | null;
  industry?: string | null;
  isin?: string | null;
  lotSize?: number | null;
  tickSize?: number | null;
  /** Crypto/forex trade outside Indian market hours. */
  tradingHours: '24x7' | '24x5' | 'IST_0915_1530' | 'NAV_DAILY';
}

/* ── Quotes & candles ────────────────────────────────────── */

export interface Quote {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  kind: InstrumentKind;
  exchange: Exchange;
  currency: 'INR' | 'USD';
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  /** Equities only. Absolute currency units (INR). */
  marketCap?: number | null;
  yearHigh?: number | null;
  yearLow?: number | null;
  /** Forex/crypto only. */
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  /** ISO-8601, always UTC. Render in IST client-side. */
  updatedAt: string;
  /** True when the underlying venue is open right now. */
  isOpen: boolean;
  /** Which provider actually served this tick. */
  source: string;
  /** Set when the value came from cache/last-close rather than a live tick. */
  stale?: boolean;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';

export interface Candle {
  /** Unix seconds, UTC. Lightweight-charts native format. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  source: string;
}

/* ── Technical analysis ──────────────────────────────────── */

export type Stance = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface IndicatorReading {
  key: string;
  label: string;
  value: number | null;
  /** Pre-formatted for display (handles %, x, ₹ and precision). */
  display: string;
  stance: Stance;
  /** Plain-language read of what this value means right now. */
  note: string;
  /** Extra series values, e.g. MACD signal/histogram, BB upper/lower. */
  extra?: Record<string, number | null>;
}

export interface TechnicalAnalysis {
  symbol: string;
  timeframe: Timeframe;
  asOf: string;
  price: number;
  indicators: IndicatorReading[];
  /** −100 … +100. Weighted roll-up of every indicator. */
  score: number;
  stance: Stance;
  trend: {
    direction: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
    strength: number; // 0…100, ADX-derived
    label: string;
    maStack: 'BULLISH' | 'BEARISH' | 'MIXED';
  };
  momentum: {
    value: number; // −100…100
    label: string;
    divergence: 'BULLISH' | 'BEARISH' | null;
  };
  volatility: {
    atr: number;
    atrPercent: number;
    regime: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
    percentile: number;
  };
  volume: {
    ratio: number; // vs 20-period average
    trend: 'RISING' | 'FALLING' | 'FLAT';
    label: string;
  };
  summary: string;
}

/* ── Price action & structure ────────────────────────────── */

export interface Level {
  price: number;
  kind: 'SUPPORT' | 'RESISTANCE' | 'PIVOT' | 'FIBONACCI';
  /** 0…100 — how many times touched, how recently, on what volume. */
  strength: number;
  label: string;
  touches: number;
  distancePercent: number;
}

export interface PriceActionAnalysis {
  symbol: string;
  timeframe: Timeframe;
  levels: Level[];
  events: Array<{
    type: 'BREAKOUT' | 'BREAKDOWN' | 'PULLBACK' | 'RETEST' | 'RANGE' | 'TRENDLINE_BREAK';
    stance: Stance;
    price: number;
    time: number;
    confidence: number;
    note: string;
  }>;
  trendlines: Array<{
    kind: 'SUPPORT' | 'RESISTANCE';
    from: { time: number; price: number };
    to: { time: number; price: number };
    slope: number;
    touches: number;
    intact: boolean;
  }>;
  channel: {
    upper: number;
    lower: number;
    midline: number;
    slope: number;
    positionPercent: number;
  } | null;
  summary: string;
}

/* ── Smart Money Concepts ────────────────────────────────── */

export interface SmcAnalysis {
  symbol: string;
  timeframe: Timeframe;
  orderBlocks: Array<{
    kind: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
    time: number;
    mitigated: boolean;
    strength: number;
  }>;
  fairValueGaps: Array<{
    kind: 'BULLISH' | 'BEARISH';
    top: number;
    bottom: number;
    time: number;
    filled: boolean;
    sizePercent: number;
  }>;
  liquidity: Array<{
    kind: 'BUY_SIDE' | 'SELL_SIDE';
    price: number;
    swept: boolean;
    time: number;
    label: string;
  }>;
  structure: Array<{
    type: 'BOS' | 'CHOCH';
    direction: 'BULLISH' | 'BEARISH';
    price: number;
    time: number;
    note: string;
  }>;
  premiumDiscount: {
    equilibrium: number;
    rangeHigh: number;
    rangeLow: number;
    zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
    positionPercent: number;
  } | null;
  bias: Stance;
  summary: string;
}

/* ── Patterns & candlesticks ─────────────────────────────── */

export interface ChartPattern {
  name: string;
  kind:
    | 'DOUBLE_TOP'
    | 'DOUBLE_BOTTOM'
    | 'HEAD_SHOULDERS'
    | 'INVERSE_HEAD_SHOULDERS'
    | 'ASCENDING_TRIANGLE'
    | 'DESCENDING_TRIANGLE'
    | 'SYMMETRICAL_TRIANGLE'
    | 'BULL_FLAG'
    | 'BEAR_FLAG'
    | 'PENNANT'
    | 'RISING_WEDGE'
    | 'FALLING_WEDGE'
    | 'RECTANGLE'
    | 'CUP_HANDLE';
  stance: Stance;
  confidence: number;
  startTime: number;
  endTime: number;
  neckline?: number | null;
  target?: number | null;
  invalidation?: number | null;
  status: 'FORMING' | 'CONFIRMED' | 'FAILED';
  note: string;
  points: Array<{ time: number; price: number; label: string }>;
}

export interface CandlestickPattern {
  name: string;
  kind: string;
  stance: Stance;
  time: number;
  /** How many bars the pattern spans. */
  bars: number;
  reliability: number; // 0…100, context-adjusted
  /** Raw textbook reliability before trend/volume/location adjustment. */
  baseReliability: number;
  note: string;
}

/* ── Per-candle characterisation & forecast ──────────────── */

/**
 * Objective, measurable description of a single candle. No interpretation —
 * that happens in `CandleForecast`.
 */
export interface CandleAnatomy {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  /** Each as a share of total range, 0…1. */
  bodyPercent: number;
  upperWickPercent: number;
  lowerWickPercent: number;
  /** Close Location Value: −1 (closed on the low) … +1 (closed on the high). */
  closeLocation: number;
  /** Candle range ÷ ATR(14). >1.5 is a wide-range bar. */
  rangeVsAtr: number;
  /** Volume ÷ 20-bar average volume. */
  volumeRatio: number;
  gapPercent: number;
  isInside: boolean;
  isOutside: boolean;
  /** Wide range + volume spike + long wick = potential exhaustion. */
  isClimactic: boolean;
  /** e.g. "Wide-range bullish marubozu", "Long-legged doji". */
  classification: string;
  /** Effort (volume) vs result (range) — Wyckoff style read. */
  effortVsResult: 'CONFIRMING' | 'DIVERGENT' | 'NEUTRAL';
  positionVsEma20: number; // % distance
  positionVsVwap: number | null;
}

/** One weighted piece of evidence feeding a forecast. */
export interface ForecastFactor {
  group:
    | 'CANDLESTICK'
    | 'INDICATORS'
    | 'PRICE_ACTION'
    | 'MARKET_STRUCTURE'
    | 'TREND'
    | 'VOLUME'
    | 'VOLATILITY'
    | 'NEWS'
    | 'FUNDAMENTALS';
  label: string;
  /** −1 (max bearish) … +1 (max bullish). */
  score: number;
  /** Relative importance within the blend, 0…1. */
  weight: number;
  stance: Stance;
  /** Human-readable justification shown verbatim in the UI. */
  detail: string;
}

/**
 * What the engine expects from the *next* candle after the one described by
 * `anatomy`. Probabilities are calibrated against walk-forward history, so
 * `probUp` of 0.62 means "in this setup, historically ~62% of next candles
 * closed higher" — not a promise.
 */
export interface CandleForecast {
  symbol: string;
  timeframe: Timeframe;
  anatomy: CandleAnatomy;
  /** Sums to 1 with probDown and probFlat. */
  probUp: number;
  probDown: number;
  probFlat: number;
  /** Expected move of the next candle as % of price, sign-aware. */
  expectedMovePercent: number;
  /** 1-sigma band around the expected close. */
  expectedRange: { low: number; high: number };
  bias: Stance;
  /** 0…100. Blends factor agreement, evidence strength and data quality. */
  confidence: number;
  factors: ForecastFactor[];
  /** Ranked plain-language reasons — highest |score × weight| first. */
  reasons: string[];
  /** What would prove this read wrong. */
  invalidation: { price: number; note: string };
  /** Measured performance of this engine on this symbol/timeframe. */
  calibration: CalibrationReport | null;
}

export interface CalibrationReport {
  /** Number of historical bars scored walk-forward. */
  samples: number;
  /** Share of directional calls that resolved correctly. */
  hitRate: number;
  /** Hit rate restricted to calls above the confidence floor. */
  highConfidenceHitRate: number;
  highConfidenceSamples: number;
  /** Mean |predicted probability − observed frequency| across buckets. */
  calibrationError: number;
  /** Predicted-vs-actual per confidence bucket. */
  buckets: Array<{
    label: string;
    predicted: number;
    actual: number;
    samples: number;
  }>;
  /** Brier score, lower is better. 0.25 = coin flip. */
  brierScore: number;
  window: string;
}

/* ── Signals ─────────────────────────────────────────────── */

export type SignalAction = 'BUY' | 'SELL' | 'HOLD' | 'WAIT';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export interface TradeSignal {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  timeframe: Timeframe;
  action: SignalAction;
  /** 0…100, calibrated. */
  confidence: number;
  /** Trade horizon this idea is built for. */
  horizon: 'INTRADAY' | 'SWING' | 'POSITIONAL' | 'LONG_TERM';
  entry: number;
  entryZone: { low: number; high: number };
  stopLoss: number;
  targets: Array<{ level: 1 | 2 | 3; price: number; rr: number; probability: number }>;
  riskLevel: RiskLevel;
  riskRewardRatio: number;
  /** % of price between entry and stop. */
  riskPercent: number;
  /** Suggested position size as % of capital, from risk model. */
  suggestedAllocationPercent: number;
  /** Ranked, human-readable. Same ordering rule as CandleForecast.reasons. */
  reasons: string[];
  factors: ForecastFactor[];
  explanation: string;
  /** Bar-level forecast the signal was built on. */
  forecast: CandleForecast | null;
  calibration: CalibrationReport | null;
  validUntil: string;
  createdAt: string;
  status: 'ACTIVE' | 'HIT_T1' | 'HIT_T2' | 'HIT_T3' | 'STOPPED' | 'EXPIRED';
}

/* ── Fundamentals (Indian equity) ────────────────────────── */

export interface Fundamentals {
  symbol: string;
  name: string;
  sector: string;
  marketCap: number;
  /** Valuation */
  pe: number | null;
  pb: number | null;
  industryPe: number | null;
  evEbitda: number | null;
  dividendYield: number | null;
  /** Profitability */
  roe: number | null;
  roce: number | null;
  netMargin: number | null;
  operatingMargin: number | null;
  /** Growth, YoY % */
  revenueGrowth: number | null;
  profitGrowth: number | null;
  epsGrowth: number | null;
  /** Health */
  debtToEquity: number | null;
  interestCoverage: number | null;
  currentRatio: number | null;
  /** Per-share */
  eps: number | null;
  bookValue: number | null;
  /** Cash flow, absolute INR */
  operatingCashFlow: number | null;
  freeCashFlow: number | null;
  /** Ownership, % — the Indian-market lens */
  promoterHolding: number | null;
  promoterPledge: number | null;
  fiiHolding: number | null;
  diiHolding: number | null;
  publicHolding: number | null;
  quarterly: Array<{
    period: string;
    revenue: number;
    netProfit: number;
    eps: number;
    operatingMargin: number;
  }>;
  annual: Array<{
    year: string;
    revenue: number;
    netProfit: number;
    eps: number;
    roe: number;
  }>;
  scores: {
    quality: number; // 0…100
    valuation: number;
    growth: number;
    financialHealth: number;
    investment: number; // composite
  };
  longTermRating: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'REDUCE' | 'AVOID';
  strengths: string[];
  concerns: string[];
  summary: string;
}

/* ── News & sentiment ────────────────────────────────────── */

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  symbols: string[];
  assetClasses: AssetClass[];
  stance: Stance;
  /** 0…1 from the classifier. */
  confidence: number;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Why a trader should care — one or two sentences. */
  whyItMatters: string;
  expectedImpact: string;
  category: string;
}

export interface SentimentAnalysis {
  symbol: string;
  stance: Stance;
  score: number; // −100…100
  confidence: number;
  sources: {
    news: { stance: Stance; score: number; count: number };
    social: { stance: Stance; score: number; count: number };
    analyst: { stance: Stance; score: number; count: number };
  };
  trend: Array<{ date: string; score: number }>;
  reasoning: string;
  model: string;
}

/* ── Risk ────────────────────────────────────────────────── */

export interface PositionSizeResult {
  capital: number;
  riskPercent: number;
  riskAmount: number;
  entry: number;
  stopLoss: number;
  riskPerUnit: number;
  quantity: number;
  positionValue: number;
  positionPercentOfCapital: number;
  /** Equity only — NSE lot sizing for F&O. */
  lots?: number | null;
  rewardAtTarget?: number | null;
  riskRewardRatio?: number | null;
  warnings: string[];
}

export interface MonteCarloResult {
  simulations: number;
  horizonDays: number;
  startingCapital: number;
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  probabilityOfProfit: number;
  probabilityOfRuin: number;
  medianMaxDrawdown: number;
  worstDrawdown: number;
  expectedReturn: number;
  /** Down-sampled equity paths for plotting. */
  paths: number[][];
  summary: string;
}

export interface PortfolioRisk {
  portfolioValue: number;
  /** 1-day 95% Value at Risk, absolute currency. */
  valueAtRisk95: number;
  valueAtRisk99: number;
  conditionalVar95: number;
  volatilityAnnual: number;
  beta: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  diversificationScore: number; // 0…100
  concentrationRisk: number;
  sectorExposure: Array<{ sector: string; percent: number; value: number }>;
  assetClassExposure: Array<{ assetClass: AssetClass; percent: number; value: number }>;
  correlationWarnings: string[];
  recommendations: string[];
}

/* ── Portfolio ───────────────────────────────────────────── */

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  kind: InstrumentKind;
  sector: string | null;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  invested: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  dayChange: number;
  dayChangePercent: number;
  allocationPercent: number;
  currency: 'INR' | 'USD';
}

export interface PortfolioSummary {
  totalInvested: number;
  currentValue: number;
  totalPnl: number;
  totalPnlPercent: number;
  dayPnl: number;
  dayPnlPercent: number;
  realisedPnl: number;
  holdingsCount: number;
  bestPerformer: { symbol: string; pnlPercent: number } | null;
  worstPerformer: { symbol: string; pnlPercent: number } | null;
}

/* ── Watchlist & alerts ──────────────────────────────────── */

export interface Watchlist {
  id: string;
  name: string;
  isDefault: boolean;
  items: WatchlistItem[];
  createdAt: string;
}

export interface WatchlistItem {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  note: string | null;
  addedAt: string;
  quote?: Quote;
}

export type AlertType =
  | 'PRICE_ABOVE'
  | 'PRICE_BELOW'
  | 'PERCENT_CHANGE'
  | 'VOLUME_SPIKE'
  | 'RSI_ABOVE'
  | 'RSI_BELOW'
  | 'AI_SIGNAL'
  | 'PATTERN'
  | 'STOP_LOSS';

export interface Alert {
  id: string;
  symbol: string;
  name: string;
  type: AlertType;
  threshold: number | null;
  channels: Array<'PUSH' | 'EMAIL' | 'IN_APP'>;
  active: boolean;
  triggeredAt: string | null;
  note: string | null;
  createdAt: string;
}

/* ── Scanners ────────────────────────────────────────────── */

export type ScannerKey =
  | 'INTRADAY'
  | 'SWING'
  | 'BREAKOUT'
  | 'HIGH_VOLUME'
  | 'MOMENTUM'
  | 'GAP_UP'
  | 'GAP_DOWN'
  | 'STRONG_FUNDAMENTALS'
  | 'OVERSOLD'
  | 'OVERBOUGHT';

export interface ScannerResult {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  price: number;
  changePercent: number;
  volume: number;
  volumeRatio: number;
  /** 0…100 — how well this row matches the scanner's intent. */
  score: number;
  matched: string[];
  signal: SignalAction;
  rsi: number | null;
  note: string;
}

/* ── Strategy builder & backtest ─────────────────────────── */

export type ConditionOperator =
  | 'GT'
  | 'LT'
  | 'GTE'
  | 'LTE'
  | 'CROSSES_ABOVE'
  | 'CROSSES_BELOW'
  | 'EQUALS'
  | 'IS';

export interface StrategyCondition {
  id: string;
  /** e.g. 'RSI', 'MACD', 'EMA', 'VOLUME', 'PRICE', 'PATTERN' */
  indicator: string;
  /** Indicator settings, e.g. { period: 14 } */
  params: Record<string, number | string>;
  operator: ConditionOperator;
  /** Number, or another indicator reference like 'EMA:50'. */
  value: number | string;
}

export interface StrategyRule {
  logic: 'AND' | 'OR';
  conditions: StrategyCondition[];
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  universe: AssetClass[];
  symbols: string[];
  timeframe: Timeframe;
  entry: StrategyRule;
  exit: StrategyRule;
  riskPerTradePercent: number;
  stopLossPercent: number | null;
  takeProfitPercent: number | null;
  useAtrStop: boolean;
  atrMultiplier: number;
  createdAt: string;
  updatedAt: string;
  lastBacktest?: BacktestResult | null;
}

export interface BacktestResult {
  strategyId: string;
  from: string;
  to: string;
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  cagr: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  largestWin: number;
  largestLoss: number;
  averageHoldingBars: number;
  equityCurve: Array<{ time: number; equity: number; drawdown: number }>;
  trades: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    pnlPercent: number;
    exitReason: string;
    bars: number;
  }>;
  monthlyReturns: Array<{ month: string; returnPercent: number }>;
  warnings: string[];
}

/* ── Investment module ───────────────────────────────────── */

export interface SipProjection {
  monthlyAmount: number;
  years: number;
  expectedReturn: number;
  stepUpPercent: number;
  totalInvested: number;
  estimatedValue: number;
  wealthGain: number;
  inflationAdjustedValue: number;
  schedule: Array<{ year: number; invested: number; value: number }>;
}

export interface GoalPlan {
  id: string;
  name: string;
  targetAmount: number;
  currentSavings: number;
  years: number;
  expectedReturn: number;
  inflationRate: number;
  inflationAdjustedTarget: number;
  requiredMonthly: number;
  onTrack: boolean;
  shortfall: number;
  suggestedAllocation: Array<{ assetClass: string; percent: number; rationale: string }>;
}

/* ── AI assistant ────────────────────────────────────────── */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Structured context the answer was grounded in. */
  context?: {
    symbols?: string[];
    usedTools?: string[];
  };
  pending?: boolean;
}

/* ── Auth & users ────────────────────────────────────────── */

export type UserRole = 'USER' | 'PRO' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  provider: 'LOCAL' | 'GOOGLE';
  createdAt: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  defaultAssetClass: AssetClass;
  baseCurrency: 'INR' | 'USD';
  riskPerTradePercent: number;
  capital: number;
  dailyLossLimitPercent: number;
  weeklyLossLimitPercent: number;
  maxDrawdownPercent: number;
  notifications: {
    email: boolean;
    push: boolean;
    priceAlerts: boolean;
    signalAlerts: boolean;
    newsAlerts: boolean;
  };
}

/* ── API envelope ────────────────────────────────────────── */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
  details?: Record<string, string[]>;
}
