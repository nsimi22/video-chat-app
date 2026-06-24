import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { GitBranch, KeyRound, LogOut, Smile, Sparkles, Ticket, Users } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { getProfile } from '@/lib/api';
import {
  getAiSettings,
  getGiphyKey,
  getGithubSettings,
  getJiraSettings,
  invalidateIntegrations,
} from '@/lib/integrations';
import { jiraIsConfigured } from '@/lib/jira';
import { Avatar, Button, Field } from '@/components/ui';
import { colors, radius, space, tabBarClearance, type PresenceStatus } from '@/theme';

// "You" tab — design prototype screen 8. Profile card, presence selector,
// integrations (read-only mirror of the desktop Settings panel), account
// fields (name / bio / password, carried over from the old Settings tab),
// then switch-team / sign-out.

const STATES: { id: PresenceStatus; label: string; color: string }[] = [
  { id: 'active', label: 'Available', color: colors.online },
  { id: 'away', label: 'Away', color: colors.away },
  { id: 'brb', label: 'BRB', color: colors.brb },
  { id: 'unavailable', label: 'Unavailable', color: colors.busy },
];

type IntegrationRow = { icon: LucideIcon; name: string; meta: string; on: boolean };

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: colors.textFaint,
        paddingHorizontal: 4,
        paddingBottom: space(2),
        marginTop: space(5),
      }}
    >
      {children}
    </Text>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

