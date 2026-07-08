import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Send, Sparkles } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { AiClient, type AiSettings, type ChatMessage, type ToolDef } from '@/lib/ai';
import { buildIntegrationTools } from '@/lib/ai-tools';
import { getAiSettings, getJiraSettings, getGithubSettings, type JiraSettings, type GithubSettings } from '@/lib/integrations';
import { getProfile, type Profile } from '@/lib/api';
import { Avatar, Markdown } from '@/components/ui';
import { colors, radius, space, tabBarClearance } from '@/theme';

// Huddle AI tab — design prototype screen 7. A direct conversation with the
// user's configured AI provider (Anthropic or OpenRouter, the same
// user_integrations.settings.ai the desktop AI panel and /ai slash command
// use). Conversation is in-memory per session — matching the desktop panel.

const SYSTEM_PROMPT =
  'You are Huddle AI, a helpful assistant inside the Huddle team chat app. Be concise and practical. Format with simple markdown (bold, code) only.';

// When Jira / GitHub tools are wired in, tell the model to use them instead of
// claiming it lacks access — that "I can't reach external tools" refusal is
// exactly what this prompt prevents.
const SYSTEM_PROMPT_WITH_TOOLS =
  SYSTEM_PROMPT +
  ' You have read access to the user\'s connected Jira and GitHub via tools. When the user names a Jira ticket key (e.g. "DAP-135"), an epic, a GitHub issue/PR, or asks anything you could answer by reading them, CALL the tools to fetch the real data first, then answer — never say you cannot access Jira or GitHub. If a tool needs a key or number you do not have, search first (jira_search_issues / github_search) to find it. Summaries should be tight bullet points.';

const SUGGESTIONS = [
  'Summarize the latest open Jira tickets',
  'What open PRs need review?',
  'Draft a ticket for a login bug',
];

type Turn = { role: 'user' | 'assistant'; text: string };

