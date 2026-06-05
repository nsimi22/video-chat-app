import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { fetchThread, listTeamProfiles, sendMessage, type Message, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { AiMessageCard, Avatar, Markdown } from '@/components/ui';
import { MessageUnfurls } from '@/components/Unfurl';
import { colors, radius, space } from '@/theme';

// Thread view — design prototype screen 3. Route id is the parent message
// id; replies are messages with parent_id = id (initial schema). The
// channel's message hook skips replies, so this screen owns its own fetch
// + realtime subscription.
export default function ThreadScreen() {
  const { id: parentId, channelId, name } = useLocalSearchParams<{ id: string; channelId?: string; name?: string }>();
  const { activeTeam, userId } = useAuth();
  const teamId = activeTeam?.id ?? '';
  const [items, setItems] = useState<Message[]>([]);
  const [roster, setRoster] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    if (teamId) listTeamProfiles(teamId).then(setRoster).catch(() => {});
  }, [teamId]);

  const load = useCallback(async () => {
    try {
      const rows = await fetchThread(String(parentId));
      setItems(rows);
    } catch (e) {
      console.warn('fetchThread failed', e);
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => { load(); }, [load]);

  // Live replies. The team-wide filter mirrors useChannelMessages — channel
  // id alone isn't unique across teams; narrow to this thread client-side.
  useEffect(() => {
    if (!teamId) return;
    const sub = supabase
      .channel(`db:messages:thread:${parentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const m = payload.new as Message;
            if (m.parent_id !== String(parentId)) return;
            setItems((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          } else if (payload.eventType === 'UPDATE') {
            const m = payload.new as Message;
            setItems((prev) => prev.map((x) => (x.id === m.id ? m : x)));
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string };
            setItems((prev) => prev.filter((x) => x.id !== old.id));
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [teamId, parentId]);

  const profileFor = useCallback((uid: string) => roster.find((p) => p.user_id === uid), [roster]);
  const mentionNames = useMemo(() => roster.map((p) => p.name).filter((n): n is string => !!n), [roster]);

  const parent = items.find((m) => m.id === String(parentId)) ?? null;
  const replies = items.filter((m) => m.id !== String(parentId));

  const send = async () => {
    const body = text.trim();
    if (!body || !userId || !channelId) return;
    setSending(true);
    setText('');
    try {
      await sendMessage({
        teamId,
        channelId: String(channelId),
        authorId: userId,
        body,
        parentId: String(parentId),
        mentions: [],
      });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e: any) {
      setText((curr) => (curr === '' ? body : curr));
      Alert.alert('Could not send', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const headerHeight = useHeaderHeight();

  const renderMessage = (m: Message, isParent: boolean) => {
    const p = profileFor(m.author_id);
    const isAi = !!m.ai_generated;
    return (
      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: space(3.5),
          paddingVertical: space(2),
          ...(isParent ? { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: space(3.5) } : null),
        }}
      >
        <View style={{ width: isParent ? 36 : 32, marginRight: space(2.5) }}>
          {isAi
            ? <Avatar name="AI" ai size={isParent ? 36 : 32} />
            : <Avatar name={p?.name ?? '?'} color={p?.color} size={isParent ? 36 : 32} uri={p?.avatar_url} />}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>
              {isAi ? 'Huddle AI' : (p?.name ?? 'Unknown')}{'  '}
              <Text style={{ color: colors.textDim, fontWeight: '400', fontSize: 11 }}>
                {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </Text>
          </View>
          {isAi ? (
            <AiMessageCard body={m.body} mentionNames={mentionNames} viaName={p?.name} model={m.ai_model}>
              {!!m.body && <MessageUnfurls body={m.body} viewerId={userId} />}
            </AiMessageCard>
          ) : (
            <>
              {!!m.body && <Markdown body={m.body} mentionNames={mentionNames} />}
              {!!m.body && <MessageUnfurls body={m.body} viewerId={userId} />}
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          title: 'Thread',
          headerBackButtonDisplayMode: 'minimal' as const,
          headerBackTitle: '',
        }}
      />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={replies}
          keyExtractor={(m) => m.id}
          extraData={roster}
          contentContainerStyle={{ paddingVertical: space(2) }}
          ListHeaderComponent={
            <View>
              {name ? (
                <Text style={{ color: colors.textDim, fontSize: 12, paddingHorizontal: space(3.5), paddingBottom: space(1.5) }}>
                  {String(name)}
                </Text>
              ) : null}
              {parent ? renderMessage(parent, true) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(1) }}>
                <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textFaint }}>
                  {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.borderSoft }} />
              </View>
            </View>
          }
          renderItem={({ item }) => renderMessage(item, false)}
        />
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2.5), borderTopWidth: 1, borderTopColor: colors.border, gap: space(2) }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Reply to thread…"
          placeholderTextColor={colors.textDim}
          multiline
          style={{
            flex: 1,
            color: colors.text,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: text ? colors.accent : colors.border,
            paddingHorizontal: space(3),
            paddingVertical: space(2.5),
            maxHeight: 120,
            fontSize: 15,
          }}
        />
        <TouchableOpacity onPress={send} disabled={sending || !text.trim()} style={{ paddingBottom: space(2.5), opacity: sending || !text.trim() ? 0.4 : 1 }}>
          <Text style={{ color: colors.accentTx, fontWeight: '600', fontSize: 15 }}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
