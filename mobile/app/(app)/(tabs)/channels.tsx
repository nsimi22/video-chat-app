import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Text, TouchableOpacity, View, ActivityIndicator, SectionList } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Lock, Plus, Users } from 'lucide-react-native';
import { listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Avatar, Logo } from '@/components/ui';
import { NewChannelSheet } from '@/components/NewChannelSheet';
import { NewDmSheet } from '@/components/NewDmSheet';
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
  const [refreshing, setRefreshing] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  const load = useCallback(async ({ pull = false }: { pull?: boolean } = {}) => {
    if (!activeTeam) return;
    // Only flip the RefreshControl when the user actually pulled. On the
    // initial focus load we render the spinner instead; otherwise iOS 26
    // can leave the contentInset stuck in the pulled-down position even
    // after refreshing goes false (visible as a ~80px empty band at the
    // top of every tab until the user manually pulls again).
    if (pull) setRefreshing(true);
    try {
      const [ch, pr] = await Promise.all([listChannels(activeTeam.id), listTeamProfiles(activeTeam.id)]);
      setChannels(ch);
      setProfiles(pr);
    } finally {
      setLoading(false);
      if (pull) setRefreshing(false);
    }
  }, [activeTeam]);

  const onPullRefresh = useCallback(() => { load({ pull: true }); }, [load]);

  // useFocusEffect fires on first focus too, so it doubles as the initial
  // load — no separate useEffect needed.
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

  // Always render both sections — the + button on the header is the entry
  // point for create-channel / new-DM, so it has to be visible even when
  // there are no rows yet. SectionList renders the header before any data,
  // so an empty `data` is the right shape.
  type Section = { title: 'Channels' | 'Direct Messages'; data: Channel[] };
  const sections: Section[] = [
    { title: 'Channels', data: channelList },
    { title: 'Direct Messages', data: dmList },
  ];

  function openChannel(id: string, name: string) {
    router.push({ pathname: '/(app)/channel/[id]', params: { id, name } });
  }

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
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={onPullRefresh} />}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => {
          // Mirror desktop's section-header-row: title + ghost "+" button.
          const isChannels = section.title === 'Channels';
          const onAdd = isChannels ? () => setNewChannelOpen(true) : () => setNewDmOpen(true);
          const a11y = isChannels ? 'Create a channel' : 'New direct message';
          return (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: space(4),
                paddingTop: space(4),
                paddingBottom: space(2),
              }}
            >
              <Text
                style={{
                  color: colors.textDim,
                  fontSize: 12,
                  fontWeight: '600',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                {section.title}
              </Text>
              <TouchableOpacity onPress={onAdd} hitSlop={10} accessibilityLabel={a11y}>
                <Plus size={16} color={colors.textDim} strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
          );
        }}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? (
            <Text
              style={{
                color: colors.textDim,
                fontSize: 13,
                paddingHorizontal: space(4),
                paddingVertical: space(3),
              }}
            >
              {section.title === 'Channels' ? 'No channels yet. Tap + to create one.' : 'No direct messages yet. Tap + to start one.'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const dm = item.type === 'dm';
          const other = dm ? dmPeerId(item.id, userId) : null;
          const otherProfile = other ? profiles.find((p) => p.user_id === other) : null;
          const isGroupDm = dm && !other;
          return (
            <TouchableOpacity
              onPress={() => openChannel(item.id, channelLabel(item, profiles, userId))}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3.5), borderBottomWidth: 1, borderBottomColor: colors.border }}
            >
              {dm && otherProfile ? (
                <Avatar name={otherProfile.name} color={otherProfile.color} size={30} uri={otherProfile.avatar_url} />
              ) : (
                <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
                  {isGroupDm ? (
                    <Users size={18} color={colors.textDim} strokeWidth={2} />
                  ) : item.type === 'private' ? (
                    <Lock size={16} color={colors.textDim} strokeWidth={2} />
                  ) : (
                    <Text style={{ color: colors.textDim, fontSize: 18 }}>#</Text>
                  )}
                </View>
              )}
              <Text style={{ color: colors.text, fontSize: 16, marginLeft: space(3), flex: 1 }} numberOfLines={1}>
                {channelLabel(item, profiles, userId)}
              </Text>
            </TouchableOpacity>
          );
        }}
      />

      {activeTeam && userId && (
        <>
          <NewChannelSheet
            visible={newChannelOpen}
            onClose={() => setNewChannelOpen(false)}
            teamId={activeTeam.id}
            creatorId={userId}
            roster={profiles}
            onCreated={(ch) => {
              // Realtime will repopulate the list on its own, but jump
              // straight into the new channel so the create-then-write
              // flow feels native (matches desktop's openChannel call
              // after createChannel).
              openChannel(ch.id, ch.name);
            }}
          />
          <NewDmSheet
            visible={newDmOpen}
            onClose={() => setNewDmOpen(false)}
            teamId={activeTeam.id}
            creatorId={userId}
            roster={profiles}
            onOpened={(ch) => openChannel(ch.id, channelLabel(ch, profiles, userId))}
          />
        </>
      )}
    </SafeAreaView>
  );
}
