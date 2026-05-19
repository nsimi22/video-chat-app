import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, FlatList, Linking } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useAuth } from '@/context/AuthContext';
import { getProfile, type Profile } from '@/lib/api';
import { useMesh } from '@/hooks/useMesh';
import type { PeerInfo } from '@/lib/mesh';
import { colors, radius, space } from '@/theme';

// Audio-only call screen. Replaces the previous LiveKit implementation with a
// WebRTC mesh signaled over the existing `call:<team>:<channel>` Supabase
// Realtime topic — same topic the desktop renderer uses, so a mobile caller
// and a desktop caller can join the same call and hear each other.
export default function CallScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam, userId } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  useKeepAwake();

  // Fetch our own profile once so the mesh can announce the same {name, color}
  // shape the desktop renderer puts in presence (so existing desktop peers
  // render us with the right label/avatar).
  useEffect(() => {
    if (!userId) return;
    let active = true;
    getProfile(userId)
      .then((p) => { if (active) setProfile(p); })
      .catch(() => { if (active) setProfile({ user_id: userId, name: 'Guest', color: colors.accent }); });
    return () => { active = false; };
  }, [userId]);

  if (!activeTeam || !userId || !profile) {
    return (
      <View style={centerStyle}>
        <Stack.Screen options={{ title: name ? String(name) : 'Call' }} />
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.textDim, marginTop: space(3) }}>Loading…</Text>
      </View>
    );
  }

  return (
    <CallActive
      teamId={activeTeam.id}
      channelId={String(channelId)}
      title={name ? String(name) : 'Call'}
      myPeerId={userId}
      myName={profile.name || 'Guest'}
      myColor={profile.color || colors.accent}
    />
  );
}

function CallActive({
  teamId, channelId, title, myPeerId, myName, myColor,
}: {
  teamId: string; channelId: string; title: string;
  myPeerId: string; myName: string; myColor: string;
}) {
  const { state, error, toggleMic, leave, retry } = useMesh({
    teamId, channelId, myPeerId, myName, myColor,
    onLeave: () => router.back(),
  });

  // Render the local user as the first tile so the layout doesn't reflow as
  // peers arrive. Remote peers follow in presence-sync order.
  const tiles = useMemo(() => {
    const me: PeerInfo & { isSelf: true } = {
      id: myPeerId, name: myName, color: myColor,
      micOn: state.micOn, connectionState: 'connected', isSelf: true,
    };
    return [me, ...state.peers];
  }, [state.peers, state.micOn, myPeerId, myName, myColor]);

  if (error) {
    const isPermission = error.kind === 'permission_denied';
    const isNoMic = error.kind === 'no_microphone';
    const headline = isPermission
      ? 'Microphone access needed'
      : isNoMic
      ? 'No microphone available'
      : 'Couldn’t join the call';
    const body = isPermission
      ? 'Huddle needs the microphone to make audio calls. Enable it in Settings to continue.'
      : isNoMic
      ? 'No microphone hardware was detected on this device.'
      : error.message || 'Something went wrong reaching the call server.';
    // Only offer Retry when retrying could plausibly succeed without the
    // user changing OS state. Permission flips happen in Settings, not by
    // tapping a button — so we offer "Open Settings" there instead, and the
    // user re-enters the call after granting access.
    const showRetry = !isPermission && !isNoMic;
    return (
      <View style={centerStyle}>
        <Stack.Screen options={{ title: 'Call' }} />
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', textAlign: 'center' }}>{headline}</Text>
        <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: space(2), marginBottom: space(5) }}>{body}</Text>
        <View style={{ flexDirection: 'row', gap: space(3) }}>
          {isPermission ? (
            <CtrlButton label="Open Settings" active onPress={() => { Linking.openSettings().catch(() => {}); }} />
          ) : null}
          {showRetry ? <CtrlButton label="Retry" active onPress={retry} /> : null}
          <CtrlButton label="Back" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen options={{ title, headerShown: false }} />
      <View style={{ position: 'absolute', top: space(12), left: 0, right: 0, alignItems: 'center', zIndex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: colors.textDim, marginTop: space(1) }}>
          {!state.joined
            ? 'Connecting…'
            : state.reconnecting
            ? 'Reconnecting…'
            : `${tiles.length} ${tiles.length === 1 ? 'person' : 'people'} on the call`}
        </Text>
      </View>
      {state.reconnecting ? (
        <View style={{ position: 'absolute', top: space(20), left: space(4), right: space(4), backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: space(3), zIndex: 1, borderWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.textDim, textAlign: 'center', fontSize: 13 }}>
            Network blip — reconnecting to the call.
          </Text>
        </View>
      ) : null}
      <FlatList
        data={tiles}
        keyExtractor={(p) => p.id}
        numColumns={2}
        contentContainerStyle={{ padding: space(3), paddingTop: space(24) }}
        renderItem={({ item }) => <Tile peer={item} isSelf={'isSelf' in item} />}
        ListEmptyComponent={
          state.joined ? (
            <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: space(20) }}>
              Waiting for others to join…
            </Text>
          ) : null
        }
      />
      <View style={{ position: 'absolute', bottom: space(10), left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: space(4) }}>
        <CtrlButton label={state.micOn ? 'Mute' : 'Unmute'} active={state.micOn} onPress={toggleMic} />
        <CtrlButton label="Leave" danger onPress={leave} />
      </View>
    </View>
  );
}

function Tile({ peer, isSelf }: { peer: PeerInfo; isSelf: boolean }) {
  const initials = (peer.name ?? '?')
    .split(/\s+/)
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  // Connection state colour cues: greenish when we've actually exchanged
  // media, dim while ICE is still finishing, red on failure. Self always
  // reads as "connected" (we're the one rendering the tile).
  const stateColor =
    isSelf || peer.connectionState === 'connected'
      ? colors.online
      : peer.connectionState === 'failed' || peer.connectionState === 'disconnected'
      ? colors.danger
      : colors.textDim;
  return (
    <View
      style={{
        flex: 1, aspectRatio: 1, margin: space(2),
        borderRadius: radius.lg, backgroundColor: colors.surfaceAlt,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: colors.border,
      }}
    >
      <View
        style={{
          width: 80, height: 80, borderRadius: 40,
          backgroundColor: peer.color || colors.accent,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '600' }}>{initials || '?'}</Text>
      </View>
      <Text style={{ color: '#fff', marginTop: space(3), fontWeight: '600' }}>
        {peer.name ?? 'Guest'}{isSelf ? ' (you)' : ''}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space(1), gap: space(2) }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stateColor }} />
        <Text style={{ color: colors.textDim, fontSize: 12 }}>
          {peer.micOn ? '' : 'Muted'}
        </Text>
      </View>
    </View>
  );
}

function CtrlButton({ label, onPress, active, danger }: {
  label: string; onPress: () => void; active?: boolean; danger?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: space(5), paddingVertical: space(3),
        borderRadius: radius.lg,
        backgroundColor: danger ? colors.danger : active ? colors.surfaceAlt : colors.surface,
        borderWidth: 1, borderColor: colors.border,
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const centerStyle = {
  flex: 1,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  backgroundColor: colors.bg,
  padding: space(6),
};
