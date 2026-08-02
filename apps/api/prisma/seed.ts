/**
 * Seed the instrument universe and a demo account.
 *
 *   npm run db:seed
 *
 * Idempotent — safe to re-run. Uses upserts keyed on symbol.
 *
 * The universe is deliberately the four supported categories only: NSE/BSE
 * equities and indices, forex pairs (INR crosses first), crypto, and Indian
 * investment products. Fundamentals are seeded for the equity names so the
 * scoring engine, the fundamentals scanner and the long-term rating are real
 * and testable end to end — swap in a licensed feed and nothing downstream
 * changes. See docs/data-sources.md §7.
 */

import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

type Row = {
  symbol: string;
  name: string;
  assetClass: 'EQUITY' | 'FOREX' | 'CRYPTO' | 'INVESTMENT';
  kind: 'STOCK' | 'INDEX' | 'FOREX' | 'CRYPTO' | 'MUTUAL_FUND' | 'ETF' | 'GOLD' | 'BOND';
  exchange: 'NSE' | 'BSE' | 'FX' | 'CRYPTO' | 'AMFI';
  currency: 'INR' | 'USD';
  sector?: string;
  lotSize?: number;
  providerSymbols?: Record<string, string>;
};

const INDICES: Row[] = [
  { symbol: 'NIFTY50', name: 'NIFTY 50', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'NSE', currency: 'INR', providerSymbols: { yahoo: '^NSEI' } },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'NSE', currency: 'INR', providerSymbols: { yahoo: '^NSEBANK' } },
  { symbol: 'SENSEX', name: 'BSE SENSEX', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'BSE', currency: 'INR', providerSymbols: { yahoo: '^BSESN' } },
  { symbol: 'NIFTYIT', name: 'NIFTY IT', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'NSE', currency: 'INR', providerSymbols: { yahoo: '^CNXIT' } },
  { symbol: 'NIFTYAUTO', name: 'NIFTY Auto', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'NSE', currency: 'INR', providerSymbols: { yahoo: '^CNXAUTO' } },
  { symbol: 'NIFTYPHARMA', name: 'NIFTY Pharma', assetClass: 'EQUITY', kind: 'INDEX', exchange: 'NSE', currency: 'INR', providerSymbols: { yahoo: '^CNXPHARMA' } },
];

const IT = 'Information Technology';
const BANK = 'Banking & Financial Services';

