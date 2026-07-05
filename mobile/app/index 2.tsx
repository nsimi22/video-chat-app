import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/theme';

export default function Index() {
  const { loading, session, activeTeam } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/(auth)/email');
    else if (!activeTeam) router.replace('/(auth)/team');
    else router.replace('/(app)/(tabs)/channels');
  }, [loading, session, activeTeam]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
