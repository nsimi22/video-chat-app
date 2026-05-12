import 'react-native-url-polyfill/auto';
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

// SecureStore caps values at ~2KB; Supabase sessions fit comfortably.
const SecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: SecureStoreAdapter,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export { SUPABASE_URL };
