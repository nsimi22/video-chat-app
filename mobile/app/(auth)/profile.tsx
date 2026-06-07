import { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Button, Field, H1, P, Screen } from '@/components/ui';

const PALETTE = ['#5b8cff', '#ff8c5b', '#34c759', '#c75bff', '#ff5b8c', '#5bd9ff'];

export default function ProfileScreen() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      Alert.alert('Enter your name');
      return;
    }
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    const userId = u.user?.id;
    if (!userId) {
      setBusy(false);
      return;
    }
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const { error } = await supabase
      .from('profiles')
      .upsert({ user_id: userId, name: n, color }, { onConflict: 'user_id' });
    setBusy(false);
    if (error) {
      Alert.alert('Could not save profile', error.message);
      return;
    }
    router.replace('/(auth)/team');
  };

  return (
    <Screen>
      <H1>What&apos;s your name?</H1>
      <P>This is how teammates will see you.</P>
      <Field placeholder="Ada Lovelace" value={name} onChangeText={setName} onSubmitEditing={submit} autoFocus />
      <Button title="Continue" onPress={submit} loading={busy} disabled={!name.trim()} />
    </Screen>
  );
}
