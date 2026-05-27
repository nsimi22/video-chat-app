import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, AppState } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { Button, Logo } from '@/components/ui';
import { capability, prompt, label, type BiometricCapability } from '@/lib/biometric';
import { setEnabled } from '@/lib/biometricPref';
import { colors, space } from '@/theme';

const MAX_ATTEMPTS = 3;

export function BiometricLockScreen() {
  const { unlock, signOut } = useAuth();
  const [cap, setCap] = useState<BiometricCapability | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  // Prevent the auto-prompt from firing twice on a single mount — React's
  // strict mode and the AppState 'active' callback can both race it.
  const promptedOnce = useRef(false);

  useEffect(() => {
    capability().then(setCap);
  }, []);

  // Auto-prompt as soon as we know what hardware is available. Also re-prompt
  // when the OS dialog gets dismissed by a background→foreground (the system
  // dialog can pause the JS callback in rare cases).
  useEffect(() => {
    if (!cap) return;
    if (promptedOnce.current) return;
    if (!cap.available) return;
    if (attempts >= MAX_ATTEMPTS) return;
    promptedOnce.current = true;
    void tryAuth();

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !busy && attempts < MAX_ATTEMPTS) void tryAuth();
    });
    return () => sub.remove();
    // tryAuth is stable enough; intentionally not in deps to avoid a re-arm loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap]);

  const tryAuth = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await prompt(`Unlock Huddle with ${cap ? label(cap.kind) : 'biometrics'}`);
    setBusy(false);
    if (ok) unlock();
    else setAttempts((n) => n + 1);
  };

  const fallbackToPassword = async () => {
    // Clear the opt-in so the user isn't immediately re-locked on the next
    // launch after they re-authenticate with password. They can re-enable in
    // Settings once they're back in.
    await setEnabled(false).catch(() => {});
    await signOut();
    router.replace('/(auth)/email');
  };

  const kindLabel = cap ? label(cap.kind) : 'biometrics';
  const exhausted = attempts >= MAX_ATTEMPTS;

  // Hardware exists but no enrolled biometrics — happens if the user disabled
  // Face ID at the OS level after enabling it in Huddle. Fall through to the
  // password escape hatch immediately.
  if (cap && !cap.available) {
    return (
      <View style={styles.root}>
        <Logo size={64} />
        <Text style={styles.title}>{kindLabel} unavailable</Text>
        <Text style={styles.body}>
          Huddle is set to unlock with {kindLabel}, but it isn't enrolled on this device.
          Sign in with your password to continue, then re-enable biometrics in Settings.
        </Text>
        <Button title="Sign in with password" onPress={fallbackToPassword} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Logo size={64} />
      <Text style={styles.title}>Huddle is locked</Text>
      <Text style={styles.body}>
        {exhausted
          ? `${kindLabel} didn't match after ${MAX_ATTEMPTS} attempts.`
          : `Use ${kindLabel} to unlock.`}
      </Text>
      {!exhausted && (
        <Button
          title={busy ? 'Waiting…' : `Unlock with ${kindLabel}`}
          onPress={tryAuth}
          disabled={busy}
        />
      )}
      <View style={{ height: space(3) }} />
      <Button
        title="Sign in with password"
        variant="ghost"
        onPress={fallbackToPassword}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space(6),
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '600',
    marginTop: space(4),
    marginBottom: space(2),
  },
  body: {
    color: colors.textDim,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: space(5),
    lineHeight: 21,
  },
});
