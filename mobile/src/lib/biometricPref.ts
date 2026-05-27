import * as SecureStore from 'expo-secure-store';

// Scoped per userId so that signing out user A and signing in user B on the
// same device doesn't carry over A's lock preference. Biometric lock is a
// device-trust gate (OS biometrics are device-level), but the *intent* to
// enable it is a per-user preference — applying A's intent to B is surprising.
const PREFIX = 'huddle.biometricEnabled';
const keyFor = (userId: string) => `${PREFIX}.${userId}`;

export async function isEnabled(userId: string): Promise<boolean> {
  const v = await SecureStore.getItemAsync(keyFor(userId)).catch(() => null);
  return v === '1';
}

export async function setEnabled(userId: string, enabled: boolean): Promise<void> {
  const key = keyFor(userId);
  if (enabled) await SecureStore.setItemAsync(key, '1');
  else await SecureStore.deleteItemAsync(key);
}
