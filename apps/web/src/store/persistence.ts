import type { Middleware } from '@reduxjs/toolkit';

import type { RootState } from './index';

const STORAGE_KEY = 'tip.state.v1';

/**
 * Slices that survive a reload.
 *
 * Deliberately excludes `auth` — the access token is short-lived and held in
 * memory only, and the refresh token lives in an httpOnly cookie. Persisting
 * either to localStorage would hand them to any XSS.
 */
const PERSISTED = ['ui', 'chart', 'risk'] as const;
type PersistedKey = (typeof PERSISTED)[number];

type PersistedShape = Partial<Pick<RootState, PersistedKey>>;

/**
 * Read persisted slices on boot.
 *
 * Returns undefined on the server so the server-rendered markup always matches
 * the initial client render — reading localStorage during SSR is what produces
 * hydration mismatches.
 */
export function loadPersistedState(): PersistedShape | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PersistedShape;

    // Transient UI flags must never come back from storage — restoring an open
    // mobile drawer or command palette on load is disorienting.
    if (parsed.ui) {
      parsed.ui = { ...parsed.ui, mobileNavOpen: false, commandPaletteOpen: false };
    }
    return parsed;
  } catch {
    // Corrupt or unreadable storage should never block boot.
    return undefined;
  }
}

/** Writes the persisted slices back on every mutation, coalesced to one frame. */
export const persistenceMiddleware: Middleware = (store) => {
  let queued = false;

  return (next) => (action) => {
    const result = next(action);
    if (typeof window === 'undefined' || queued) return result;

    queued = true;
    queueMicrotask(() => {
      queued = false;
      try {
        const state = store.getState() as RootState;
        const slice: PersistedShape = {};
        for (const key of PERSISTED) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (slice as any)[key] = state[key];
        }
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
      } catch {
        // Quota exceeded or private mode — persistence is best-effort.
      }
    });

    return result;
  };
};

export function clearPersistedState() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
