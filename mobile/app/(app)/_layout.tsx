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
    if (!userId) return;
    // Surface failures to the console — push registration is the most
    // common silent failure mode (permission gate, missing projectId,
    // device_tokens RLS, expired Expo project). Logging here is the
    // first place a "push doesn't work" report lands.
    registerForPush(userId).catch((err) => {
      console.error('[push] registerForPush failed at app layout:', err);
    });
  }, [userId]);

  // The (tabs) group is the bottom-tab shell; chat and call screens push
  // *over* the tabs at this Stack level.
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
        // expo-router 6 / React Navigation 7 surfaces the parent route's
        // name as the back-button label; without this, pushing from
        // (tabs) shows the literal string "(tabs)" next to the chevron.
        // `minimal` is the RN-Nav-7 idiomatic way (forces chevron-only);
        // headerBackTitle:'' alone wasn't enough on iOS 26.
        headerBackButtonDisplayMode: 'minimal',
        headerBackTitle: '',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="channel/[id]" options={{ title: '' }} />
      <Stack.Screen
        name="call/[id]"
        options={{
          // headerShown declared once here so the call screen never has to
          // toggle it at runtime. Modal screens that change header visibility
          // mid-render get remounted by react-native-screens, which
          // unmounts LiveKitRoom and kills the in-flight signal connection.
          headerShown: false,
          presentation: 'fullScreenModal',
        }}
      />
      <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
