# Expo SDK 52 → 54 upgrade plan

**Date:** 2026-05-19
**Trigger:** Apple rejected the first TestFlight submission with error 90725 —
"This app was built with the iOS 18.2 SDK. All iOS and iPadOS apps must be
built with the iOS 26 SDK or later, included in Xcode 26 or later." Our
Expo SDK 52 build chain pins Xcode 16.2, so a re-roll of `eas build` alone
cannot resolve this; the SDK has to move.

## Why we cannot stay on SDK 52

| Expo SDK | EAS default image | Xcode | iOS SDK |
|---|---|---|---|
| **52 (current)** | `macos-sequoia-15.3-xcode-16.2` | 16.2 | 18.2 — **Apple rejects** |
| 53 | `macos-sequoia-15.5-xcode-16.4` | 16.4 | 18.x — still rejected |
| **54** | `macos-sequoia-15.6-xcode-26.0` | **26.0** | **26** — accepted |
| 55 (latest) | `macos-sequoia-15.6-xcode-26.2` | 26.2 | 26 |

Per the EAS infrastructure docs (`docs.expo.dev/build-reference/infrastructure/`),
each Expo SDK is paired with a specific Xcode version. Overriding `image`
to `xcode-26` on SDK 52 is not a supported combination. SDK 54 is the
floor that unblocks App Store submission.

## What changes

### Direct version bumps (`mobile/package.json`)

- `expo`: `~52.0.0` → `~54.0.0`
- `react-native`: `0.76.5` → whatever SDK 54 ships (likely `0.81.x`)
- `react`: stays `18.3.1` unless SDK 54 requires a bump
- Every `expo-*` package — bumped via `npx expo install --check && npx expo install --fix`:
  - `expo-router`, `expo-secure-store`, `expo-camera`, `expo-notifications`,
    `expo-constants`, `expo-device`, `expo-asset`, `expo-av`, `expo-clipboard`,
    `expo-crypto`, `expo-document-picker`, `expo-file-system`, `expo-image-picker`,
    `expo-keep-awake`, `expo-linking`, `expo-status-bar`, `expo-updates`
- Native plugins:
  - `@livekit/react-native` (currently `~2.7.0`)
  - `@livekit/react-native-expo-plugin` (currently `^1.0.2`)
  - `@livekit/react-native-webrtc` (currently `^125.0.0`)
  - `@react-native-community/datetimepicker` (currently `8.2.0`)
  - `react-native-svg`, `react-native-gesture-handler`,
    `react-native-safe-area-context`, `react-native-screens`
- JS-only deps: usually fine as-is; `livekit-client` and `lucide-react-native`
  are pure JS and should not need version surgery.

### Config files

- `mobile/eas.json` — set `build.production.ios.image` explicitly to
  `macos-sequoia-15.6-xcode-26.0` so we don't quietly drift onto a newer
  image that ships a different Xcode patch. Also worth adding the same
  `image` to `build.preview.ios` for symmetry.
- `mobile/app.json` — bumps to `newArchEnabled` and `runtimeVersion`
  policies may be required by SDK 54; let `expo install --fix` decide.

### Native re-prebuild

- `npx expo prebuild --clean` from `mobile/` regenerates `ios/` and `android/`
  against the new SDK. Will replace any locally-tweaked native files —
  inspect the diff to make sure no manual fixes get clobbered (we don't
  currently have any hand-edited native code that I know of, but verify).

## Steps (ordered)

1. **Branch off main**: `git checkout -b mobile/expo-sdk-54-upgrade`. Keep
   `mobile/testflight-prep` parked — it has the TestFlight config we want
   to preserve, just not on SDK 54 yet. (We can rebase it onto the upgrade
   later or merge them.)
2. **Cherry-pick TestFlight prep** if helpful (`5d79148`, `5ab8401`,
   `4401793`, `ca93ee8`) so the upgrade branch has the right bundle id,
   ASC config, and EAS additions. Alternative: merge `testflight-prep`
   into main first, then branch off again — cleaner history.
3. **`cd mobile && npx expo install expo@~54.0.0`** — pulls the SDK
   metadata.
4. **`npx expo install --check`** — lists every dep that needs version
   surgery for SDK 54.
5. **`npx expo install --fix`** — applies the fixes.
6. **`npx expo prebuild --clean`** — regenerates iOS/Android native dirs.
7. **`npm run ios`** in `mobile/` — local sim build. First failure mode
   to watch for: LiveKit polyfill stack (we already fought it on SDK 52).
   Second: `expo-router` 4.x → 5.x route conventions (we use it heavily;
   group folders, dynamic params, `useLocalSearchParams` typing).
