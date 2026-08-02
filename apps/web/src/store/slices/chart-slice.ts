import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { Timeframe } from '@/types';

/**
 * Chart preferences.
 *
 * Indicators are opt-in and off by default — the brief calls for enabling them
 * only when needed, and an empty chart is the readable one.
 */
export type OverlayKey =
  | 'ema20'
  | 'ema50'
  | 'ema200'
  | 'sma50'
  | 'bollinger'
  | 'supertrend'
  | 'vwap'
  | 'ichimoku'
  | 'psar';

export type PaneKey = 'volume' | 'rsi' | 'macd' | 'stochastic' | 'atr' | 'adx' | 'mfi';

export type DrawingTool = 'none' | 'trendline' | 'horizontal' | 'ray' | 'rectangle' | 'fib';

export interface Drawing {
  id: string;
  tool: Exclude<DrawingTool, 'none'>;
  symbol: string;
  points: Array<{ time: number; price: number }>;
  color: string;
}

export interface ChartState {
  chartType: 'candlestick' | 'line' | 'area' | 'bar';
  timeframe: Timeframe;
  overlays: OverlayKey[];
  panes: PaneKey[];
  activeTool: DrawingTool;
  drawings: Drawing[];
  /** Chart annotations from the analysis engine. */
  showLevels: boolean;
  showPatterns: boolean;
  showSmc: boolean;
  showSignals: boolean;
  logScale: boolean;
}

const initialState: ChartState = {
  chartType: 'candlestick',
  timeframe: '1D',
  overlays: [],
  panes: ['volume'],
  activeTool: 'none',
  drawings: [],
  showLevels: true,
  showPatterns: false,
  showSmc: false,
  showSignals: true,
  logScale: false,
};

const chartSlice = createSlice({
  name: 'chart',
  initialState,
  reducers: {
    setChartType(state, action: PayloadAction<ChartState['chartType']>) {
      state.chartType = action.payload;
    },
    setTimeframe(state, action: PayloadAction<Timeframe>) {
      state.timeframe = action.payload;
    },
    toggleOverlay(state, action: PayloadAction<OverlayKey>) {
      const i = state.overlays.indexOf(action.payload);
      if (i >= 0) state.overlays.splice(i, 1);
      else state.overlays.push(action.payload);
    },
    togglePane(state, action: PayloadAction<PaneKey>) {
      const i = state.panes.indexOf(action.payload);
      if (i >= 0) state.panes.splice(i, 1);
      else state.panes.push(action.payload);
    },
    clearIndicators(state) {
      state.overlays = [];
      state.panes = ['volume'];
    },
    setActiveTool(state, action: PayloadAction<DrawingTool>) {
      state.activeTool = action.payload;
    },
    addDrawing(state, action: PayloadAction<Drawing>) {
      state.drawings.push(action.payload);
      state.activeTool = 'none';
    },
    removeDrawing(state, action: PayloadAction<string>) {
      state.drawings = state.drawings.filter((d) => d.id !== action.payload);
    },
    clearDrawings(state, action: PayloadAction<string | undefined>) {
      state.drawings = action.payload
        ? state.drawings.filter((d) => d.symbol !== action.payload)
        : [];
    },
    toggleAnnotation(
      state,
      action: PayloadAction<'showLevels' | 'showPatterns' | 'showSmc' | 'showSignals' | 'logScale'>,
    ) {
      state[action.payload] = !state[action.payload];
    },
  },
});

export const {
  setChartType,
  setTimeframe,
  toggleOverlay,
  togglePane,
  clearIndicators,
  setActiveTool,
  addDrawing,
  removeDrawing,
  clearDrawings,
  toggleAnnotation,
} = chartSlice.actions;

export default chartSlice.reducer;
