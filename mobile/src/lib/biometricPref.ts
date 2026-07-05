import type * as SecureStore from 'expo-secure-store';
import { requireOptionalNativeModule } from 'expo-modules-core';

// Scoped per userId so that signing out user A and signing in user B on the
// same device doesn't carry over A's lock preference. Biometric lock is a
// device-trust gate (OS biometrics are device-level), but the *intent* to
// enable it is a per-user preference — applying A's intent to B is surprising.
const PREFIX = 'huddle.biometricEnabled';
const keyFor = (userId: string) => `${PREFIX}.${userId}`;

// `expo-secure-store`'s entry eagerly resolves its native binding
// (`requireNativeModule('ExpoSecureStore')`) at import time, which is a fatal
// native crash on a binary that predates the dependency (e.g. an OTA served to
// an old build). Probe with `requireOptionalNativeModule` — which returns null
// instead of crashing — and load lazily, so a missing module degrades to "no
// stored preference" rather than taking the app down. Mirrors lib/biometric.ts.
let store: typeof SecureStore | null | undefined;
function load(): typeof SecureStore | null {
  if (store !== undefined) return store;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = requireOptionalNativeModule('ExpoSecureStore')
      ? (require('expo-secure-store') as typeof SecureStore)
      : null;
  } catch {
    store = null;
  }
  return store;
}

export async function isEnabled(userId: string): Promise<boolean> {
  const s = load();
  if (!s) return false;
  const v = await s.getItemAsync(keyFor(userId)).catch(() => null);
  return v === '1';
}

export async function setEnabled(userId: string, enabled: boolean): Promise<void> {
  const s = load();
  if (!s) return;
  const key = keyFor(userId);
  if (enabled) await s.setItemAsync(key, '1');
  else await s.deleteItemAsync(key);
}
