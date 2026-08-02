import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { User } from '@/types';

export interface AuthState {
  user: User | null;
  /** In-memory only. Refresh tokens live in an httpOnly cookie and are never
   *  readable from JS — that's the point of them. */
  accessToken: string | null;
  status: 'idle' | 'loading' | 'authenticated' | 'unauthenticated';
}

const initialState: AuthState = {
  user: null,
  accessToken: null,
  status: 'idle',
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    authLoading(state) {
      state.status = 'loading';
    },
    setCredentials(state, action: PayloadAction<{ user: User; accessToken: string }>) {
      state.user = action.payload.user;
      state.accessToken = action.payload.accessToken;
      state.status = 'authenticated';
    },
    setAccessToken(state, action: PayloadAction<string>) {
      state.accessToken = action.payload;
    },
    updateUser(state, action: PayloadAction<Partial<User>>) {
      if (state.user) state.user = { ...state.user, ...action.payload };
    },
    updatePreferences(state, action: PayloadAction<Partial<User['preferences']>>) {
      if (state.user) {
        state.user.preferences = { ...state.user.preferences, ...action.payload };
      }
    },
    signedOut(state) {
      state.user = null;
      state.accessToken = null;
      state.status = 'unauthenticated';
    },
  },
});

export const {
  authLoading,
  setCredentials,
  setAccessToken,
  updateUser,
  updatePreferences,
  signedOut,
} = authSlice.actions;

export default authSlice.reducer;
