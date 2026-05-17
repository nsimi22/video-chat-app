import { useEffect, useState } from 'react';
import { View, Text, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { getProfile } from '@/lib/api';
import { Avatar, Button, Field, H1, Screen } from '@/components/ui';
import { colors, space } from '@/theme';

export default function SettingsScreen() {
  const { userId, activeTeam, setActiveTeam, signOut } = useAuth();
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Set-/change-password section: a single field that updates the user's
  // auth password via supabase.auth.updateUser. Same path as desktop, so a
  // password set here also works for sign-in on the desktop app.
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!userId) return;
    getProfile(userId).then((p) => {
      setName(p?.name ?? '');
      setBio(p?.bio ?? '');
      setColor(p?.color ?? null);
      setLoading(false);
    });
  }, [userId]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ name: name.trim(), bio: bio.trim() }).eq('user_id', userId!);
    setSaving(false);
    if (error) Alert.alert('Could not save', error.message);
    else Alert.alert('Saved');
  };

  const savePassword = async () => {
    if (newPassword.length < 6) {
      Alert.alert('Pick a longer password', 'Use 6 or more characters.');
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      Alert.alert('Could not update password', error.message);
      return;
    }
    setNewPassword('');
    Alert.alert('Password updated', 'You can now sign in with this password on any device.');
  };

  if (loading) {
    return <Screen><ActivityIndicator color={colors.accent} /></Screen>;
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: space(8) }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', marginBottom: space(5) }}>
          <Avatar name={name} color={color} size={72} />
        </View>
        <H1>Your profile</H1>
        <Text style={{ color: colors.textDim, marginBottom: space(1) }}>Display name</Text>
        <Field value={name} onChangeText={setName} placeholder="Your name" />
        <Text style={{ color: colors.textDim, marginBottom: space(1) }}>Bio</Text>
        <Field value={bio} onChangeText={setBio} placeholder="Optional" multiline />
        <Button title="Save" onPress={save} loading={saving} />

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space(6) }} />
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: space(2) }}>Password</Text>
        <Text style={{ color: colors.textDim, marginBottom: space(2), fontSize: 13 }}>
          Set or change your sign-in password. Useful as a faster alternative to the email code on return logins.
        </Text>
        <Field
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="New password (6+ characters)"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          textContentType="newPassword"
        />
        <Button title="Update password" onPress={savePassword} loading={savingPassword} disabled={newPassword.length < 6} />

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space(6) }} />
        <Text style={{ color: colors.textDim, marginBottom: space(2) }}>Active team: {activeTeam?.name ?? '—'}</Text>
        <Button title="Switch team" variant="ghost" onPress={() => { setActiveTeam(null); router.replace('/(auth)/team'); }} />
        <Button title="Sign out" variant="danger" onPress={async () => { await signOut(); router.replace('/(auth)/email'); }} />

        <Text style={{ color: colors.textDim, fontSize: 12, marginTop: space(8) }}>
          Integration API keys (Jira, GitHub, AI, Giphy) live in the desktop app's Settings panel — coming to mobile in a later release.
        </Text>
      </ScrollView>
    </Screen>
  );
}
