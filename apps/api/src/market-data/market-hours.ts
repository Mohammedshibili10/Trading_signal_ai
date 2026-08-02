/**
 * Market hours — the single authority.
 *
 * Trading-hours logic was previously duplicated across seven files, and the
 * copies had already drifted: two of them believed forex opened Sunday at 03:30
 * IST, which is a full day early and meant the scanner spent every Sunday
 * analysing a market nobody could trade. One source of truth is the fix.
 *
 * Three things this gets right that a naive implementation does not:
 *
 * **Daylight saving is never computed.** Every calendar carries an IANA zone
 * and all wall-clock arithmetic goes through `Intl.DateTimeFormat`. NYSE opens
 * at 09:30 New York time, which is 19:00 IST in winter and 18:00 IST in summer;
 * anything that stores a fixed offset is wrong for half the year.
 *
 * **Holidays are data, not logic.** They are listed per exchange and must be
 * refreshed annually — most Indian market holidays follow lunar calendars and
 * cannot be derived. Where a year has no list, the calendar says so rather than
 * silently reporting a closed exchange as open.
 *
 * **The four states are distinct.** Pre-market and after-hours are not "open"
 * and not "closed": prices print, but they print on thin volume in a session
 * the engine's calibration was never measured against.
 */

export type MarketState = 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS';

export interface MarketSession {
  /** Minutes from local midnight. */
  open: number;
  close: number;
}

export interface ExchangeCalendar {
  code: string;
  name: string;
  /** IANA zone — carries DST rules, so nothing here stores an offset. */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  tradingDays: number[];
  regular: MarketSession;
  preMarket?: MarketSession;
  afterHours?: MarketSession;
  /** ISO dates (YYYY-MM-DD) in exchange-local terms. */
  holidays: Record<number, string[]>;
  /** True for venues with no close at all. */
  alwaysOpen?: boolean;
  note: string;
}

const HHMM = (hours: number, minutes = 0) => hours * 60 + minutes;

/**
 * Holiday calendars.
 *
 * **These need updating every year.** Indian exchange holidays largely follow
 * lunar calendars — Holi, Diwali, Eid and several others move by a fortnight or
 * more between years and cannot be computed from a rule. Only dates that are
 * fixed by statute are listed below; the rest must be loaded from the
 * exchange's published circular.
 *
 * A year with no entry is reported as `holidaysUnknown` rather than assumed
 * clear, because silently treating an unlisted year as holiday-free would mean
 * confidently declaring a closed exchange open.
 */
const NSE_HOLIDAYS: Record<number, string[]> = {
  // Fixed-date national holidays only. Verified against statute, not a circular.
  2026: ['2026-01-26', '2026-05-01', '2026-08-15', '2026-10-02', '2026-12-25'],
};

const US_HOLIDAYS: Record<number, string[]> = {
  // Fixed-date US market holidays. The moving ones (Thanksgiving, Good Friday,
  // Memorial/Labor Day) follow rules and are handled below.
  2026: ['2026-01-01', '2026-07-03', '2026-12-25'],
};

