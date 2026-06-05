import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

// Starred channels/DMs. Persisted in user_integrations.settings.favorites
// (channelIds: string[]) — the same slot the desktop renderer writes
// (renderer/app.js toggleFavorite) — so favorites follow the user across
// devices. Saves are read-modify-write of the settings blob, merging ONLY
// the favorites key so we can't clobber Jira/AI/GitHub credentials the
// desktop Settings panel owns. Writes are chained like desktop's
// favoritesSave promise so rapid toggles can't land out of order.

type State = {
  favorites: string[];
  isFavorite: (channelId: string) => boolean;
  toggleFavorite: (channelId: string) => void;
};

const Ctx = createContext<State | undefined>(undefined);

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [favorites, setFavorites] = useState<string[]>([]);
  const saveChain = useRef(Promise.resolve());

  useEffect(() => {
    if (!userId) { setFavorites([]); return; }
    let cancelled = false;
    supabase
      .from('user_integrations')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const ids = (data?.settings as { favorites?: { channelIds?: string[] } } | null)?.favorites?.channelIds;
        if (Array.isArray(ids)) setFavorites(ids.filter((x) => typeof x === 'string'));
      });
    return () => { cancelled = true; };
  }, [userId]);

  const persist = useCallback((ids: string[]) => {
    if (!userId) return;
    saveChain.current = saveChain.current
      .then(async () => {
        // Re-read inside the chain so the merge sees the freshest blob
        // (another device may have written credentials in the meantime).
        const { data } = await supabase
          .from('user_integrations')
          .select('settings')
          .eq('user_id', userId)
          .maybeSingle();
        const settings = { ...((data?.settings as Record<string, unknown>) ?? {}) };
        settings.favorites = { ...(settings.favorites as Record<string, unknown> | undefined), channelIds: ids };
        const { error } = await supabase
          .from('user_integrations')
          .upsert({ user_id: userId, settings }, { onConflict: 'user_id' });
        if (error) throw error;
      })
      .catch((err) => console.warn('[favorites] save failed', err));
  }, [userId]);

  const toggleFavorite = useCallback((channelId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId];
      persist(next);
      return next;
    });
  }, [persist]);

  const isFavorite = useCallback((channelId: string) => favorites.includes(channelId), [favorites]);

  const value = useMemo<State>(() => ({ favorites, isFavorite, toggleFavorite }), [favorites, isFavorite, toggleFavorite]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFavorites(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFavorites must be used within FavoritesProvider');
  return v;
}
