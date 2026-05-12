import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, FlatList } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useLocalParticipant,
  isTrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import { getCallToken, type LiveKitGrant } from '@/lib/livekit';
import { useAuth } from '@/context/AuthContext';
import { colors, radius, space } from '@/theme';

export default function CallScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam } = useAuth();
  const [grant, setGrant] = useState<LiveKitGrant | null>(null);
  const [error, setError] = useState<string | null>(null);
  useKeepAwake();

  useEffect(() => {
    let active = true;
    AudioSession.startAudioSession();
    if (activeTeam) {
      getCallToken(activeTeam.id, String(channelId))
        .then((g) => active && setGrant(g))
        .catch((e) => active && setError(e?.message ?? String(e)));
    }
    return () => {
      active = false;
      AudioSession.stopAudioSession();
    };
  }, [activeTeam, channelId]);

  if (error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Call' }} />
        <Text style={{ color: colors.danger, textAlign: 'center', marginBottom: space(4) }}>{error}</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={{ color: colors.accent }}>Back</Text></TouchableOpacity>
      </View>
    );
  }
  if (!grant) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: name ? String(name) : 'Call' }} />
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.textDim, marginTop: space(3) }}>Connecting…</Text>
      </View>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={grant.url}
      token={grant.token}
      connect
      audio
      video
      options={{ adaptiveStream: { pixelDensity: 'screen' } }}
      onDisconnected={() => router.back()}
    >
      <Stack.Screen options={{ title: name ? String(name) : 'Call', headerShown: false }} />
      <CallView title={name ? String(name) : 'Call'} />
    </LiveKitRoom>
  );
}

function CallView({ title }: { title: string }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const { localParticipant } = useLocalParticipant();
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);

  const toggleMic = async () => {
    const next = !mic;
    setMic(next);
    await localParticipant.setMicrophoneEnabled(next);
  };
  const toggleCam = async () => {
    const next = !cam;
    setCam(next);
    await localParticipant.setCameraEnabled(next);
  };
  const flipCamera = async () => {
    // @livekit/react-native augments the local camera track with switchCamera().
    const track = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
      | { switchCamera?: () => Promise<void>; restartTrack?: () => Promise<void> }
      | undefined;
    if (track?.switchCamera) await track.switchCamera();
    else await track?.restartTrack?.();
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        data={tracks}
        keyExtractor={(t, i) => (isTrackReference(t) ? `${t.participant.identity}:${t.source}` : `ph:${i}`)}
        numColumns={2}
        contentContainerStyle={{ padding: space(1), paddingTop: space(12) }}
        renderItem={({ item }) => (
          <View style={{ flex: 1, aspectRatio: 1, margin: space(1), borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surfaceAlt }}>
            {isTrackReference(item) ? (
              <VideoTrack trackRef={item} style={{ flex: 1 }} />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: colors.textDim }}>Camera off</Text>
              </View>
            )}
            <Text style={{ position: 'absolute', bottom: 6, left: 8, color: '#fff', fontSize: 12, textShadowColor: '#000', textShadowRadius: 3 }}>
              {isTrackReference(item) ? item.participant.name || item.participant.identity : ''}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={{ color: colors.textDim, textAlign: 'center', marginTop: space(20) }}>Waiting for others to join…</Text>}
      />
      <View style={{ position: 'absolute', top: space(10), left: 0, right: 0, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontWeight: '600' }}>{title}</Text>
      </View>
      <View style={{ position: 'absolute', bottom: space(10), left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: space(4) }}>
        <CtrlButton label={mic ? 'Mute' : 'Unmute'} active={mic} onPress={toggleMic} />
        <CtrlButton label={cam ? 'Cam off' : 'Cam on'} active={cam} onPress={toggleCam} />
        <CtrlButton label="Flip" active onPress={flipCamera} />
        <CtrlButton label="Leave" danger onPress={() => router.back()} />
      </View>
    </View>
  );
}

function CtrlButton({ label, onPress, active, danger }: { label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{ paddingHorizontal: space(4), paddingVertical: space(2.5), borderRadius: radius.lg, backgroundColor: danger ? colors.danger : active ? colors.surfaceAlt : colors.surface, borderWidth: 1, borderColor: colors.border }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = {
  center: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: colors.bg, padding: space(6) },
};
