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
import { Stack, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { Pin, Paperclip, Plus } from 'lucide-react-native';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { SlashSuggest } from '@/components/SlashSuggest';
import { GifPicker } from '@/components/GifPicker';
import { ComposerMenu } from '@/components/ComposerMenu';
import { EmojiPanel } from '@/components/EmojiPanel';
import { runSlash, type SlashCommand } from '@/lib/slash';
import { getGiphyKey } from '@/lib/integrations';
import type { GiphyResult } from '@/lib/giphy';
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

export default function ChannelScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam, userId } = useAuth();
  const teamId = activeTeam?.id ?? '';
  const { messages, loading, hasMore, loadOlder } = useChannelMessages(teamId, String(channelId));
  const [roster, setRoster] = useState<Profile[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [sheetMessage, setSheetMessage] = useState<Message | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [giphyKey, setGiphyKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Track TextInput selection so emoji insert lands at the cursor instead
  // of always appending — matters when the user has typed text and tapped
  // back into the middle of it.
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const listRef = useRef<FlatList<Message>>(null);
  const teamChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastTypingSent = useRef(0);
  const lastTailId = useRef<string | null>(null);

  useEffect(() => {
    if (teamId) listTeamProfiles(teamId).then(setRoster).catch(() => {});
  }, [teamId]);

  useEffect(() => {
    if (userId) getGiphyKey(userId).then(setGiphyKey).catch(() => {});
  }, [userId]);

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
      // Slash commands only fire when there are no attachments — an image
      // upload that happens to be captioned with "/me" should be a normal
      // message, not a /me command on the caption.
      if (!attachments.length && body.startsWith('/')) {
        const consumed = await runSlash(body, {
          teamId,
          channelId: String(channelId),
          userId: userId!,
          roster,
          recentMessages: messages,
          onAiThinking: setAiThinking,
          onError: (msg) => Alert.alert('Slash command', msg),
        });
        if (consumed) {
          setText('');
          return;
        }
      }
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

  const onSelectSlash = (cmd: SlashCommand) => setText(`/${cmd.name} `);

  const insertEmoji = (emoji: string) => {
    const { start, end } = selection;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const next = `${before}${emoji}${after}`;
    setText(next);
    const cursor = start + emoji.length;
    setSelection({ start: cursor, end: cursor });
  };

  // Posting a Giphy GIF: forward the hosted URL as an `image/gif` attachment.
  // No upload to Supabase Storage — Giphy hosts the file. The receiver-side
  // image render (channel/[id].tsx attachment loop) picks it up via the
  // `type`/`contentType` MIME check we added earlier.
  const onSelectGif = (gif: GiphyResult) => {
    setGifPickerOpen(false);
    sendMessage({
      teamId,
      channelId: String(channelId),
      authorId: userId!,
      body: '',
      attachments: [
        {
          url: gif.url,
          name: (gif.title || 'giphy.gif').slice(0, 80),
          size: gif.size || undefined,
          type: 'image/gif',
          contentType: 'image/gif',
        },
      ],
    }).catch((e: any) => Alert.alert('Could not send', e?.message ?? String(e)));
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

  const onLongPressMessage = (m: Message) => setSheetMessage(m);

  const headerTitle = useMemo(() => (name ? String(name) : '#channel'), [name]);

  if (!activeTeam) return null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={88}>
      <Stack.Screen
        options={{
          title: headerTitle,
          // Call button hidden for v1 — mobile<->mobile calls require a
          // RN-compatible LiveKit polyfill stack we haven't landed. Edge
          // function + call/[id].tsx + LiveKit deps remain in place for
          // future re-enable; just restore the headerRight TouchableOpacity.
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
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                      <Text style={{ color: colors.text, fontWeight: '600' }}>
                        {isAi ? 'AI' : (p?.name ?? 'Unknown')}{'  '}
                        <Text style={{ color: colors.textDim, fontWeight: '400', fontSize: 11 }}>
                          {isAi && p ? `via ${p.name} · ` : ''}
                          {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </Text>
                      {item.pinned_at ? (
                        <Pin size={12} color={colors.textDim} style={{ marginLeft: 6 }} />
                      ) : null}
                    </View>
                  )}
                  {!!item.body && (
                    <View>
                      <Markdown body={item.body} />
                      {item.edited_ts ? <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>(edited)</Text> : null}
                    </View>
                  )}
                  {!!item.body && <MessageUnfurls body={item.body} viewerId={userId} />}
                  {(item.attachments ?? []).map((a, i) => {
                    const mime = a.type ?? a.contentType ?? '';
                    return mime.startsWith('image/') ? (
                      <Image key={i} source={{ uri: a.url }} style={{ width: 220, height: 160, borderRadius: radius.sm, marginTop: space(1.5), backgroundColor: colors.surfaceAlt }} resizeMode="cover" />
                    ) : (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space(1) }}>
                        <Paperclip size={14} color={colors.accent} style={{ marginRight: 6 }} />
                        <Text style={{ color: colors.accent }}>{a.name}</Text>
                      </View>
                    );
                  })}
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
      <SlashSuggest text={text} onSelect={onSelectSlash} />
      {aiThinking && (
        <Text style={{ color: colors.textDim, fontSize: 12, paddingHorizontal: space(4), paddingBottom: 2 }}>
          AI is thinking…
        </Text>
      )}
      {typingNames.length > 0 && (
        <Text style={{ color: colors.textDim, fontSize: 12, paddingHorizontal: space(4), paddingBottom: 2 }}>
          {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…
        </Text>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2.5), borderTopWidth: 1, borderTopColor: colors.border, gap: space(2) }}>
        <TouchableOpacity onPress={() => setMenuOpen(true)} style={{ paddingBottom: space(2.5) }} hitSlop={8}>
          <Plus size={22} color={colors.textDim} />
        </TouchableOpacity>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
          selection={selection}
          placeholder={`Message ${headerTitle}`}
          placeholderTextColor={colors.textDim}
          multiline
          style={{ flex: 1, color: colors.text, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space(3), paddingVertical: space(2.5), maxHeight: 120, fontSize: 15 }}
        />
        <TouchableOpacity onPress={() => doSend()} disabled={sending || (!text.trim())} style={{ paddingBottom: space(2.5), opacity: sending || !text.trim() ? 0.4 : 1 }}>
          <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 15 }}>Send</Text>
        </TouchableOpacity>
      </View>
      <ComposerMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onPickPhoto={attachImage}
        onPickGif={() => setGifPickerOpen(true)}
        onPickEmoji={() => setEmojiOpen(true)}
      />
      <GifPicker
        visible={gifPickerOpen}
        apiKey={giphyKey}
        onClose={() => setGifPickerOpen(false)}
        onSelect={onSelectGif}
      />
      <EmojiPanel
        visible={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onPick={(e) => { insertEmoji(e); setEmojiOpen(false); }}
      />
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
        onDelete={() => {
          if (sheetMessage) deleteMessage(sheetMessage.id).catch(() => {});
        }}
      />
    </KeyboardAvoidingView>
  );
}
