import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Camera } from 'expo-camera';
import { AudioSession } from '@livekit/react-native';
import { getCallToken, type LiveKitGrant } from '@/lib/livekit';
import { useAuth } from '@/context/AuthContext';

// Owns the in-progress call so the LiveKit room can outlive the
// /(app)/call/[id] screen. Hoisted into (app)/_layout.tsx so the
// peer connection survives any route change — the user can pop back
// to a channel to read messages while the call keeps running, with a
// floating tile (see components/FloatingCall.tsx) keeping the video
// visible.

export type ActiveCall = {
  channelId: string;
  name: string;
  grant: LiveKitGrant;
};

export type CallPerms = { camera: boolean; mic: boolean };

type CallState = {
  activeCall: ActiveCall | null;
  perms: CallPerms | null;
  // Last setup error (token fetch, perms ask). Surfaced via Alert at
  // the call site, then read-once and cleared.
  error: string | null;
  // True while a startCall is in flight, so the call screen can show
  // its loading spinner instead of flashing the empty CallView frame.
  starting: boolean;
  startCall: (channelId: string, name?: string) => Promise<void>;
  endCall: () => void;
  clearError: () => void;
};

const Ctx = createContext<CallState | undefined>(undefined);

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { activeTeam } = useAuth();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [perms, setPerms] = useState<CallPerms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Guards against the user mashing the call button while the prior
  // startCall is mid-flight (e.g. perms prompt + token fetch can take
  // a second on a slow network).
  const startingRef = useRef(false);

  const endCall = useCallback(() => {
    // Order: clear React state first so the LiveKitRoom in the
    // layout unmounts (it's gated on activeCall), then stop the iOS
    // audio session. Stopping the session before disconnect logs a
    // warning on iOS about deactivating an in-use audio session.
    setActiveCall(null);
    setPerms(null);
    setStarting(false);
    startingRef.current = false;
    AudioSession.stopAudioSession();
  }, []);

  const startCall = useCallback(
    async (channelId: string, name?: string) => {
      if (!activeTeam) {
        setError('No active team — pick a workspace first.');
        return;
      }
      // Same in-flight call → no-op. Different in-flight call →
      // tear the previous one down (last-wins) before starting.
      if (activeCall?.channelId === channelId) return;
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      setError(null);
      if (activeCall) {
        // Last-wins: starting a new call ends the current one.
        endCall();
      }
      try {
        AudioSession.startAudioSession();
        // Run perms ask + token fetch in parallel. Native perm
        // prompts return cached decisions instantly after first ask,
        // so this is one round-trip on subsequent calls.
        const [camRes, micRes, grant] = await Promise.all([
          Camera.requestCameraPermissionsAsync(),
          Camera.requestMicrophonePermissionsAsync(),
          getCallToken(activeTeam.id, channelId),
        ]);
        setPerms({ camera: camRes.granted, mic: micRes.granted });
        setActiveCall({ channelId, name: name ?? 'Call', grant });
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
        AudioSession.stopAudioSession();
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [activeTeam, activeCall, endCall],
  );

  // Tear the call down on sign-out / team switch — the LiveKit grant
  // is team-scoped, so a stale activeCall would be unreachable anyway.
  useEffect(() => {
    if (!activeTeam) {
      endCall();
    }
  }, [activeTeam, endCall]);

  const clearError = useCallback(() => setError(null), []);

  return (
    <Ctx.Provider value={{ activeCall, perms, error, starting, startCall, endCall, clearError }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCall(): CallState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCall must be used within CallProvider');
  return v;
}
