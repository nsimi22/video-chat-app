import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, RefreshControl, Text, TextInput, TouchableOpacity, View, ActivityIndicator, SectionList } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BellOff, Lock, Plus, Search, Star, Trash2, Users } from 'lucide-react-native';
import { deleteChannel, leaveDmChannel, listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useMutedChannels } from '@/context/MutedChannelsContext';
import { useFavorites } from '@/context/FavoritesContext';
import { usePresence } from '@/context/PresenceContext';
import { supabase } from '@/lib/supabase';
import { Avatar, Logo } from '@/components/ui';
import { NewChannelSheet } from '@/components/NewChannelSheet';
import { NewDmSheet } from '@/components/NewDmSheet';
import { UnreadBadge } from '@/components/UnreadBadge';
import { colors, space, tabBarClearance } from '@/theme';

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

// Roster discovery lives behind the Direct Messages "+" picker — a
// standing Team section duplicated it and pushed channels below the fold,
// so it was cut (2026-06-05).
type Section = { title: 'Favorites' | 'Channels' | 'Direct Messages'; data: Channel[] };

export default function ChannelsScreen() {
  const insets = useSafeAreaInsets();
  const { activeTeam, userId } = useAuth();
  const { isMuted, toggle: toggleMute } = useMutedChannels();
  const { favorites, isFavorite, toggleFavorite } = useFavorites();
  const { statuses } = usePresence();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
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

  function openChannel(id: string, name: string) {
    router.push({ pathname: '/(app)/channel/[id]', params: { id, name } });
  }

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (label: string) => !q || label.toLowerCase().includes(q);
    const favSet = new Set(favorites);
    const favItems = favorites
      .map((id) => channels.find((c) => c.id === id))
      .filter((c): c is Channel => !!c && matches(channelLabel(c, profiles, userId)));
    const channelItems = channels
      .filter((c) => c.type !== 'dm' && !favSet.has(c.id) && matches(c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dmItems = channels
      .filter((c) => c.type === 'dm' && !favSet.has(c.id) && matches(channelLabel(c, profiles, userId)))
      .sort((a, b) => channelLabel(a, profiles, userId).localeCompare(channelLabel(b, profiles, userId)));
    const out: Section[] = [];
    if (favItems.length) out.push({ title: 'Favorites', data: favItems });
    out.push({ title: 'Channels', data: channelItems });
    out.push({ title: 'Direct Messages', data: dmItems });
    return out;
  }, [channels, profiles, favorites, query, userId]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
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
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(2.5) }}>
        <Logo size={32} />
        <View style={{ marginLeft: space(3), flex: 1 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 2 }}>Workspace</Text>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }} numberOfLines={1}>
            {activeTeam?.name ?? 'Huddle'}
          </Text>
        </View>
      </View>
      {/* Search / jump-to filter (design prototype's search pill). */}
      <View style={{ paddingHorizontal: space(4), paddingBottom: space(1.5) }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space(2),
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 12,
            paddingHorizontal: space(3),
          }}
        >
          <Search size={16} color={colors.textDim} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search or jump to…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: colors.text, fontSize: 14.5, paddingVertical: space(2.25) }}
          />
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(c, index) => `${c.team_id}/${c.id}/${index}`}
        // Content scrolls under the floating glass tab bar; pad so the
        // last row clears it.
        contentContainerStyle={{ paddingBottom: tabBarClearance(insets.bottom) }}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={onPullRefresh} />}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => {
          // Mirror desktop's section-header-row: title + ghost "+" button.
          const isChannels = section.title === 'Channels';
          const isDms = section.title === 'Direct Messages';
          const isFavs = section.title === 'Favorites';
          const onAdd = isChannels ? () => setNewChannelOpen(true) : isDms ? () => setNewDmOpen(true) : null;
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {isFavs && <Star size={13} color={colors.away} fill={colors.away} />}
                <Text
                  style={{
                    color: colors.textFaint,
                    fontSize: 12,
                    fontWeight: '700',
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                  }}
                >
                  {section.title}
                </Text>
              </View>
              {onAdd && (
                <TouchableOpacity onPress={onAdd} hitSlop={10} accessibilityLabel={a11y}>
                  <Plus size={16} color={colors.textDim} strokeWidth={2.4} />
                </TouchableOpacity>
              )}
            </View>
          );
        }}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 && (section.title === 'Channels' || section.title === 'Direct Messages') ? (
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
        renderItem={({ item: channel }) => {
          const label = channelLabel(channel, profiles, userId);
          const deletable = !!userId && canDelete(channel, userId);
          const muted = isMuted(channel.id);
          const peer = dmPeerId(channel.id, userId);
          return (
            <ChannelRow
              item={channel}
              label={label}
              profiles={profiles}
              meId={userId}
              deletable={deletable}
              muted={muted}
              peerStatus={peer ? statuses[peer] ?? 'offline' : null}
              fav={isFavorite(channel.id)}
              onToggleFav={() => toggleFavorite(channel.id)}
              onOpen={() => openChannel(channel.id, label)}
              onRequestDelete={(close) => confirmDelete(channel, label, close)}
              onLongPress={() => onLongPressRow(channel, label, muted)}
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
  peerStatus,
  fav,
  onToggleFav,
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
  peerStatus: string | null;
  fav: boolean;
  onToggleFav: () => void;
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
        borderBottomColor: colors.borderSoft,
      }}
    >
      {dm && otherProfile ? (
        <Avatar name={otherProfile.name} color={otherProfile.color} size={30} uri={otherProfile.avatar_url} status={peerStatus} />
      ) : (
        <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
          {groupDm ? (
            <Users size={18} color={colors.textDim} strokeWidth={2} />
          ) : item.type === 'private' ? (
            <Lock size={16} color={colors.textDim} strokeWidth={2} />
          ) : (
            <Text style={{ color: colors.textFaint, fontSize: 18 }}>#</Text>
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
      {/* Star toggle — favorite/unfavorite without opening the row. */}
      <TouchableOpacity
        onPress={onToggleFav}
        hitSlop={8}
        accessibilityLabel={fav ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
        style={{ paddingLeft: space(2.5), paddingVertical: 4 }}
      >
        <Star size={18} color={fav ? colors.away : colors.textFaint} fill={fav ? colors.away : 'transparent'} />
      </TouchableOpacity>
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
