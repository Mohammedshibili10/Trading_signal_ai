import { combineReducers, configureStore } from '@reduxjs/toolkit';

import authReducer from './slices/auth-slice';
import chartReducer from './slices/chart-slice';
import riskReducer from './slices/risk-slice';
import uiReducer from './slices/ui-slice';
import { loadPersistedState, persistenceMiddleware } from './persistence';

const rootReducer = combineReducers({
  auth: authReducer,
  ui: uiReducer,
  chart: chartReducer,
  risk: riskReducer,
});

/**
 * Redux holds *client* state: session, UI preferences, chart configuration and
 * risk parameters. Server state (quotes, candles, analysis, portfolio) stays in
 * TanStack Query, which already solves caching, refetching and invalidation.
 * Mirroring server data into Redux would mean maintaining that machinery twice.
 *
 * A store is created per request rather than as a module singleton — a shared
 * store on the server would leak one user's state into another's render.
 */
export function makeStore() {
  return configureStore({
    reducer: rootReducer,
    preloadedState: loadPersistedState(),
    middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(persistenceMiddleware),
    devTools: process.env.NODE_ENV !== 'production',
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = AppStore['dispatch'];
