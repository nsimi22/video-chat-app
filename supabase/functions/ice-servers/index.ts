// Returns an ICE-server list (STUN + TURN) for the mobile mesh client.
//
// Trust model:
//   1. The caller must present a valid Supabase session (Authorization: Bearer <jwt>).
//      This is the only auth on the function — TURN credentials are
//      short-lived and scoped to the issuing provider, but we still don't
//      want to hand them to unauthenticated callers.
//
// Provider selection (first match wins):
//   - Cloudflare TURN (CLOUDFLARE_TURN_TOKEN_ID + CLOUDFLARE_TURN_API_TOKEN):
//     calls the Cloudflare API to mint a one-shot credential. Free tier
//     covers ~1 TB/month. See:
//     https://developers.cloudflare.com/calls/turn/generate-credentials/
//   - Twilio NTS (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN): calls the
//     Network Traversal Service. Pay-as-you-go.
//   - Otherwise: public Google STUN only. Good enough for symmetric-NAT-free
//     home Wi-Fi; cellular and corporate NATs will need TURN.
//
// Required Edge Function secrets (any of):
//   CLOUDFLARE_TURN_TOKEN_ID, CLOUDFLARE_TURN_API_TOKEN
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//
// Deploy:  supabase functions deploy ice-servers

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const STUN_FALLBACK: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);

  // Verify the caller has a valid session before handing out TURN creds.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

  // Cloudflare TURN: short-lived single-use credential.
  const cfId = Deno.env.get('CLOUDFLARE_TURN_TOKEN_ID');
  const cfToken = Deno.env.get('CLOUDFLARE_TURN_API_TOKEN');
  if (cfId && cfToken) {
    try {
      const ttl = 3600;
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${cfId}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl }),
        },
      );
      if (res.ok) {
        const cf = await res.json() as {
          iceServers: { urls: string | string[]; username?: string; credential?: string };
        };
        // Cloudflare returns a single `iceServers` object (not a list);
        // wrap it and prepend the public STUN servers so peers that can
        // negotiate without relaying don't pay the TURN bill.
        return json({
          iceServers: [...STUN_FALLBACK, cf.iceServers],
          ttlSeconds: ttl,
        });
      }
      console.warn('[ice-servers] cloudflare API returned', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.warn('[ice-servers] cloudflare lookup failed', err);
    }
  }

  // Twilio NTS: short-lived ICE-server bundle.
  const twSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const twToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (twSid && twToken) {
    try {
      const auth = btoa(`${twSid}:${twToken}`);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twSid}/Tokens.json`,
        { method: 'POST', headers: { Authorization: `Basic ${auth}` } },
      );
      if (res.ok) {
        const t = await res.json() as { ice_servers: Array<{ url?: string; urls?: string; username?: string; credential?: string }>; ttl?: string };
        const iceServers: IceServer[] = (t.ice_servers ?? []).map((s) => ({
          urls: (s.urls ?? s.url)!,
          username: s.username,
          credential: s.credential,
        }));
        return json({ iceServers, ttlSeconds: Number(t.ttl ?? '3600') });
      }
      console.warn('[ice-servers] twilio API returned', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.warn('[ice-servers] twilio lookup failed', err);
    }
  }

  // No TURN provider configured (or all of them errored). STUN-only is enough
  // for many networks; mobile clients will gracefully fall back to this
  // exact list locally, so this branch mostly exists so the function still
  // returns 200 in dev.
  return json({ iceServers: STUN_FALLBACK, ttlSeconds: 600 });
});