export default function AiScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [jira, setJira] = useState<JiraSettings | null>(null);
  const [github, setGithub] = useState<GithubSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [me, setMe] = useState<Profile | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  // Name of the integration tool currently running, surfaced in the
  // thinking footer so a slow Jira/GitHub fetch doesn't look stuck.
  const [toolNote, setToolNote] = useState<string | null>(null);
  const listRef = useRef<FlatList<Turn>>(null);
  // The composer sits above the floating glass tab bar when idle, but
  // docks to the keyboard while typing (the bar is covered by the
  // keyboard anyway, so the clearance would just leave a gap).
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!userId) return;
    // Guard against a fast account switch: ignore resolutions from the
    // previous userId so stale settings don't clobber the new account's.
    let active = true;
    getAiSettings(userId).then((s) => { if (active) { setSettings(s); setSettingsLoaded(true); } }).catch(() => { if (active) setSettingsLoaded(true); });
    getJiraSettings(userId).then((j) => { if (active) setJira(j); }).catch(() => {});
    getGithubSettings(userId).then((g) => { if (active) setGithub(g); }).catch(() => {});
    getProfile(userId).then((p) => { if (active) setMe(p); }).catch(() => {});
    return () => { active = false; };
  }, [userId]);

  const client = settings ? new AiClient(settings) : null;
  const configured = !!client?.isConfigured();
  // Jira/GitHub read tools, rebuilt when either integration's settings load.
  const tools: ToolDef[] = useMemo(() => buildIntegrationTools(jira, github), [jira, github]);
  // Base the label on the provider the client actually RESOLVED to, not the
  // stored provider — a desktop 'claude-code' account falls back to whichever
  // API key is present here, so the raw provider would mislabel it.
  const modelLabel = !configured || !client
    ? '—'
    : client.provider === 'openrouter'
      ? settings?.openrouterModel || 'openrouter'
      : settings?.anthropicModel || 'anthropic';

  const send = useCallback(async (raw?: string) => {
    const prompt = (raw ?? text).trim();
    if (!prompt || !client || !configured || thinking) return;
    setText('');
    const nextTurns: Turn[] = [...turns, { role: 'user', text: prompt }];
    setTurns(nextTurns);
    setThinking(true);
    setToolNote(null);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    try {
      const history: ChatMessage[] = nextTurns.map((t) => ({ role: t.role, content: t.text }));
      const result = await client.chat({
        system: tools.length ? SYSTEM_PROMPT_WITH_TOOLS : SYSTEM_PROMPT,
        messages: history,
        tools: tools.length ? tools : undefined,
        onToolUse: (name) => setToolNote(name),
      });
      setTurns((prev) => [...prev, { role: 'assistant', text: result.text || '(no response)' }]);
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: 'assistant', text: `Request failed: ${e?.message ?? String(e)}` }]);
    } finally {
      setThinking(false);
      setToolNote(null);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [text, turns, client, configured, thinking, tools]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.75), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
          <Avatar name="AI" ai size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Huddle AI</Text>
            <Text style={{ fontSize: 11.5, color: colors.textDim }}>
              {configured
                ? (tools.length ? 'Ask anything — reads your Jira & GitHub' : 'Ask anything — answers stay on this device')
                : 'Not configured'}
            </Text>
          </View>
          <Text style={{ fontSize: 10.5, color: colors.textFaint, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' }} numberOfLines={1}>
            {modelLabel}
          </Text>
        </View>

        {!settingsLoaded ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : !configured ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8) }}>
            <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, marginBottom: space(3) }}>
              <Sparkles size={24} color={colors.textFaint} />
            </View>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 4, textAlign: 'center' }}>
              Connect an AI provider
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
              Add an Anthropic or OpenRouter API key in the desktop app&apos;s Settings panel — mobile reads the same account.
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={turns}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={{ padding: space(4), gap: space(4), flexGrow: 1 }}
            ListEmptyComponent={
              <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: space(2) }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 4 }}>Ask Huddle AI</Text>
                <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 19 }}>
                  {tools.length
                    ? 'Summaries, drafts, quick answers — grounded in your Jira & GitHub. Try a suggestion below.'
                    : 'Drafts, summaries, quick answers. Try a suggestion below to start.'}
                </Text>
              </View>
            }
            ListFooterComponent={
              thinking ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.75) }}>
                  <Avatar name="AI" ai size={30} />
                  <ActivityIndicator color={colors.textDim} size="small" />
                  {toolNote ? (
                    <Text style={{ fontSize: 12, color: colors.textDim }}>{`reading ${toolNote.replace(/_/g, ' ')}…`}</Text>
                  ) : null}
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <View style={{ flexDirection: 'row', gap: space(2.75) }}>
                {item.role === 'assistant'
                  ? <Avatar name="AI" ai size={30} />
                  : <Avatar name={me?.name ?? 'You'} color={me?.color} uri={me?.avatar_url} size={30} />}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 13.5, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
                    {item.role === 'assistant' ? 'Huddle AI' : 'You'}
                  </Text>
                  <Markdown body={item.text} />
                </View>
              </View>
            )}
          />
        )}

        {/* Suggestions + composer */}
        {configured && (
          <View style={{ paddingHorizontal: space(3.5), paddingBottom: keyboardOpen ? space(2.5) : tabBarClearance(insets.bottom) }}>
            {turns.length === 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: space(2.75) }}>
                {SUGGESTIONS.map((s) => (
                  <TouchableOpacity
                    key={s}
                    onPress={() => send(s)}
                    activeOpacity={0.75}
                    style={{ paddingHorizontal: space(3), paddingVertical: space(1.75), borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}
                  >
                    <Text style={{ fontSize: 12.5, color: colors.textMid }}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space(2.5),
                borderWidth: 1,
                borderColor: text ? colors.accent : colors.border,
                borderRadius: radius.lg,
                backgroundColor: colors.surface,
                paddingLeft: space(3.5),
                paddingRight: space(2),
                paddingVertical: space(2),
              }}
            >
              <Sparkles size={18} color={colors.accentTx} />
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Ask anything…"
                placeholderTextColor={colors.textFaint}
                multiline
                style={{ flex: 1, color: colors.text, fontSize: 15, maxHeight: 100, paddingVertical: 2 }}
              />
              <TouchableOpacity
                onPress={() => send()}
                disabled={!text.trim() || thinking}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: text.trim() && !thinking ? colors.accent : colors.surfaceAlt,
                }}
              >
                <Send size={16} color={text.trim() && !thinking ? colors.bg : colors.textDim} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
