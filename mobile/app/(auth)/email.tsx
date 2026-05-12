import { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Button, Field, H1, P, Screen } from '@/components/ui';

export default function EmailScreen() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const addr = email.trim().toLowerCase();
    if (!addr.includes('@')) {
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

  return (
    <Screen>
      <H1>Sign in to Huddle</H1>
      <P>We'll email you a 6-digit code.</P>
      <Field
        placeholder="you@company.com"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={submit}
      />
      <Button title="Send code" onPress={submit} loading={busy} disabled={!email.trim()} />
    </Screen>
  );
}