export default function YouScreen() {
  const insets = useSafeAreaInsets();
  const { userId, activeTeam, setActiveTeam, signOut } = useAuth();
  const { myStatus, setMyStatus } = usePresence();
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);

  const loadProfile = useCallback(() => {
    if (!userId) return;
    setLoading(true);
    setLoadError(false);
    getProfile(userId)
      .then((p) => {
        setName(p?.name ?? '');
        setBio(p?.bio ?? '');
        setColor(p?.color ?? null);
        setAvatarUrl(p?.avatar_url ?? null);
      })
      // Surface the failure instead of swallowing it: a transient rejection
      // used to leave the tab spinning forever, but silently clearing `loading`
      // would show a blank form whose Save would overwrite the real profile
      // with empty values. We render a retry state instead (see below).
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Re-read integration state on focus so a key added on desktop shows up
  // after the cache TTL without an app restart.
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let cancelled = false;
      invalidateIntegrations();
      Promise.all([
        getJiraSettings(userId),
        getGithubSettings(userId),
        getAiSettings(userId),
        getGiphyKey(userId),
      ]).then(([jira, github, ai, giphy]) => {
        if (cancelled) return;
        setIntegrations([
          {
            icon: Ticket,
            name: 'Jira',
            meta: jiraIsConfigured(jira) ? jira.host.replace(/^https?:\/\//, '') : 'Connect on desktop',
            on: jiraIsConfigured(jira),
          },
          {
            icon: GitBranch,
            name: 'GitHub',
            meta: github?.token ? 'Personal access token' : 'Connect on desktop',
            on: !!github?.token,
          },
          {
            icon: Sparkles,
            name: 'AI assistant',
            meta: ai?.provider === 'openrouter'
              ? (ai.openrouterModel || 'OpenRouter')
              : ai?.anthropicKey
                ? (ai.anthropicModel || 'Anthropic')
                : 'Connect on desktop',
            on: !!(ai?.anthropicKey || ai?.openrouterKey),
          },
          {
            icon: Smile,
            name: 'Giphy',
            meta: giphy ? 'API key set' : 'Connect on desktop',
            on: !!giphy,
          },
        ]);
      }).catch(() => {});
      return () => { cancelled = true; };
    }, [userId]),
  );

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
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // Block the form on a load failure rather than showing empty fields — saving
  // from here would clobber the user's stored profile with blank values.
  if (loadError) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: space(4) }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: space(2), textAlign: 'center' }}>
          Couldn't load your profile
        </Text>
        <Text style={{ color: colors.textDim, textAlign: 'center', marginBottom: space(4) }}>
          Check your connection and try again. We won't save anything until it loads, so your profile stays safe.
        </Text>
        <Button title="Retry" onPress={loadProfile} />
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: tabBarClearance(insets.bottom) }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: colors.text, paddingTop: space(2), paddingBottom: space(3) }}>
          You
        </Text>

        {/* Profile card */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space(3.5),
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            padding: space(4),
          }}
        >
          <Avatar name={name} color={color} uri={avatarUrl} size={56} status={myStatus} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }} numberOfLines={1}>{name || '—'}</Text>
            <Text style={{ fontSize: 13, color: colors.textDim, marginTop: 1 }} numberOfLines={1}>
              {activeTeam?.name ?? '—'}
            </Text>
          </View>
        </View>

        {/* Presence selector — 2×2 grid (four states) */}
        <GroupLabel>Set your status</GroupLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
          {STATES.map((s) => {
            const on = s.id === myStatus;
            return (
              <TouchableOpacity
                key={s.id}
                onPress={() => setMyStatus(s.id)}
                activeOpacity={0.7}
                style={{
                  flexBasis: '47%',
                  flexGrow: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: space(2),
                  paddingVertical: space(3),
                  borderRadius: radius.md,
                  backgroundColor: on ? colors.accentDim : colors.surface,
                  borderWidth: 1,
                  borderColor: on ? colors.accent : colors.border,
                }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: s.color }} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: on ? colors.text : colors.textMid }}>{s.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Integrations — read-only; keys are managed on desktop. */}
        <GroupLabel>Integrations</GroupLabel>
        <Group>
          {integrations.map((it, i) => (
            <View
              key={it.name}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space(3),
                padding: space(3.5),
                borderBottomWidth: i === integrations.length - 1 ? 0 : 1,
                borderBottomColor: colors.borderSoft,
              }}
            >
              <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
                <it.icon size={17} color={it.on ? colors.accentTx : colors.textDim} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: colors.text }}>{it.name}</Text>
                <Text style={{ fontSize: 12, color: colors.textDim, marginTop: 1 }} numberOfLines={1}>{it.meta}</Text>
              </View>
              {it.on ? (
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.online, backgroundColor: colors.liveDim, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' }}>
                  ON
                </Text>
              ) : (
                <Text style={{ fontSize: 12, color: colors.textFaint }}>Desktop</Text>
              )}
            </View>
          ))}
        </Group>

        {/* Account — profile fields + password (carried over from Settings). */}
        <GroupLabel>Account</GroupLabel>
        <Text style={{ color: colors.textDim, marginBottom: space(1) }}>Display name</Text>
        <Field value={name} onChangeText={setName} placeholder="Your name" />
        <Text style={{ color: colors.textDim, marginBottom: space(1) }}>Bio</Text>
        <Field value={bio} onChangeText={setBio} placeholder="Optional" multiline />
        <Button title="Save" onPress={save} loading={saving} />

        <GroupLabel>Password</GroupLabel>
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

        {/* Team + session */}
        <GroupLabel>Workspace</GroupLabel>
        <Group>
          <TouchableOpacity
            onPress={() => { setActiveTeam(null); router.replace('/(auth)/team'); }}
            activeOpacity={0.7}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3.5), borderBottomWidth: 1, borderBottomColor: colors.borderSoft }}
          >
            <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
              <Users size={17} color={colors.textMid} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '500', color: colors.text }}>Switch team</Text>
              <Text style={{ fontSize: 12, color: colors.textDim, marginTop: 1 }}>{activeTeam?.name ?? '—'}</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={async () => { await signOut(); router.replace('/(auth)/email'); }}
            activeOpacity={0.7}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3.5) }}
          >
            <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
              <LogOut size={17} color={colors.danger} />
            </View>
            <Text style={{ fontSize: 15, fontWeight: '500', color: colors.danger }}>Sign out</Text>
          </TouchableOpacity>
        </Group>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space(6) }}>
          <KeyRound size={12} color={colors.textFaint} />
          <Text style={{ color: colors.textFaint, fontSize: 12, flex: 1 }}>
            Integration API keys (Jira, GitHub, AI, Giphy) are managed in the desktop app&apos;s Settings panel.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
