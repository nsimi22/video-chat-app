// Shared bits for the webhook-secret-authenticated edge functions
// (notify-on-message, flush-scheduled). Both are deployed --no-verify-jwt
// and gated on a shared secret header instead, and both talk to Expo push —
// keep the security-sensitive compare and the Expo wire constants in ONE
// place so the two functions can't drift.

export const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

// Accept both the legacy and current Expo push-token shapes.
export const EXPO_TOKEN_RE = /^Ex(?:ponent|po)PushToken\[[^\]]+\]$/;

// Constant-time string compare for the x-webhook-secret header.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