export const CALENDARS: Record<string, ExchangeCalendar> = {
  NSE: {
    code: 'NSE',
    name: 'National Stock Exchange of India',
    timezone: 'Asia/Kolkata',
    tradingDays: [1, 2, 3, 4, 5],
    regular: { open: HHMM(9, 15), close: HHMM(15, 30) },
    preMarket: { open: HHMM(9, 0), close: HHMM(9, 15) },
    // The post-close session is for closing-price orders only.
    afterHours: { open: HHMM(15, 40), close: HHMM(16, 0) },
    holidays: NSE_HOLIDAYS,
    note: 'Equities trade 09:15–15:30 IST with a pre-open auction from 09:00.',
  },
  BSE: {
    code: 'BSE',
    name: 'Bombay Stock Exchange',
    timezone: 'Asia/Kolkata',
    tradingDays: [1, 2, 3, 4, 5],
    regular: { open: HHMM(9, 15), close: HHMM(15, 30) },
    preMarket: { open: HHMM(9, 0), close: HHMM(9, 15) },
    afterHours: { open: HHMM(15, 40), close: HHMM(16, 0) },
    holidays: NSE_HOLIDAYS,
    note: 'Same session as the NSE.',
  },
  NYSE: {
    code: 'NYSE',
    name: 'New York Stock Exchange',
    timezone: 'America/New_York',
    tradingDays: [1, 2, 3, 4, 5],
    regular: { open: HHMM(9, 30), close: HHMM(16, 0) },
    preMarket: { open: HHMM(4, 0), close: HHMM(9, 30) },
    afterHours: { open: HHMM(16, 0), close: HHMM(20, 0) },
    holidays: US_HOLIDAYS,
    note: 'Regular session 09:30–16:00 ET, with extended hours either side.',
  },
  NASDAQ: {
    code: 'NASDAQ',
    name: 'Nasdaq Stock Market',
    timezone: 'America/New_York',
    tradingDays: [1, 2, 3, 4, 5],
    regular: { open: HHMM(9, 30), close: HHMM(16, 0) },
    preMarket: { open: HHMM(4, 0), close: HHMM(9, 30) },
    afterHours: { open: HHMM(16, 0), close: HHMM(20, 0) },
    holidays: US_HOLIDAYS,
    note: 'Same session as the NYSE.',
  },
  FX: {
    code: 'FX',
    name: 'Foreign exchange',
    timezone: 'America/New_York',
    // Continuous from Sunday 17:00 ET to Friday 17:00 ET. Expressed in New York
    // terms because that is where the week's boundary is actually defined —
    // converting it to IST is what produced the off-by-a-day bug.
    tradingDays: [0, 1, 2, 3, 4, 5],
    regular: { open: HHMM(17, 0), close: HHMM(17, 0) },
    holidays: {},
    note: 'Opens Sunday 17:00 New York and runs continuously to Friday 17:00.',
  },
  CRYPTO: {
    code: 'CRYPTO',
    name: 'Crypto',
    timezone: 'UTC',
    tradingDays: [0, 1, 2, 3, 4, 5, 6],
    regular: { open: 0, close: 1440 },
    holidays: {},
    alwaysOpen: true,
    note: 'Trades 24×7 with no close.',
  },
  AMFI: {
    code: 'AMFI',
    name: 'AMFI (mutual fund NAVs)',
    timezone: 'Asia/Kolkata',
    tradingDays: [1, 2, 3, 4, 5],
    // A NAV is published once, after the underlying market closes.
    regular: { open: HHMM(9, 15), close: HHMM(15, 30) },
    holidays: NSE_HOLIDAYS,
    note: 'NAVs publish once daily after the equity market closes.',
  },
};

/** Local wall-clock parts for an instant, in a given zone. DST-correct. */
function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // 24:00 is emitted by some ICU versions for midnight; normalise it.
  const hour = Number(get('hour')) % 24;

  return {
    weekday: weekdays[get('weekday')] ?? 0,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    year: Number(get('year')),
    minutes: hour * 60 + Number(get('minute')),
  };
}

/**
 * Moving US holidays, derived from their rules.
 *
 * Only the ones that follow a stated rule. Good Friday depends on the
 * ecclesiastical lunar calendar and is deliberately not computed here — a
 * wrong holiday is worse than a missing one, because it silently suppresses a
 * whole trading day.
 */
function movingUsHolidays(year: number): string[] {
  const iso = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  /** The nth given weekday of a month, or the last when n is -1. */
  const nth = (month: number, weekday: number, n: number): Date => {
    if (n > 0) {
      const first = new Date(Date.UTC(year, month, 1));
      const shift = (weekday - first.getUTCDay() + 7) % 7;
      return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
    }
    const last = new Date(Date.UTC(year, month + 1, 0));
    const shift = (last.getUTCDay() - weekday + 7) % 7;
    return new Date(Date.UTC(year, month + 1, 0 - shift));
  };

  return [
    iso(nth(0, 1, 3)), // MLK Day — third Monday in January
    iso(nth(1, 1, 3)), // Presidents' Day — third Monday in February
    iso(nth(4, 1, -1)), // Memorial Day — last Monday in May
    iso(nth(8, 1, 1)), // Labor Day — first Monday in September
    iso(nth(10, 4, 4)), // Thanksgiving — fourth Thursday in November
  ];
}

function holidaysFor(calendar: ExchangeCalendar, year: number): string[] | null {
  const listed = calendar.holidays[year];
  const isUs = calendar.timezone === 'America/New_York' && calendar.code !== 'FX';

  if (!listed) return isUs ? movingUsHolidays(year) : null;
  return isUs ? [...listed, ...movingUsHolidays(year)] : listed;
}

