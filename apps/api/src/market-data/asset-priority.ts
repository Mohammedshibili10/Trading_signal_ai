/**
 * Asset prioritisation.
 *
 * The scanners previously took an alphabetical slice of the universe, which
 * meant ADANIENT and AXISBANK were analysed every pass while RELIANCE and TCS
 * waited for the cursor to come round. Alphabetical order is not a statement
 * about anything, and using it as one wasted most of the scanning budget on
 * instruments nobody was going to trade.
 *
 * Priority here means **liquidity and consequence**, not a view on the
 * investment. A tier-one asset is one where a signal is actionable: the spread
 * is tight, size can be filled, and the price is not one participant's opinion.
 * That is orthogonal to whether the setup is any good.
 *
 * Two sources, in order:
 *
 * **A curated majors list.** For crypto and forex there is no defensible way to
 * derive this from data the platform holds — BTC and ETH are majors because of
 * where the world's volume sits, not because of anything in the instruments
 * table. A short explicit list is more honest than a proxy that happens to
 * rank them correctly today.
 *
 * **Measured liquidity, where it exists.** For equities, market capitalisation
 * and traded volume are real signals and are used to rank everything the list
 * does not name. This is what stops the curated list becoming a maintenance
 * burden that silently goes stale.
 */

export type AssetTier = 1 | 2 | 3;

/**
 * Which markets this platform leads with.
 *
 * Crypto and forex are the primary focus, so they outrank the other classes at
 * equal tier. This is a product decision rather than a claim about the assets:
 * they trade around the clock, so there is always a live read to be had on
 * them, and a scan budget spent there is spent on something actionable at the
 * moment it runs — whereas an NSE name is only tradeable for six and a quarter
 * hours a day.
 *
 * Applied as a band above the tier bonus but below the tier itself, so a major
 * equity still outranks an obscure altcoin. Focus decides ties, not everything.
 */
const CLASS_PRIORITY: Record<string, number> = {
  CRYPTO: 4,
  FOREX: 4,
  EQUITY: 1,
  INVESTMENT: 0,
};

/**
 * The majors, by asset class.
 *
 * Deliberately short. A list of forty "major" crypto assets is a list of
 * everything, which defeats the purpose. These are the instruments where a
 * signal is most likely to be both reliable and executable.
 */
const TIER_ONE: Record<string, string[]> = {
  // Widened with the two consistently top-five names by traded volume and the
  // remaining textbook major pair, now that these are the platform's primary
  // markets. Still deliberately short — the file's own warning holds: a list of
  // forty majors is a list of everything.
  CRYPTO: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'],
  FOREX: ['EURUSD', 'USDJPY', 'GBPUSD', 'USDINR', 'AUDUSD'],
  // NIFTY heavyweights: the largest weights in the index, which is where
  // index-driven flow concentrates.
  EQUITY: [
    'RELIANCE',
    'HDFCBANK',
    'ICICIBANK',
    'INFY',
    'TCS',
    'BHARTIARTL',
    'SBIN',
    'ITC',
    'NIFTY50',
    'BANKNIFTY',
  ],
  INVESTMENT: ['GOLDBEES', 'NIFTYBEES'],
};

/** Second tier — liquid and worth scanning, below the headline names. */
const TIER_TWO: Record<string, string[]> = {
  CRYPTO: ['ADA', 'AVAX', 'DOGE'],
  FOREX: ['USDCHF', 'USDCAD', 'EURINR', 'GBPINR', 'JPYINR'],
  EQUITY: [
    'AXISBANK',
    'KOTAKBANK',
    'LT',
    'HINDUNILVR',
    'MARUTI',
    'TITAN',
    'ASIANPAINT',
    'BAJFINANCE',
    'HCLTECH',
    'WIPRO',
    'SENSEX',
  ],
  INVESTMENT: [],
};

export interface PrioritisedInstrument {
  symbol: string;
  assetClass: string;
  exchange?: string | null;
  tier: AssetTier;
  /** Higher sorts first. Combines tier with any measured liquidity. */
  weight: number;
  reason: string;
}

/**
 * Tier for one symbol.
 *
 * Market cap only promotes, never demotes: a large company absent from the
 * curated list is clearly tier two, but a listed major with no market-cap
 * record on file should not fall to tier three because of a data gap.
 */
export function tierFor(
  symbol: string,
  assetClass: string,
  marketCap?: number | null,
): { tier: AssetTier; reason: string } {
  const upper = symbol.toUpperCase();

  if (TIER_ONE[assetClass]?.includes(upper)) {
    return { tier: 1, reason: 'Among the most traded in its market' };
  }
  if (TIER_TWO[assetClass]?.includes(upper)) {
    return { tier: 2, reason: 'Liquid, below the headline names' };
  }

  // Large caps earn tier two on measured size rather than on being listed.
  // ₹1 lakh crore is roughly the large-cap boundary on Indian exchanges.
  if (assetClass === 'EQUITY' && marketCap && marketCap >= 1e12) {
    return { tier: 2, reason: 'Large cap by market capitalisation' };
  }

  return { tier: 3, reason: 'Outside the prioritised set' };
}

/**
 * Sort a universe so the most consequential instruments come first.
 *
 * Tier dominates; measured liquidity breaks ties within a tier. Nothing is
 * removed — a lower tier is scanned later, not never, because the point is to
 * spend the budget well rather than to narrow the universe permanently.
 */
export function prioritise<
  T extends { symbol: string; assetClass: string; exchange?: string | null },
>(instruments: T[], marketCaps?: Map<string, number>): Array<T & PrioritisedInstrument> {
  return instruments
    .map((instrument) => {
      const marketCap = marketCaps?.get(instrument.symbol);
      const { tier, reason } = tierFor(instrument.symbol, instrument.assetClass, marketCap);

      // Tier sets the band; asset-class focus orders within it; log market cap
      // nudges within that so the ordering is stable rather than alphabetical
      // among equals.
      const liquidityBonus = marketCap ? Math.min(0.9, Math.log10(marketCap) / 15) : 0;
      const focusBonus = CLASS_PRIORITY[instrument.assetClass] ?? 0;
      const weight = (4 - tier) * 10 + focusBonus + liquidityBonus;

      return { ...instrument, tier, weight, reason };
    })
    .sort((a, b) => b.weight - a.weight);
}

/**
 * How much of a scan budget each tier should receive.
 *
 * Tier one is scanned every pass — those instruments move, and a stale read on
 * BTC is worse than a stale read on a mid-cap. The remainder rotates, so the
 * rest of the universe is still covered, just less often.
 */
export function allocateBudget(
  prioritised: Array<{ tier: AssetTier }>,
  budget: number,
): { alwaysScan: number; rotating: number } {
  const tierOne = prioritised.filter((item) => item.tier === 1).length;
  // Never let the majors consume the whole budget — a scanner that only ever
  // looks at ten instruments stops being a scanner.
  const alwaysScan = Math.min(tierOne, Math.floor(budget * 0.6));
  return { alwaysScan, rotating: Math.max(0, budget - alwaysScan) };
}
