import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { registerForPush } from '@/lib/push';
import { colors } from '@/theme';

export default function AppLayout() {
  const { loading, session, activeTeam, userId } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace('/(auth)/email');
    else if (!activeTeam) router.replace('/(auth)/team');
  }, [loading, session, activeTeam]);

  useEffect(() => {
    if (userId) registerForPush(userId).catch(() => {});
  }, [userId]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="channels" options={{ title: activeTeam?.name ?? 'Huddle' }} />
      <Stack.Screen name="channel/[id]" options={{ title: '' }} />
      <Stack.Screen name="call/[id]" options={{ title: 'Call', presentation: 'fullScreenModal' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
    </Stack>
  );
}