8. **Smoke test in the simulator**: sign in, browse channels, send a
   message, open the calendar, open the create-channel/DM sheets, tap
   the phone icon to open the call screen, verify the LiveKitRoom mounts
   and the placeholder tile renders.
9. **Set the EAS image** in `eas.json`:
   ```json
   "production": {
     "channel": "production",
     "autoIncrement": true,
     "ios": { "image": "macos-sequoia-15.6-xcode-26.0" }
   }
   ```
10. **`eas build --platform ios --profile production`** — should now
    compile against the iOS 26 SDK.
11. **`eas submit --platform ios --profile production --latest --non-interactive`**
    — credentials and ASC app id are cached from the earlier attempt.
12. **TestFlight processing** (~5–30 min), then internal-test the binary
    on a real iPhone. This is where we finally verify the real-device
    camera path the simulator could never test.

## Risks and mitigations

- **expo-router major bump.** Likely 4.x → 5.x. Breaking changes have
  historically been around: nested `Stack.Screen` options (we use these
  for the call screen and channel header), `useLocalSearchParams`
  generics, group folder semantics. Mitigation: read the 5.0 changelog
  before pushing, and have the smoke test cover every route we have
  (`(tabs)`, `channel/[id]`, `call/[id]`, `event/[id]`).
- **LiveKit native modules out of sync.** `@livekit/react-native-webrtc`
  125 is from the RN 0.76 era; SDK 54's RN 0.81 may require 130+. The
  Expo plugin's `~1.0.2` is RN-architecture-sensitive. Mitigation: pin
  exactly the version `expo install --check` recommends, not "latest"
  from npm. Also: confirm the polyfill stack still wires up without
  the BOOT_ERROR / Hermes pitfalls we hit before (the `livekit-token`
  edge function comment in `supabase/functions/livekit-token/index.ts`
  documents one of those traps).
- **New architecture default.** SDK 54 may flip `newArchEnabled` to
  true by default. Some native modules (especially older ones like our
  `datetimepicker`) may not have Fabric/TurboModule support. Mitigation:
  if anything breaks at runtime with a Fabric error, set
  `"newArchEnabled": false` in `app.json` as a temporary fallback.
- **datetimepicker.** The "Tried to register two views with the same
  name RNDateTimePicker" bug already bit us on SDK 52 with a Metro cache
  remedy. After a clean prebuild, that should not recur, but worth being
  ready to clear Metro again.
- **Push notifications.** `expo-notifications` keeps breaking minor
  things between SDKs (sound, channel id formats). Likely a small fix,
  not a blocker.
- **App still ships on SDK 52 desktop renderer.** Electron app is
  unrelated to Expo SDK — it stays on whatever it is. No coupling.

## Fallback strategy

If the upgrade trips a real wall (some native module is *truly* not
compatible with SDK 54 yet):

- **Plan B:** Pin to SDK 53 + Xcode 16.4 image (`macos-sequoia-15.5-xcode-16.4`).
  Apple still rejects builds compiled with Xcode 16.x today, so this
  doesn't ship to TestFlight — but it does isolate "did the SDK upgrade
  break us" from "did Xcode 26 break us."
- **Plan C:** Abandon Expo for a full bare-RN rewrite. Probably 1–2
  weeks of work. We'd want to be very sure SDK 54 was genuinely broken
  before going there.
- **Plan D:** Wait for Expo SDK 55 to mature. SDK 54 was released
  recently; if it's still rough at the edges for our combination of
  native plugins, sometimes waiting two weeks is cheaper than fighting
  through.

## Acceptance criteria (definition of done)

- [ ] `mobile/expo-sdk-54-upgrade` branch builds locally on the iOS
      simulator.
- [ ] Every route in the app loads without console errors: auth → team
      picker → channels → channel → call → calendar → people → settings.
- [ ] `eas build --platform ios --profile production` completes.
- [ ] `eas submit` succeeds; Apple no longer raises error 90725.
- [ ] TestFlight build reaches "Ready to Test" state and installs on a
      real iPhone.
- [ ] On the real iPhone: signing in works, messaging works, tapping
      the phone icon opens the call screen, the local camera tile
      shows real video (the test the simulator could not run).

## Out of scope for this plan

- Mobile Android Play Store submission. Not requested. Bundle id has
  already been aligned to `com.nicksimi.huddle` if/when we want it.
- Desktop renderer → LiveKit migration (separate task #9). Independent
  of the mobile SDK upgrade.
- Any new feature work on mobile. Pure infra-only PR.
