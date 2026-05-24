import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, FlatList, Platform, Alert, Linking, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Device from 'expo-device';
import { Camera } from 'expo-camera';
import { startIOSPIP } from '@livekit/react-native-webrtc';
import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useLocalParticipant,
  useParticipants,
  isTrackReference,
  type TrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
  PictureInPicture,
  PhoneOff,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { getCallToken, type LiveKitGrant } from '@/lib/livekit';
import { useAuth } from '@/context/AuthContext';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';

export default function CallScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeTeam } = useAuth();
  const [grant, setGrant] = useState<LiveKitGrant | null>(null);
  const [error, setError] = useState<string | null>(null);
  // perms tracks the user's decision on the iOS/Android camera + mic
  // prompts. We have to ask explicitly *before* LiveKit's auto-publish
  // fires its own getUserMedia, otherwise iOS treats the underlying
  // RNWebRTC getUserMedia call as a denied-without-prompt no-op and
  // setCameraEnabled/setMicrophoneEnabled silently fail forever. null
  // means we haven't asked yet; once decided we pass the grants to
  // LiveKitRoom so it only tries to publish what the OS will allow.
  const [perms, setPerms] = useState<{ camera: boolean; mic: boolean } | null>(null);
  useKeepAwake();

  useEffect(() => {
    let active = true;
    AudioSession.startAudioSession();
    (async () => {
      // Native prompts; safe to call repeatedly — both functions return
      // the existing decision without re-prompting once the user has
      // answered.
      const [camRes, micRes] = await Promise.all([
        Camera.requestCameraPermissionsAsync(),
        Camera.requestMicrophonePermissionsAsync(),
      ]);
      if (active) setPerms({ camera: camRes.granted, mic: micRes.granted });
    })().catch((e) => active && setError(e?.message ?? String(e)));
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
  if (!grant || !perms) {
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
      audio={perms.mic}
      video={perms.camera}
      options={{ adaptiveStream: { pixelDensity: 'screen' } }}
      onDisconnected={() => router.back()}
    >
      <CallView title={name ? String(name) : 'Call'} perms={perms} />
    </LiveKitRoom>
  );
}

function CallView({ title, perms }: { title: string; perms: { camera: boolean; mic: boolean } }) {
  const insets = useSafeAreaInsets();
  const { height: winHeight } = useWindowDimensions();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // Drive the mic/cam button state from LiveKit's live observer rather
  // than a local intent flag — if auto-publish fails (denied permission,
  // hardware busy, etc.) the underlying state stays false and the
  // button needs to reflect that so the user can see something's wrong
  // instead of staring at an "on" icon over a "Camera off" tile.
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    lastCameraError,
  } = useLocalParticipant();
  const participants = useParticipants();
  // PiP can only bind to one track at a time (iOS is a system-level
  // singleton). Selection order:
  //   1. a remote screenshare (most likely the thing the user wants to
  //      keep watching)
  //   2. a remote camera (audio + their face stays visible)
  //   3. the local camera as a last resort, so a solo caller can still
  //      open PiP from the in-app button — iOS WILL stop the local
  //      capture on background and the window will go black, but the
  //      PiP mechanism itself still works (and the moment anyone joins
  //      and turns on a camera, this swaps to the remote tile).
  const pipTrack = useMemo<TrackReference | null>(() => {
    const reals = tracks.filter(
      (t): t is TrackReference => isTrackReference(t) && !t.publication.isMuted,
    );
    const remotes = reals.filter((t) => !t.participant.isLocal);
    return (
      remotes.find((t) => t.source === Track.Source.ScreenShare) ??
      remotes.find((t) => t.source === Track.Source.Camera) ??
      reals.find((t) => t.participant.isLocal && t.source === Track.Source.Camera) ??
      null
    );
  }, [tracks]);
  // Captured at render-time on whichever <VideoTrack> matches pipTrack.
  // Passed to startIOSPIP() when the user taps the PiP control button.
  const pipRef = useRef<ComponentRef<typeof VideoTrack>>(null);
  const mic = isMicrophoneEnabled;
  const cam = isCameraEnabled;

  // iOS Simulator has no camera hardware; LiveKit publishes nothing for
  // the local participant regardless of `cam=true`. Detect this so the
  // placeholder text doesn't lie ("Camera off" implies you flipped a switch).
  const isSim = !Device.isDevice;

  const toggleMic = async () => {
    if (!perms.mic && !mic) {
      // The grant we captured at call entry can be stale — the user
      // might have denied, gone to Settings, flipped it on, and come
      // back. Re-read the OS state before we tell them their perm is
      // still denied and route them back to Settings.
      const { granted } = await Camera.getMicrophonePermissionsAsync();
      if (!granted) {
        promptOpenSettings('Microphone');
        return;
      }
    }
    try {
      await localParticipant.setMicrophoneEnabled(!mic);
    } catch (e) {
      Alert.alert("Couldn't toggle microphone", (e as Error)?.message ?? String(e));
    }
  };
  const toggleCam = async () => {
    if (!perms.camera && !cam) {
      // Same recover-from-settings dance as mic.
      const { granted } = await Camera.getCameraPermissionsAsync();
      if (!granted) {
        promptOpenSettings('Camera');
        return;
      }
    }
    try {
      await localParticipant.setCameraEnabled(!cam);
    } catch (e) {
      Alert.alert("Couldn't toggle camera", (e as Error)?.message ?? String(e));
    }
  };
  const flipCamera = async () => {
    // @livekit/react-native augments the local camera track with switchCamera().
    const track = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
      | { switchCamera?: () => Promise<void>; restartTrack?: () => Promise<void> }
      | undefined;
    if (track?.switchCamera) await track.switchCamera();
    else await track?.restartTrack?.();
  };

  // 1-up fills the viewport (solo or 1:1, stacked); 3+ tiles fall into a 2-col grid.
  const numColumns = tracks.length <= 2 ? 1 : 2;
  // FlatList items don't auto-flex inside the scroll container, so size
  // 1-up tiles explicitly to the available vertical space (window minus
  // header and control bar) divided by the visible tile count.
  const tileHeight =
    numColumns === 1
      ? Math.max(
          240,
          (winHeight - (insets.top + space(14)) - (insets.bottom + space(20))) /
            Math.max(1, tracks.length),
        )
      : undefined;

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
          // TrackReference and TrackReferencePlaceholder both expose `participant`;
          // only TrackReference has a `publication`. A muted publication
          // (camera toggled off mid-call) is treated the same as a
          // placeholder so we don't render a frozen last frame.
          const isPlaceholder = !isTrackReference(item);
          const isMuted = !isPlaceholder && item.publication.isMuted;
          const showVideo = !isPlaceholder && !isMuted;
          const isLocal = item.participant.isLocal;
          const showSimHint = isSim && (isPlaceholder || isLocal);
          const showCamBlocked = !isSim && isPlaceholder && isLocal && !!lastCameraError;
          const displayName = item.participant.name || item.participant.identity;
          return (
            <View
              style={{
                flex: 1 / numColumns,
                aspectRatio: numColumns === 1 ? undefined : 1,
                height: tileHeight,
                margin: space(1),
                borderRadius: radius.md,
                overflow: 'hidden',
                backgroundColor: colors.surfaceAlt,
              }}
            >
              {showVideo ? (
                <VideoTrack
                  trackRef={item}
                  // Attach the PiP ref only to the matching tile so the
                  // PiP button can target this specific RTCPIPView.
                  ref={item === pipTrack ? pipRef : null}
                  style={isLocal ? { flex: 1, transform: [{ scaleX: -1 }] } : { flex: 1 }}
                  iosPIP={
                    pipTrack && item === pipTrack
                      ? {
                          enabled: true,
                          startAutomatically: true,
                          // Honour the track's real aspect (portrait camera,
                          // wide screenshare, etc.) so iOS doesn't letterbox.
                          // Fall back to 16:9 before the first frame lands
                          // and dimensions are still undefined.
                          preferredSize:
                            item.publication.dimensions ?? { width: 16, height: 9 },
                        }
                      : undefined
                  }
                />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(3) }}>
                  <Avatar name={displayName} size={96} />
                  <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: space(3) }}>
                    {showSimHint
                      ? 'Camera unavailable\n(iOS Simulator)'
                      : showCamBlocked
                        ? Platform.OS === 'ios'
                          ? 'Camera blocked\nEnable it in Settings → Huddle'
                          : 'Camera blocked\nEnable it in your device settings'
                        : 'Camera off'}
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
                {displayName}
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
          off={!mic}
        />
        <CtrlButton
          icon={cam ? VideoIcon : VideoOff}
          a11yLabel={cam ? 'Turn camera off' : 'Turn camera on'}
          onPress={toggleCam}
          active={cam}
          off={!cam}
        />
        <CtrlButton icon={SwitchCamera} a11yLabel="Flip camera" onPress={flipCamera} active />
        {Platform.OS === 'ios' && (
          // Manual PiP trigger. iOS's `startAutomatically: true` covers
          // the home-button / app-switcher case, but a lot of users
          // expect an explicit in-app PiP button (Safari, YouTube,
          // FaceTime all have one). Disabled until there's a track to
          // bind to — see pipTrack selection above.
          <CtrlButton
            icon={PictureInPicture}
            a11yLabel="Picture in Picture"
            onPress={() => {
              if (pipRef.current) startIOSPIP(pipRef);
            }}
            active={!!pipTrack}
            disabled={!pipTrack}
          />
        )}
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
  off,
  danger,
  disabled,
}: {
  icon: LucideIcon;
  a11yLabel: string;
  onPress: () => void;
  active?: boolean;
  off?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  // Off-state (mic/cam disabled) gets the same red treatment as the
  // leave-call button so the user can see at a glance that they're muted.
  const bg = danger || off ? colors.danger : active ? colors.surfaceAlt : colors.surface;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={a11yLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={8}
      style={{
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
        borderWidth: danger || off ? 0 : 1,
        borderColor: colors.border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon size={24} color="#fff" strokeWidth={2} />
    </TouchableOpacity>
  );
}

// Confirm dialog → deep-link to the app's settings page so the user
// can flip the camera/mic permission. Linking.openSettings() handles
// both platforms (iOS app-settings: deep link, Android intent).
function promptOpenSettings(label: 'Camera' | 'Microphone') {
  Alert.alert(
    `${label} access denied`,
    `Huddle needs ${label.toLowerCase()} access to publish your ${label === 'Camera' ? 'video' : 'audio'}. Open Settings to grant it.`,
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: () => Linking.openSettings() },
    ],
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
