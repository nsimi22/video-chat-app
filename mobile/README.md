# Huddle Mobile (Expo)

Native iOS + Android client for Huddle. Talks to the **same Supabase project**
as the desktop app (`jwqvrdgjpftjiwvgdrck`) — no backend changes for chat.
Audio calls use a **WebRTC mesh** signaled over the existing
`call:<team>:<channel>` Supabase Realtime topic (the same topic the desktop
mesh uses), so a mobile caller and a desktop caller can join the same call
and hear each other.

## Status

MVP scope: **chat + audio calls**.

- ✅ Email-OTP auth, profile setup, team picker (mirrors `renderer/api.js`)
- ✅ Channel / DM list (live via `postgres_changes`)
- ✅ Chat: history pagination, realtime, reactions, pins, attachments (images), typing
- ✅ Push notifications (DMs + @-mentions) via Expo push + `notify-on-message`
- ✅ Calls: join a channel call, hear participants, publish mic, mute/leave (WebRTC mesh)
- ⛔ Not yet: video send/receive on mobile, screen-share, annotations, whiteboard, threads UI, search UI, GIF picker, integration API keys, CallKit/ConnectionService

## Develop

This package is **not** part of the Electron app's build; it's a standalone Expo
project. `react-native-webrtc` needs a dev client (Expo Go won't work).

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

## Calls (WebRTC mesh)

Calls are full-mesh: every participant holds one `RTCPeerConnection` per other
participant. Plenty for audio-only up through ~6–8 people; revisit if the
typical call gets larger. The signaling protocol is identical to the desktop's
(`renderer/webrtc.js` + `renderer/api.js`), so mobile ↔ desktop calls Just
Work — desktop publishes video too, mobile peers ignore the video track.

**TURN** is optional but strongly recommended for cellular: STUN-only fails on
symmetric NATs. The `ice-servers` Edge Function returns short-lived
credentials from Cloudflare TURN (or Twilio NTS, or just public STUN if
nothing is configured):

```bash
# Cloudflare (free tier: ~1 TB/month)
supabase secrets set \
  CLOUDFLARE_TURN_TOKEN_ID=<id> \
  CLOUDFLARE_TURN_API_TOKEN=<token>

# …or Twilio (pay-as-you-go)
supabase secrets set TWILIO_ACCOUNT_SID=<sid> TWILIO_AUTH_TOKEN=<token>

supabase functions deploy ice-servers
```

The function 401s any caller without a Supabase session, so TURN credentials
aren't handed to anonymous users.

### Known limitations

- **Android background audio.** The `FOREGROUND_SERVICE` /
  `FOREGROUND_SERVICE_MICROPHONE` permissions are declared, but the app
  does not yet start a foreground service when a call begins — so on
  Android, locking the screen will let the OS kill the call after a
  while. `useKeepAwake()` keeps the screen on while the app is in the
  foreground, which is enough for the common case. Proper background
  calling needs a foreground service (likely via `expo-task-manager` or
  a small custom config plugin) — tracked as follow-up work.
- **No speaker / earpiece toggle.** RN-WebRTC routes audio to the
  earpiece by default. AirPods and other Bluetooth headsets are picked
  up automatically by the OS. Loudspeaker requires a native helper
  (`AudioManager.setSpeakerphoneOn` on Android,
  `AVAudioSession.overrideOutputAudioPort` on iOS) which rn-webrtc
  doesn't expose; follow-up.
- **Incoming-call notifications.** Tapping into a call is opt-in — if
  you're not looking at the channel, you won't know someone started a
  call. Push-on-call is a follow-up that needs a small DB schema +
  Edge Function webhook (mirroring `notify-on-message`).
- **Same user on two devices.** Presence keys on `userId`, so a user
  signed in on both desktop and mobile collides in the call channel.
  Pre-existing in the desktop renderer too — needs a coordinated
  per-device peer-id scheme to fix properly.

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

## Branding assets

The login screen, splash background and primary colour are wired up
already (the three-circle Huddle mark on the auth screens is rendered
from `<Logo />` in `src/components/ui.tsx`, no PNG needed). What's still
missing for store-quality builds:

- `assets/icon.png` — 1024×1024 app icon. Reference it as `"icon": "./assets/icon.png"` under `expo` in `app.json`.
- `assets/adaptive-icon.png` — 1024×1024 foreground for Android. Reference
  it as `"android.adaptiveIcon": { "foregroundImage": "./assets/adaptive-icon.png", "backgroundColor": "#0b0b0d" }`.
- `assets/splash.png` — wordmark for the splash screen (Expo centers it on the configured `backgroundColor`). Reference as `"splash.image": "./assets/splash.png"`.

Until those are added, Expo falls back to its default icon and a solid
`#0b0b0d` splash.

## Builds / release

```bash
eas build --profile preview --platform all     # internal install
eas build --profile production --platform all  # store builds
```

Add a separate GitHub Actions workflow for EAS — do **not** touch
`.github/workflows/release.yml` (that's the desktop installer pipeline).
