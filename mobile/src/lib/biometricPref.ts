import * as SecureStore from 'expo-secure-store';

const KEY = 'huddle.biometricEnabled';

export async function isEnabled(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(KEY).catch(() => null);
  return v === '1';
}

export async function setEnabled(enabled: boolean): Promise<void> {
  if (enabled) await SecureStore.setItemAsync(KEY, '1');
  else await SecureStore.deleteItemAsync(KEY);
}
