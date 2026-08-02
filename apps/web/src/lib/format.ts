/**
 * Display formatting.
 *
 * Indian conventions are the default: the lakh/crore scale for large numbers
 * and the en-IN digit grouping (₹1,23,456.78 rather than ₹123,456.78).
 * Forex and crypto get their own precision rules — a 2-decimal USDINR quote
 * would be useless.
 */

import type { AssetClass, InstrumentKind } from '@/types';

const IST = 'Asia/Kolkata';

/* ── Numbers ─────────────────────────────────────────────── */

/**
 * Decimal places appropriate to the instrument. Forex majors quote to 5
 * decimals (JPY pairs to 3), crypto scales with price, equities to 2.
 */
export function precisionFor(kind: InstrumentKind, price = 0): number {
  switch (kind) {
    case 'FOREX':
      return price > 20 ? 4 : 5; // USDINR ~83.x → 4dp, EURUSD ~1.08 → 5dp
    case 'CRYPTO':
      if (price >= 1000) return 2;
      if (price >= 1) return 4;
      if (price >= 0.01) return 6;
      return 8;
    case 'MUTUAL_FUND':
      return 4; // NAVs are published to 4dp
    default:
      return 2;
  }
}

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPrice(
  value: number | null | undefined,
  opts: { kind?: InstrumentKind; currency?: 'INR' | 'USD'; withSymbol?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const { kind = 'STOCK', currency = 'INR', withSymbol = true } = opts;
  const decimals = precisionFor(kind, Math.abs(value));
  const num = value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (!withSymbol || kind === 'FOREX') return num;
  return `${currency === 'INR' ? '₹' : '$'}${num}`;
}

/**
 * Large currency amounts in the Indian scale.
 * 1 lakh = 1e5, 1 crore = 1e7. Above 1e12 we say "L Cr" (lakh crore), which is
 * how Indian market cap is quoted in practice.
 */
export function formatCompactINR(value: number | null | undefined, withSymbol = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const prefix = withSymbol ? '₹' : '';

  const scale = (n: number, suffix: string) => {
    const d = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return `${sign}${prefix}${n.toFixed(d)} ${suffix}`;
  };

  if (abs >= 1e12) return scale(abs / 1e12, 'L Cr');
  if (abs >= 1e7) return scale(abs / 1e7, 'Cr');
  if (abs >= 1e5) return scale(abs / 1e5, 'L');
  if (abs >= 1e3) return scale(abs / 1e3, 'K');
  return `${sign}${prefix}${abs.toFixed(abs % 1 === 0 ? 0 : 2)}`;
}

export function formatCompactUSD(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatCompact(value: number | null | undefined, currency: 'INR' | 'USD' = 'INR') {
  return currency === 'INR' ? formatCompactINR(value) : formatCompactUSD(value);
}

/** Volume — plain counts, Indian scale, no currency symbol. */
export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export function formatPercent(
  value: number | null | undefined,
  opts: { decimals?: number; signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const { decimals = 2, signed = true } = opts;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatSigned(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, decimals)}`;
}

export function formatMultiple(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}x`;
}

/* ── Direction helpers ───────────────────────────────────── */

export type Direction = 'up' | 'down' | 'flat';

export function directionOf(value: number | null | undefined, epsilon = 0): Direction {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'flat';
  if (value > epsilon) return 'up';
  if (value < -epsilon) return 'down';
  return 'flat';
}

/** Tailwind text colour for a P&L / change value. */
export function changeTextClass(value: number | null | undefined): string {
  const dir = directionOf(value);
  if (dir === 'up') return 'text-bull';
  if (dir === 'down') return 'text-bear';
  return 'text-muted-foreground';
}

/* ── Dates & market clock ────────────────────────────────── */

export function formatDate(input: string | number | Date, withTime = false): string {
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}),
  });
}

export function formatTimeIST(input: string | number | Date): string {
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatRelative(input: string | number | Date): string {
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(d);
}

/** Current time in IST as { hours, minutes, day }. */
function istParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    hours: Number(get('hour')),
    minutes: Number(get('minute')),
    weekday: get('weekday'),
  };
}

export type MarketStatus = {
  isOpen: boolean;
  label: string;
  /** Short status word for badges. */
  state: 'OPEN' | 'CLOSED' | 'PRE_OPEN' | 'ALWAYS_OPEN';
};

/**
 * Venue clock. NSE/BSE run 09:15–15:30 IST Mon–Fri (pre-open 09:00–09:15).
 * Forex is 24×5, crypto 24×7. Mutual fund NAVs publish once daily.
 */
export function marketStatus(assetClass: AssetClass, now = new Date()): MarketStatus {
  const { hours, minutes, weekday } = istParts(now);
  const mins = hours * 60 + minutes;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';

  if (assetClass === 'CRYPTO') {
    return { isOpen: true, label: 'Crypto · 24×7', state: 'ALWAYS_OPEN' };
  }

  if (assetClass === 'FOREX') {
    // Simplified: closed Sat, and Sun before 03:30 IST (Sydney open).
    const open = !(weekday === 'Sat' || (weekday === 'Sun' && mins < 210));
    return {
      isOpen: open,
      label: open ? 'Forex · Open' : 'Forex · Weekend',
      state: open ? 'OPEN' : 'CLOSED',
    };
  }

  if (assetClass === 'INVESTMENT') {
    return { isOpen: !isWeekend, label: 'NAV updates daily', state: isWeekend ? 'CLOSED' : 'OPEN' };
  }

  // EQUITY — NSE/BSE
  if (isWeekend) return { isOpen: false, label: 'NSE closed · Weekend', state: 'CLOSED' };
  if (mins >= 540 && mins < 555) return { isOpen: false, label: 'Pre-open session', state: 'PRE_OPEN' };
  if (mins >= 555 && mins <= 930) return { isOpen: true, label: 'NSE open', state: 'OPEN' };
  return { isOpen: false, label: 'NSE closed', state: 'CLOSED' };
}

/** "2h 14m" style countdown to the next NSE open. */
export function timeToNextOpen(now = new Date()): string {
  const { hours, minutes, weekday } = istParts(now);
  const mins = hours * 60 + minutes;
  const openAt = 555; // 09:15
  const daysAhead =
    weekday === 'Sat' ? 2 : weekday === 'Sun' ? 1 : mins < openAt ? 0 : weekday === 'Fri' ? 3 : 1;
  const total = daysAhead * 1440 + openAt - mins;
  if (total <= 0) return 'now';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Truncate a headline without cutting mid-word. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