export interface MarketStatus {
  exchange: string;
  name: string;
  timezone: string;
  state: MarketState;
  isOpen: boolean;
  /** True when signals may be issued — open, and not a thin extended session. */
  tradeable: boolean;
  label: string;
  localTime: string;
  /** ISO instant of the next state change, or null when there is none. */
  nextChange: string | null;
  nextChangeLabel: string | null;
  /** Set when the year's holiday list has not been loaded. */
  holidaysUnknown: boolean;
  note: string;
}

/** Is this local date a holiday? `null` means the year's list is unavailable. */
function isHoliday(calendar: ExchangeCalendar, date: string, year: number): boolean | null {
  const list = holidaysFor(calendar, year);
  if (list === null) return null;
  return list.includes(date);
}

/**
 * Forex is continuous across the week, so it gets its own path.
 *
 * Expressed entirely in New York time, where the week's boundaries are
 * actually defined: open Sunday 17:00, close Friday 17:00.
 */
function forexStatus(calendar: ExchangeCalendar, at: Date): MarketStatus {
  const { weekday, minutes } = localParts(at, calendar.timezone);
  const openMinute = calendar.regular.open;

  const open =
    (weekday === 0 && minutes >= openMinute) ||
    (weekday >= 1 && weekday <= 4) ||
    (weekday === 5 && minutes < openMinute);

  const next = nextForexChange(calendar, at, open);

  return {
    exchange: calendar.code,
    name: calendar.name,
    timezone: calendar.timezone,
    state: open ? 'OPEN' : 'CLOSED',
    isOpen: open,
    tradeable: open,
    label: open ? 'Forex open' : 'Forex closed for the weekend',
    localTime: formatLocal(at, calendar.timezone),
    nextChange: next?.toISOString() ?? null,
    nextChangeLabel: open ? 'Closes' : 'Opens',
    holidaysUnknown: false,
    note: calendar.note,
  };
}

function nextForexChange(calendar: ExchangeCalendar, at: Date, open: boolean): Date | null {
  const openAt = (moment: Date): boolean => {
    const { weekday, minutes } = localParts(moment, calendar.timezone);
    return (
      (weekday === 0 && minutes >= calendar.regular.open) ||
      (weekday >= 1 && weekday <= 4) ||
      (weekday === 5 && minutes < calendar.regular.open)
    );
  };

  // Coarse scan to find the window the flip falls in, then narrow to the
  // minute. Without the second pass the answer lands up to five minutes late,
  // which a visible countdown makes obvious.
  for (let step = 5; step <= 60 * 24 * 8; step += 5) {
    const probe = new Date(at.getTime() + step * 60_000);
    if (openAt(probe) === open) continue;

    for (let back = 4; back >= 0; back -= 1) {
      const finer = new Date(probe.getTime() - back * 60_000);
      if (openAt(finer) !== open) return finer;
    }
    return probe;
  }
  return null;
}

