import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant, useParticipants } from '@livekit/react-native';
import {
  fetchLatestMessagesByChannel,
  fetchMessages,
  listChannels,
  listTeamProfiles,
  sendMessage,
  type Channel,
  type Message,
  type Profile,
} from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { useCall } from '@/context/CallContext';
import { useCallSignals } from '@/context/CallSignalsContext';
import { useUnread } from '@/context/UnreadContext';
import { CarPlayController, type CarPlayViewState, type ConversationRow } from '@/lib/carplay';

// Headless component that mirrors Huddle's conversations + active call onto the
// CarPlay head-unit as an iMessage-style surface. Renders nothing.
//
// Mounted *inside* <LiveKitRoom> (app/(app)/_layout.tsx) so useLocalParticipant()
// can read/toggle the mic for the car's in-call Mute button; it still sits under
// CallProvider/CallSignalsProvider/UnreadProvider for call + unread state.
//
// Inert on non-iOS (or an iOS build without react-native-carplay): the controller
// reports isSupported === false and every effect early-outs.

// Canned replies — CarPlay forbids free-text entry while driving, so hands-free
// replies are presets. (Reading messages aloud + voice dictation is the SiriKit
// path; see docs/carplay.md.)
const QUICK_REPLIES = ['👍 Got it', 'On my way', 'Running late', 'Call you back', 'Thanks!'];

// DM channel ids look like `dm:<a>::<b>` (sorted uuids). Mirrors the helper in
// app/(app)/(tabs)/channels.tsx.
function dmPeerId(channelId: string, me: string | null): string | null {
  if (!channelId.startsWith('dm:')) return null;
  return channelId.replace(/^dm:/, '').split('::').find((x) => x && x !== me) ?? null;
}

function channelLabel(c: Channel, profiles: Profile[], me: string | null): string {
  if (c.type === 'dm') {
    const other = dmPeerId(c.id, me);
    if (other) return profiles.find((p) => p.user_id === other)?.name ?? 'Direct message';
    return c.name || 'Group DM';
  }
  return c.name;
}

