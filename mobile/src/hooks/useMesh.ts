import { useEffect, useRef, useState } from 'react';
import { Mesh, MeshError, type MeshErrorKind, type MeshState } from '@/lib/mesh';

export type UseMeshResult = {
  state: MeshState;
  error: { kind: MeshErrorKind; message: string } | null;
  // Imperative actions. Stable identity so they can sit in deps arrays.
  toggleMic: () => void;
  leave: () => void;
  // Re-construct the mesh from scratch. Use after a recoverable error
  // (transient network failure, permission re-granted in Settings, etc.).
  retry: () => void;
};

const INITIAL_STATE: MeshState = { peers: [], micOn: true, joined: false, reconnecting: false };

// Owns a Mesh instance for the lifetime of the screen. The constructor
// arguments are read once on mount — calling code shouldn't expect the mesh
// to switch teams/channels mid-call; the call screen unmounts and remounts on
// navigation, which is the right reset.
export function useMesh(opts: {
  teamId: string;
  channelId: string;
  myPeerId: string;
  myName: string;
  myColor: string;
  // Fires after disconnect() completes; the call screen pops the route here.
  onLeave?: () => void;
}): UseMeshResult {
  const { teamId, channelId, myPeerId, myName, myColor, onLeave } = opts;
  const meshRef = useRef<Mesh | null>(null);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const [state, setState] = useState<MeshState>(INITIAL_STATE);
  const [error, setError] = useState<UseMeshResult['error']>(null);
  // Bumping this re-runs the connect effect from scratch, which is how
  // retry() recovers from a failed initial join.
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setState(INITIAL_STATE);
    const mesh = new Mesh({ teamId, channelId, myPeerId, myName, myColor });
    meshRef.current = mesh;
    const unsub = mesh.subscribe((s) => {
      if (!cancelled) setState(s);
    });
    mesh.connect().catch((e: unknown) => {
      if (cancelled) return;
      if (e instanceof MeshError) setError({ kind: e.kind, message: e.message });
      else setError({ kind: 'unknown', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
      unsub();
      // Best-effort teardown; errors here just mean we're racing the
      // realtime channel close and don't need to surface to the user.
      mesh.disconnect().catch(() => { /* tearing down anyway */ });
      meshRef.current = null;
    };
    // Re-mount the mesh if the call identity or retryKey changes. The screen
    // normally unmounts on route change so this is mostly defensive aside
    // from retry().
  }, [teamId, channelId, myPeerId, myName, myColor, retryKey]);

  return {
    state,
    error,
    toggleMic: () => { meshRef.current?.toggleMic(); },
    leave: () => {
      meshRef.current?.disconnect().finally(() => onLeaveRef.current?.());
    },
    retry: () => setRetryKey((k) => k + 1),
  };
}
