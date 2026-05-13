import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useChannelMessages } from '@/hooks/useChannelMessages';
import {
  deleteMessage,
  extractMentions,
  listTeamProfiles,
  sendMessage,
  setPin,
  toggleReaction,
  uploadAttachment,
  type Attachment,
  type Message,
  type Profile,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { teamTopic } from '@/lib/topics';
import { Avatar, Markdown } from '@/components/ui';
import { MessageUnfurls } from '@/components/Unfurl';
import { colors, radius, space } from '@/theme';

const QUICK = ['👍', '✅', '🎉', '❤️', '😂', '👀'];

export default function ChannelScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam, userId } = useAuth();
  const teamId = activeTeam?.id ?? '';
  const { messages, loading, hasMore, loadOlder } = useChannelMessages(teamId, String(channelId));
  const [roster, setRoster] = useState<Profile[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const listRef = useRef<FlatList<Message>>(null);
  const teamChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastTypingSent = useRef(0);
  const lastTailId = useRef<string | null>(null);

  useEffect(() => {
    if (teamId) listTeamProfiles(teamId).then(setRoster).catch(() => {});
  }, [teamId]);

  // Typing indicator over the team:<id> broadcast topic (same as desktop).
  // The topic is RLS-gated, so the channel must be marked `private`.
  useEffect(() => {
    if (!teamId) return;
    let active = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const ch = supabase.channel(teamTopic(teamId), { config: { broadcast: { self: false }, private: true } });
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!active || !payload || payload.channelId !== String(channelId) || payload.from === userId) return;
      setTypingNames((prev) => Array.from(new Set([...prev, payload.name])));
      const t = setTimeout(() => {
        timers.delete(t);
        if (active) setTypingNames((prev) => prev.filter((n) => n !== payload.name));
      }, 3500);
      timers.add(t);
    });
    ch.subscribe();
    teamChannelRef.current = ch;
    return () => {
      active = false;
      timers.forEach(clearTimeout);
      supabase.removeChannel(ch);
      teamChannelRef.current = null;
    };
  }, [teamId, channelId, userId]);

  const profileFor = useCallback((uid: string) => roster.find((p) => p.user_id === uid), [roster]);

  const onChangeText = (t: string) => {
    setText(t);
    const now = Date.now();
    if (now - lastTypingSent.current > 1500 && teamChannelRef.current) {
      lastTypingSent.current = now;
      const me = profileFor(userId ?? '');
      teamChannelRef.current.send({
        type: 'broadcast',
        event: 'typing',
        payload: { from: userId, name: me?.name ?? 'Someone', channelId: String(channelId) },
      });
    }
  };

  const doSend = async (attachments: Attachment[] = []) => {
    const body = text.trim();
    if (!body && !attachments.length) return;
    setSending(true);
    try {
      await sendMessage({
        teamId,
        channelId: String(channelId),
        authorId: userId!,
        body,
        attachments,
        mentions: extractMentions(body, roster),
      });
      setText('');
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const attachImage = async () => {
    // Images only for the MVP: uploads read the whole file into memory, so
    // videos / huge assets would risk OOM. Broaden once we have resumable uploads.
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    setSending(true);
    try {
      const att = await uploadAttachment(userId!, {
        uri: a.uri,
        name: a.fileName ?? `upload-${Date.now()}.${(a.uri.split('.').pop() ?? 'jpg')}`,
        mime: a.mimeType ?? 'application/octet-stream',
      });
      await doSend([att]);
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const onLongPressMessage = (m: Message) => {
    const isMine = m.author_id === userId;
    // Lightweight action sheet via Alert for portability.
    Alert.alert('Message', undefined, [
      ...QUICK.map((e) => ({ text: e, onPress: () => toggleReaction(m.id, e, userId!).catch(() => {}) })),
      { text: m.pinned_at ? 'Unpin' : 'Pin', onPress: () => setPin(m.id, !m.pinned_at).catch(() => {}) },
      ...(isMine ? [{ text: 'Delete', style: 'destructive' as const, onPress: () => deleteMessage(m.id).catch(() => {}) }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const headerTitle = useMemo(() => (name ? String(name) : '#channel'), [name]);

  if (!activeTeam) return null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={88}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push({ pathname: '/(app)/call/[id]', params: { id: String(channelId), name: headerTitle } })}>
              <Text style={{ color: colors.accent, fontSize: 15 }}>Call</Text>
            </TouchableOpacity>
          ),
        }}
      />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingVertical: space(3) }}
          onContentSizeChange={() => {
            // Stick to the bottom on initial load and when a new message
            // arrives at the tail — but NOT when older messages are prepended
            // (that doesn't change the last id), so "Load earlier" doesn't yank.
            const tail = messages[messages.length - 1]?.id ?? null;
            if (tail !== lastTailId.current) {
              lastTailId.current = tail;
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          ListHeaderComponent={
            hasMore ? (
              <TouchableOpacity onPress={loadOlder} style={{ padding: space(3), alignItems: 'center' }}>
                <Text style={{ color: colors.textDim }}>Load earlier messages</Text>
              </TouchableOpacity>
            ) : null
          }
          renderItem={({ item, index }) => {
            const prev = messages[index - 1];
            // AI messages never group — they should always show the robot
            // avatar + "AI · via <user>" header so it's clear which lines are
            // model output (vs the human's own messages, even when they share
            // an author_id).
            const isAi = !!item.ai_generated;
            const prevIsAi = !!prev?.ai_generated;
            const grouped = !isAi && !prevIsAi && prev && prev.author_id === item.author_id
              && new Date(item.ts).getTime() - new Date(prev.ts).getTime() < 5 * 60_000;
            const p = profileFor(item.author_id);
            return (
              <TouchableOpacity activeOpacity={0.7} onLongPress={() => onLongPressMessage(item)} style={{ flexDirection: 'row', paddingHorizontal: space(3), paddingTop: grouped ? 2 : space(2.5) }}>
                <View style={{ width: 36, marginRight: space(2.5) }}>
                  {!grouped && (
                    isAi
                      ? <Avatar name="AI" ai size={36} />
                      : <Avatar name={p?.name ?? '?'} color={p?.color} size={36} uri={p?.avatar_url} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  {!grouped && (
                    <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 2 }}>
                      {isAi ? 'AI' : (p?.name ?? 'Unknown')}{'  '}
                      <Text style={{ color: colors.textDim, fontWeight: '400', fontSize: 11 }}>
                        {isAi && p ? `via ${p.name} · ` : ''}
                        {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                      {item.pinned_at ? '  📌' : ''}
                    </Text>
                  )}
                  {!!item.body && (
                    <View>
                      <Markdown body={item.body} />
                      {item.edited_ts ? <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>(edited)</Text> : null}
                    </View>
                  )}
                  {!!item.body && <MessageUnfurls body={item.body} viewerId={userId} />}
                  {(item.attachments ?? []).map((a, i) => (
                    a.type?.startsWith('image/') ? (
                      <Image key={i} source={{ uri: a.url }} style={{ width: 220, height: 160, borderRadius: radius.sm, marginTop: space(1.5), backgroundColor: colors.surfaceAlt }} resizeMode="cover" />
                    ) : (
                      <Text key={i} style={{ color: colors.accent, marginTop: space(1) }}>📎 {a.name}</Text>
                    )
                  ))}
                  {item.reactions && Object.keys(item.reactions).length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space(1.5) }}>
                      {Object.entries(item.reactions).map(([emoji, users]) => (
                        <TouchableOpacity key={emoji} onPress={() => toggleReaction(item.id, emoji, userId!).catch(() => {})} style={{ flexDirection: 'row', backgroundColor: (users as string[]).includes(userId ?? '') ? colors.accent : colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 }}>
                          <Text style={{ color: colors.text, fontSize: 12 }}>{emoji} {(users as string[]).length}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
      {typingNames.length > 0 && (
        <Text style={{ color: colors.textDim, fontSize: 12, paddingHorizontal: space(4), paddingBottom: 2 }}>
          {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…
        </Text>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2.5), borderTopWidth: 1, borderTopColor: colors.border, gap: space(2) }}>
        <TouchableOpacity onPress={attachImage} style={{ paddingBottom: space(2.5) }}>
          <Text style={{ color: colors.textDim, fontSize: 22 }}>＋</Text>
        </TouchableOpacity>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          placeholder={`Message ${headerTitle}`}
          placeholderTextColor={colors.textDim}
          multiline
          style={{ flex: 1, color: colors.text, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space(3), paddingVertical: space(2.5), maxHeight: 120, fontSize: 15 }}
        />
        <TouchableOpacity onPress={() => doSend()} disabled={sending || (!text.trim())} style={{ paddingBottom: space(2.5), opacity: sending || !text.trim() ? 0.4 : 1 }}>
          <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 15 }}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
