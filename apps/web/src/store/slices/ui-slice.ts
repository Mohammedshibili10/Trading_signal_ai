import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { AssetClass } from '@/types';

export interface UiState {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  commandPaletteOpen: boolean;
  /** Which market tab the user last looked at — restored on return. */
  activeAssetClass: AssetClass;
  /** Hide P&L figures for screen-sharing. */
  privacyMode: boolean;
  /** Collapse the disclaimer banner after first acknowledgement. */
  disclaimerAcknowledged: boolean;
  density: 'comfortable' | 'compact';
}

const initialState: UiState = {
  sidebarCollapsed: false,
  mobileNavOpen: false,
  commandPaletteOpen: false,
  activeAssetClass: 'EQUITY',
  privacyMode: false,
  disclaimerAcknowledged: false,
  density: 'comfortable',
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
    setMobileNavOpen(state, action: PayloadAction<boolean>) {
      state.mobileNavOpen = action.payload;
    },
    setCommandPaletteOpen(state, action: PayloadAction<boolean>) {
      state.commandPaletteOpen = action.payload;
    },
    setActiveAssetClass(state, action: PayloadAction<AssetClass>) {
      state.activeAssetClass = action.payload;
    },
    togglePrivacyMode(state) {
      state.privacyMode = !state.privacyMode;
    },
    acknowledgeDisclaimer(state) {
      state.disclaimerAcknowledged = true;
    },
    setDensity(state, action: PayloadAction<UiState['density']>) {
      state.density = action.payload;
    },
  },
});

export const {
  toggleSidebar,
  setSidebarCollapsed,
  setMobileNavOpen,
  setCommandPaletteOpen,
  setActiveAssetClass,
  togglePrivacyMode,
  acknowledgeDisclaimer,
  setDensity,
} = uiSlice.actions;

export default uiSlice.reducer;
