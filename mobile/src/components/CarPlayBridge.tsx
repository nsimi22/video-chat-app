import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant, useParticipants } from '@livekit/react-native';
import { listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { useCall } from '@/context/CallContext';
import { useCallSignals } from '@/context/CallSignalsContext';
import { CarPlayController, type CarPlaySection } from '@/lib/carplay';

// Headless component that mirrors Huddle's channel list + active-call state onto
// the CarPlay head-unit. Renders nothing.
//
// It lives *inside* <LiveKitRoom> (app/(app)/_layout.tsx) for two reasons:
//   • useLocalParticipant() needs a Room context to read/toggle the mic, so the
//     car's Mute button drives the same audio track the phone UI does.
//   • It still sits under CallProvider/CallSignalsProvider, so useCall() and the
//     desktop-parity mute broadcast are available too.
//
// On non-iOS (or an iOS build that didn't bundle react-native-carplay) the
// controller reports `isSupported === false` and every effect below early-outs,
// so this is inert everywhere but a CarPlay-capable iOS build.

// DM channel ids look like `dm:<a>::<b>` (sorted uuids). Return the *other*
// participant's uuid for 1:1s; null for group DMs and non-DM channels. Mirrors
// the same helper in app/(app)/(tabs)/channels.tsx.
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

export function CarPlayBridge() {
  const supported = CarPlayController.isSupported;

  const { activeTeam, userId } = useAuth();
  const { activeCall, startCall, endCall } = useCall();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const { broadcastMuteState } = useCallSignals();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  // Latest channel/profile snapshot for the tap handler, so onSelectChannel can
  // resolve a fresh display name without being re-created (and re-registered on
  // the native template) on every list refresh.
  const dataRef = useRef({ channels, profiles, userId });
  dataRef.current = { channels, profiles, userId };

  // ── Load + live-subscribe the channel list (only when CarPlay is in play) ──
  const load = useCallback(async () => {
    if (!activeTeam) return;
    try {
      const [ch, pr] = await Promise.all([
        listChannels(activeTeam.id),
        listTeamProfiles(activeTeam.id),
      ]);
      setChannels(ch);
      setProfiles(pr);
    } catch (err) {
      console.warn('[carplay] channel load failed', err);
    }
  }, [activeTeam]);

  useEffect(() => {
    if (!supported || !activeTeam) return;
    load();
    // Same realtime channel-list subscription the channels tab uses, so renames,
    // new channels, and new DMs reach the car without a manual refresh.
    const sub = supabase
      .channel(`carplay:channels:${activeTeam.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'channels', filter: `team_id=eq.${activeTeam.id}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(sub);
    };
  }, [supported, activeTeam, load]);

  // ── Handlers (kept current on the controller every render) ────────────────
  const onSelectChannel = useCallback(
    (id: string) => {
      const { channels: chs, profiles: prs, userId: me } = dataRef.current;
      const ch = chs.find((c) => c.id === id);
      const label = ch ? channelLabel(ch, prs, me) : 'Call';
      // Reuses the exact CallContext path the phone uses — perms ask + LiveKit
      // token + room connect. CarPlay is audio-only, but startCall still asks
      // for camera perms; the car never renders video, so a denied camera is
      // harmless here.
      void startCall(id, label);
    },
    [startCall],
  );

  const onToggleMute = useCallback(() => {
    if (!localParticipant) return;
    const next = !isMicrophoneEnabled;
    Promise.resolve(localParticipant.setMicrophoneEnabled(next))
      // Mirror to the call channel so desktop tiles reflect a mute toggled from
      // the car even while the phone's call screen isn't mounted (locked/pocket).
      .then(() => broadcastMuteState(next, isCameraEnabled))
      .catch((err) => console.warn('[carplay] mic toggle failed', err));
  }, [localParticipant, isMicrophoneEnabled, isCameraEnabled, broadcastMuteState]);

  const onLeave = useCallback(() => {
    endCall();
  }, [endCall]);

  useEffect(() => {
    if (!supported) return;
    CarPlayController.setHandlers({ onSelectChannel, onToggleMute, onLeave });
  }, [supported, onSelectChannel, onToggleMute, onLeave]);

  // ── Register scene connect/disconnect listeners once ──────────────────────
  useEffect(() => {
    if (!supported) return;
    CarPlayController.start({ onSelectChannel, onToggleMute, onLeave });
    return () => CarPlayController.stop();
    // Intentionally mount-once: start() is idempotent and setHandlers (above)
    // keeps the closures fresh, so we don't re-register listeners on every
    // handler identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  // ── Browse template: channels + DMs, split into two sections ──────────────
  const sections = useMemo<CarPlaySection[]>(() => {
    const channelItems = channels
      .filter((c) => c.type !== 'dm')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, label: c.name, sub: c.type === 'private' ? '🔒 Private' : '# Channel' }));
    const dmItems = channels
      .filter((c) => c.type === 'dm')
      .map((c) => ({ id: c.id, label: channelLabel(c, profiles, userId), sub: 'Direct message' }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const out: CarPlaySection[] = [];
    if (channelItems.length) out.push({ header: 'Channels', items: channelItems });
    if (dmItems.length) out.push({ header: 'Direct Messages', items: dmItems });
    return out;
  }, [channels, profiles, userId]);

  // Signature so we only rebuild the native list template when the visible
  // content actually changes (the realtime sub can fire on unrelated column
  // updates that don't alter what the car shows).
  const browseSig = useMemo(
    () => sections.map((s) => `${s.header}:${s.items.map((i) => `${i.id}|${i.label}`).join(',')}`).join(';'),
    [sections],
  );

  // ── Active-call template: name + live participant count + mute state ───────
  const callTitle = activeCall?.name ?? '';
  const participantCount = participants.length;
  const callDetail =
    participantCount > 1 ? `${participantCount} on the call` : 'Waiting for others…';
  const muted = !isMicrophoneEnabled;

  // Drive the controller off the current state. Two effects, keyed on their own
  // signatures, so a browse refresh doesn't rebuild the call template and vice
  // versa.
  useEffect(() => {
    if (!supported) return;
    if (activeCall) return; // call template owns the root while a call is live
    CarPlayController.setBrowse(sections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, activeCall, browseSig]);

  useEffect(() => {
    if (!supported || !activeCall) return;
    CarPlayController.setCall(callTitle, callDetail, muted);
  }, [supported, activeCall, callTitle, callDetail, muted]);

  return null;
}
