import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'generic';

export type BiometricCapability = {
  hasHardware: boolean;
  isEnrolled: boolean;
  available: boolean;
  kind: BiometricKind;
};

export async function capability(): Promise<BiometricCapability> {
  const [hasHardware, isEnrolled, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);

  // Prefer Face ID label on devices that support it (iPhone X+, recent Androids
  // with face unlock). Falls back to fingerprint, then iris, then a generic
  // term for anything else the device reports.
  let kind: BiometricKind = 'generic';
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) kind = 'face';
  else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) kind = 'fingerprint';
  else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) kind = 'iris';

  return {
    hasHardware,
    isEnrolled,
    available: hasHardware && isEnrolled,
    kind,
  };
}

export async function prompt(reason: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    // Disable the device-passcode fallback. We have our own "Sign in with
    // password" escape hatch that fully signs the user out — relying on the
    // OS passcode would unlock the session without proving identity in a way
    // we can detect.
    disableDeviceFallback: true,
    cancelLabel: 'Cancel',
  });
  return result.success;
}

export function label(kind: BiometricKind): string {
  switch (kind) {
    case 'face': return 'Face ID';
    case 'fingerprint': return 'fingerprint';
    case 'iris': return 'iris scan';
    default: return 'biometrics';
  }
}
