import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, FlatList } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Device from 'expo-device';
import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useLocalParticipant,
  useParticipants,
  isTrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
  PhoneOff,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
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
      <SafeAreaView style={styles.center}>
        <Text style={{ color: colors.danger, textAlign: 'center', marginBottom: space(4) }}>{error}</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={{ color: colors.accent }}>Back</Text></TouchableOpacity>
      </SafeAreaView>
    );
  }
  if (!grant) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.textDim, marginTop: space(3) }}>Connecting…</Text>
      </SafeAreaView>
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
      <CallView title={name ? String(name) : 'Call'} />
    </LiveKitRoom>
  );
}

function CallView({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);

  // iOS Simulator has no camera hardware; LiveKit publishes nothing for
  // the local participant regardless of `cam=true`. Detect this so the
  // placeholder text doesn't lie ("Camera off" implies you flipped a switch).
  const isSim = !Device.isDevice;

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

  // Tile grid columns scale with participant count, matching desktop's
  // huddle grid: 1 column when alone, 2 columns once a peer joins.
  const numColumns = tracks.length <= 1 ? 1 : 2;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Top bar — title, sits below the status bar/notch. */}
      <View
        style={{
          paddingTop: insets.top + space(2),
          paddingBottom: space(3),
          paddingHorizontal: space(4),
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>
          {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
        </Text>
      </View>

      <FlatList
        // Forcing a remount when column count changes is the supported
        // pattern for dynamic numColumns on FlatList.
        key={`grid-${numColumns}`}
        data={tracks}
        keyExtractor={(t, i) => (isTrackReference(t) ? `${t.participant.identity}:${t.source}` : `ph:${i}`)}
        numColumns={numColumns}
        contentContainerStyle={{
          padding: space(1),
          paddingBottom: space(2),
          flexGrow: 1,
        }}
        renderItem={({ item }) => {
          const isLocal = isTrackReference(item) && item.participant.isLocal;
          const showSimHint = isSim && (!isTrackReference(item) || isLocal);
          return (
            <View
              style={{
                flex: 1 / numColumns,
                aspectRatio: numColumns === 1 ? undefined : 1,
                ...(numColumns === 1 ? { minHeight: 240 } : null),
                margin: space(1),
                borderRadius: radius.md,
                overflow: 'hidden',
                backgroundColor: colors.surfaceAlt,
              }}
            >
              {isTrackReference(item) ? (
                <VideoTrack trackRef={item} style={{ flex: 1 }} />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(3) }}>
                  <Text style={{ color: colors.textDim, textAlign: 'center' }}>
                    {showSimHint ? 'Camera unavailable\n(iOS Simulator)' : 'Camera off'}
                  </Text>
                </View>
              )}
              <Text
                style={{
                  position: 'absolute',
                  bottom: 6,
                  left: 8,
                  color: '#fff',
                  fontSize: 12,
                  textShadowColor: '#000',
                  textShadowRadius: 3,
                }}
              >
                {isTrackReference(item) ? item.participant.name || item.participant.identity : ''}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: space(20) }}>
            Waiting for others to join…
          </Text>
        }
      />

      {/* Control bar, pinned above the home indicator. */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          gap: space(3),
          paddingHorizontal: space(4),
          paddingTop: space(3),
          paddingBottom: Math.max(insets.bottom, space(3)),
          backgroundColor: 'rgba(0,0,0,0.4)',
        }}
      >
        <CtrlButton
          icon={mic ? Mic : MicOff}
          a11yLabel={mic ? 'Mute microphone' : 'Unmute microphone'}
          onPress={toggleMic}
          active={mic}
        />
        <CtrlButton
          icon={cam ? VideoIcon : VideoOff}
          a11yLabel={cam ? 'Turn camera off' : 'Turn camera on'}
          onPress={toggleCam}
          active={cam}
        />
        <CtrlButton icon={SwitchCamera} a11yLabel="Flip camera" onPress={flipCamera} active />
        <CtrlButton icon={PhoneOff} a11yLabel="Leave call" onPress={() => router.back()} danger />
      </View>
    </View>
  );
}

function CtrlButton({
  icon: Icon,
  a11yLabel,
  onPress,
  active,
  danger,
}: {
  icon: LucideIcon;
  a11yLabel: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  const bg = danger ? colors.danger : active ? colors.surfaceAlt : colors.surface;
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityLabel={a11yLabel}
      accessibilityRole="button"
      hitSlop={8}
      style={{
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
        borderWidth: danger ? 0 : 1,
        borderColor: colors.border,
      }}
    >
      <Icon size={24} color="#fff" strokeWidth={2} />
    </TouchableOpacity>
  );
}

const styles = {
  center: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: colors.bg,
    padding: space(6),
  },
};
