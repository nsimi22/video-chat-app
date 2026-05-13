import { useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Brand, Button, Field, H1, LinkButton, P, Screen } from '@/components/ui';
import { space } from '@/theme';

// After a successful sign-in (OTP or password), route based on whether
// the user has a profile name set yet. Mirrors verify.tsx so the password
// and code paths land in the same place.
async function routePostAuth(userId: string) {
  const { data: prof } = await supabase
    .from('profiles')
    .select('name')
    .eq('user_id', userId)
    .maybeSingle();
  if (!prof?.name) router.replace('/(auth)/profile');
  else router.replace('/(auth)/team');
}

export default function EmailScreen() {
  // Default flow is "email me a code"; toggling reveals a password field
  // (matches the desktop: emailed code by default, password if you've set
  // one). Both paths talk to the same Supabase project, so a user who set
  // a password on the desktop app can sign in with it here.
  const [mode, setMode] = useState<'otp' | 'password'>('otp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const addr = email.trim().toLowerCase();
  const validEmail = addr.includes('@');

  const sendCode = async () => {
    if (!validEmail) {
      Alert.alert('Enter a valid email');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) {
      Alert.alert('Could not send code', error.message);
      return;
    }
    router.push({ pathname: '/(auth)/verify', params: { email: addr } });
  };

  const signInWithPassword = async () => {
    if (!validEmail || !password) return;
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email: addr, password });
    setBusy(false);
    if (error || !data.session) {
      Alert.alert('Could not sign in', error?.message ?? 'Check your password or use the email code.');
      return;
    }
    await routePostAuth(data.session.user.id);
  };

  const signUpWithPassword = async () => {
    if (!validEmail || password.length < 6) {
      Alert.alert('Pick a longer password', 'Use 6 or more characters.');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({ email: addr, password });
    setBusy(false);
    if (error) {
      Alert.alert('Could not create account', error.message);
      return;
    }
    if (data.session) {
      await routePostAuth(data.session.user.id);
    } else {
      // Email confirmation enabled on the project — the user has to verify
      // their address before a session opens.
      Alert.alert(
        'Check your email',
        "We've sent a confirmation link. Once you've confirmed, come back and sign in.",
      );
    }
  };

  return (
    <Screen>
      <Brand tagline="Team video, screen-share, and chat — in one app." />
      <H1>Sign in to Huddle</H1>
      <P>
        {mode === 'otp'
          ? "We'll email you a 6-digit code."
          : 'Use a password if you’ve set one, or create an account.'}
      </P>
      <Field
        placeholder="you@company.com"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={mode === 'otp' ? sendCode : signInWithPassword}
      />
      {mode === 'password' ? (
        <Field
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password"
          textContentType="password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={signInWithPassword}
        />
      ) : null}

      {mode === 'otp' ? (
        <Button title="Send code" onPress={sendCode} loading={busy} disabled={!validEmail} />
      ) : (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Button title="Sign in" onPress={signInWithPassword} loading={busy} disabled={!validEmail || !password} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Create account" variant="ghost" onPress={signUpWithPassword} loading={busy} disabled={!validEmail || password.length < 6} />
          </View>
        </View>
      )}

      <LinkButton
        title={mode === 'otp' ? 'Use a password instead' : 'Use the email code instead'}
        onPress={() => { setMode(mode === 'otp' ? 'password' : 'otp'); setPassword(''); }}
      />
    </Screen>
  );
}
