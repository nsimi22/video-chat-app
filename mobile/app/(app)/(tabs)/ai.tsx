import { useCallback, useEffect, useRef, useState } from 'react';
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
import { AiClient, type AiSettings, type ChatMessage } from '@/lib/ai';
import { getAiSettings } from '@/lib/integrations';
import { getProfile, type Profile } from '@/lib/api';
import { Avatar, Markdown } from '@/components/ui';
import { colors, radius, space, tabBarClearance } from '@/theme';

// Huddle AI tab — design prototype screen 7. A direct conversation with the
// user's configured AI provider (Anthropic or OpenRouter, the same
// user_integrations.settings.ai the desktop AI panel and /ai slash command
// use). Conversation is in-memory per session — matching the desktop panel.

const SYSTEM_PROMPT =
  'You are Huddle AI, a helpful assistant inside the Huddle team chat app. Be concise and practical. Format with simple markdown (bold, code) only.';

const SUGGESTIONS = [
  'Summarize what a daily stand-up should cover',
  'Draft a ticket for a login bug',
  'Write a friendly release announcement',
];

type Turn = { role: 'user' | 'assistant'; text: string };

export default function AiScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [me, setMe] = useState<Profile | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
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
    getAiSettings(userId).then((s) => { setSettings(s); setSettingsLoaded(true); }).catch(() => setSettingsLoaded(true));
    getProfile(userId).then(setMe).catch(() => {});
  }, [userId]);

  const client = settings ? new AiClient(settings) : null;
  const configured = !!client?.isConfigured();
  const modelLabel = settings?.provider === 'openrouter'
    ? settings.openrouterModel || 'openrouter'
    : settings?.anthropicModel || (configured ? 'anthropic' : '—');

  const send = useCallback(async (raw?: string) => {
    const prompt = (raw ?? text).trim();
    if (!prompt || !client || !configured || thinking) return;
    setText('');
    const nextTurns: Turn[] = [...turns, { role: 'user', text: prompt }];
    setTurns(nextTurns);
    setThinking(true);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    try {
      const history: ChatMessage[] = nextTurns.map((t) => ({ role: t.role, content: t.text }));
      const result = await client.chat({ system: SYSTEM_PROMPT, messages: history });
      setTurns((prev) => [...prev, { role: 'assistant', text: result.text || '(no response)' }]);
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: 'assistant', text: `Request failed: ${e?.message ?? String(e)}` }]);
    } finally {
      setThinking(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [text, turns, client, configured, thinking]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.75), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
          <Avatar name="AI" ai size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>Huddle AI</Text>
            <Text style={{ fontSize: 11.5, color: colors.textDim }}>
              {configured ? 'Ask anything — answers stay on this device' : 'Not configured'}
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
              Add an Anthropic or OpenRouter API key in the desktop app's Settings panel — mobile reads the same account.
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
                  Drafts, summaries, quick answers. Try a suggestion below to start.
                </Text>
              </View>
            }
            ListFooterComponent={
              thinking ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.75) }}>
                  <Avatar name="AI" ai size={30} />
                  <ActivityIndicator color={colors.textDim} size="small" />
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
