import { useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  VideoTrack,
  isTrackReference,
  useTracks,
  type TrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';
import { useCall } from '@/context/CallContext';

// Mini call window pinned to the bottom-right corner of the app
// while the user navigates around (channels, settings, etc.). Tapping
// it returns to the full call view. Only rendered by (app)/_layout.tsx
// when there's an active call AND the current route isn't /call/[id]
// itself. Sits above the tab bar via insets.bottom + a tab-bar fudge.

// Match the LocalParticipantTile portrait aspect; landscape cams get
// letterboxed but on a phone-sized floater that's fine.
const FLOATER_WIDTH = 110;
const FLOATER_HEIGHT = 150;
// Approximate room for the bottom-tab strip; safer than parsing the
// runtime tab-bar height which requires being inside the tab navigator.
const TAB_BAR_OFFSET = 56;

export function FloatingCall() {
  const insets = useSafeAreaInsets();
  const { activeCall } = useCall();
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

  if (!activeCall) return null;

  const onExpand = () =>
    router.navigate({
      pathname: '/(app)/call/[id]',
      params: { id: activeCall.channelId, name: activeCall.name },
    });

  return (
    <TouchableOpacity
      onPress={onExpand}
      activeOpacity={0.85}
      accessibilityLabel="Return to call"
      accessibilityRole="button"
      // Absolute placement on top of whatever route is rendered.
      // Anchored to the bottom-right safe-area corner.
      style={{
        position: 'absolute',
        right: space(3),
        bottom: insets.bottom + TAB_BAR_OFFSET + space(2),
        width: FLOATER_WIDTH,
        height: FLOATER_HEIGHT,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: colors.surfaceAlt,
        borderWidth: 1,
        borderColor: colors.border,
        // Soft drop shadow so the floater reads as detached from the
        // route content underneath.
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
      }}
    >
      {floaterTrack ? (
        <VideoTrack
          trackRef={floaterTrack}
          // Mirror the local cam preview to match the full-screen view.
          style={
            floaterTrack.participant.isLocal
              ? { flex: 1, transform: [{ scaleX: -1 }] }
              : { flex: 1 }
          }
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Avatar name={activeCall.name} size={44} />
        </View>
      )}
    </TouchableOpacity>
  );
}