function truncate(s: string, n: number): string {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// "Name: body" preview/line for a message, with sensible fallbacks for
// attachment-only, poll, and empty bodies.
function formatMessage(m: Message, profiles: Profile[], me: string | null): string {
  const who = m.author_id === me ? 'You' : profiles.find((p) => p.user_id === m.author_id)?.name ?? 'Someone';
  let body = (m.body || '').trim();
  if (m.meta?.poll) body = `📊 ${m.meta.poll.question}`;
  else if (!body && m.attachments?.length) body = '📎 Attachment';
  else if (!body) body = '(no text)';
  return `${who}: ${body}`;
}

const OPEN_LINE_COUNT = 8;

export function CarPlayBridge() {
  const supported = CarPlayController.isSupported;

  const { activeTeam, userId } = useAuth();
  const { activeCall, startCall, endCall } = useCall();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const { broadcastMuteState } = useCallSignals();
  const { unreadFor } = useUnread();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [previews, setPreviews] = useState<Map<string, Message>>(new Map());

  // The conversation the car is currently viewing (its detail template).
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMessages, setOpenMessages] = useState<Message[]>([]);
  const [openLoading, setOpenLoading] = useState(false);

  // Refs so the stable handlers below resolve current state without being
  // re-created (and re-registered on the native templates) each render.
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const dataRef = useRef({ channels, profiles, userId, teamId: activeTeam?.id ?? null });
  dataRef.current = { channels, profiles, userId, teamId: activeTeam?.id ?? null };

  // ── Load channels + profiles + previews, and keep them live ───────────────
  const loadRoster = useCallback(async () => {
    if (!activeTeam) return;
    try {
      const [ch, pr] = await Promise.all([listChannels(activeTeam.id), listTeamProfiles(activeTeam.id)]);
      setChannels(ch);
      setProfiles(pr);
    } catch (err) {
      console.warn('[carplay] roster load failed', err);
    }
  }, [activeTeam]);

  const loadPreviews = useCallback(async () => {
    if (!activeTeam) return;
    try {
      setPreviews(await fetchLatestMessagesByChannel(activeTeam.id));
    } catch (err) {
      console.warn('[carplay] preview load failed', err);
    }
  }, [activeTeam]);

  // Throttle preview reloads triggered by the firehose of team message inserts.
  const lastPreviewLoad = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!supported || !activeTeam) return;
    loadRoster();
    loadPreviews();

    const channelSub = supabase
      .channel(`carplay:channels:${activeTeam.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'channels', filter: `team_id=eq.${activeTeam.id}` },
        () => loadRoster(),
      )
      .subscribe();

    // Refresh previews when new messages land, throttled to ~once/4s so a busy
    // team doesn't hammer the DB from the car.
    const msgSub = supabase
      .channel(`carplay:previews:${activeTeam.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `team_id=eq.${activeTeam.id}` },
        () => {
          const now = Date.now();
          const since = now - lastPreviewLoad.current;
          if (since >= 4000) {
            lastPreviewLoad.current = now;
            loadPreviews();
          } else if (!previewTimer.current) {
            previewTimer.current = setTimeout(() => {
              previewTimer.current = null;
              lastPreviewLoad.current = Date.now();
              loadPreviews();
            }, 4000 - since);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channelSub);
      supabase.removeChannel(msgSub);
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
        previewTimer.current = null;
      }
    };
  }, [supported, activeTeam, loadRoster, loadPreviews]);

  // ── Load the open conversation's recent messages + live-append new ones ────
  useEffect(() => {
    if (!supported || !openId || !activeTeam) {
      setOpenMessages([]);
      setOpenLoading(false);
      return;
    }
    let active = true;
    setOpenLoading(true);
    fetchMessages(activeTeam.id, openId)
      .then((ms) => {
        if (!active) return;
        setOpenMessages(ms.slice(-OPEN_LINE_COUNT));
        setOpenLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setOpenLoading(false);
        console.warn('[carplay] open conversation load failed', err);
      });

    const sub = supabase
      .channel(`carplay:conv:${activeTeam.id}:${openId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `team_id=eq.${activeTeam.id}` },
        (payload) => {
          const m = payload.new as Message;
          if (m.channel_id !== openId || m.parent_id) return;
          setOpenMessages((prev) => [...prev, m].slice(-OPEN_LINE_COUNT));
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(sub);
    };
  }, [supported, openId, activeTeam]);

  // ── Handlers (kept current on the controller every render) ────────────────
  const onOpenConversation = useCallback((id: string) => setOpenId(id), []);
  const onCloseConversation = useCallback(() => setOpenId(null), []);

  const onQuickReply = useCallback(
    (text: string) => {
      const { teamId, userId: me } = dataRef.current;
      const channelId = openIdRef.current;
      if (!teamId || !me || !channelId) return;
      sendMessage({ teamId, channelId, authorId: me, body: text }).catch((err) =>
        console.warn('[carplay] quick reply failed', err),
      );
    },
    [],
  );

  const onStartCall = useCallback(() => {
    const { channels: chs, profiles: prs, userId: me } = dataRef.current;
    const channelId = openIdRef.current;
    if (!channelId) return;
    const ch = chs.find((c) => c.id === channelId);
    const label = ch ? channelLabel(ch, prs, me) : 'Call';
    // Reuses the phone's CallContext path (perms + LiveKit token + connect).
    // Audio-only on the car — a denied camera is harmless, nothing renders video.
    void startCall(channelId, label);
  }, [startCall]);

  const onToggleMute = useCallback(() => {
    if (!localParticipant) return;
    const next = !isMicrophoneEnabled;
    Promise.resolve(localParticipant.setMicrophoneEnabled(next))
      .then(() => broadcastMuteState(next, isCameraEnabled))
      .catch((err) => console.warn('[carplay] mic toggle failed', err));
  }, [localParticipant, isMicrophoneEnabled, isCameraEnabled, broadcastMuteState]);

  const onLeave = useCallback(() => endCall(), [endCall]);

  const handlers = useMemo(
    () => ({ onOpenConversation, onCloseConversation, onQuickReply, onStartCall, onToggleMute, onLeave }),
    [onOpenConversation, onCloseConversation, onQuickReply, onStartCall, onToggleMute, onLeave],
  );

  useEffect(() => {
    if (!supported) return;
    CarPlayController.setHandlers(handlers);
  }, [supported, handlers]);

  // Register scene connect/disconnect once; setHandlers (above) keeps the
  // closures fresh, so we don't re-register on handler identity changes.
  useEffect(() => {
    if (!supported) return;
    CarPlayController.start(handlers);
    return () => CarPlayController.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  // ── Build the view state ──────────────────────────────────────────────────
  const conversations = useMemo<ConversationRow[]>(() => {
    const rows = channels.map((c) => {
      const preview = previews.get(c.id);
      return {
        id: c.id,
        label: channelLabel(c, profiles, userId),
        preview: preview ? truncate(formatMessage(preview, profiles, userId), 40) : '',
        unread: unreadFor(c.id)?.count ?? 0,
        ts: preview?.ts ?? '',
      };
    });
    // Most-recently-active first (channels with no messages sink to the bottom,
    // sorted alphabetically among themselves).
    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.label.localeCompare(b.label)));
    return rows.map(({ id, label, preview, unread }) => ({ id, label, preview, unread }));
  }, [channels, profiles, userId, previews, unreadFor]);

  const openConversation = useMemo(() => {
    if (!openId) return null;
    const ch = channels.find((c) => c.id === openId);
    return {
      id: openId,
      title: ch ? channelLabel(ch, profiles, userId) : 'Conversation',
      lines: openMessages.map((m) => truncate(formatMessage(m, profiles, userId), 60)),
      quickReplies: QUICK_REPLIES,
      loading: openLoading,
    };
  }, [openId, channels, profiles, userId, openMessages, openLoading]);

  const call = useMemo(() => {
    if (!activeCall) return null;
    const count = participants.length;
    return {
      title: activeCall.name,
      detail: count > 1 ? `${count} on the call` : 'Waiting for others…',
      muted: !isMicrophoneEnabled,
    };
  }, [activeCall, participants.length, isMicrophoneEnabled]);

  useEffect(() => {
    if (!supported) return;
    const state: CarPlayViewState = { conversations, open: openConversation, call };
    CarPlayController.render(state);
  }, [supported, conversations, openConversation, call]);

  return null;
}
