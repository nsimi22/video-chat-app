import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Text, TouchableOpacity, View, ActivityIndicator, SectionList } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Avatar, Logo } from '@/components/ui';
import { colors, space } from '@/theme';

// DM channel ids look like `dm:<a>::<b>` with the two user uuids sorted
// (see renderer/api.js openDm). Return the *other* participant's uuid for
// 1:1s; null for group DMs (`gdm:<uuid>`) and non-DM channels.
function dmPeerId(channelId: string, me: string | null): string | null {
  if (!channelId.startsWith('dm:')) return null;
  return channelId.replace(/^dm:/, '').split('::').find((x) => x && x !== me) ?? null;
}

function channelLabel(c: Channel, profiles: Profile[], me: string | null): string {
  if (c.type === 'dm') {
    const other = dmPeerId(c.id, me);
    if (other) return profiles.find((p) => p.user_id === other)?.name ?? 'Direct message';
    return c.name || 'Group DM';
  }
  return c.name;
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

  useEffect(() => { load(); }, [load]);
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

  const channelList = channels.filter((c) => c.type !== 'dm').sort((a, b) => a.name.localeCompare(b.name));
  const dmList = channels.filter((c) => c.type === 'dm').sort((a, b) => channelLabel(a, profiles, userId).localeCompare(channelLabel(b, profiles, userId)));

  const sections: { title: string; data: Channel[] }[] = [];
  if (channelList.length) sections.push({ title: 'Channels', data: channelList });
  if (dmList.length) sections.push({ title: 'Direct Messages', data: dmList });

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Brand header. Sits above the SectionList so the workspace name
          is always visible — the tabs layout hides the navigation
          header for this screen. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(3) }}>
        <Logo size={32} />
        <View style={{ marginLeft: space(3), flex: 1 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 2 }}>Workspace</Text>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }} numberOfLines={1}>
            {activeTeam?.name ?? 'Huddle'}
          </Text>
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(c) => `${c.team_id}/${c.id}`}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={false} onRefresh={load} />}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section: { title } }) => (
          <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: space(4), paddingTop: space(4), paddingBottom: space(2) }}>
            {title}
          </Text>
        )}
        renderItem={({ item }) => {
          const dm = item.type === 'dm';
          const other = dm ? dmPeerId(item.id, userId) : null;
          const otherProfile = other ? profiles.find((p) => p.user_id === other) : null;
          const isGroupDm = dm && !other;
          return (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/(app)/channel/[id]', params: { id: item.id, name: channelLabel(item, profiles, userId) } })}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3.5), borderBottomWidth: 1, borderBottomColor: colors.border }}
            >
              {dm && otherProfile ? (
                <Avatar name={otherProfile.name} color={otherProfile.color} size={30} uri={otherProfile.avatar_url} />
              ) : (
                <Text style={{ color: colors.textDim, fontSize: 18, width: 30, textAlign: 'center' }}>
                  {isGroupDm ? '👥' : item.type === 'private' ? '🔒' : '#'}
                </Text>
              )}
              <Text style={{ color: colors.text, fontSize: 16, marginLeft: space(3), flex: 1 }} numberOfLines={1}>
                {channelLabel(item, profiles, userId)}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={{ padding: space(6), alignItems: 'center' }}>
            <Text style={{ color: colors.textDim, fontSize: 14 }}>No channels yet.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}
