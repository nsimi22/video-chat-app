import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { Paperclip } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import {
  deleteMessage,
  editMessage,
  fetchThread,
  listTeamProfiles,
  sendMessage,
  setPin,
  toggleReaction,
  type Message,
  type Profile,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { AiMessageCard, Avatar, Markdown } from '@/components/ui';
import { MessageUnfurls } from '@/components/Unfurl';
import { ImageLightbox } from '@/components/ImageLightbox';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { PollCard } from '@/components/PollCard';
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
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  // Long-pressed message → action sheet (react / copy / pin / edit / delete),
  // same as the channel view. No "Reply in thread" here — you can't nest a
  // thread inside a thread, so onOpenThread is intentionally not passed.
  const [sheetMessage, setSheetMessage] = useState<Message | null>(null);
  // The reply currently being edited, or null for normal compose.
  const [editing, setEditing] = useState<Message | null>(null);
  const inputRef = useRef<TextInput>(null);
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
  // postgres_changes is at-most-once and mobile tears the WS down on
  // background, so re-SUBSCRIBED and AppState 'active' both refetch the
  // whole thread (fetchThread is cheap and load() replaces wholesale) —
  // the same gap-fill discipline as useChannelMessages.
  useEffect(() => {
    if (!teamId) return;
    let firstSubscribe = true;
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
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        if (firstSubscribe) {
          firstSubscribe = false;
          return;
        }
        load(); // reconnect after a transient drop — fill any gap
      });
    const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') load();
    });
    return () => {
      appStateSub.remove();
      supabase.removeChannel(sub);
    };
  }, [teamId, parentId, load]);

  // Drop out of edit mode if the message being edited is deleted — locally or
  // by another user over realtime — so Save can't fire editMessage() against a
  // row that no longer exists.
  useEffect(() => {
    if (editing && !items.some((m) => m.id === editing.id)) {
      setEditing(null);
      setText('');
    }
  }, [editing, items]);

  const profileFor = useCallback((uid: string) => roster.find((p) => p.user_id === uid), [roster]);
  const mentionNames = useMemo(() => roster.map((p) => p.name).filter((n): n is string => !!n), [roster]);

  const parent = items.find((m) => m.id === String(parentId)) ?? null;
  const replies = items.filter((m) => m.id !== String(parentId));

  const startEditing = (m: Message) => {
    setEditing(m);
    setText(m.body ?? '');
    setTimeout(() => inputRef.current?.focus(), 50);
  };
  const cancelEditing = () => {
    setEditing(null);
    setText('');
  };
  const saveEdit = async () => {
    if (!editing) return;
    const body = text.trim();
    if (!body) {
      Alert.alert('Empty message', 'An edited message can’t be empty. Delete it instead to remove it.');
      return;
    }
    if (body === (editing.body ?? '').trim()) {
      cancelEditing();
      return;
    }
    setSending(true);
    try {
      await editMessage(editing.id, body);
      cancelEditing();
    } catch (e: any) {
      Alert.alert('Could not save edit', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (editing) return saveEdit();
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
      <TouchableOpacity
        activeOpacity={1}
        onLongPress={() => setSheetMessage(m)}
        delayLongPress={350}
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
          {m.meta?.poll ? (
            // Desktop posts polls into threads too — render the votable
            // card here, not the "📊 Poll: …" fallback body.
            <PollCard message={m} meId={userId} roster={roster} />
          ) : isAi ? (
            <AiMessageCard body={m.body} mentionNames={mentionNames} viaName={p?.name} model={m.ai_model}>
              {!!m.body && <MessageUnfurls body={m.body} viewerId={userId} />}
            </AiMessageCard>
          ) : (
            <>
              {!!m.body && <Markdown body={m.body} mentionNames={mentionNames} />}
              {m.edited_ts ? <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>(edited)</Text> : null}
              {!!m.body && <MessageUnfurls body={m.body} viewerId={userId} />}
            </>
          )}
          {(m.attachments ?? []).map((a, i) => {
            const mime = a.type ?? a.contentType ?? '';
            return mime.startsWith('image/') ? (
              // Tap an image attachment to open the full-screen lightbox.
              <TouchableOpacity
                key={i}
                activeOpacity={0.85}
                onPress={() => setLightboxUri(a.url)}
                accessibilityLabel={`Open image ${a.name ?? 'attachment'}`}
              >
                <Image source={{ uri: a.url }} style={{ width: 220, height: 160, borderRadius: radius.sm, marginTop: space(1.5), backgroundColor: colors.surfaceAlt }} resizeMode="cover" />
              </TouchableOpacity>
            ) : (
              // Non-image attachment (zip, pdf, doc, …). Tap to open the public
              // URL in the device browser — same behaviour as the channel screen.
              <TouchableOpacity
                key={i}
                activeOpacity={0.7}
                onPress={() =>
                  Linking.openURL(a.url).catch(() =>
                    Alert.alert('Could not open', a.name ?? 'attachment')
                  )
                }
                style={{ flexDirection: 'row', alignItems: 'center', marginTop: space(1) }}
                accessibilityLabel={`Open attachment ${a.name ?? ''}`}
              >
                <Paperclip size={14} color={colors.accent} style={{ marginRight: 6 }} />
                <Text style={{ color: colors.accent }}>{a.name}</Text>
              </TouchableOpacity>
            );
          })}
          {m.reactions && Object.keys(m.reactions).length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space(1.5) }}>
              {Object.entries(m.reactions).map(([emoji, users]) => (
                <TouchableOpacity
                  key={emoji}
                  onPress={() => toggleReaction(m.id, emoji, userId!).catch(() => {})}
                  style={{ flexDirection: 'row', backgroundColor: (users as string[]).includes(userId ?? '') ? colors.accent : colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 }}
                >
                  <Text style={{ color: colors.text, fontSize: 12 }}>{emoji} {(users as string[]).length}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </TouchableOpacity>
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
      {editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: 2 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, flex: 1 }}>Editing message</Text>
          <TouchableOpacity onPress={cancelEditing} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2.5), borderTopWidth: 1, borderTopColor: colors.border, gap: space(2) }}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          placeholder={editing ? 'Edit message' : 'Reply to thread…'}
          placeholderTextColor={colors.textDim}
          multiline
          style={{
            flex: 1,
            color: colors.text,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: text || editing ? colors.accent : colors.border,
            paddingHorizontal: space(3),
            paddingVertical: space(2.5),
            maxHeight: 120,
            fontSize: 15,
          }}
        />
        <TouchableOpacity onPress={send} disabled={sending || !text.trim()} style={{ paddingBottom: space(2.5), opacity: sending || !text.trim() ? 0.4 : 1 }}>
          <Text style={{ color: colors.accentTx, fontWeight: '600', fontSize: 15 }}>{editing ? 'Save' : 'Send'}</Text>
        </TouchableOpacity>
      </View>
      <MessageActionSheet
        message={sheetMessage}
        isMine={sheetMessage?.author_id === userId}
        onClose={() => setSheetMessage(null)}
        onReact={(emoji) => {
          if (sheetMessage) toggleReaction(sheetMessage.id, emoji, userId!).catch(() => {});
        }}
        onCopy={() => {
          if (sheetMessage?.body) Clipboard.setStringAsync(sheetMessage.body).catch(() => {});
        }}
        onTogglePin={() => {
          if (sheetMessage) setPin(sheetMessage.id, !sheetMessage.pinned_at).catch(() => {});
        }}
        onEdit={() => {
          if (sheetMessage) startEditing(sheetMessage);
        }}
        onDelete={() => {
          if (sheetMessage) deleteMessage(sheetMessage.id).catch(() => {});
        }}
      />
      <ImageLightbox uri={lightboxUri} onClose={() => setLightboxUri(null)} />
    </KeyboardAvoidingView>
  );
}
