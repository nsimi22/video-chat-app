# Huddle on CarPlay

CarPlay support turns the phone app's audio-calling into a hands-free surface on
the car head-unit: browse the team's channels and DMs, tap one to join its audio
call, and control the call (Mute / Leave) from the car screen.

CarPlay is **not a separate app** — it's a scene inside the existing iOS app
(`mobile/`), so it ships in the same binary and talks to the same Supabase +
LiveKit backend. It's **audio-only**: Apple prohibits video on the car display
while driving, so the CarPlay surface never touches camera tracks. It drives the
same `CallContext`/LiveKit room the phone UI uses.

## What's implemented

| Piece | File |
| --- | --- |
| Guarded native wrapper (templates, connect lifecycle) | `src/lib/carplay.ts` |
| React bridge (channel list → templates, call state, mute) | `src/components/CarPlayBridge.tsx` |
| Mount point (inside `<LiveKitRoom>`) | `app/(app)/_layout.tsx` |
| Native config (entitlement, scene manifest, scene delegate) | `plugins/withCarPlay.js` |
| ObjC scene delegate source of truth | `ios-carplay/HuddleCarSceneDelegate.{h,m}` |
| Dependency | `react-native-carplay` in `package.json` |

Two templates:

- **Browse** — a `CPListTemplate` with **Channels** and **Direct Messages**
  sections, kept live off the same `channels` realtime subscription the
  Channels tab uses. Selecting a row calls `startCall(channelId, name)`.
- **Call** — a `CPInformationTemplate` showing the call name, a live
  participant count, and **Mute** / **Leave** buttons. Mute toggles the same
  LiveKit mic the phone does (`setMicrophoneEnabled`) and broadcasts the state
  so desktop tiles reflect it even while the phone is locked.

The bridge is inert on Android and on any iOS build that didn't bundle
`react-native-carplay` (`CarPlayController.isSupported === false`), and the
native module is required lazily, so nothing here affects non-CarPlay builds.

## One-time Apple setup (required — manual, external)

CarPlay is gated behind an entitlement Apple grants per-app. **Until this is
approved the code is dormant** — the car simply won't show Huddle.

1. Request the CarPlay capability for the app's category from Apple at
   <https://developer.apple.com/contact/request/carplay/> — choose
   **Communication (VoIP calling)**.
2. Once granted, enable **CarPlay** on the App ID and regenerate the
   provisioning profile. The entitlement key this plugin writes is
   `com.apple.developer.carplay-communication`.

## Build & run

CarPlay needs a native rebuild (the config plugin injects the scene delegate at
prebuild time — Expo Go can't run it):

```bash
cd mobile
npm install                  # pulls in react-native-carplay
npx expo prebuild --clean    # runs plugins/withCarPlay.js
npm run ios                   # dev client on a device/simulator
```

### Testing in the simulator

1. Run the app on an iOS **Simulator**.
2. Simulator menu → **I/O → External Displays → CarPlay** to open the car
   screen.
3. Sign in and pick a team on the phone; the CarPlay screen shows the channel
   list. Tap a row to join its audio call, then use Mute / Leave.

> If prebuild ever fails to add the delegate to the Xcode target, the plugin
> logs a warning; add `HuddleCarSceneDelegate.m` manually under **Target → Build
> Phases → Compile Sources**. The `.h`/`.m` live in `ios-carplay/` and are
> copied into `ios/<project>/` on every prebuild.

## How the native wiring works

`expo prebuild` runs `plugins/withCarPlay.js`, which:

1. adds the `com.apple.developer.carplay-communication` entitlement;
2. writes a `UIApplicationSceneManifest` to `Info.plist` declaring a
   `CPTemplateApplicationSceneSessionRoleApplication` scene whose delegate is
   `HuddleCarSceneDelegate` (the phone keeps its normal AppDelegate window — we
   don't declare a `UIWindowSceneSessionRoleApplication`);
3. copies `HuddleCarSceneDelegate.{h,m}` into the iOS project and adds the `.m`
   to Compile Sources.

On connect, the delegate calls `[RNCarPlay connectWithInterfaceController:window:]`,
handing control to `react-native-carplay`, which the JS in `src/lib/carplay.ts`
then drives.

## Not yet (follow-ups)

- **CallKit / incoming calls** — answering a call *from* CarPlay (native
  incoming-call UI) needs CallKit + PushKit VoIP pushes and backend changes to
  `notify-on-message`/a new VoIP-push path. Tracked alongside the mobile
  CallKit item in the README.
- **Recents / favorites** section on the browse template for faster access.
- **Now-playing style** call template with richer transport controls.
