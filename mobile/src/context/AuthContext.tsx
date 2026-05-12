import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '@/lib/supabase';
import { listTeams, type Team } from '@/lib/api';

type AuthState = {
  loading: boolean;
  session: Session | null;
  userId: string | null;
  activeTeam: Team | null;
  setActiveTeam: (t: Team | null) => void;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | undefined>(undefined);

const TEAM_KEY = 'huddle.activeTeamId';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [activeTeam, setActiveTeamState] = useState<Team | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) setActiveTeamState(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Restore the last-used team once we have a session.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const teams = await listTeams().catch(() => [] as Team[]);
      if (cancelled) return;
      const savedId = await SecureStore.getItemAsync(TEAM_KEY).catch(() => null);
      const pick = teams.find((t) => t.id === savedId) ?? (teams.length === 1 ? teams[0] : null);
      setActiveTeamState(pick);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const setActiveTeam = (t: Team | null) => {
    setActiveTeamState(t);
    // Fire-and-forget persistence; failures here are non-fatal.
    if (t) void SecureStore.setItemAsync(TEAM_KEY, t.id).catch(() => {});
    else void SecureStore.deleteItemAsync(TEAM_KEY).catch(() => {});
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      userId: session?.user?.id ?? null,
      activeTeam,
      setActiveTeam,
      signOut,
    }),
    [loading, session, activeTeam],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
