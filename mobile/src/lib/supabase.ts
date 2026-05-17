import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

// Same Supabase project as the desktop app (project ref jwqvrdgjpftjiwvgdrck).
// Values come from app.json `extra`; override per build if you self-host.
const extra = (Constants.expoConfig?.extra ?? {}) as {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

const SUPABASE_URL = extra.supabaseUrl ?? 'https://jwqvrdgjpftjiwvgdrck.supabase.co';
const SUPABASE_ANON_KEY =
  extra.supabaseAnonKey ?? 'sb_publishable_5eJWwJEHWHSLuhFEs2iUlw_tu4fGOvn';

// SecureStore rejects values larger than ~2KB on Android, and a Supabase
// session (access JWT + refresh token + user object) can exceed that. Store the
// value in fixed-size chunks under <key>.0, <key>.1, … with a small manifest at
// <key> recording the chunk count. Small values (the common case for everything
// else) round-trip in a single chunk.
const CHUNK = 1800;

async function setLarge(key: string, value: string): Promise<void> {
  await clearLarge(key); // drop any stale chunks first
  const parts = Math.ceil(value.length / CHUNK) || 1;
  for (let i = 0; i < parts; i++) {
    await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
  }
  await SecureStore.setItemAsync(key, JSON.stringify({ parts }));
}

async function getLarge(key: string): Promise<string | null> {
  const manifest = await SecureStore.getItemAsync(key);
  if (!manifest) return null;
  let parts = 1;
  try {
    const m = JSON.parse(manifest);
    if (typeof m?.parts === 'number') parts = m.parts;
    else return manifest; // legacy: value was stored directly under `key`
  } catch {
    return manifest; // legacy plain value
  }
  let out = '';
  for (let i = 0; i < parts; i++) {
    const part = await SecureStore.getItemAsync(`${key}.${i}`);
    if (part == null) {
      // Corrupt/partial — treat as missing so the auth layer falls back
      // to refresh-or-re-login. Log it so a flaky storage doesn't
      // silently sign users out without leaving a trace.
      console.warn('[secure-store] missing chunk', `${key}.${i}`, 'of', parts);
      return null;
    }
    out += part;
  }
  return out;
}

async function clearLarge(key: string): Promise<void> {
  const manifest = await SecureStore.getItemAsync(key);
  let parts = 0;
  if (manifest) {
    try {
      const m = JSON.parse(manifest);
      if (typeof m?.parts === 'number') parts = m.parts;
    } catch {
      /* legacy plain value: nothing extra to clear */
    }
  }
  for (let i = 0; i < parts; i++) await SecureStore.deleteItemAsync(`${key}.${i}`);
  await SecureStore.deleteItemAsync(key);
}

const SecureStoreAdapter = {
  getItem: (key: string) => getLarge(key),
  setItem: (key: string, value: string) => setLarge(key, value),
  removeItem: (key: string) => clearLarge(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: SecureStoreAdapter,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// Supabase recommends pausing/resuming token auto-refresh with app foreground
// state on React Native.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

export { SUPABASE_URL };
