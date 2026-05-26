import * as SecureStore from 'expo-secure-store';

// Per-device channel mute preference. Stored as a JSON array of
// channel ids so a single SecureStore round-trip carries the whole
// set — typical usage is ≤20 muted channels which is well under
// SecureStore's ~2KB Android value cap (a UUID is ~36 chars, 50
// channels ≈ 1.8KB).
//
// Persistence is local-only by design: cross-device sync would need a
// new (user, channel) row in the database plus an RPC, and that's
// scope-creep against the QoL goal here. If a user mutes #foo on
// their phone, opening desktop will still show its full unread.

const KEY = 'huddle.mutedChannels';

export async function loadMutedChannels(): Promise<Set<string>> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
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
    await SecureStore.setItemAsync(KEY, JSON.stringify([...ids]));
  } catch (e) {
    console.warn('[muted] save failed', e);
  }
}
