import { useEffect, useState } from 'react';
import { FlatList, TouchableOpacity, Text, View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { listTeams, type Team } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button, H1, P, Screen } from '@/components/ui';
import { colors, radius, space } from '@/theme';

export default function TeamScreen() {
  const { setActiveTeam, signOut } = useAuth();
  const [teams, setTeams] = useState<Team[] | null>(null);

  useEffect(() => {
    listTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  const choose = (t: Team) => {
    setActiveTeam(t);
    router.replace('/(app)/channels');
  };

  if (!teams) {
    return (
      <Screen>
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }

  return (
    <Screen>
      <H1>Pick a team</H1>
      {teams.length === 0 ? (
        <>
          <P>You're not a member of any team yet. Ask a teammate for an invite, then sign in again.</P>
          <Button title="Sign out" variant="ghost" onPress={signOut} />
        </>
      ) : (
        <FlatList
          data={teams}
          keyExtractor={(t) => t.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => choose(item)}
              style={{
                backgroundColor: colors.surface,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                padding: space(4),
                marginBottom: space(3),
              }}
            >
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{item.name}</Text>
              <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 2 }}>{item.id}</Text>
            </TouchableOpacity>
          )}
          ListFooterComponent={
            <View style={{ marginTop: space(4) }}>
              <Button title="Sign out" variant="ghost" onPress={signOut} />
            </View>
          }
        />
      )}
    </Screen>
  );
}
