import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Camera } from 'expo-camera';
import { AudioSession } from '@livekit/react-native';
import { getCallToken, type LiveKitGrant } from '@/lib/livekit';
import { startCallForegroundService, stopCallForegroundService } from '@/lib/callForegroundService';
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
    // Drop call state synchronously; the layout's CallRoomShell
    // re-renders next tick and unmounts the LiveKitRoom. The audio
    // session stop is deferred to a useEffect (see below) so it
    // runs *after* React commits the unmount — otherwise we tear
    // down the iOS audio session while the room is still using it
    // and iOS logs an "audio session deactivated while in use" warning.
    setActiveCall(null);
    setPerms(null);
    setStarting(false);
    startingRef.current = false;
  }, []);

  // Audio session lifecycle is split across two places intentionally:
  //   - startCall() calls startAudioSession() inline (before any LiveKit
  //     work; iOS needs the session active for getUserMedia to capture)
  //   - here, we stop the session only after `activeCall` has flipped to
  //     null and React has committed the LiveKitRoom unmount.
  // Same logic applies to the Android foreground service (which itself
  // is a no-op on iOS — see lib/callForegroundService).
  useEffect(() => {
    if (!activeCall && !startingRef.current) {
      AudioSession.stopAudioSession();
      stopCallForegroundService();
    }
  }, [activeCall]);

  // Ref-mirror of the active team so the in-flight startCall path can
  // detect a team-switch race without the useCallback closure capturing
  // a stale value. `activeTeam` (the dep) is captured at startCall
  // construction time; if the user switches teams while the perms +
  // token-fetch promise is in flight, that closure still sees the old
  // team and would otherwise resurrect a ghost call for it.
  const activeTeamRef = useRef(activeTeam);
  activeTeamRef.current = activeTeam;

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
      const startTeamId = activeTeam.id;
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
        // Team-switch race: the user signed into a different team
        // while perms + token were in flight. The grant we just
        // fetched is tied to the old team and the team-switch
        // teardown effect already ran (cleared activeCall, stopped
        // audio session). Abandon this startCall — resurrecting
        // activeCall here would surface a ghost call for the
        // team the user is no longer viewing.
        if (activeTeamRef.current?.id !== startTeamId) {
          AudioSession.stopAudioSession();
          stopCallForegroundService();
          return;
        }
        setPerms({ camera: camRes.granted, mic: micRes.granted });
        setActiveCall({ channelId, name: name ?? 'Call', grant });
        // Android: drop a persistent "in call" notification that
        // promotes our process to a foreground service. iOS no-op.
        // Failures here don't block the call — the helper logs and
        // continues. See lib/callForegroundService.
        startCallForegroundService(name ?? 'Call');
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
        AudioSession.stopAudioSession();
        stopCallForegroundService();
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
