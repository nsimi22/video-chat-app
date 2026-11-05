# Huddle on CarPlay

CarPlay support turns Huddle into a hands-free surface on the car head-unit: an
iMessage-style list of conversations, read recent messages, send canned
quick-replies, and join/control an audio call — all from the car screen.

CarPlay is **not a separate app** — it's a scene inside the existing iOS app
(`mobile/`), so it ships in the same binary and talks to the same Supabase +
LiveKit backend. Two hard limits shape the UX, both from Apple: **no video** on
the car display while driving (calls are audio-only; the surface never touches
camera tracks), and **no free-text entry** (replies are canned presets, or voice
via the SiriKit path below).

## What's implemented (in-app, on-screen)

| Piece | File |
| --- | --- |
| Guarded native wrapper — stack reconciler for the templates | `src/lib/carplay.ts` |
| React bridge — conversations, open-conversation, call, mute | `src/components/CarPlayBridge.tsx` |
| Mount point (inside `<LiveKitRoom>`) | `app/(app)/_layout.tsx` |
| Last-message-per-channel query | `src/lib/api.ts` → `fetchLatestMessagesByChannel` |
| Native config (entitlement + CarPlay connector) | `plugins/withCarPlay.js` |
| ObjC CarPlay connector source of truth | `ios-carplay/AppDelegate+HuddleCarPlay.m` |
| Dependency | `react-native-carplay` in `package.json` |

Three templates, driven by a small **stack reconciler** (the bridge computes a
plain view-state; the controller diffs it against the live template stack and
issues the minimal set-root / push / pop / update calls):

- **Conversations** (root) — a `CPListTemplate` of channels + DMs, each with a
  last-message preview and an unread count. Sorted most-recently-active first.
  Kept live off `channels` + `messages` realtime subscriptions and the shared
  `UnreadContext`.
- **Conversation** (pushed on tap) — a `CPListTemplate` with the most recent
  messages (read-only), a set of **canned quick-replies** you can send
  hands-free (`On my way`, `Running late`, …), and a **Join audio call** row.
  New messages append live while it's open.
- **Call** (pushed while active) — a `CPInformationTemplate` with the call name,
  a live participant count, and **Mute** / **Leave**. Mute toggles the same
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

CarPlay needs a native rebuild (the config plugin injects the CarPlay connector
at prebuild time — Expo Go can't run it):

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

> If prebuild ever fails to add the connector to the Xcode target, the plugin
> logs a warning; add `AppDelegate+HuddleCarPlay.m` manually under **Target →
> Build Phases → Compile Sources**. The `.m` lives in `ios-carplay/` and is
> copied into `ios/<project>/` on every prebuild.

## How the native wiring works

`expo prebuild` runs `plugins/withCarPlay.js`, which:

1. adds the `com.apple.developer.carplay-communication` entitlement;
2. copies `AppDelegate+HuddleCarPlay.m` into the iOS project and adds it to
   Compile Sources.

The connector is an ObjC category on the (Swift) `AppDelegate` that adopts
`CPApplicationDelegate` — the AppDelegate connection method
`react-native-carplay` documents. **We deliberately do NOT declare a
`UIApplicationSceneManifest` / `UIApplicationSupportsMultipleScenes`.** In a
prebuilt Expo SDK 54 / RN 0.81 app, enabling multiple scenes without a matching
`UIWindowScene` delegate leaves the phone's AppDelegate-created window
unattached and the **entire app renders black**. Keeping the app AppDelegate/
window based avoids that; CarPlay attaches through the `CPWindow` instead.

On connect, the category's `application:didConnectCarInterfaceController:toWindow:`
calls `[RNCarPlay connectWithInterfaceController:window:]`, handing control to
`react-native-carplay`, which the JS in `src/lib/carplay.ts` then drives.

## Siri voice messaging (iMessage-parity) — SCAFFOLD

The on-screen surface above can't read message text aloud or take dictation while
driving — Apple routes that through **SiriKit**. A SiriKit *Intents extension*
lets Siri say "New message from Dana on Huddle: …", offer to reply, and send your
dictated response, and powers CarPlay's "Announce Messages". This repo ships a
**scaffold** for it — the structure and the declarative config — but it is **not
wired into a build yet** and needs finishing on a Mac.

### What's here

| Piece | File |
| --- | --- |
| Extension principal class (intent router) | `ios-carplay/HuddleIntents/IntentHandler.swift` |
| Send a message (`INSendMessageIntent`) | `ios-carplay/HuddleIntents/SendMessageIntentHandler.swift` |
| Read messages aloud (`INSearchForMessagesIntent`) | `ios-carplay/HuddleIntents/SearchForMessagesIntentHandler.swift` |
| Swift Supabase client (send/fetch) | `ios-carplay/HuddleShared/SupabaseMessaging.swift` |
| Extension `Info.plist` (declares `IntentsSupported`) | `ios-carplay/HuddleIntents/Info.plist` |
| Extension entitlements (App Group) | `ios-carplay/HuddleIntents/HuddleIntents.entitlements` |
| Main-app config plugin (Siri entitlement, usage string, App Group) | `plugins/withSiriMessaging.js` |

### Why it's a scaffold, not a build

- The extension is a **separate target** in its own process — it can't call the
  React Native JS, so it talks to Supabase directly in Swift
  (`SupabaseMessaging.swift`, currently stubbed).
- `@expo/config-plugins` can't reliably add a new **app-extension target** to the
  Xcode project, so that step is manual.
- Enabling the **Siri capability** requires it on the App ID / provisioning
  profile; adding the entitlement without it fails signing — which is why
  `withSiriMessaging.js` is **not** in `app.json` by default.

### Remaining steps (on a Mac)

1. `expo prebuild`, then in Xcode add a **Messaging Intents Extension** target.
   Set its principal class to `IntentHandler`, add the four Swift files + the
   extension `Info.plist` + `.entitlements`, and add `SupabaseMessaging.swift` to
   both the app and extension targets (or a shared framework).
2. Enable **Siri** and an **App Group** (`group.com.nicksimi.huddle`) on both the
   app and the extension in Signing & Capabilities.
3. Share the session: on sign-in, have the RN app write the Supabase
   `access_token`, `active_team_id`, and `user_id` into the App Group's
   `UserDefaults(suiteName:)` (a tiny native module, since JS AsyncStorage
   doesn't cross into the extension). `SupabaseMessaging` reads them.
4. Implement the two `// TODO` REST calls in `SupabaseMessaging.swift` (mirror
   `src/lib/api.ts` `sendMessage` + a recent-messages fetch).
5. Request Siri authorization (`INPreferences.requestSiriAuthorization`) and
   donate/interaction intents so Siri learns the vocabulary.
6. Add `"./plugins/withSiriMessaging.js"` to `app.json` → `plugins`.

## Not yet (other follow-ups)

- **CallKit / incoming calls** — answering a call *from* CarPlay (native
  incoming-call UI) needs CallKit + PushKit VoIP pushes and backend changes to
  `notify-on-message`/a new VoIP-push path. Tracked alongside the mobile
  CallKit item in the README.
- **Now-playing style** call template with richer transport controls.
