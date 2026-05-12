import { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Button, Field, H1, P, Screen } from '@/components/ui';

export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const token = code.trim();
    if (token.length < 6) {
      Alert.alert('Enter the 6-digit code');
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
      <H1>Enter your code</H1>
      <P>Sent to {String(email)}.</P>
      <Field
        placeholder="123456"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
        onSubmitEditing={submit}
      />
      <Button title="Verify" onPress={submit} loading={busy} disabled={code.length < 6} />
    </Screen>
  );
}
