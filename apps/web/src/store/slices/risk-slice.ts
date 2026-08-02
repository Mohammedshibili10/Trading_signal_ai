import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { RISK_DEFAULTS } from '@/lib/constants';

/**
 * The user's risk parameters.
 *
 * Held in Redux rather than fetched per-page because every calculator, signal
 * card and position-size widget in the app reads from the same numbers, and
 * they must not drift between surfaces.
 */
export interface RiskState {
  capital: number;
  riskPerTradePercent: number;
  dailyLossLimitPercent: number;
  weeklyLossLimitPercent: number;
  maxDrawdownPercent: number;
  minRiskReward: number;
  /** Running tally, reset by the API on the session date rolling over. */
  realisedTodayPercent: number;
  realisedWeekPercent: number;
  currentDrawdownPercent: number;
}

const initialState: RiskState = {
  ...RISK_DEFAULTS,
  realisedTodayPercent: 0,
  realisedWeekPercent: 0,
  currentDrawdownPercent: 0,
};

const riskSlice = createSlice({
  name: 'risk',
  initialState,
  reducers: {
    setRiskSettings(state, action: PayloadAction<Partial<RiskState>>) {
      Object.assign(state, action.payload);
    },
    setCapital(state, action: PayloadAction<number>) {
      state.capital = Math.max(0, action.payload);
    },
    setRiskPerTrade(state, action: PayloadAction<number>) {
      // Hard ceiling at 5%. Anything above this is not risk management.
      state.riskPerTradePercent = Math.min(5, Math.max(0.1, action.payload));
    },
  },
});

export const { setRiskSettings, setCapital, setRiskPerTrade } = riskSlice.actions;

/** Derived: is the user allowed to take another trade right now? */
export function tradingHalted(state: RiskState): { halted: boolean; reason: string | null } {
  if (state.currentDrawdownPercent >= state.maxDrawdownPercent) {
    return {
      halted: true,
      reason: `Max drawdown limit of ${state.maxDrawdownPercent}% reached. Stop and review the system.`,
    };
  }
  if (Math.abs(state.realisedTodayPercent) >= state.dailyLossLimitPercent && state.realisedTodayPercent < 0) {
    return {
      halted: true,
      reason: `Daily loss limit of ${state.dailyLossLimitPercent}% hit. No more trades today.`,
    };
  }
  if (Math.abs(state.realisedWeekPercent) >= state.weeklyLossLimitPercent && state.realisedWeekPercent < 0) {
    return {
      halted: true,
      reason: `Weekly loss limit of ${state.weeklyLossLimitPercent}% hit. Halve size for the rest of the week.`,
    };
  }
  return { halted: false, reason: null };
}

export default riskSlice.reducer;
