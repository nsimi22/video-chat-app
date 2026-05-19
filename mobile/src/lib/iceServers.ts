import { supabase } from './supabase';

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// Public STUN fallback. Enough for symmetric NAT-free networks (most home
// Wi-Fi); cellular and corporate NATs will need real TURN — wire it up in the
// `ice-servers` Edge Function via env vars (see supabase/functions/ice-servers).
const PUBLIC_STUN: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// Cache the negotiated credentials in memory. Cloudflare TURN tokens are
// short-lived (default 1h), Twilio NTS even shorter (24h max but typically
// 1h), so we re-fetch on each call rather than persisting to disk.
let cache: { servers: IceServer[]; expiresAt: number } | null = null;

export async function fetchIceServers(): Promise<IceServer[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.servers;
  try {
    const { data, error } = await supabase.functions.invoke<{
      iceServers: IceServer[];
      ttlSeconds?: number;
    }>('ice-servers', { body: {} });
    if (error || !data?.iceServers?.length) {
      // Cache the fallback briefly so a flaky function call doesn't fire on
      // every connection-state retry, but short enough that a fixed deploy
      // is picked up on the next call attempt.
      cache = { servers: PUBLIC_STUN, expiresAt: Date.now() + 30_000 };
      return PUBLIC_STUN;
    }
    const ttlMs = Math.max(60, (data.ttlSeconds ?? 600)) * 1000;
    // Refresh slightly before expiry so an in-flight call doesn't suddenly
    // lose TURN auth mid-handshake.
    cache = { servers: data.iceServers, expiresAt: Date.now() + ttlMs - 30_000 };
    return data.iceServers;
  } catch {
    cache = { servers: PUBLIC_STUN, expiresAt: Date.now() + 30_000 };
    return PUBLIC_STUN;
  }
}
