import { useMemo } from 'react';
import {
  isTrackReference,
  useTracks,
  type TrackReference,
} from '@livekit/react-native';
import { Track } from 'livekit-client';

// Shared selection rule for "which one track gets PiP" — both the
// full call view (mobile/app/(app)/call/[id].tsx) and the in-app
// floater (mobile/src/components/FloatingCall.tsx) wire iosPIP to
// exactly one tile, and they need to agree on which. iOS's
// AVPictureInPictureController is a process-wide singleton; if the
// two views disagreed they'd race for it on every route change.

// Floater render box. Also used as the iosPIP `preferredSize` fallback
// in both call surfaces so the system-level PiP window opens at a
// sensible portrait shape before the first frame's `publication.dimensions`
// land. Kept here so the call view can reference it without pulling
// in the floater module just for two numbers.
export const PIP_WINDOW_FALLBACK = { width: 110, height: 150 } as const;

/**
 * Picks the track that should drive iOS PiP. Priority:
 *   1. a remote screenshare (most useful: the thing the user is
 *      actively watching when they background the app)
 *   2. a remote camera (someone's face stays visible)
 *   3. the local camera as a last resort, so a solo caller still
 *      sees PiP — iOS will stop the local capture on background and
 *      the window will go black, but the *mechanism* still works and
 *      swaps to a remote tile the moment one appears.
 * Returns null when there's nothing eligible (placeholder-only,
 * everyone muted) — caller should skip rendering iosPIP entirely.
 */
export function usePipTrack(): TrackReference | null {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  return useMemo<TrackReference | null>(() => {
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
}
