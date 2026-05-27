import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '@/lib/supabase';
import { listTeams, type Team } from '@/lib/api';
import { isEnabled as biometricPrefEnabled } from '@/lib/biometricPref';

type AuthState = {
  loading: boolean;
  session: Session | null;
  userId: string | null;
  activeTeam: Team | null;
  setActiveTeam: (t: Team | null) => void;
  signOut: () => Promise<void>;
  locked: boolean;
  unlock: () => void;
};

const Ctx = createContext<AuthState | undefined>(undefined);

const TEAM_KEY = 'huddle.activeTeamId';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [activeTeam, setActiveTeamState] = useState<Team | null>(null);
  // Biometric lock — true on cold start if a session exists and the user
  // has opted in. Subsequent sign-ins within the same JS runtime are not
  // re-locked: the `coldStart` ref ensures we only consult the pref once.
  const [locked, setLocked] = useState(false);
  const coldStart = useRef(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        // Keep `loading` true if we have a session so the restore-team
        // effect below can finish before Index routes. If there's no
        // session at all there's nothing to restore — flip false now so
        // the user lands on the login screen immediately.
        if (!data.session) {
          setLoading(false);
          coldStart.current = false;
          return;
        }
        const uid = data.session.user.id;
        if (coldStart.current && (await biometricPrefEnabled(uid).catch(() => false))) {
          setLocked(true);
        }
        coldStart.current = false;
      })
      // If the SDK fails to even resolve the session (low-level
      // network blip, native crypto issue), bail out of loading or
      // the user is stranded on the spinner forever.
      .catch(() => setLoading(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) {
        setActiveTeamState(null);
        setLocked(false);
        // Defensive: covers the case where the user signs out while
        // the restore is still in flight; without this `loading`
        // would stay true forever and Index would never re-route.
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Restore the last-used team once we have a session. Keep `loading`
  // true throughout the *first* restore so Index doesn't bounce to
  // the team picker before we've had a chance to read SecureStore.
  // On subsequent session changes (token refresh) activeTeam is
  // already set, so we don't flip loading — that avoids a spinner
  // flash on consumers of `loading` every time the access token
  // refreshes in the background.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    if (!activeTeam) setLoading(true);
    (async () => {
      // Distinguish "API failed" (null) from "got empty list" ([]).
      // A transient failure during a background token refresh would
      // otherwise null out activeTeam and bounce the user back to
      // the picker.
      const teams = await listTeams().catch(() => null);
      if (cancelled) return;
      if (teams !== null) {
        const savedId = await SecureStore.getItemAsync(TEAM_KEY).catch(() => null);
        const pick = teams.find((t) => t.id === savedId) ?? (teams.length === 1 ? teams[0] : null);
        setActiveTeamState(pick);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // activeTeam is intentionally read but not a dep — we only want
    // to re-run on session change, not when the team changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const setActiveTeam = (t: Team | null) => {
    setActiveTeamState(t);
    // Fire-and-forget persistence; failures here are non-fatal but worth
    // surfacing — silently dropping the write means the user lands on the
    // team picker every launch, which looks like a bug not a storage error.
    const onWriteErr = (err: unknown) => console.warn('[auth] team persist failed', err);
    if (t) void SecureStore.setItemAsync(TEAM_KEY, t.id).catch(onWriteErr);
    else void SecureStore.deleteItemAsync(TEAM_KEY).catch(onWriteErr);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const unlock = () => setLocked(false);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      userId: session?.user?.id ?? null,
      activeTeam,
      setActiveTeam,
      signOut,
      locked,
      unlock,
    }),
    [loading, session, activeTeam, locked],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
