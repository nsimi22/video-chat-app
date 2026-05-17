import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { listTeamProfiles, openDm, type Profile } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Avatar } from '@/components/ui';
import { colors, space } from '@/theme';

// People tab: full team roster. (Online presence dots are deliberately
// deferred — the mobile client doesn't yet track presence on the team topic,
// so we'd have nothing to drive them. Tap a row to DM that person.)
export default function PeopleScreen() {
  const { activeTeam, userId } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!activeTeam) return;
    setRefreshing(true);
    try {
      const pr = await listTeamProfiles(activeTeam.id);
      setProfiles(pr);
    } catch (e: any) {
      // Surface failures so the user doesn't see the misleading
      // "You're the only one on this team" empty state when the
      // roster query actually broke.
      console.warn('[people] listTeamProfiles failed', e);
      Alert.alert('Could not load team', e?.message ?? String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTeam]);

  // useFocusEffect fires on first focus too, so it doubles as the initial load.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const others = profiles.filter((p) => p.user_id !== userId).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      data={others}
      keyExtractor={(p) => p.user_id}
      refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={load} />}
      ListEmptyComponent={
        <View style={{ padding: space(6), alignItems: 'center' }}>
          <Text style={{ color: colors.textDim, fontSize: 14 }}>You're the only one on this team so far.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          onPress={async () => {
            if (!userId || !activeTeam) return;
            try {
              const ch = await openDm(activeTeam.id, userId, item.user_id, item.name);
              router.push({ pathname: '/(app)/channel/[id]', params: { id: ch.id, name: item.name } });
            } catch (e: any) {
              Alert.alert('Could not open DM', e?.message ?? String(e));
            }
          }}
          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.border }}
        >
          <Avatar name={item.name} color={item.color} size={36} uri={item.avatar_url} />
          <View style={{ marginLeft: space(3), flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{item.name}</Text>
            {item.bio ? <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 1 }} numberOfLines={1}>{item.bio}</Text> : null}
          </View>
        </TouchableOpacity>
      )}
    />
  );
}
