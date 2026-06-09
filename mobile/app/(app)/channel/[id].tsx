import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
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
  Linking,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { ChevronRight, MessageCircle, Pin, Paperclip, Phone, Plus, Star } from 'lucide-react-native';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { PollCard } from '@/components/PollCard';
import { CreatePollSheet } from '@/components/CreatePollSheet';
import { SlashSuggest } from '@/components/SlashSuggest';
import { MentionSuggest, MENTION_TOKEN_RE } from '@/components/MentionSuggest';
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
  sendPollMessage,
  setPin,
  toggleReaction,
  uploadAttachment,
  type Attachment,
  type Message,
  type Profile,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useFavorites } from '@/context/FavoritesContext';
import { usePresence } from '@/context/PresenceContext';
import { AiMessageCard, Avatar, Markdown } from '@/components/ui';
import { MessageUnfurls } from '@/components/Unfurl';
import { DateBanner, isSameLocalDay } from '@/components/DateBanner';
import { ReactorSheet } from '@/components/ReactorSheet';
import { ImageLightbox } from '@/components/ImageLightbox';
import { colors, radius, space } from '@/theme';

export default function ChannelScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam, userId } = useAuth();
  const teamId = activeTeam?.id ?? '';
  const { messages, replyCounts, loading, hasMore, loadOlder } = useChannelMessages(teamId, String(channelId));
  const { isFavorite, toggleFavorite } = useFavorites();
  const { sendTyping, onTyping } = usePresence();
  const [roster, setRoster] = useState<Profile[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [sheetMessage, setSheetMessage] = useState<Message | null>(null);
  // Long-press on a reaction pill opens this sheet so the user can see
  // who reacted with that emoji. Tap still toggles, only long-press
  // routes here. Single piece of state covers any (message, emoji)
  // pair since we never need to surface two sheets at once.
  const [reactorSheet, setReactorSheet] = useState<{ emoji: string; userIds: string[] } | null>(null);
  // Tapped-image preview. Holds just the source URI — re-rendering the
  // Lightbox with a different URI swaps the displayed image cleanly
  // without unmounting the Modal (cheaper than open/close churn when
  // tapping multiple attachments in the same message).
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [giphyKey, setGiphyKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  // Track TextInput selection so emoji insert lands at the cursor instead
  // of always appending — matters when the user has typed text and tapped
  // back into the middle of it.
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const lastTypingSent = useRef(0);

  // Render newest-first so the visible bottom is the latest message. This
  // is the standard chat-list pattern (Slack/Discord/iMessage all do this)
  // and removes the scrollToEnd-on-mount race that fought Fabric layout
  // timing on iOS 26 / RN 0.81. With `inverted`, FlatList anchors data[0]
  // at the visual bottom, so reversing the ascending `messages` puts the
  // newest message there for free — no programmatic scroll needed.
  const reversed = useMemo(() => [...messages].reverse(), [messages]);

  // Bump a primitive whenever the system day might have flipped so the
  // FlatList re-renders and "Today" / "Yesterday" banners refresh. Without
  // this, a user sitting in a channel as the clock rolls past midnight
  // would see yesterday's messages still labelled "Today" until the next
  // incoming message forced a re-render. AppState 'active' on returning
  // from background covers the common case (overnight backgrounded app);
  // a real-time interval-based refresh is unnecessary on mobile because
  // keeping a screen actively foregrounded across midnight is rare.
  const [dayKey, setDayKey] = useState(0);
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') setDayKey((k) => k + 1);
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // Memoize the FlatList extraData tuple — a fresh array literal in JSX
  // would defeat virtualization (FlatList does an Object.is identity
  // check and would re-render every cell on every parent render).
  const flatListExtra = useMemo(() => [roster, dayKey], [roster, dayKey]);

  useEffect(() => {
    if (teamId) listTeamProfiles(teamId).then(setRoster).catch(() => {});
  }, [teamId]);

  useEffect(() => {
    if (userId) getGiphyKey(userId).then(setGiphyKey).catch(() => {});
  }, [userId]);

  // Tell the unread tracker which channel we're sitting in. Marks
  // this channel as read on focus and suppresses further bumps while
  // we're here; blur restores the global "not in any channel" state
  // so messages from any room bump unread normally again. Using
  // useFocusEffect (not useEffect) so popping back from a push-stacked
  // child screen re-marks this channel as active instead of leaving
  // active=null after the child set it.
  //
  // The blur cleanup uses the functional update form so it only
  // clears when *this* channel is still the active one. React
  // Navigation 7 can fire a newly-focused screen's effect before the
  // blurring screen's cleanup; a naive setActiveChannel(null) on
  // blur would then wipe out the newer screen's registration and
  // bumps for the channel the user is now reading would resume.
  const { setActiveChannel } = useUnread();
  useFocusEffect(
    useCallback(() => {
      if (!channelId) return;
      const cid = String(channelId);
      setActiveChannel(cid);
      return () => setActiveChannel((curr) => (curr === cid ? null : curr));
    }, [channelId, setActiveChannel]),
  );

  // Typing indicator over the shared team topic. The channel itself lives
  // in PresenceContext (one join per topic per socket); this screen just
  // registers a listener scoped to its channelId.
  useEffect(() => {
    let active = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onTyping((payload) => {
      if (!active || payload.channelId !== String(channelId)) return;
      setTypingNames((prev) => Array.from(new Set([...prev, payload.name])));
      const t = setTimeout(() => {
        timers.delete(t);
        if (active) setTypingNames((prev) => prev.filter((n) => n !== payload.name));
      }, 3500);
      timers.add(t);
    });
    return () => {
      active = false;
      timers.forEach(clearTimeout);
      off();
    };
  }, [channelId, onTyping]);

  const profileFor = useCallback((uid: string) => roster.find((p) => p.user_id === uid), [roster]);

  const onChangeText = (t: string) => {
    setText(t);
    const now = Date.now();
    if (now - lastTypingSent.current > 1500 && userId) {
      // Skip the broadcast until the roster fetch has resolved our
      // own profile — otherwise the receiver renders "Someone is
      // typing" which is uglier than no indicator at all. The user
      // typing within ~100ms of channel mount (before
      // listTeamProfiles returns) is the realistic trigger.
      const me = profileFor(userId);
      if (!me?.name) return;
      lastTypingSent.current = now;
      sendTyping({ from: userId, name: me.name, channelId: String(channelId) });
    }
  };

  const doSend = async (attachments: Attachment[] = []) => {
    const body = text.trim();
    if (!body && !attachments.length) return;
    setSending(true);
    // Clear the composer up front so the user can see their send went
    // through. /ai-ticket and /summarize can take 10–30s end-to-end
    // (AI inference + Jira create + sendMessage) — without this the
    // composer keeps showing the original "/ai-ticket …" text for the
    // whole window, looking exactly like the send didn't fire.
    setText('');
    // Restore the body only if the user hasn't started composing
    // something new in the meantime — a long-running /ai-ticket can
    // overlap with the user typing the next message.
    const restoreBody = () => setText((curr) => (curr === '' ? body : curr));
    try {
      // Slash commands only fire when there are no attachments — an image
      // upload that happens to be captioned with "/me" should be a normal
      // message, not a /me command on the caption. Skip when userId isn't
      // resolved yet: every dispatch path needs an authenticated author.
      if (!attachments.length && body.startsWith('/') && userId) {
        let consumed = false;
        try {
          consumed = await runSlash(body, {
            teamId,
            channelId: String(channelId),
            userId,
            roster,
            recentMessages: messages,
            onAiThinking: setAiThinking,
            // Slash handlers catch their own internal errors and still
            // return `true`, so the outer catch below never sees them.
            // Restore the composer here so a failed /ai-ticket leaves
            // the user with their text to edit + retry.
            onError: (msg) => {
              restoreBody();
              Alert.alert('Slash command', msg);
            },
          });
        } finally {
          // Safety net: any code path inside runSlash that flipped
          // aiThinking true and then threw before flipping it back
          // would otherwise leave the "AI is thinking…" indicator
          // stuck on screen.
          setAiThinking(false);
        }
        if (consumed) return;
      }
      await sendMessage({
        teamId,
        channelId: String(channelId),
        authorId: userId!,
        body,
        attachments,
        mentions: extractMentions(body, roster),
      });
    } catch (e: any) {
      restoreBody();
      Alert.alert('Could not send', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const onSelectSlash = (cmd: SlashCommand) => setText(`/${cmd.name} `);

  // Replace the in-progress `@<partial>` token at the caret with `@Name `
  // and reposition the caret at the end of the inserted token. The regex
  // is exported from MentionSuggest so the trigger detection here stays
  // in lockstep with the popup's matching logic.
  const onSelectMention = (p: Profile) => {
    const before = text.slice(0, selection.start);
    const after = text.slice(selection.start);
    const m = MENTION_TOKEN_RE.exec(before);
    if (!m) return;
    // match[0] is either "@partial" (at string start) or " @partial"
    // (after whitespace). The `@` position is the end of `before`
    // minus the partial length minus 1.
    const tokenStart = before.length - m[0].length + (m[0].startsWith('@') ? 0 : 1);
    const replacement = `@${p.name} `;
    const newBefore = before.slice(0, tokenStart) + replacement;
    setText(newBefore + after);
    const cursor = newBefore.length;
    setSelection({ start: cursor, end: cursor });
  };

  // Names we feed to the message renderer to gate which @-tokens become
  // styled pills — same approach as desktop's MessageList._knownNames.
  const mentionNames = useMemo(
    () => roster.map((p) => p.name).filter((n): n is string => !!n),
    [roster],
  );

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
  const onSelectGif = async (gif: GiphyResult) => {
    setGifPickerOpen(false);
    // Gate re-entry. Without this, the user could re-open the GIF
    // picker and pick again while the prior send was still in flight,
    // producing duplicate messages. The composer's text-send path is
    // already protected by disabling the send button on `sending`;
    // the GIF path was the one entry that didn't go through doSend
    // and so didn't toggle the flag.
    if (sending) return;
    setSending(true);
    try {
      await sendMessage({
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
      });
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

  const onLongPressMessage = (m: Message) => setSheetMessage(m);

  const headerTitle = useMemo(() => (name ? String(name) : '#channel'), [name]);

  // Memoise the Stack.Screen options so the header doesn't get re-applied
  // on every composer keystroke (which would otherwise hand expo-router a
  // brand-new headerRight closure each render and re-mount the button).
  const fav = isFavorite(String(channelId));
  const screenOptions = useMemo(
    () => ({
      title: headerTitle,
      headerBackButtonDisplayMode: 'minimal' as const,
      headerBackTitle: '',
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          {/* Star — favorite/unfavorite the open conversation (design
              prototype chat header). */}
          <TouchableOpacity
            onPress={() => toggleFavorite(String(channelId))}
            accessibilityLabel={fav ? 'Remove from favorites' : 'Add to favorites'}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Star size={21} color={fav ? colors.away : colors.textDim} fill={fav ? colors.away : 'transparent'} />
          </TouchableOpacity>
          <TouchableOpacity
            // navigate (not push) so a quick double-tap can't stack two call
            // screens. channelId is already a string from useLocalSearchParams.
            onPress={() =>
              router.navigate({ pathname: '/(app)/call/[id]', params: { id: channelId, name: headerTitle } })
            }
            accessibilityLabel="Start call"
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ paddingHorizontal: 4 }}
          >
            <Phone size={22} color={colors.accentTx} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      ),
    }),
    [headerTitle, channelId, fav, toggleFavorite],
  );

  // Read live so the offset tracks the actual stack header height — a
  // hard-coded 88 was right for older iPhones but iOS 26's dynamic-island
  // header runs ~96-100, which leaves the composer partially behind the
  // keyboard.
  const headerHeight = useHeaderHeight();

  if (!activeTeam) return null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={screenOptions} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={reversed}
          inverted
          // renderItem closes over `roster` (author name + avatar lookup),
          // which loads asynchronously after the first paint. Without
          // extraData FlatList's virtualised cells reuse their cached
          // render and authors stay "Unknown" until something else
          // forces a re-render. userId is set once via auth before the
          // screen mounts, so it doesn't need to be in the dep tuple.
          // dayKey bumps on AppState 'active' so the Today/Yesterday
          // banners refresh after the app sits across local midnight.
          extraData={flatListExtra}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingVertical: space(3) }}
          // ListFooterComponent renders at the visual top under `inverted`,
          // so the "Load earlier" pill sits above the oldest message — same
          // mental model as before, just wired through the inverted axis.
          ListFooterComponent={
            hasMore ? (
              <TouchableOpacity onPress={loadOlder} style={{ padding: space(3), alignItems: 'center' }}>
                <Text style={{ color: colors.textDim }}>Load earlier messages</Text>
              </TouchableOpacity>
            ) : null
          }
          renderItem={({ item, index }) => {
            // `reversed` is newest-first, so the visually-above neighbour
            // (the older message in time) lives at index + 1, not - 1.
            const prev = reversed[index + 1];
            // First chronological message of a local day gets a banner
            // above it (and also at the very top of the list when there
            // is no prev). Crossing midnight also breaks the followup
            // grouping below so the ungrouped header reinforces the
            // "new day" separation visually.
            const showDateBanner = !prev || !isSameLocalDay(prev.ts, item.ts);
            // AI messages never group — they should always show the robot
            // avatar + "AI · via <user>" header so it's clear which lines are
            // model output (vs the human's own messages, even when they share
            // an author_id).
            const isAi = !!item.ai_generated;
            const prevIsAi = !!prev?.ai_generated;
            const grouped = !showDateBanner && !isAi && !prevIsAi && prev && prev.author_id === item.author_id
              && new Date(item.ts).getTime() - new Date(prev.ts).getTime() < 5 * 60_000;
            const p = profileFor(item.author_id);
            const row = (
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
                        {isAi ? 'Huddle AI' : (p?.name ?? 'Unknown')}{'  '}
                        <Text style={{ color: colors.textDim, fontWeight: '400', fontSize: 11 }}>
                          {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </Text>
                      {item.pinned_at ? (
                        <Pin size={12} color={colors.textDim} style={{ marginLeft: 6 }} />
                      ) : null}
                    </View>
                  )}
                  {item.meta?.poll ? (
                    // Poll messages render the interactive card in place of
                    // the body (the "📊 Poll: …" body is a fallback for
                    // notifications/search, same as desktop).
                    <PollCard message={item} meId={userId} roster={roster} />
                  ) : isAi ? (
                    // AI output gets the accent card + "via @asker · model"
                    // footer (desktop's .msg-ai treatment).
                    <AiMessageCard body={item.body} mentionNames={mentionNames} viaName={p?.name} model={item.ai_model}>
                      {!!item.body && <MessageUnfurls body={item.body} viewerId={userId} />}
                    </AiMessageCard>
                  ) : (
                    <>
                      {!!item.body && (
                        <View>
                          <Markdown body={item.body} mentionNames={mentionNames} />
                          {item.edited_ts ? <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>(edited)</Text> : null}
                        </View>
                      )}
                      {!!item.body && <MessageUnfurls body={item.body} viewerId={userId} />}
                    </>
                  )}
                  {(item.attachments ?? []).map((a, i) => {
                    const mime = a.type ?? a.contentType ?? '';
                    return mime.startsWith('image/') ? (
                      // Tap an image attachment to open the full-screen
                      // lightbox. activeOpacity matches the rest of the
                      // chat row so the press feedback feels consistent.
                      <TouchableOpacity
                        key={i}
                        activeOpacity={0.85}
                        onPress={() => setLightboxUri(a.url)}
                        accessibilityLabel={`Open image ${a.name ?? 'attachment'}`}
                      >
                        <Image source={{ uri: a.url }} style={{ width: 220, height: 160, borderRadius: radius.sm, marginTop: space(1.5), backgroundColor: colors.surfaceAlt }} resizeMode="cover" />
                      </TouchableOpacity>
                    ) : (
                      // Non-image attachment (zip, pdf, doc, …). Tap to open the
                      // public URL in the device browser — the mobile equivalent
                      // of the desktop renderer's <a href> download link.
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
                  {(replyCounts.get(item.id) ?? 0) > 0 && (
                    // Thread chip — replies live under messages.parent_id;
                    // tap to open the thread screen (design prototype's
                    // "N replies" pill).
                    <TouchableOpacity
                      onPress={() =>
                        router.push({
                          pathname: '/(app)/thread/[id]',
                          params: { id: item.id, channelId: String(channelId), name: headerTitle },
                        })
                      }
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        alignSelf: 'flex-start',
                        gap: 6,
                        marginTop: space(2),
                        paddingHorizontal: space(2.5),
                        paddingVertical: space(1),
                        borderRadius: 20,
                        backgroundColor: colors.surfaceAlt,
                        borderWidth: 1,
                        borderColor: colors.borderSoft,
                      }}
                    >
                      <MessageCircle size={13} color={colors.accentTx} />
                      <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.accentTx }}>
                        {replyCounts.get(item.id)} {replyCounts.get(item.id) === 1 ? 'reply' : 'replies'}
                      </Text>
                      <ChevronRight size={14} color={colors.textFaint} />
                    </TouchableOpacity>
                  )}
                  {item.reactions && Object.keys(item.reactions).length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space(1.5) }}>
                      {Object.entries(item.reactions).map(([emoji, users]) => (
                        <TouchableOpacity
                          key={emoji}
                          onPress={() => toggleReaction(item.id, emoji, userId!).catch(() => {})}
                          // Long-press routes to ReactorSheet — the user
                          // can see who reacted with this emoji without
                          // losing the tap-to-toggle gesture they
                          // expect from every other chat app.
                          onLongPress={() => setReactorSheet({ emoji, userIds: users as string[] })}
                          delayLongPress={350}
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
            // Banner appears visually above the message it announces;
            // because the FlatList is `inverted`, "above in render order"
            // means "above in JSX order" within the same cell. The
            // <View> wrapper keeps the cell a single React element so
            // FlatList's per-item key (item.id) still uniquely identifies
            // the row.
            return showDateBanner ? (
              <View>
                <DateBanner ts={item.ts} />
                {row}
              </View>
            ) : row;
          }}
        />
      )}
      <SlashSuggest text={text} onSelect={onSelectSlash} />
      <MentionSuggest
        text={text}
        caretPos={selection.start}
        roster={roster}
        meId={userId ?? null}
        onSelect={onSelectMention}
      />
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
        onPickPoll={() => setPollOpen(true)}
      />
      <CreatePollSheet
        visible={pollOpen}
        onClose={() => setPollOpen(false)}
        onCreate={async (question, options, multi) => {
          setPollOpen(false);
          try {
            await sendPollMessage({ teamId, channelId: String(channelId), authorId: userId!, question, options, multi });
          } catch (e: any) {
            Alert.alert('Could not create poll', e?.message ?? String(e));
          }
        }}
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
        onOpenThread={() => {
          if (!sheetMessage) return;
          router.push({
            pathname: '/(app)/thread/[id]',
            params: { id: sheetMessage.id, channelId: String(channelId), name: headerTitle },
          });
        }}
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
      <ReactorSheet
        open={reactorSheet !== null}
        emoji={reactorSheet?.emoji ?? null}
        userIds={reactorSheet?.userIds ?? []}
        profiles={roster}
        meId={userId ?? null}
        onClose={() => setReactorSheet(null)}
      />
      <ImageLightbox uri={lightboxUri} onClose={() => setLightboxUri(null)} />
    </KeyboardAvoidingView>
  );
}
