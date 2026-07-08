import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Stack } from 'expo-router';
import { GitBranch, Smile, Sparkles, Ticket } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { loadAllIntegrationSettings, updateIntegrationSettings } from '@/lib/integrations';
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

// One flat form object instead of a useState per field — every field is an
// editable string except the AI provider toggle.
type FormState = {
  jiraHost: string;
  jiraEmail: string;
  jiraToken: string;
  jiraProject: string;
  githubToken: string;
  aiProvider: AiProvider;
  anthropicKey: string;
  anthropicModel: string;
  openrouterKey: string;
  openrouterModel: string;
  giphyKey: string;
};

const EMPTY_FORM: FormState = {
  jiraHost: '',
  jiraEmail: '',
  jiraToken: '',
  jiraProject: '',
  githubToken: '',
  aiProvider: 'anthropic',
  anthropicKey: '',
  anthropicModel: '',
  openrouterKey: '',
  openrouterModel: '',
  giphyKey: '',
};

export default function IntegrationsScreen() {
  const { userId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const setField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError(false);
    try {
      // loadAllIntegrationSettings surfaces read errors (the cached getters
      // swallow them → null), so a network failure lands in catch below and
      // blocks Save instead of silently blanking the form and clobbering keys.
      const { jira, github, ai, giphy } = await loadAllIntegrationSettings(userId);
      setForm({
        jiraHost: jira?.host ?? '',
        jiraEmail: jira?.email ?? '',
        jiraToken: jira?.token ?? '',
        jiraProject: jira?.defaultProject ?? '',
        githubToken: github?.token ?? '',
        aiProvider: ai?.provider === 'openrouter' ? 'openrouter' : 'anthropic',
        anthropicKey: ai?.anthropicKey ?? '',
        anthropicModel: ai?.anthropicModel ?? '',
        openrouterKey: ai?.openrouterKey ?? '',
        openrouterModel: ai?.openrouterModel ?? '',
        giphyKey: giphy?.key ?? '',
      });
    } catch {
      setLoadError(true);
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
          host: form.jiraHost.trim(),
          email: form.jiraEmail.trim(),
          token: form.jiraToken.trim(),
          defaultProject: form.jiraProject.trim(),
        },
        github: { token: form.githubToken.trim() },
        ai: {
          provider: form.aiProvider,
          anthropicKey: form.anthropicKey.trim(),
          anthropicModel: form.anthropicModel.trim(),
          openrouterKey: form.openrouterKey.trim(),
          openrouterModel: form.openrouterModel.trim(),
        },
        giphy: { key: form.giphyKey.trim() },
      });
      Alert.alert('Saved', 'Your integration keys are updated on this account.');
    } catch (err) {
      Alert.alert('Couldn’t save', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [userId, form]);

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Integrations' }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Integrations' }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: space(4) }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: space(2), textAlign: 'center' }}>
            Couldn’t load integrations
          </Text>
          <Text style={{ color: colors.textDim, textAlign: 'center', marginBottom: space(4), lineHeight: 19 }}>
            Check your connection and try again. Nothing is saved until it loads, so your keys stay safe.
          </Text>
          <View style={{ alignSelf: 'stretch' }}>
            <Button title="Retry" onPress={load} />
          </View>
        </View>
      </>
    );
  }

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
          <Field value={form.jiraHost} onChangeText={(v) => setField('jiraHost', v)} placeholder="https://your-team.atlassian.net" autoCapitalize="none" keyboardType="url" />
          <FieldLabel>Email</FieldLabel>
          <Field value={form.jiraEmail} onChangeText={(v) => setField('jiraEmail', v)} placeholder="you@company.com" autoCapitalize="none" keyboardType="email-address" />
          <FieldLabel>API token</FieldLabel>
          <Field value={form.jiraToken} onChangeText={(v) => setField('jiraToken', v)} placeholder="Atlassian API token" autoCapitalize="none" secureTextEntry />
          <FieldLabel>Default project key (optional)</FieldLabel>
          <Field value={form.jiraProject} onChangeText={(v) => setField('jiraProject', v)} placeholder="e.g. HUD" autoCapitalize="characters" />

          {/* GitHub */}
          <GroupLabel icon={GitBranch}>GitHub</GroupLabel>
          <FieldLabel>Personal access token</FieldLabel>
          <Field value={form.githubToken} onChangeText={(v) => setField('githubToken', v)} placeholder="ghp_…" autoCapitalize="none" secureTextEntry />

          {/* AI */}
          <GroupLabel icon={Sparkles}>AI</GroupLabel>
          <FieldLabel>Provider</FieldLabel>
          <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(3) }}>
            {(['anthropic', 'openrouter'] as const).map((p) => {
              const on = form.aiProvider === p;
              return (
                <TouchableOpacity
                  key={p}
                  onPress={() => setField('aiProvider', p)}
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
          {form.aiProvider === 'anthropic' ? (
            <>
              <FieldLabel>Anthropic API key</FieldLabel>
              <Field value={form.anthropicKey} onChangeText={(v) => setField('anthropicKey', v)} placeholder="sk-ant-…" autoCapitalize="none" secureTextEntry />
              <FieldLabel>Model (optional)</FieldLabel>
              <Field value={form.anthropicModel} onChangeText={(v) => setField('anthropicModel', v)} placeholder="claude-sonnet-5" autoCapitalize="none" />
            </>
          ) : (
            <>
              <FieldLabel>OpenRouter API key</FieldLabel>
              <Field value={form.openrouterKey} onChangeText={(v) => setField('openrouterKey', v)} placeholder="sk-or-…" autoCapitalize="none" secureTextEntry />
              <FieldLabel>Model (optional)</FieldLabel>
              <Field value={form.openrouterModel} onChangeText={(v) => setField('openrouterModel', v)} placeholder="anthropic/claude-sonnet-5" autoCapitalize="none" />
            </>
          )}

          {/* Giphy */}
          <GroupLabel icon={Smile}>Giphy</GroupLabel>
          <FieldLabel>API key</FieldLabel>
          <Field value={form.giphyKey} onChangeText={(v) => setField('giphyKey', v)} placeholder="Giphy API key" autoCapitalize="none" secureTextEntry />

          <View style={{ marginTop: space(6) }}>
            <Button title="Save" onPress={save} loading={saving} disabled={loading} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