const EQUITIES: Row[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Oil & Gas', lotSize: 250 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: IT, lotSize: 175 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 550 },
  { symbol: 'INFY', name: 'Infosys', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: IT, lotSize: 400 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 700 },
  { symbol: 'SBIN', name: 'State Bank of India', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 750 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Telecom', lotSize: 475 },
  { symbol: 'ITC', name: 'ITC', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'FMCG', lotSize: 1600 },
  { symbol: 'LT', name: 'Larsen & Toubro', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Infrastructure', lotSize: 300 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 400 },
  { symbol: 'AXISBANK', name: 'Axis Bank', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 625 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'FMCG', lotSize: 300 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: BANK, lotSize: 125 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Automobile', lotSize: 50 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Chemicals', lotSize: 200 },
  { symbol: 'WIPRO', name: 'Wipro', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: IT, lotSize: 1500 },
  { symbol: 'HCLTECH', name: 'HCL Technologies', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: IT, lotSize: 350 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Pharmaceuticals', lotSize: 350 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Automobile', lotSize: 800 },
  { symbol: 'TATASTEEL', name: 'Tata Steel', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Metals & Mining', lotSize: 5500 },
  { symbol: 'TITAN', name: 'Titan Company', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Consumer Durables', lotSize: 175 },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Cement', lotSize: 50 },
  { symbol: 'NESTLEIND', name: 'Nestle India', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'FMCG', lotSize: 25 },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corporation', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Oil & Gas', lotSize: 3850 },
  { symbol: 'NTPC', name: 'NTPC', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Power & Utilities', lotSize: 1500 },
  { symbol: 'POWERGRID', name: 'Power Grid Corporation', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Power & Utilities', lotSize: 2700 },
  { symbol: 'ADANIENT', name: 'Adani Enterprises', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Infrastructure', lotSize: 300 },
  { symbol: 'JSWSTEEL', name: 'JSW Steel', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Metals & Mining', lotSize: 675 },
  { symbol: 'DRREDDY', name: "Dr. Reddy's Laboratories", assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Pharmaceuticals', lotSize: 625 },
  { symbol: 'CIPLA', name: 'Cipla', assetClass: 'EQUITY', kind: 'STOCK', exchange: 'NSE', currency: 'INR', sector: 'Pharmaceuticals', lotSize: 650 },
];

const FOREX: Row[] = [
  { symbol: 'USDINR', name: 'US Dollar / Indian Rupee', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'INR' },
  { symbol: 'EURINR', name: 'Euro / Indian Rupee', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'INR' },
  { symbol: 'GBPINR', name: 'British Pound / Indian Rupee', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'INR' },
  { symbol: 'JPYINR', name: 'Japanese Yen / Indian Rupee', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'INR' },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
  { symbol: 'AUDUSD', name: 'Australian Dollar / US Dollar', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
  { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
  { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc', assetClass: 'FOREX', kind: 'FOREX', exchange: 'FX', currency: 'USD' },
];

const CRYPTO: Row[] = [
  { symbol: 'BTC', name: 'Bitcoin', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'BTCUSDT', yahoo: 'BTC-USD' } },
  { symbol: 'ETH', name: 'Ethereum', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'ETHUSDT', yahoo: 'ETH-USD' } },
  { symbol: 'SOL', name: 'Solana', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'SOLUSDT', yahoo: 'SOL-USD' } },
  { symbol: 'BNB', name: 'BNB', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'BNBUSDT', yahoo: 'BNB-USD' } },
  { symbol: 'XRP', name: 'XRP', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'XRPUSDT', yahoo: 'XRP-USD' } },
  { symbol: 'ADA', name: 'Cardano', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'ADAUSDT', yahoo: 'ADA-USD' } },
  { symbol: 'DOGE', name: 'Dogecoin', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'DOGEUSDT', yahoo: 'DOGE-USD' } },
  { symbol: 'AVAX', name: 'Avalanche', assetClass: 'CRYPTO', kind: 'CRYPTO', exchange: 'CRYPTO', currency: 'USD', providerSymbols: { binance: 'AVAXUSDT', yahoo: 'AVAX-USD' } },
];

const INVESTMENTS: Row[] = [
  { symbol: 'NIFTYBEES', name: 'Nippon India ETF Nifty 50 BeES', assetClass: 'INVESTMENT', kind: 'ETF', exchange: 'NSE', currency: 'INR', sector: 'Index ETF' },
  { symbol: 'BANKBEES', name: 'Nippon India ETF Nifty Bank BeES', assetClass: 'INVESTMENT', kind: 'ETF', exchange: 'NSE', currency: 'INR', sector: 'Sector ETF' },
  { symbol: 'GOLDBEES', name: 'Nippon India ETF Gold BeES', assetClass: 'INVESTMENT', kind: 'GOLD', exchange: 'NSE', currency: 'INR', sector: 'Commodity ETF' },
  { symbol: 'JUNIORBEES', name: 'Nippon India ETF Nifty Next 50 Junior BeES', assetClass: 'INVESTMENT', kind: 'ETF', exchange: 'NSE', currency: 'INR', sector: 'Index ETF' },
  { symbol: 'LIQUIDBEES', name: 'Nippon India ETF Liquid BeES', assetClass: 'INVESTMENT', kind: 'BOND', exchange: 'NSE', currency: 'INR', sector: 'Debt ETF' },
  // Mutual funds carry their AMFI scheme code so the NAV provider can resolve them.
  { symbol: 'MF_PPFAS_FLEXI', name: 'Parag Parikh Flexi Cap Fund - Direct Growth', assetClass: 'INVESTMENT', kind: 'MUTUAL_FUND', exchange: 'AMFI', currency: 'INR', sector: 'Flexi Cap', providerSymbols: { amfi: '122639' } },
  { symbol: 'MF_UTI_NIFTY', name: 'UTI Nifty 50 Index Fund - Direct Growth', assetClass: 'INVESTMENT', kind: 'MUTUAL_FUND', exchange: 'AMFI', currency: 'INR', sector: 'Index Fund', providerSymbols: { amfi: '120716' } },
  { symbol: 'MF_HDFC_MIDCAP', name: 'HDFC Mid-Cap Opportunities Fund - Direct Growth', assetClass: 'INVESTMENT', kind: 'MUTUAL_FUND', exchange: 'AMFI', currency: 'INR', sector: 'Mid Cap', providerSymbols: { amfi: '118989' } },
];

/**
 * Fundamentals for the equity universe.
 *
 * Representative figures, not a licensed feed — enough to exercise the scoring
 * engine, sector benchmarking and the promoter-pledge risk path end to end.
 * Marked `source: 'seed'` so it is never mistaken for filed data.
 */
const FUNDAMENTALS: Record<string, Record<string, number>> = {
  RELIANCE:   { pe: 24.5, pb: 2.1, roe: 8.9,  roce: 10.2, netMargin: 7.8,  operatingMargin: 15.2, revenueGrowth: 11.2, profitGrowth: 9.4,  epsGrowth: 8.8,  debtToEquity: 0.44, interestCoverage: 6.2,  currentRatio: 1.1, promoterHolding: 50.3, promoterPledge: 0,   fiiHolding: 22.1, diiHolding: 15.4 },
  TCS:        { pe: 28.1, pb: 13.4, roe: 46.2, roce: 58.1, netMargin: 19.2, operatingMargin: 24.8, revenueGrowth: 6.8,  profitGrowth: 9.1,  epsGrowth: 10.2, debtToEquity: 0.02, interestCoverage: 120,  currentRatio: 2.5, promoterHolding: 71.8, promoterPledge: 0,   fiiHolding: 12.4, diiHolding: 11.2 },
  HDFCBANK:   { pe: 18.4, pb: 2.7, roe: 16.8, roce: 12.1, netMargin: 22.4, operatingMargin: 28.1, revenueGrowth: 14.2, profitGrowth: 12.8, epsGrowth: 11.4, debtToEquity: 6.8,  interestCoverage: 2.1,  currentRatio: 1.0, promoterHolding: 0,    promoterPledge: 0,   fiiHolding: 47.2, diiHolding: 32.1 },
  INFY:       { pe: 26.2, pb: 8.9, roe: 31.4, roce: 39.8, netMargin: 17.1, operatingMargin: 21.2, revenueGrowth: 4.8,  profitGrowth: 7.2,  epsGrowth: 8.1,  debtToEquity: 0.09, interestCoverage: 85,   currentRatio: 2.2, promoterHolding: 14.7, promoterPledge: 0,   fiiHolding: 33.2, diiHolding: 36.4 },
  ICICIBANK:  { pe: 17.2, pb: 2.9, roe: 18.2, roce: 13.4, netMargin: 24.1, operatingMargin: 30.2, revenueGrowth: 16.4, profitGrowth: 18.2, epsGrowth: 17.1, debtToEquity: 6.2,  interestCoverage: 2.4,  currentRatio: 1.0, promoterHolding: 0,    promoterPledge: 0,   fiiHolding: 44.8, diiHolding: 41.2 },
  SBIN:       { pe: 11.8, pb: 1.7, roe: 17.4, roce: 9.8,  netMargin: 18.2, operatingMargin: 24.1, revenueGrowth: 12.1, profitGrowth: 21.4, epsGrowth: 20.8, debtToEquity: 12.4, interestCoverage: 1.8,  currentRatio: 1.0, promoterHolding: 57.5, promoterPledge: 0,   fiiHolding: 11.2, diiHolding: 24.8 },
  BHARTIARTL: { pe: 62.4, pb: 9.2, roe: 12.1, roce: 11.4, netMargin: 8.4,  operatingMargin: 32.1, revenueGrowth: 13.8, profitGrowth: 42.1, epsGrowth: 38.4, debtToEquity: 1.82, interestCoverage: 2.9,  currentRatio: 0.6, promoterHolding: 53.2, promoterPledge: 0,   fiiHolding: 22.4, diiHolding: 18.1 },
  ITC:        { pe: 27.1, pb: 7.4, roe: 28.4, roce: 36.2, netMargin: 25.1, operatingMargin: 34.2, revenueGrowth: 3.2,  profitGrowth: 5.1,  epsGrowth: 4.8,  debtToEquity: 0.01, interestCoverage: 210,  currentRatio: 2.8, promoterHolding: 0,    promoterPledge: 0,   fiiHolding: 43.1, diiHolding: 42.8 },
  LT:         { pe: 34.2, pb: 5.1, roe: 15.2, roce: 14.8, netMargin: 6.8,  operatingMargin: 11.2, revenueGrowth: 18.4, profitGrowth: 22.1, epsGrowth: 21.4, debtToEquity: 1.12, interestCoverage: 4.8,  currentRatio: 1.3, promoterHolding: 0,    promoterPledge: 0,   fiiHolding: 24.1, diiHolding: 38.2 },
  KOTAKBANK:  { pe: 19.1, pb: 2.8, roe: 14.8, roce: 11.2, netMargin: 23.1, operatingMargin: 29.4, revenueGrowth: 13.1, profitGrowth: 15.2, epsGrowth: 14.8, debtToEquity: 5.4,  interestCoverage: 2.6,  currentRatio: 1.0, promoterHolding: 25.9, promoterPledge: 0,   fiiHolding: 38.2, diiHolding: 24.1 },
  AXISBANK:   { pe: 13.4, pb: 2.1, roe: 16.1, roce: 10.8, netMargin: 21.2, operatingMargin: 27.1, revenueGrowth: 15.2, profitGrowth: 17.8, epsGrowth: 16.9, debtToEquity: 7.1,  interestCoverage: 2.2,  currentRatio: 1.0, promoterHolding: 8.2,  promoterPledge: 0,   fiiHolding: 47.1, diiHolding: 34.2 },
  HINDUNILVR: { pe: 52.1, pb: 10.8, roe: 20.4, roce: 26.1, netMargin: 17.2, operatingMargin: 23.8, revenueGrowth: 2.1,  profitGrowth: 1.8,  epsGrowth: 2.2,  debtToEquity: 0.03, interestCoverage: 145,  currentRatio: 1.3, promoterHolding: 61.9, promoterPledge: 0,   fiiHolding: 12.8, diiHolding: 15.2 },
  BAJFINANCE: { pe: 28.4, pb: 5.4, roe: 20.1, roce: 12.4, netMargin: 26.8, operatingMargin: 34.1, revenueGrowth: 26.4, profitGrowth: 24.1, epsGrowth: 22.8, debtToEquity: 3.8,  interestCoverage: 2.1,  currentRatio: 1.4, promoterHolding: 54.7, promoterPledge: 0,   fiiHolding: 20.4, diiHolding: 12.1 },
  MARUTI:     { pe: 26.8, pb: 4.2, roe: 16.4, roce: 20.1, netMargin: 9.1,  operatingMargin: 11.8, revenueGrowth: 14.2, profitGrowth: 32.1, epsGrowth: 30.4, debtToEquity: 0.01, interestCoverage: 95,   currentRatio: 1.1, promoterHolding: 58.2, promoterPledge: 0,   fiiHolding: 22.1, diiHolding: 16.4 },
  ASIANPAINT: { pe: 48.2, pb: 12.1, roe: 27.4, roce: 34.2, netMargin: 13.2, operatingMargin: 19.4, revenueGrowth: 1.8,  profitGrowth: -4.2, epsGrowth: -3.8, debtToEquity: 0.06, interestCoverage: 68,   currentRatio: 1.9, promoterHolding: 52.6, promoterPledge: 0,   fiiHolding: 15.2, diiHolding: 12.8 },
  WIPRO:      { pe: 22.4, pb: 3.4, roe: 15.1, roce: 18.2, netMargin: 13.4, operatingMargin: 17.1, revenueGrowth: -1.2, profitGrowth: 2.4,  epsGrowth: 3.1,  debtToEquity: 0.21, interestCoverage: 28,   currentRatio: 2.4, promoterHolding: 72.7, promoterPledge: 0,   fiiHolding: 7.8,  diiHolding: 8.4 },
  HCLTECH:    { pe: 25.1, pb: 6.2, roe: 24.8, roce: 30.1, netMargin: 15.2, operatingMargin: 19.8, revenueGrowth: 5.4,  profitGrowth: 8.1,  epsGrowth: 7.8,  debtToEquity: 0.08, interestCoverage: 72,   currentRatio: 2.1, promoterHolding: 60.8, promoterPledge: 0,   fiiHolding: 20.1, diiHolding: 12.4 },
  SUNPHARMA:  { pe: 34.1, pb: 5.8, roe: 17.2, roce: 20.4, netMargin: 18.4, operatingMargin: 25.1, revenueGrowth: 9.8,  profitGrowth: 14.2, epsGrowth: 13.8, debtToEquity: 0.05, interestCoverage: 48,   currentRatio: 2.6, promoterHolding: 54.5, promoterPledge: 0,   fiiHolding: 16.2, diiHolding: 18.4 },
  TATAMOTORS: { pe: 9.8,  pb: 2.9, roe: 32.1, roce: 18.4, netMargin: 6.2,  operatingMargin: 12.1, revenueGrowth: 12.4, profitGrowth: 48.2, epsGrowth: 45.1, debtToEquity: 1.24, interestCoverage: 4.2,  currentRatio: 0.9, promoterHolding: 42.6, promoterPledge: 0,   fiiHolding: 18.4, diiHolding: 22.1 },
  TATASTEEL:  { pe: 42.1, pb: 2.2, roe: 5.1,  roce: 8.4,  netMargin: 2.8,  operatingMargin: 11.2, revenueGrowth: -2.4, profitGrowth: -32.1, epsGrowth: -30.2, debtToEquity: 1.08, interestCoverage: 2.4, currentRatio: 0.8, promoterHolding: 33.2, promoterPledge: 0,   fiiHolding: 14.2, diiHolding: 24.8 },
  TITAN:      { pe: 88.2, pb: 24.1, roe: 29.4, roce: 26.8, netMargin: 7.2,  operatingMargin: 10.4, revenueGrowth: 21.4, profitGrowth: 8.2,  epsGrowth: 7.8,  debtToEquity: 0.62, interestCoverage: 8.1,  currentRatio: 1.5, promoterHolding: 52.9, promoterPledge: 0,   fiiHolding: 18.2, diiHolding: 14.1 },
  ULTRACEMCO: { pe: 46.2, pb: 4.8, roe: 11.2, roce: 13.4, netMargin: 9.8,  operatingMargin: 16.2, revenueGrowth: 10.2, profitGrowth: 22.4, epsGrowth: 21.8, debtToEquity: 0.18, interestCoverage: 12.4, currentRatio: 1.2, promoterHolding: 59.9, promoterPledge: 0,   fiiHolding: 16.4, diiHolding: 14.2 },
  NESTLEIND:  { pe: 72.4, pb: 68.2, roe: 102.4, roce: 128.1, netMargin: 15.8, operatingMargin: 22.4, revenueGrowth: 8.2, profitGrowth: 10.1, epsGrowth: 9.8, debtToEquity: 0.02, interestCoverage: 180, currentRatio: 1.1, promoterHolding: 62.8, promoterPledge: 0,   fiiHolding: 12.1, diiHolding: 10.4 },
  ONGC:       { pe: 7.8,  pb: 0.9, roe: 12.4, roce: 14.2, netMargin: 8.9,  operatingMargin: 18.4, revenueGrowth: 4.2,  profitGrowth: 12.1, epsGrowth: 11.8, debtToEquity: 0.42, interestCoverage: 9.2,  currentRatio: 0.9, promoterHolding: 58.9, promoterPledge: 0,   fiiHolding: 8.2,  diiHolding: 22.4 },
  NTPC:       { pe: 15.2, pb: 2.1, roe: 13.8, roce: 9.4,  netMargin: 12.4, operatingMargin: 24.1, revenueGrowth: 6.8,  profitGrowth: 14.2, epsGrowth: 13.8, debtToEquity: 1.48, interestCoverage: 3.8,  currentRatio: 0.9, promoterHolding: 51.1, promoterPledge: 0,   fiiHolding: 15.2, diiHolding: 26.4 },
  POWERGRID:  { pe: 18.4, pb: 3.1, roe: 17.2, roce: 11.8, netMargin: 32.1, operatingMargin: 52.4, revenueGrowth: 4.1,  profitGrowth: 8.2,  epsGrowth: 7.9,  debtToEquity: 1.52, interestCoverage: 3.2,  currentRatio: 0.7, promoterHolding: 51.3, promoterPledge: 0,   fiiHolding: 16.8, diiHolding: 24.2 },
  // Deliberately includes a pledged name so the promoter-pledge risk path and
  // the rating cap are exercised by the seed data.
  ADANIENT:   { pe: 68.4, pb: 7.2, roe: 11.2, roce: 12.8, netMargin: 3.2,  operatingMargin: 9.4,  revenueGrowth: 24.1, profitGrowth: 38.2, epsGrowth: 36.4, debtToEquity: 1.42, interestCoverage: 2.8,  currentRatio: 1.1, promoterHolding: 72.6, promoterPledge: 28.4, fiiHolding: 14.2, diiHolding: 6.8 },
  JSWSTEEL:   { pe: 38.2, pb: 2.8, roe: 7.4,  roce: 9.8,  netMargin: 3.8,  operatingMargin: 13.2, revenueGrowth: 2.1,  profitGrowth: -24.1, epsGrowth: -22.8, debtToEquity: 1.18, interestCoverage: 2.9, currentRatio: 0.8, promoterHolding: 44.8, promoterPledge: 8.2, fiiHolding: 18.4, diiHolding: 22.1 },
  DRREDDY:    { pe: 19.4, pb: 3.4, roe: 19.2, roce: 24.1, netMargin: 18.1, operatingMargin: 24.8, revenueGrowth: 12.4, profitGrowth: 18.2, epsGrowth: 17.8, debtToEquity: 0.08, interestCoverage: 62,   currentRatio: 2.4, promoterHolding: 26.7, promoterPledge: 0,   fiiHolding: 28.4, diiHolding: 22.1 },
  CIPLA:      { pe: 27.8, pb: 4.2, roe: 16.4, roce: 20.8, netMargin: 16.2, operatingMargin: 22.1, revenueGrowth: 10.1, profitGrowth: 22.4, epsGrowth: 21.8, debtToEquity: 0.04, interestCoverage: 88,   currentRatio: 3.1, promoterHolding: 33.4, promoterPledge: 0,   fiiHolding: 24.2, diiHolding: 26.8 },
};

/** Recurring, publicly-scheduled macro events. See docs/data-sources.md §6. */
function economicEvents() {
  const now = new Date();
  const events: Array<{
    title: string; country: string; category: string; importance: string; scheduledAt: Date; notes: string;
  }> = [];

  for (let offset = 0; offset < 3; offset++) {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);

    events.push({
      title: 'CPI Inflation (YoY)',
      country: 'IN', category: 'Inflation', importance: 'HIGH',
      scheduledAt: new Date(month.getFullYear(), month.getMonth(), 12, 17, 30),
      notes: 'Released by MoSPI at 17:30 IST. Drives RBI policy expectations and the rupee.',
    });
    events.push({
      title: 'WPI Inflation',
      country: 'IN', category: 'Inflation', importance: 'MEDIUM',
      scheduledAt: new Date(month.getFullYear(), month.getMonth(), 14, 12, 0),
      notes: 'Wholesale price index. Leading indicator for input costs and margins.',
    });
    events.push({
      title: 'Index of Industrial Production',
      country: 'IN', category: 'Growth', importance: 'MEDIUM',
      scheduledAt: new Date(month.getFullYear(), month.getMonth(), 12, 17, 30),
      notes: 'Monthly industrial output. Moves capital goods and infrastructure names.',
    });
    events.push({
      title: 'US CPI',
      country: 'US', category: 'Inflation', importance: 'HIGH',
      scheduledAt: new Date(month.getFullYear(), month.getMonth(), 13, 19, 0),
      notes: 'Sets the tone for USDINR, FII flows and crypto risk appetite.',
    });
  }

  return events;
}

async function main(): Promise<void> {
  console.log('Seeding…\n');

  // ── Instruments ────────────────────────────────────────────────
  const all = [...INDICES, ...EQUITIES, ...FOREX, ...CRYPTO, ...INVESTMENTS];

  for (const row of all) {
    await prisma.instrument.upsert({
      where: { symbol: row.symbol },
      create: {
        symbol: row.symbol,
        name: row.name,
        assetClass: row.assetClass,
        kind: row.kind,
        exchange: row.exchange,
        currency: row.currency,
        sector: row.sector,
        lotSize: row.lotSize,
        providerSymbols: row.providerSymbols ?? undefined,
      },
      update: {
        name: row.name,
        sector: row.sector,
        lotSize: row.lotSize,
        providerSymbols: row.providerSymbols ?? undefined,
        isActive: true,
      },
    });
  }
  console.log(`  ${all.length} instruments`);
  console.log(
    `    ${INDICES.length} indices · ${EQUITIES.length} equities · ` +
      `${FOREX.length} forex · ${CRYPTO.length} crypto · ${INVESTMENTS.length} investment`,
  );

  // ── Fundamentals ───────────────────────────────────────────────
  let fundamentalsCount = 0;
  for (const [symbol, data] of Object.entries(FUNDAMENTALS)) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) continue;

    await prisma.fundamentals.upsert({
      where: { instrumentId: instrument.id },
      create: { instrumentId: instrument.id, symbol, ...data, source: 'seed' },
      update: { ...data, source: 'seed' },
    });
    fundamentalsCount += 1;
  }
  console.log(`  ${fundamentalsCount} fundamentals records`);

  // ── Economic calendar ──────────────────────────────────────────
  const events = economicEvents();
  for (const event of events) {
    const existing = await prisma.economicEvent.findFirst({
      where: { title: event.title, scheduledAt: event.scheduledAt },
    });
    if (!existing) await prisma.economicEvent.create({ data: event });
  }
  console.log(`  ${events.length} economic events`);

  // ── Demo account ───────────────────────────────────────────────
  const demoEmail = 'demo@alphaline.app';
  const existingDemo = await prisma.user.findUnique({ where: { email: demoEmail } });

  if (!existingDemo) {
    const passwordHash = await argon2.hash('DemoPassword1', {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const user = await prisma.user.create({
      data: {
        email: demoEmail,
        name: 'Demo Trader',
        passwordHash,
        role: 'ADMIN',
        emailVerified: true,
        preferences: { create: { capital: 500000, riskPerTradePercent: 1 } },
        subscription: { create: { tier: 'PRO' } },
        watchlists: {
          create: [
            { name: 'My Watchlist', isDefault: true, sortOrder: 0 },
            { name: 'Crypto', sortOrder: 1 },
          ],
        },
      },
      include: { watchlists: true },
    });

    const defaultList = user.watchlists.find((w) => w.isDefault)!;
    const cryptoList = user.watchlists.find((w) => !w.isDefault)!;

    const seedWatchlist = async (watchlistId: string, symbols: string[]) => {
      for (const [index, symbol] of symbols.entries()) {
        const instrument = await prisma.instrument.findUnique({ where: { symbol } });
        if (!instrument) continue;
        await prisma.watchlistItem.create({
          data: { watchlistId, instrumentId: instrument.id, symbol, sortOrder: index },
        });
      }
    };

    await seedWatchlist(defaultList.id, ['NIFTY50', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'USDINR']);
    await seedWatchlist(cryptoList.id, ['BTC', 'ETH', 'SOL']);

    // A small portfolio so the P&L, allocation and risk screens have content.
    const holdings: Array<[string, number, number]> = [
      ['RELIANCE', 50, 2650],
      ['TCS', 25, 3820],
      ['HDFCBANK', 100, 1580],
      ['INFY', 60, 1450],
      ['NIFTYBEES', 200, 245],
    ];

    for (const [symbol, quantity, price] of holdings) {
      const instrument = await prisma.instrument.findUnique({ where: { symbol } });
      if (!instrument) continue;

      await prisma.holding.create({
        data: { userId: user.id, instrumentId: instrument.id, symbol, quantity, averagePrice: price },
      });
      await prisma.transaction.create({
        data: {
          userId: user.id, instrumentId: instrument.id, symbol,
          type: 'BUY', quantity, price, charges: Math.round(quantity * price * 0.0025),
        },
      });
    }

    console.log(`  demo account: ${demoEmail} / DemoPassword1  (role: ADMIN)`);
  } else {
    console.log(`  demo account already exists (${demoEmail})`);
  }

  console.log('\nDone.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
