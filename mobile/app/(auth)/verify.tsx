import { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Brand, Button, Field, H1, P, Screen } from '@/components/ui';

export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const token = code.trim();
    if (!token) {
      Alert.alert('Enter your verification code');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.verifyOtp({ email: String(email), token, type: 'email' });
    setBusy(false);
    if (error || !data.session) {
      Alert.alert('Invalid code', error?.message ?? 'Try again');
      return;
    }
    const { data: prof } = await supabase
      .from('profiles')
      .select('name')
      .eq('user_id', data.session.user.id)
      .maybeSingle();
    if (!prof?.name) router.replace('/(auth)/profile');
    else router.replace('/(auth)/team');
  };

  return (
    <Screen>
      <Brand />
      <H1>Enter your code</H1>
      <P>Sent to {String(email)}.</P>
      <Field
        placeholder="12345678"
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
        onSubmitEditing={submit}
      />
      <Button title="Verify" onPress={submit} loading={busy} disabled={!code.trim()} />
    </Screen>
  );
}
