import { useEffect, useRef, useState } from 'react';
import { Mesh, type MeshState } from '@/lib/mesh';

export type UseMeshResult = {
  state: MeshState;
  error: string | null;
  // Imperative actions. Stable identity so they can sit in deps arrays.
  toggleMic: () => void;
  leave: () => void;
};

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
  const [state, setState] = useState<MeshState>({ peers: [], micOn: true, joined: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mesh = new Mesh({ teamId, channelId, myPeerId, myName, myColor });
    meshRef.current = mesh;
    const unsub = mesh.subscribe((s) => {
      if (!cancelled) setState(s);
    });
    mesh.connect().catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      unsub();
      // Best-effort teardown; errors here just mean we're racing the
      // realtime channel close and don't need to surface to the user.
      mesh.disconnect().catch(() => { /* tearing down anyway */ });
      meshRef.current = null;
    };
    // Re-mount the mesh if the call identity changes. The screen normally
    // unmounts on route change so this is mostly defensive.
  }, [teamId, channelId, myPeerId, myName, myColor]);

  return {
    state,
    error,
    toggleMic: () => { meshRef.current?.toggleMic(); },
    leave: () => {
      meshRef.current?.disconnect().finally(() => onLeaveRef.current?.());
    },
  };
}
