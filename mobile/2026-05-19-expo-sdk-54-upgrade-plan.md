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
- `react-native`: `0.76.5` → `0.81` (per the SDK 54 dependency table)
- `react`: `18.3.1` → `19.1.0` (required by RN 0.81 / SDK 54)
- **JS engine:** RN 0.81 drops first-party JSC support. We already use
  Hermes (no `jsEngine` override in `mobile/app.json`), so this is a
  no-op for us — just don't add a JSC override.
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

- `mobile/eas.json` — set `build.production.ios.image` to `"sdk-54"`
  (the EAS alias that currently resolves to `macos-sequoia-15.6-xcode-26.0`).
  The alias is the SDK 54 default per EAS infra docs, so it tracks Xcode
  patch updates without us hand-editing the dot version. Add the same
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
2. **Cherry-pick TestFlight prep** from `mobile/testflight-prep` (all
   four verified to exist on that branch as of 2026-05-19):
   - `5d79148` — Mobile: capture eas-init side effects (expo-updates, eas.json reformat)
   - `5ab8401` — Mobile: bundle id → com.nicksimi.huddle, keep prebuild additions
   - `4401793` — Mobile: prep app.json for TestFlight submission
   - `ca93ee8` — Mobile: pre-populate eas.json submit config (ASC App ID + team)

   Alternative: merge `testflight-prep` into main first, then branch off
   again — cleaner history.
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
9. **Set the EAS image** in `eas.json` (use the alias so we follow
   Xcode patch updates without hand-editing):
   ```json
   "production": {
     "channel": "production",
     "autoIncrement": true,
     "ios": { "image": "sdk-54" }
   }
   ```
   `sdk-54` currently resolves to `macos-sequoia-15.6-xcode-26.0`
   (Xcode 26.0 / iOS 26 SDK).
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
- **New architecture.** SDK 54 still treats new arch as opt-in (per the
  SDK 54 changelog: "SDK 55 ... only support the New Architecture").
  So we can stay on legacy for this upgrade and decouple the Xcode-26
  unblock from the Fabric/TurboModules migration. Mitigation: leave
  `newArchEnabled` whatever `expo install --fix` sets it to; if anything
  breaks at runtime with a Fabric error, explicitly set
  `"newArchEnabled": false` in `app.json`. Track the new-arch migration
  as a separate follow-up before SDK 55 lands (datetimepicker and the
  LiveKit native trio are the likely sticking points).
- **datetimepicker.** The "Tried to register two views with the same
  name RNDateTimePicker" bug already bit us on SDK 52 with a Metro cache
  remedy. After a clean prebuild, that should not recur, but worth being
  ready to clear Metro again.
- **Push notifications.** `expo-notifications` keeps breaking minor
  things between SDKs (sound, channel id formats). Likely a small fix,
  not a blocker.
- **App still ships on SDK 52 desktop renderer.** Electron app is
  unrelated to Expo SDK — it stays on whatever it is. No coupling.

## Diagnostic step (when something breaks)

If a build fails after the upgrade, bisect along the only two axes that
changed at once: the SDK and the Xcode toolchain.

- **Bisect:** Pin to SDK 53 + Xcode 16.4 image (`macos-sequoia-15.5-xcode-16.4`)
  *locally only*. This won't ship (Apple still rejects Xcode 16.x for
  TestFlight today), but it isolates "did the SDK upgrade break us" from
  "did Xcode 26 break us." Treat this as a debug tool, not a fallback.

## Fallback strategy

If the upgrade trips a real wall (some native module is *truly* not
compatible with SDK 54 yet):

- **Plan B:** Wait for Expo SDK 55 to mature. SDK 54 was released
  recently; if it's still rough at the edges for our combination of
  native plugins, sometimes waiting two weeks is cheaper than fighting
  through. Note: SDK 55 forces new-arch, which raises rather than lowers
  risk for our LiveKit + datetimepicker stack.
- **Plan C:** Abandon Expo for a full bare-RN rewrite. Probably 1–2
  weeks of work. We'd want to be very sure SDK 54 was genuinely broken
  before going there.

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
- [ ] Sanity-check cold-start time and IPA size against the SDK 52
      baseline. Hermes + bytecode generation in RN 0.81 can move both;
      we don't need parity, just an absence of >2× regressions that
      would surprise us in production.

## Out of scope for this plan

- Mobile Android Play Store submission. Not requested. Bundle id has
  already been aligned to `com.nicksimi.huddle` if/when we want it.
- Desktop renderer → LiveKit migration (separate task #9). Independent
  of the mobile SDK upgrade.
- Any new feature work on mobile. Pure infra-only PR.

## Android note

`npx expo prebuild --clean` regenerates `android/` as well as `ios/`,
so the Android dir comes along for the ride even though we aren't
shipping it. **Policy:** if the Android prebuild fails on RN 0.81 in a
way that's not trivially fixable, we stop and triage rather than
proceeding ios-only. Carrying a broken `android/` checkout creates
drift that costs more to unwind later than to fix now.
