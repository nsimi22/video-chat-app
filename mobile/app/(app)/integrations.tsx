import { useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Stack } from 'expo-router';
import { GitBranch, Smile, Sparkles, Ticket } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import {
  getAiSettings,
  getGiphyKey,
  getGithubSettings,
  getJiraSettings,
  updateIntegrationSettings,
} from '@/lib/integrations';
import type { AiProvider } from '@/lib/ai';
import { Button, Field } from '@/components/ui';
import { colors, radius, space } from '@/theme';

// Editable mirror of the desktop Settings panel's per-user integration keys
// (Jira / GitHub / AI / Giphy). Writes ride RLS straight to
// user_integrations.settings via updateIntegrationSettings — the same JSONB
// row the desktop reads/writes — so a key entered here lights up the feature
// on both clients. Previously mobile could only read these ("managed on
// desktop"); this closes that parity gap.

function GroupLabel({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(6), marginBottom: space(2), paddingHorizontal: 4 }}>
      <Icon size={15} color={colors.textDim} />
      <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textFaint }}>
        {children}
      </Text>
    </View>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ color: colors.textDim, marginBottom: space(1), fontSize: 13 }}>{children}</Text>
  );
}

export default function IntegrationsScreen() {
  const { userId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Jira
  const [jiraHost, setJiraHost] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraProject, setJiraProject] = useState('');
  // GitHub
  const [githubToken, setGithubToken] = useState('');
  // AI
  const [aiProvider, setAiProvider] = useState<AiProvider>('anthropic');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState('');
  // Giphy
  const [giphyKey, setGiphyKey] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [jira, github, ai, giphy] = await Promise.all([
        getJiraSettings(userId),
        getGithubSettings(userId),
        getAiSettings(userId),
        getGiphyKey(userId),
      ]);
      setJiraHost(jira?.host ?? '');
      setJiraEmail(jira?.email ?? '');
      setJiraToken(jira?.token ?? '');
      setJiraProject(jira?.defaultProject ?? '');
      setGithubToken(github?.token ?? '');
      setAiProvider(ai?.provider === 'openrouter' ? 'openrouter' : 'anthropic');
      setAnthropicKey(ai?.anthropicKey ?? '');
      setAnthropicModel(ai?.anthropicModel ?? '');
      setOpenrouterKey(ai?.openrouterKey ?? '');
      setOpenrouterModel(ai?.openrouterModel ?? '');
      setGiphyKey(giphy ?? '');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await updateIntegrationSettings(userId, {
        jira: {
          host: jiraHost.trim(),
          email: jiraEmail.trim(),
          token: jiraToken.trim(),
          defaultProject: jiraProject.trim(),
        },
        github: { token: githubToken.trim() },
        ai: {
          provider: aiProvider,
          anthropicKey: anthropicKey.trim(),
          anthropicModel: anthropicModel.trim(),
          openrouterKey: openrouterKey.trim(),
          openrouterModel: openrouterModel.trim(),
        },
        giphy: { key: giphyKey.trim() },
      });
      Alert.alert('Saved', 'Your integration keys are updated on this account.');
    } catch (err) {
      Alert.alert('Couldn’t save', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [
    userId, jiraHost, jiraEmail, jiraToken, jiraProject, githubToken,
    aiProvider, anthropicKey, anthropicModel, openrouterKey, openrouterModel, giphyKey,
  ]);

  return (
    <>
      <Stack.Screen options={{ title: 'Integrations' }} />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: space(4), paddingBottom: space(16) }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 19 }}>
            Keys are stored per-account and shared with the desktop app. Leave a
            field blank to disconnect that integration.
          </Text>

          {/* Jira */}
          <GroupLabel icon={Ticket}>Jira</GroupLabel>
          <FieldLabel>Site URL</FieldLabel>
          <Field value={jiraHost} onChangeText={setJiraHost} placeholder="https://your-team.atlassian.net" autoCapitalize="none" keyboardType="url" />
          <FieldLabel>Email</FieldLabel>
          <Field value={jiraEmail} onChangeText={setJiraEmail} placeholder="you@company.com" autoCapitalize="none" keyboardType="email-address" />
          <FieldLabel>API token</FieldLabel>
          <Field value={jiraToken} onChangeText={setJiraToken} placeholder="Atlassian API token" autoCapitalize="none" secureTextEntry />
          <FieldLabel>Default project key (optional)</FieldLabel>
          <Field value={jiraProject} onChangeText={setJiraProject} placeholder="e.g. HUD" autoCapitalize="characters" />

          {/* GitHub */}
          <GroupLabel icon={GitBranch}>GitHub</GroupLabel>
          <FieldLabel>Personal access token</FieldLabel>
          <Field value={githubToken} onChangeText={setGithubToken} placeholder="ghp_…" autoCapitalize="none" secureTextEntry />

          {/* AI */}
          <GroupLabel icon={Sparkles}>AI</GroupLabel>
          <FieldLabel>Provider</FieldLabel>
          <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(3) }}>
            {(['anthropic', 'openrouter'] as const).map((p) => {
              const on = aiProvider === p;
              return (
                <TouchableOpacity
                  key={p}
                  onPress={() => setAiProvider(p)}
                  activeOpacity={0.8}
                  style={{
                    flex: 1,
                    paddingVertical: space(2.5),
                    borderRadius: radius.sm,
                    borderWidth: 1,
                    alignItems: 'center',
                    backgroundColor: on ? colors.accentDim : colors.surface,
                    borderColor: on ? colors.accent : colors.border,
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: on ? colors.accentTx : colors.textMid }}>
                    {p === 'anthropic' ? 'Anthropic' : 'OpenRouter'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {aiProvider === 'anthropic' ? (
            <>
              <FieldLabel>Anthropic API key</FieldLabel>
              <Field value={anthropicKey} onChangeText={setAnthropicKey} placeholder="sk-ant-…" autoCapitalize="none" secureTextEntry />
              <FieldLabel>Model (optional)</FieldLabel>
              <Field value={anthropicModel} onChangeText={setAnthropicModel} placeholder="claude-sonnet-5" autoCapitalize="none" />
            </>
          ) : (
            <>
              <FieldLabel>OpenRouter API key</FieldLabel>
              <Field value={openrouterKey} onChangeText={setOpenrouterKey} placeholder="sk-or-…" autoCapitalize="none" secureTextEntry />
              <FieldLabel>Model (optional)</FieldLabel>
              <Field value={openrouterModel} onChangeText={setOpenrouterModel} placeholder="anthropic/claude-sonnet-5" autoCapitalize="none" />
            </>
          )}

          {/* Giphy */}
          <GroupLabel icon={Smile}>Giphy</GroupLabel>
          <FieldLabel>API key</FieldLabel>
          <Field value={giphyKey} onChangeText={setGiphyKey} placeholder="Giphy API key" autoCapitalize="none" secureTextEntry />

          <View style={{ marginTop: space(6) }}>
            <Button title="Save" onPress={save} loading={saving} disabled={loading} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
