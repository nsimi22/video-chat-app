# Huddle Mobile (Expo)

Native iOS + Android client for Huddle. Talks to the **same Supabase project**
as the desktop app (`jwqvrdgjpftjiwvgdrck`) — no backend changes for chat. Video
calls use a hosted **LiveKit** SFU instead of the desktop full-mesh, brokered by
the `livekit-token` Supabase Edge Function.

## Status

MVP scope: **chat + receive-only calls**.

- ✅ Email-OTP auth, profile setup, team picker (mirrors `renderer/api.js`)
- ✅ Channel / DM list (live via `postgres_changes`)
- ✅ Chat: history pagination, realtime, reactions, pins, attachments (images), typing
- ✅ Push notifications (DMs + @-mentions) via Expo push + `notify-on-message`
- ✅ Calls: join a channel call, see/hear participants, publish camera/mic, mute/flip/leave (LiveKit)
- ⛔ Not yet: screen-share send, annotations, whiteboard, threads UI, search UI, GIF picker, integration API keys, CallKit/ConnectionService, cross-platform A/V with desktop (desktop still on mesh)

## Develop

This package is **not** part of the Electron app's build; it's a standalone Expo
project. WebRTC/LiveKit need a dev client (Expo Go won't work).

```bash
cd mobile
npm install
npx expo prebuild            # generates ios/ android/
npm run ios                  # or: npm run android
# day-to-day:
npm start                    # dev client
npm run typecheck
```

Supabase URL / anon key are in `app.json` → `expo.extra` (same public values as
the desktop default). Override per build if you self-host.

## LiveKit setup (calls)

1. Create a LiveKit Cloud project (or self-host).
2. Set Edge Function secrets in Supabase:
   ```bash
   supabase secrets set LIVEKIT_URL=wss://<your>.livekit.cloud \
     LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...
   supabase functions deploy livekit-token
   ```
3. The app calls `livekit-token` (see `src/lib/livekit.ts`); it verifies the
   caller's session + channel membership (`can_see_channel`) before signing a
   token for room `call:<team_id>:<channel_id>`.

## Push setup

1. `npx eas credentials` — configure APNs key + FCM.
2. Apply the migration `supabase/migrations/20260512000000_huddle_device_tokens.sql`.
3. Deploy + wire the webhook:
   ```bash
   supabase secrets set NOTIFY_WEBHOOK_SECRET="$(openssl rand -hex 24)"
   supabase functions deploy notify-on-message --no-verify-jwt
   ```
   Then in the dashboard add a Database Webhook on `public.messages` INSERT →
   HTTP POST to the `notify-on-message` function, with an
   `x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>` header (the function is deployed
   without JWT verification, so this header is its only auth).

## Builds / release

```bash
eas build --profile preview --platform all     # internal install
eas build --profile production --platform all  # store builds
```

Add a separate GitHub Actions workflow for EAS — do **not** touch
`.github/workflows/release.yml` (that's the desktop installer pipeline).