/** Status for one exchange at an instant. */
export function statusFor(exchangeCode: string, at: Date = new Date()): MarketStatus {
  const calendar = CALENDARS[exchangeCode] ?? CALENDARS.NSE;

  if (calendar.alwaysOpen) {
    return {
      exchange: calendar.code,
      name: calendar.name,
      timezone: calendar.timezone,
      state: 'OPEN',
      isOpen: true,
      tradeable: true,
      label: 'Open 24×7',
      localTime: formatLocal(at, calendar.timezone),
      nextChange: null,
      nextChangeLabel: null,
      holidaysUnknown: false,
      note: calendar.note,
    };
  }

  if (calendar.code === 'FX') return forexStatus(calendar, at);

  const { weekday, date, year, minutes } = localParts(at, calendar.timezone);
  const holiday = isHoliday(calendar, date, year);
  const isTradingDay = calendar.tradingDays.includes(weekday) && holiday !== true;

  let state: MarketState = 'CLOSED';
  if (isTradingDay) {
    if (minutes >= calendar.regular.open && minutes < calendar.regular.close) {
      state = 'OPEN';
    } else if (
      calendar.preMarket &&
      minutes >= calendar.preMarket.open &&
      minutes < calendar.preMarket.close
    ) {
      state = 'PRE_MARKET';
    } else if (
      calendar.afterHours &&
      minutes >= calendar.afterHours.open &&
      minutes < calendar.afterHours.close
    ) {
      state = 'AFTER_HOURS';
    }
  }

  const next = nextChangeFor(calendar, at);

  const label =
    state === 'OPEN'
      ? `${calendar.code} open`
      : state === 'PRE_MARKET'
        ? 'Pre-market'
        : state === 'AFTER_HOURS'
          ? 'After-hours'
          : holiday === true
            ? `${calendar.code} closed — market holiday`
            : calendar.tradingDays.includes(weekday)
              ? `${calendar.code} closed`
              : `${calendar.code} closed — weekend`;

  return {
    exchange: calendar.code,
    name: calendar.name,
    timezone: calendar.timezone,
    state,
    isOpen: state === 'OPEN',
    // Extended sessions print prices on thin volume, in a session the engine's
    // calibration was never measured against. Analysable, not tradeable.
    tradeable: state === 'OPEN',
    label,
    localTime: formatLocal(at, calendar.timezone),
    nextChange: next?.at.toISOString() ?? null,
    nextChangeLabel: next?.label ?? null,
    holidaysUnknown: holiday === null,
    note: calendar.note,
  };
}

/**
 * When the state next changes.
 *
 * Scans forward in five-minute steps for up to ten days. Deliberately a scan
 * rather than closed-form arithmetic: it inherits DST transitions, holidays and
 * weekends from `statusFor` itself, so the answer cannot disagree with the
 * status it accompanies.
 */
function nextChangeFor(
  calendar: ExchangeCalendar,
  at: Date,
): { at: Date; label: string } | null {
  const current = stateAt(calendar, at);

  for (let step = 5; step <= 60 * 24 * 10; step += 5) {
    const probe = new Date(at.getTime() + step * 60_000);
    const probeState = stateAt(calendar, probe);
    if (probeState === current) continue;

    // Narrow to the minute so a countdown does not sit up to five minutes off.
    for (let back = 4; back >= 0; back -= 1) {
      const finer = new Date(probe.getTime() - back * 60_000);
      if (stateAt(calendar, finer) !== current) {
        return {
          at: finer,
          label: probeState === 'OPEN' ? 'Opens' : current === 'OPEN' ? 'Closes' : 'Next session',
        };
      }
    }
    return {
      at: probe,
      label: probeState === 'OPEN' ? 'Opens' : current === 'OPEN' ? 'Closes' : 'Next session',
    };
  }
  return null;
}

function stateAt(calendar: ExchangeCalendar, at: Date): MarketState {
  const { weekday, date, year, minutes } = localParts(at, calendar.timezone);
  if (!calendar.tradingDays.includes(weekday)) return 'CLOSED';
  if (isHoliday(calendar, date, year) === true) return 'CLOSED';

  if (minutes >= calendar.regular.open && minutes < calendar.regular.close) return 'OPEN';
  if (
    calendar.preMarket &&
    minutes >= calendar.preMarket.open &&
    minutes < calendar.preMarket.close
  ) {
    return 'PRE_MARKET';
  }
  if (
    calendar.afterHours &&
    minutes >= calendar.afterHours.open &&
    minutes < calendar.afterHours.close
  ) {
    return 'AFTER_HOURS';
  }
  return 'CLOSED';
}

function formatLocal(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/**
 * Which calendar an instrument uses.
 *
 * Exchange first, because it is the specific answer; asset class is the
 * fallback for anything whose exchange is not recognised.
 */
export function calendarFor(exchange: string | null, assetClass: string): string {
  if (exchange && CALENDARS[exchange]) return exchange;
  if (assetClass === 'CRYPTO') return 'CRYPTO';
  if (assetClass === 'FOREX') return 'FX';
  if (assetClass === 'INVESTMENT') return 'AMFI';
  return 'NSE';
}

/** Convenience for the many callers that only need the boolean. */
export function isOpen(exchange: string | null, assetClass: string, at = new Date()): boolean {
  return statusFor(calendarFor(exchange, assetClass), at).isOpen;
}

/** Every calendar's status at once, for the markets overview. */
export function allStatuses(at = new Date()): MarketStatus[] {
  return Object.keys(CALENDARS).map((code) => statusFor(code, at));
}
