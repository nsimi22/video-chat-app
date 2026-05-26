import * as SecureStore from 'expo-secure-store';

// Per-device channel mute preference, persisted via expo-secure-store
// (the kv this app already uses for the Supabase session). The mute set
// is non-sensitive data — expo-secure-store is overkill on that
// dimension — but adding @react-native-async-storage/async-storage just
// for this one preference would mean a new native dep + a dev-client
// rebuild, which isn't worth the trade for "a list of channel ids the
// user wants to silence."
//
// Values are stored chunked under <KEY>.<i> with a small manifest at
// <KEY> recording the chunk count — mirrors the pattern
// mobile/src/lib/supabase.ts uses for the Supabase session. SecureStore
// rejects values >~2KB on Android, which would mean any user who mutes
// 53+ channels stops persisting new mutes; chunking sidesteps the cap
// entirely.
//
// Persistence is local-only by design: cross-device sync would need a
// new (user, channel) row in the database plus an RPC, and that's
// scope-creep against the QoL goal here.

const KEY = 'huddle.mutedChannels';
// Same chunk size supabase.ts uses, so we stay below the Android cap on
// every platform's SecureStore implementation.
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
      // Corrupt/partial — treat as missing so a torn write doesn't
      // half-restore the mute list.
      console.warn('[muted] missing chunk', `${key}.${i}`, 'of', parts);
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

export async function loadMutedChannels(): Promise<Set<string>> {
  try {
    const raw = await getLarge(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch (e) {
    console.warn('[muted] load failed', e);
    return new Set();
  }
}

export async function saveMutedChannels(ids: Set<string>): Promise<void> {
  try {
    await setLarge(KEY, JSON.stringify([...ids]));
  } catch (e) {
    console.warn('[muted] save failed', e);
  }
}
