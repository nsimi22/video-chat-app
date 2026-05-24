import { useMemo } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  VideoTrack,
  isTrackReference,
  useLocalParticipant,
  useTracks,
  type TrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Mic, MicOff, PhoneOff } from 'lucide-react-native';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';
import { useCall } from '@/context/CallContext';

// Mini call window pinned over the route content while the user
// navigates around (channels, settings, etc.). Tap the video to
// return to the full call view; drag to snap to a different corner;
// the tiny control strip handles mute / end-call without expanding.
//
// Only rendered by (app)/_layout.tsx when there's an active call AND
// the current route isn't /call/[id] itself.

// Match the LocalParticipantTile portrait aspect; landscape cams get
// letterboxed but on a phone-sized floater that's fine.
const FLOATER_WIDTH = 110;
const FLOATER_HEIGHT = 150;
const FLOATER_CONTROLS_HEIGHT = 32;
// react-navigation's default bottom-tab content heights (sans safe-area
// inset, which we add separately). Keep this in sync if we override
// `tabBarStyle.height` in (app)/(tabs)/_layout.tsx — there's no React
// hook for it from outside the tab navigator, so we mirror the default
// by hand. See `getDefaultTabBarHeight()` in @react-navigation/bottom-tabs.
const TAB_BAR_CONTENT_HEIGHT = Platform.OS === 'ios' ? 49 : 56;
// Gap from screen edges when snapped into a corner.
const EDGE_PADDING = space(3);
// Velocity multiplier when projecting where a drag would have ended
// on its own — felt right at 0.1 in playtest, higher feels skiddy.
const FLING_PROJECTION = 0.1;
// Minimum drag distance before the pan gesture activates; lets a tap
// fall through to the inner Pressable without triggering a drag.
const PAN_MIN_DISTANCE = 8;

export function FloatingCall() {
  const insets = useSafeAreaInsets();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { activeCall, endCall } = useCall();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Same selection rule as the full-screen PiP: prefer a remote
  // screenshare, then a remote camera, then the local camera as a
  // last resort so a solo caller still sees themself in the floater.
  const floaterTrack = useMemo<TrackReference | null>(() => {
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

  // Corner bounds. These are screen-relative top/left positions
  // (Reanimated drives translateX/Y from {0,0}, so the four corners
  // are absolute coords inside the parent view). Recomputed on
  // dimension changes (orientation, safe-area updates).
  const corners = useMemo(() => {
    const right = winWidth - FLOATER_WIDTH - EDGE_PADDING;
    const left = EDGE_PADDING;
    const top = insets.top + EDGE_PADDING;
    const bottom =
      winHeight - FLOATER_HEIGHT - insets.bottom - TAB_BAR_CONTENT_HEIGHT - space(2);
    return { right, left, top, bottom };
  }, [winWidth, winHeight, insets.top, insets.bottom]);

  // Reanimated shared values for the floater's top-left position.
  // Default: bottom-right corner. We can't useSharedValue(corners.x)
  // directly because corners changes on resize and Reanimated
  // initialisers only fire once — settle on corners.right/bottom up
  // front and let the gesture's snap handler keep things on a corner.
  const x = useSharedValue(corners.right);
  const y = useSharedValue(corners.bottom);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const pan = Gesture.Pan()
    .minDistance(PAN_MIN_DISTANCE)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = startX.value + e.translationX;
      y.value = startY.value + e.translationY;
    })
    .onEnd((e) => {
      // Project where the drag would land on its own, then snap to
      // the nearest of the four corners. iOS PiP, Slack mini-huddle,
      // and Messenger chat heads all behave roughly this way.
      const projectedX = x.value + e.velocityX * FLING_PROJECTION;
      const projectedY = y.value + e.velocityY * FLING_PROJECTION;
      const targetX = projectedX + FLOATER_WIDTH / 2 < winWidth / 2 ? corners.left : corners.right;
      const targetY = projectedY + FLOATER_HEIGHT / 2 < winHeight / 2 ? corners.top : corners.bottom;
      x.value = withSpring(targetX, { damping: 18, stiffness: 180 });
      y.value = withSpring(targetY, { damping: 18, stiffness: 180 });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  if (!activeCall) return null;

  const onExpand = () =>
    router.navigate({
      pathname: '/(app)/call/[id]',
      params: { id: activeCall.channelId, name: activeCall.name },
    });

  const onToggleMute = async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      // Floater is too small to show an error UI. The user can tap
      // to expand and try again — the full call screen surfaces the
      // proper Alert with the rejection reason.
    }
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        // Floater is positioned in absolute coords from {0,0} so the
        // gesture translation maps cleanly onto top/left. The parent
        // view in (app)/_layout.tsx provides the absolute frame.
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            width: FLOATER_WIDTH,
            height: FLOATER_HEIGHT,
            borderRadius: radius.md,
            overflow: 'hidden',
            backgroundColor: colors.surfaceAlt,
            borderWidth: 1,
            borderColor: colors.border,
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 8,
          },
          animatedStyle,
        ]}
      >
        {/* Video region — tap to expand to the full call view. */}
        <Pressable
          onPress={onExpand}
          accessibilityLabel="Return to call"
          accessibilityRole="button"
          style={{ flex: 1 }}
        >
          {floaterTrack ? (
            <VideoTrack
              trackRef={floaterTrack}
              // Mirror the local cam preview so it matches the
              // full-screen view's self-tile.
              style={
                floaterTrack.participant.isLocal
                  ? { flex: 1, transform: [{ scaleX: -1 }] }
                  : { flex: 1 }
              }
              // Native iOS Picture-in-Picture: when the user
              // backgrounds the whole app (home button / app switcher),
              // iOS will pop the floater out into a system-level PiP
              // window overlaying the home screen / other apps. Only
              // wired to the floater (not the full call view) because
              // the floater is the *persistent* track across routes —
              // wiring iosPIP in two places at once would race for the
              // single AVPictureInPictureController iOS gives us.
              iosPIP={{
                enabled: true,
                startAutomatically: true,
                preferredSize: floaterTrack.publication.dimensions ?? { width: 16, height: 9 },
              }}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Avatar name={activeCall.name} size={44} />
            </View>
          )}
        </Pressable>

        {/* Control strip — mute + end-call without having to expand. */}
        <View
          style={{
            height: FLOATER_CONTROLS_HEIGHT,
            flexDirection: 'row',
            backgroundColor: 'rgba(0,0,0,0.65)',
            borderTopWidth: 1,
            borderTopColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <FloatBtn
            icon={isMicrophoneEnabled ? Mic : MicOff}
            onPress={onToggleMute}
            a11y={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
            tint={isMicrophoneEnabled ? '#fff' : colors.danger}
          />
          <View style={{ width: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <FloatBtn
            icon={PhoneOff}
            onPress={endCall}
            a11y="End call"
            tint={colors.danger}
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function FloatBtn({
  icon: Icon,
  onPress,
  a11y,
  tint,
}: {
  icon: typeof Mic;
  onPress: () => void;
  a11y: string;
  tint: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={a11y}
      accessibilityRole="button"
      hitSlop={4}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon size={18} color={tint} strokeWidth={2} />
    </Pressable>
  );
}
