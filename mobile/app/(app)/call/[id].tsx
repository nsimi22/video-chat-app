import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, FlatList, Platform, Alert, Linking, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Device from 'expo-device';
import { Camera } from 'expo-camera';
import {
  VideoTrack,
  useTracks,
  useLocalParticipant,
  useParticipants,
  isTrackReference,
} from '@livekit/react-native';
import { PIP_WINDOW_FALLBACK, useIsAppActive, usePipTrack } from '@/lib/pipTrack';
import { PipFallbackView } from '@/components/PipFallbackView';
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
import { useCall, type CallPerms } from '@/context/CallContext';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';

// Full-screen call view. As of the room-hoist refactor, this screen
// no longer owns the LiveKitRoom — the room lives in (app)/_layout.tsx
// so it survives navigation (the user can pop back to a channel and
// the call keeps running, with a floating tile pinned to the corner).
// This screen is now a consumer that:
//   1. ensures CallProvider has the right activeCall for the route id
//      (kicks off startCall if not, or replaces a mismatched one)
//   2. renders the grid + control bar against the room mounted above
export default function CallScreen() {
  const { id: channelId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { activeCall, perms, starting, error, startCall, endCall, clearError } = useCall();
  useKeepAwake();

  const routeId = String(channelId);
  const routeName = name ? String(name) : undefined;
  // Tracks whether we've ever observed activeCall match this route
  // during this mount. Used to distinguish "still waiting for the
  // initial start" from "the call ended out from under us" — without
  // this, an externally-triggered endCall (server disconnect, hangup
  // from elsewhere) would race with startCall in a re-render loop.
  const sawMatch = useRef(false);

  useEffect(() => {
    if (activeCall?.channelId === routeId) {
      sawMatch.current = true;
      return;
    }
    if (sawMatch.current && !error) {
      // We had a matching call; now we don't. Pop back to whatever
      // route opened us. Skip while error is set so the user can
      // read the error screen before dismissing it manually.
      router.back();
      return;
    }
    if (error) return;
    // Initial mount, different channel, or recovery after a cleared
    // error → start (or last-wins switch to) this call.
    startCall(routeId, routeName).catch(() => {});
  }, [activeCall, routeId, routeName, startCall, error]);

  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={{ color: colors.danger, textAlign: 'center', marginBottom: space(4) }}>{error}</Text>
        <TouchableOpacity onPress={() => { clearError(); endCall(); router.back(); }}>
          <Text style={{ color: colors.accent }}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // No matching active call yet → startCall is in flight (or the
  // layout hasn't mounted LiveKitRoom). LiveKit hooks would throw if
  // we tried to render CallView before the room mounts.
  if (!activeCall || activeCall.channelId !== routeId || !perms || starting) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.textDim, marginTop: space(3) }}>Connecting…</Text>
      </SafeAreaView>
    );
  }

  return <CallView title={activeCall.name} perms={perms} onHangUp={() => { endCall(); router.back(); }} />;
}

function CallView({
  title,
  perms,
  onHangUp,
}: {
  title: string;
  perms: CallPerms;
  onHangUp: () => void;
}) {
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
  // We wire iosPIP on the same track the floater would have picked,
  // so iOS auto-PiP fires whether the user backgrounds from the full
  // call view or the floater. The two views are never mounted at the
  // same time (floater hides when on /call/[id]) so they don't race
  // for AVPictureInPictureController, the iOS singleton.
  const pipTrack = usePipTrack();
  const isActive = useIsAppActive();
  // Same local-cam-on-background workaround as the floater: hand the
  // native PIPController a nil track when iOS has paused our local
  // capture, so it shows the fallbackView instead of a frozen frame.
  const liveInPip = pipTrack && !(pipTrack.participant.isLocal && !isActive);
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
          // `pipTrack` comes from a *separate* useTracks subscription
          // (usePipTrack only watches non-placeholder real tracks). Even
          // for the same underlying track LiveKit hands out different
          // object instances per subscription, so `item === pipTrack`
          // is always false and iosPIP never gets wired. Match by
          // participant identity + source instead.
          const isPipTile =
            !isPlaceholder &&
            pipTrack !== null &&
            item.participant.identity === pipTrack.participant.identity &&
            item.source === pipTrack.source;
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
                  // On the pipTile only: clear trackRef while iOS has
                  // suspended local capture so the PIPController swaps
                  // to its fallbackView instead of freezing on the last
                  // frame. The in-app frame shows black for a moment
                  // until foreground returns — fine because by then
                  // the user isn't looking at the call screen anyway.
                  trackRef={isPipTile && !liveInPip ? undefined : item}
                  style={isLocal ? { flex: 1, transform: [{ scaleX: -1 }] } : { flex: 1 }}
                  // Only the chosen pipTrack tile registers iosPIP, so
                  // we don't fight the floater's iosPIP for iOS's
                  // singleton AVPictureInPictureController. Honour the
                  // track's real aspect when available; floater
                  // dimensions are the right "looked at this last"
                  // fallback before the first frame lands.
                  iosPIP={
                    isPipTile
                      ? {
                          enabled: true,
                          startAutomatically: true,
                          preferredSize: item.publication.dimensions ?? PIP_WINDOW_FALLBACK,
                          fallbackView: <PipFallbackView name={displayName} />,
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
        {/* Minimize: pop back to the previous route, which surfaces
            the in-app floater. Same outcome as the OS back gesture
            but discoverable from the in-call control bar. */}
        <CtrlButton
          icon={PictureInPicture}
          a11yLabel="Minimize call"
          onPress={() => router.back()}
          active
        />
        {/* End-call button actually ends the call; the user can also
            navigate away (back gesture / back button) which leaves the
            call running and surfaces the floating tile. */}
        <CtrlButton icon={PhoneOff} a11yLabel="Leave call" onPress={onHangUp} danger />
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
}: {
  icon: LucideIcon;
  a11yLabel: string;
  onPress: () => void;
  active?: boolean;
  off?: boolean;
  danger?: boolean;
}) {
  // Off-state (mic/cam disabled) gets the same red treatment as the
  // leave-call button so the user can see at a glance that they're muted.
  const bg = danger || off ? colors.danger : active ? colors.surfaceAlt : colors.surface;
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
        borderWidth: danger || off ? 0 : 1,
        borderColor: colors.border,
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
