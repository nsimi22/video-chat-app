import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Avatar } from '@/components/ui';
import { colors, space } from '@/theme';

// DM channel ids look like `dm:<a>::<b>` with the two user uuids sorted
// (see renderer/api.js openDm). Return the *other* participant's uuid.
function dmPeerId(channelId: string, me: string | null): string | null {
  return channelId.replace(/^dm:/, '').split('::').find((x) => x && x !== me) ?? null;
}

function channelLabel(c: Channel, profiles: Profile[], me: string | null): string {
  if (c.type === 'dm') {
    const other = dmPeerId(c.id, me);
    return profiles.find((p) => p.user_id === other)?.name ?? 'Direct message';
  }
  return `# ${c.name}`;
}

export default function ChannelsScreen() {
  const { activeTeam, userId } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeTeam) return;
    const [ch, pr] = await Promise.all([listChannels(activeTeam.id), listTeamProfiles(activeTeam.id)]);
    setChannels(ch);
    setProfiles(pr);
    setLoading(false);
  }, [activeTeam]);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Live channel list (new channels, renames, archive).
  useEffect(() => {
    if (!activeTeam) return;
    const sub = supabase
      .channel(`db:channels:${activeTeam.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'channels', filter: `team_id=eq.${activeTeam.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [activeTeam, load]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const sorted = [...channels].sort((a, b) => {
    if (a.type === 'dm' && b.type !== 'dm') return 1;
    if (b.type === 'dm' && a.type !== 'dm') return -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      data={sorted}
      keyExtractor={(c) => `${c.team_id}/${c.id}`}
      refreshControl={<RefreshControl tintColor={colors.accent} refreshing={false} onRefresh={load} />}
      renderItem={({ item }) => {
        const dm = item.type === 'dm';
        const other = dm ? dmPeerId(item.id, userId) : null;
        const otherProfile = other ? profiles.find((p) => p.user_id === other) : null;
        return (
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/(app)/channel/[id]', params: { id: item.id, name: channelLabel(item, profiles, userId) } })}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3.5), borderBottomWidth: 1, borderBottomColor: colors.border }}
          >
            {dm ? (
              <Avatar name={otherProfile?.name ?? '?'} color={otherProfile?.color} size={30} uri={otherProfile?.avatar_url} />
            ) : (
              <Text style={{ color: colors.textDim, fontSize: 18, width: 30, textAlign: 'center' }}>
                {item.type === 'private' ? '🔒' : '#'}
              </Text>
            )}
            <Text style={{ color: colors.text, fontSize: 16, marginLeft: space(3), flex: 1 }} numberOfLines={1}>
              {dm ? otherProfile?.name ?? 'Direct message' : item.name}
            </Text>
          </TouchableOpacity>
        );
      }}
      ListHeaderComponent={
        <TouchableOpacity onPress={() => router.push('/(app)/settings')} style={{ padding: space(4), alignItems: 'flex-end' }}>
          <Text style={{ color: colors.accent }}>Settings</Text>
        </TouchableOpacity>
      }
    />
  );
}
