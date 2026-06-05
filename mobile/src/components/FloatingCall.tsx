import { useMemo } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  VideoTrack,
  useLocalParticipant,
} from '@livekit/react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Mic, MicOff, PhoneOff, type LucideIcon } from 'lucide-react-native';
import { Avatar } from '@/components/ui';
import { PipFallbackView } from '@/components/PipFallbackView';
import { colors, radius, space, TAB_BAR_HEIGHT, tabBarOffset } from '@/theme';
import { useCall } from '@/context/CallContext';
import { PIP_WINDOW_FALLBACK, useIsAppBackgrounded, usePipTrack } from '@/lib/pipTrack';

// Mini call window pinned over the route content while the user
// navigates around (channels, settings, etc.). Tap the video to
// return to the full call view; drag to snap to a different corner;
// the tiny control strip handles mute / end-call without expanding.
//
// Only rendered by (app)/_layout.tsx when there's an active call AND
// the current route isn't /call/[id] itself.

// Match the LocalParticipantTile portrait aspect; landscape cams get
// letterboxed but on a phone-sized floater that's fine. Shared with
// the iosPIP `preferredSize` fallback over in lib/pipTrack so the
// system PiP window matches the floater the user just had on screen.
const FLOATER_WIDTH = PIP_WINDOW_FALLBACK.width;
const FLOATER_HEIGHT = PIP_WINDOW_FALLBACK.height;
const FLOATER_CONTROLS_HEIGHT = 32;
// The floating liquid-glass tab bar's geometry lives in theme.ts
// (TAB_BAR_HEIGHT + tabBarOffset) — shared with (app)/(tabs)/_layout.tsx
// so the bottom snap corner clears the glass pill.
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
  // Same selection rule as the full-screen PiP — shared so both
  // surfaces agree on what gets the singleton AVPictureInPictureController.
  const floaterTrack = usePipTrack();
  const isBackgrounded = useIsAppBackgrounded();
  // Local cam capture is suspended by iOS when the app backgrounds, so
  // the PiP layer would freeze on its last frame. Swap to an undefined
  // trackRef in that case — the native PIPController interprets the
  // resulting nil videoTrack as "show the fallbackView" instead.
  // Remote tracks keep streaming over WebRTC regardless and don't need
  // the workaround.
  const showFrozenFallback = !!floaterTrack && floaterTrack.participant.isLocal && isBackgrounded;
  // VideoTrack's trackRef prop is TrackReference | undefined — coerce
  // the usePipTrack null to undefined to match (this branch only fires
  // when floaterTrack is non-null anyway).
  const videoTrackForPip = showFrozenFallback ? undefined : floaterTrack ?? undefined;

  // Corner bounds. These are screen-relative top/left positions
  // (Reanimated drives translateX/Y from {0,0}, so the four corners
  // are absolute coords inside the parent view). Recomputed on
  // dimension changes (orientation, safe-area updates).
  const corners = useMemo(() => {
    const right = winWidth - FLOATER_WIDTH - EDGE_PADDING;
    const left = EDGE_PADDING;
    const top = insets.top + EDGE_PADDING;
    const bottom =
      winHeight - FLOATER_HEIGHT - tabBarOffset(insets.bottom) - TAB_BAR_HEIGHT - space(2);
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
          {/* The VideoTrack stays MOUNTED while the floater shows and is
              driven via trackRef — unmounting a PiP-registered video view
              (e.g. the pip track going null when a camera mutes) trips
              Fabric's recycle assertion and aborts the app. Same fix as
              the full call view's tiles. */}
          <VideoTrack
            // When local + backgrounded (or no eligible track at all),
            // drop to undefined so the native PIPController sees a nil
            // video track and swaps to the fallbackView (an "Audio only"
            // panel) instead of freezing on the last frame iOS gave us.
            trackRef={videoTrackForPip}
            // Mirror the local cam preview so it matches the
            // full-screen view's self-tile.
            style={
              floaterTrack?.participant.isLocal
                ? { flex: 1, transform: [{ scaleX: -1 }] }
                : { flex: 1 }
            }
            // Native iOS Picture-in-Picture: when the user
            // backgrounds the whole app (home button / app switcher),
            // iOS will pop the floater out into a system-level PiP
            // window overlaying the home screen / other apps.
            iosPIP={{
              enabled: true,
              startAutomatically: true,
              preferredSize: floaterTrack?.publication.dimensions ?? PIP_WINDOW_FALLBACK,
              fallbackView: <PipFallbackView name={activeCall.name} />,
            }}
          />
          {!floaterTrack && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
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
  icon: LucideIcon;
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
