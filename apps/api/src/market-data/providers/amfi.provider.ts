import { Injectable, Logger } from '@nestjs/common';

import {
  fetchText,
  type InstrumentRef,
  type MarketDataProvider,
  type ProviderCandle,
  type ProviderQuote,
  type Timeframe,
} from './provider.interface';

export interface AmfiScheme {
  schemeCode: string;
  isinGrowth: string | null;
  isinReinvestment: string | null;
  name: string;
  nav: number;
  date: string;
  fundHouse: string;
  category: string;
}

/**
 * AMFI — the authoritative source for Indian mutual fund NAVs.
 *
 * The daily file is ~9 MB covering ~16,000 schemes, so it is fetched once a day
 * by a scheduled job and parsed into Postgres. It is never on a request path.
 *
 * Historical NAV per scheme comes from mfapi.in, a community mirror of AMFI
 * history — convenient, but AMFI remains the source of truth.
 *
 * File format and parsing rules: docs/data-sources.md §4.1
 */
@Injectable()
export class AmfiProvider implements MarketDataProvider {
  readonly name = 'amfi';
  private readonly logger = new Logger(AmfiProvider.name);
  private readonly navUrl = 'https://www.amfiindia.com/spages/NAVAll.txt';
  private readonly historyUrl = 'https://api.mfapi.in/mf';

  supports(instrument: InstrumentRef): boolean {
    return instrument.kind === 'MUTUAL_FUND';
  }

  private schemeCode(instrument: InstrumentRef): string | null {
    return instrument.providerSymbols?.amfi ?? null;
  }

  async getQuote(instrument: InstrumentRef): Promise<ProviderQuote | null> {
    const code = this.schemeCode(instrument);
    if (!code) return null;

    try {
      const data = await fetchText(`${this.historyUrl}/${code}/latest`, { timeoutMs: 8000 });
      const parsed = JSON.parse(data) as MfApiResponse;
      const latest = parsed.data?.[0];
      if (!latest) return null;

      const nav = Number(latest.nav);
      if (!Number.isFinite(nav)) return null;

      // The "latest" endpoint returns one row, so there is no previous NAV to
      // compute a change from. Reported as zero rather than fabricated; the
      // service fills it in from the stored history where available.
      return {
        symbol: instrument.symbol,
        price: nav,
        change: 0,
        changePercent: 0,
        open: nav,
        high: nav,
        low: nav,
        previousClose: nav,
        volume: 0,
        currency: 'INR',
        updatedAt: this.parseDate(latest.date).toISOString(),
        source: this.name,
      };
    } catch (error) {
      this.logger.debug(`NAV lookup failed for ${code}: ${(error as Error).message}`);
      return null;
    }
  }

  async getCandles(
    instrument: InstrumentRef,
    _timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderCandle[]> {
    const code = this.schemeCode(instrument);
    if (!code) return [];

    try {
      const raw = await fetchText(`${this.historyUrl}/${code}`, { timeoutMs: 20_000 });
      const parsed = JSON.parse(raw) as MfApiResponse;
      if (!parsed.data?.length) return [];

      // A NAV series has no intrabar shape. Open/high/low are set to the close
      // so downstream code has a valid OHLC record; the analysis engine drops
      // the candlestick and volume factor groups for INVESTMENT instruments
      // precisely because those values carry no information here.
      const candles = parsed.data
        .map((row) => {
          const nav = Number(row.nav);
          if (!Number.isFinite(nav) || nav <= 0) return null;
          return {
            time: Math.floor(this.parseDate(row.date).getTime() / 1000),
            open: nav,
            high: nav,
            low: nav,
            close: nav,
            volume: 0,
          };
        })
        .filter((c): c is ProviderCandle => c !== null)
        // mfapi returns newest first.
        .reverse();

      return candles.slice(-limit);
    } catch (error) {
      this.logger.debug(`NAV history failed for ${code}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Download and parse the full AMFI dump.
   *
   * Called by the nightly job, not by request handlers.
   */
  async fetchAllSchemes(): Promise<AmfiScheme[]> {
    const text = await fetchText(this.navUrl, { timeoutMs: 90_000 });
    const lines = text.split('\n');

    const schemes: AmfiScheme[] = [];
    let currentCategory = '';
    let currentFundHouse = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // The header row repeats between blocks.
      if (line.startsWith('Scheme Code')) continue;

      const fields = line.split(';');

      // Single-field lines are section headers: a category line (which contains
      // "Schemes") or a fund-house name. Tracking them is what lets us classify
      // each scheme — discarding them, as most parsers do, throws that away.
      if (fields.length === 1) {
        if (line.includes('Schemes') || line.includes('Scheme')) {
          currentCategory = line;
        } else {
          currentFundHouse = line;
        }
        continue;
      }

      if (fields.length !== 6) continue;

      const [code, isinGrowth, isinReinvest, name, navRaw, dateRaw] = fields.map((f) => f.trim());
      const nav = Number(navRaw);
      // Schemes that did not report publish "N.A."
      if (!Number.isFinite(nav) || nav <= 0) continue;

      schemes.push({
        schemeCode: code,
        isinGrowth: isinGrowth && isinGrowth !== '-' ? isinGrowth : null,
        isinReinvestment: isinReinvest && isinReinvest !== '-' ? isinReinvest : null,
        name,
        nav,
        date: dateRaw,
        fundHouse: currentFundHouse,
        category: currentCategory,
      });
    }

    this.logger.log(`parsed ${schemes.length} schemes from AMFI`);
    return schemes;
  }

  /** AMFI publishes dates as DD-MMM-YYYY. */
  private parseDate(value: string): Date {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const match = /^(\d{2})-(\w{3})-(\d{4})$/.exec(value.trim());
    if (!match) {
      const fallback = new Date(value);
      return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
    }
    return new Date(Date.UTC(Number(match[3]), months[match[2]] ?? 0, Number(match[1])));
  }
}

interface MfApiResponse {
  meta?: { scheme_name?: string; fund_house?: string };
  data?: Array<{ date: string; nav: string }>;
}
