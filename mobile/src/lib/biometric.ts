import type * as LocalAuthentication from 'expo-local-authentication';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'generic';

export type BiometricCapability = {
  hasHardware: boolean;
  isEnrolled: boolean;
  available: boolean;
  kind: BiometricKind;
};

// `expo-local-authentication`'s entry eagerly resolves its native binding
// (`export default requireNativeModule('ExpoLocalAuthentication')`) at import
// time. On a binary that doesn't contain the native module — e.g. an OTA JS
// bundle delivered to a build that predates the dependency — resolving it is a
// *fatal native crash*, NOT a catchable JS throw: a `try/catch` around the
// `require()` does not save us.
//
// An earlier fix made the import lazy to keep it off the cold-start path, but
// that only relocated the crash to the first `capability()`/`prompt()` call
// (opening the You settings screen or the lock screen). The real guard is
// `requireOptionalNativeModule`, which returns `null` instead of crashing when
// the module is absent — so we probe first and only touch
// `expo-local-authentication` when the native module actually exists. A missing
// module degrades to "biometrics unavailable" (the UI already routes
// `available: false` to the password sign-in fallback).
let mod: typeof LocalAuthentication | null | undefined;
function load(): typeof LocalAuthentication | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = requireOptionalNativeModule('ExpoLocalAuthentication')
      ? (require('expo-local-authentication') as typeof LocalAuthentication)
      : null;
  } catch {
    mod = null;
  }
  return mod;
}

// Returned by reference on every failure path, so freeze it — a consumer
// mutating the shared singleton would corrupt all subsequent results.
const UNAVAILABLE: BiometricCapability = Object.freeze({
  hasHardware: false,
  isEnrolled: false,
  available: false,
  kind: 'generic',
});

// Single guard for every public call: if the native module is missing it
// degrades to `fallback`, and a native-layer failure (module present but
// throwing) is caught so it never surfaces as an unhandled rejection — both
// paths route the UI to the password fallback rather than crashing.
async function withModule<T>(
  fn: (LA: typeof LocalAuthentication) => Promise<T>,
  fallback: T,
): Promise<T> {
  const LA = load();
  if (!LA) return fallback;
  try {
    return await fn(LA);
  } catch {
    return fallback;
  }
}

export function capability(): Promise<BiometricCapability> {
  return withModule(async (LA) => {
    const [hasHardware, isEnrolled, types] = await Promise.all([
      LA.hasHardwareAsync(),
      LA.isEnrolledAsync(),
      LA.supportedAuthenticationTypesAsync(),
    ]);

    // Prefer Face ID label on devices that support it (iPhone X+, recent Androids
    // with face unlock). Falls back to fingerprint, then iris, then a generic
    // term for anything else the device reports.
    let kind: BiometricKind = 'generic';
    if (types.includes(LA.AuthenticationType.FACIAL_RECOGNITION)) kind = 'face';
    else if (types.includes(LA.AuthenticationType.FINGERPRINT)) kind = 'fingerprint';
    else if (types.includes(LA.AuthenticationType.IRIS)) kind = 'iris';

    return {
      hasHardware,
      isEnrolled,
      available: hasHardware && isEnrolled,
      kind,
    };
  }, UNAVAILABLE);
}

export function prompt(reason: string): Promise<boolean> {
  return withModule(async (LA) => {
    const result = await LA.authenticateAsync({
      promptMessage: reason,
      // Disable the device-passcode fallback. We have our own "Sign in with
      // password" escape hatch that fully signs the user out — relying on the
      // OS passcode would unlock the session without proving identity in a way
      // we can detect.
      disableDeviceFallback: true,
      cancelLabel: 'Cancel',
    });
    return result.success;
  }, false);
}

export function label(kind: BiometricKind): string {
  switch (kind) {
    case 'face': return 'Face ID';
    case 'fingerprint': return 'fingerprint';
    case 'iris': return 'iris scan';
    default: return 'biometrics';
  }
}
