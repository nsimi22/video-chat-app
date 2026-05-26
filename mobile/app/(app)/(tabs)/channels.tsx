import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, Text, TouchableOpacity, View, ActivityIndicator, SectionList } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BellOff, Lock, Plus, Trash2, Users } from 'lucide-react-native';
import { deleteChannel, leaveDmChannel, listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useMutedChannels } from '@/context/MutedChannelsContext';
import { supabase } from '@/lib/supabase';
import { Avatar, Logo } from '@/components/ui';
import { NewChannelSheet } from '@/components/NewChannelSheet';
import { NewDmSheet } from '@/components/NewDmSheet';
import { UnreadBadge } from '@/components/UnreadBadge';
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

// Group DMs use a `gdm:<uuid>` channel id; 1:1 DMs use `dm:<a>::<b>`.
function isGroupDm(c: Channel): boolean {
  return c.type === 'dm' && c.id.startsWith('gdm:');
}

// Mirrors desktop's canDelete() (renderer/app.js): protected channels
// (#general, etc.) are never deletable; any DM member can close their
// DM or leave their group; named channels are only deletable by their
// creator. RLS enforces the same rules server-side — this just skips
// wrapping the row in a swipe gesture so users can't even reveal a
// trash button for something the backend would reject.
function canDelete(c: Channel, userId: string): boolean {
  if (c.protected) return false;
  if (c.type === 'dm') return true;
  return !!c.created_by && c.created_by === userId;
}

export default function ChannelsScreen() {
  const { activeTeam, userId } = useAuth();
  const { isMuted, toggle: toggleMute } = useMutedChannels();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  // Long-press on a row pops a small action sheet. Using Alert.alert
  // (Apple's UIAlertController on iOS, AlertDialog on Android) instead
  // of a custom bottom sheet keeps the surface lightweight and
  // platform-native; there's only one real action right now (mute) so
  // a dedicated sheet would be overkill.
  const onLongPressRow = useCallback((channel: Channel, label: string, muted: boolean) => {
    Alert.alert(
      label,
      muted ? 'Notifications are silenced for this channel.' : undefined,
      [
        {
          text: muted ? 'Unmute' : 'Mute notifications',
          onPress: () => toggleMute(channel.id),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [toggleMute]);

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

  // Swipe-left on a row exposes a red trash button (see ChannelRow); tapping
  // it lands here, opens a confirm Alert, then deletes (or closes/leaves).
  // Mirrors desktop's sidebar X-button (renderer/app.js). DELETE on the
  // channels table fans out via the realtime subscription above and
  // refreshes the list; the leave-group branch only changes
  // channel_members, so we reload manually after success.
  function confirmDelete(item: Channel, label: string, closeSwipe: () => void) {
    if (!userId) return;
    if (isGroupDm(item)) {
      Alert.alert(
        `Leave "${label}"?`,
        "You won't get new messages unless someone adds you back.",
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Leave',
            style: 'destructive',
            onPress: async () => {
              try {
                await leaveDmChannel(item.team_id, item.id, userId);
                closeSwipe();
                load();
              } catch (err) {
                Alert.alert('Could not leave', (err as Error)?.message ?? String(err));
              }
            },
          },
        ],
      );
      return;
    }
    const isDm = item.type === 'dm';
    const verb = isDm ? 'Close' : 'Delete';
    const target = isDm ? `your DM with ${label}` : `#${item.name}`;
    Alert.alert(
      `${verb} ${target}?`,
      'This is permanent.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb,
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteChannel(item.team_id, item.id);
              closeSwipe();
              // channels realtime DELETE event will trigger load()
            } catch (err) {
              Alert.alert(`Could not ${verb.toLowerCase()}`, (err as Error)?.message ?? String(err));
            }
          },
        },
      ],
    );
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
          const label = channelLabel(item, profiles, userId);
          const deletable = !!userId && canDelete(item, userId);
          const muted = isMuted(item.id);
          return (
            <ChannelRow
              item={item}
              label={label}
              profiles={profiles}
              meId={userId}
              deletable={deletable}
              muted={muted}
              onOpen={() => openChannel(item.id, label)}
              onRequestDelete={(close) => confirmDelete(item, label, close)}
              onLongPress={() => onLongPressRow(item, label, muted)}
            />
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

// Single channel/DM row. When `deletable`, wraps the row in a
// swipe-left-reveals-trash gesture (iOS Mail / Messages convention).
// The trash tap fires onRequestDelete with a close() callback so the
// caller can collapse the swipe after a successful API call.
function ChannelRow({
  item,
  label,
  profiles,
  meId,
  deletable,
  muted,
  onOpen,
  onRequestDelete,
  onLongPress,
}: {
  item: Channel;
  label: string;
  profiles: Profile[];
  meId: string | null;
  deletable: boolean;
  muted: boolean;
  onOpen: () => void;
  onRequestDelete: (close: () => void) => void;
  onLongPress: () => void;
}) {
  const swipeRef = useRef<SwipeableMethods>(null);
  const dm = item.type === 'dm';
  const other = dm ? dmPeerId(item.id, meId) : null;
  const otherProfile = other ? profiles.find((p) => p.user_id === other) : null;
  const groupDm = dm && !other;

  const row = (
    // backgroundColor is required so the row paints over the red action
    // panel during the swipe — without it the trash button bleeds through
    // before the gesture fully exposes it.
    <TouchableOpacity
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={350}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.bg,
        paddingHorizontal: space(4),
        paddingVertical: space(3.5),
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      {dm && otherProfile ? (
        <Avatar name={otherProfile.name} color={otherProfile.color} size={30} uri={otherProfile.avatar_url} />
      ) : (
        <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
          {groupDm ? (
            <Users size={18} color={colors.textDim} strokeWidth={2} />
          ) : item.type === 'private' ? (
            <Lock size={16} color={colors.textDim} strokeWidth={2} />
          ) : (
            <Text style={{ color: colors.textDim, fontSize: 18 }}>#</Text>
          )}
        </View>
      )}
      {/* Muted channels dim the label to match Slack's "I muted this on
          purpose" affordance — combined with the bell-off icon it gives
          two converging visual cues without competing with the row's
          tappability. */}
      <Text
        style={{
          color: muted ? colors.textDim : colors.text,
          fontSize: 16,
          marginLeft: space(3),
          flex: 1,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {muted && (
        <BellOff
          size={14}
          color={colors.textDim}
          strokeWidth={2}
          style={{ marginRight: space(2) }}
          accessibilityLabel="Muted"
        />
      )}
      <UnreadBadge channelId={item.id} />
    </TouchableOpacity>
  );

  if (!deletable) return row;

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => {
        const verb = isGroupDm(item) ? 'Leave' : item.type === 'dm' ? 'Close DM with' : 'Delete';
        return (
          <TouchableOpacity
            accessibilityLabel={`${verb} ${label}`}
            onPress={() => onRequestDelete(() => swipeRef.current?.close())}
            style={{
              backgroundColor: colors.danger,
              justifyContent: 'center',
              alignItems: 'center',
              width: 80,
            }}
          >
            <Trash2 size={22} color="#fff" strokeWidth={2} />
          </TouchableOpacity>
        );
      }}
    >
      {row}
    </ReanimatedSwipeable>
  );
}
