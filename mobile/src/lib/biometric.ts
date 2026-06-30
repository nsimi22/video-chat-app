import type * as LocalAuthentication from 'expo-local-authentication';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'generic';

export type BiometricCapability = {
  hasHardware: boolean;
  isEnrolled: boolean;
  available: boolean;
  kind: BiometricKind;
};

// `expo-local-authentication` resolves its native binding
// (requireNativeModule('ExpoLocalAuthentication')) at *import* time. A static
// top-level import therefore runs that resolution the moment this module is
// pulled into the graph — and because expo-router eagerly evaluates every
// route file at launch to build the route tree, this module sits on the
// cold-start path (via BiometricLockScreen + the You settings screen) for
// every user, not just those who opted into biometric lock.
//
// On any binary that doesn't contain the native module — e.g. an OTA JS bundle
// delivered to a TestFlight build that predates the dependency — that
// resolution throws synchronously and takes the whole startup module graph
// down with it: the app crashes on open before anything renders. Loading the
// module lazily (Metro defers a `require()` factory until first call) keeps it
// off the cold-start path, and the try/catch turns a missing or broken native
// module into a graceful "biometrics unavailable" rather than a crash — the UI
// already routes `available: false` to the password sign-in fallback.
let mod: typeof LocalAuthentication | null | undefined;
function load(): typeof LocalAuthentication | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-local-authentication') as typeof LocalAuthentication;
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

export async function capability(): Promise<BiometricCapability> {
  const LA = load();
  if (!LA) return UNAVAILABLE;

  try {
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
  } catch {
    // A native-layer failure (module present but throwing) should degrade to
    // the password fallback, never surface as an unhandled rejection.
    return UNAVAILABLE;
  }
}

export async function prompt(reason: string): Promise<boolean> {
  const LA = load();
  if (!LA) return false;

  try {
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
  } catch {
    return false;
  }
}

export function label(kind: BiometricKind): string {
  switch (kind) {
    case 'face': return 'Face ID';
    case 'fingerprint': return 'fingerprint';
    case 'iris': return 'iris scan';
    default: return 'biometrics';
  }
}
