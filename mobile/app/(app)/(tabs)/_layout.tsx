import { useEffect, useState } from 'react';
import { Tabs } from 'expo-router';
import { Calendar as CalendarIcon, MessageSquare, Sparkles, SquareKanban } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useUnread } from '@/context/UnreadContext';
import { usePresence } from '@/context/PresenceContext';
import { useAuth } from '@/context/AuthContext';
import { getProfile, type Profile } from '@/lib/api';
import { Avatar } from '@/components/ui';
import { colors } from '@/theme';

// Bottom tab bar for the signed-in app — mirrors the design prototype's
// five destinations: Messages · Calendar · Board · Huddle AI · You.
// People folds into Messages (Team section); Settings lives inside You.
// The chat (channel/[id]) and call (call/[id]) screens live one level up
// at the (app) Stack so they push *over* the tab bar.
const tabIcon =
  (Icon: LucideIcon) =>
  ({ focused, color }: { focused: boolean; color: string }) =>
    <Icon size={focused ? 24 : 22} color={color} strokeWidth={focused ? 2.4 : 2} />;

// The You tab renders your avatar with a presence dot instead of a glyph
// (design kit MTabBar). Profile is fetched once per user; presence rides
// the shared PresenceContext so the dot tracks the selector live.
function MeTabIcon({ focused }: { focused: boolean }) {
  const { userId } = useAuth();
  const { myStatus } = usePresence();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getProfile(userId).then((p) => { if (!cancelled) setProfile(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);
  return (
    <Avatar
      name={profile?.name ?? '?'}
      color={profile?.color}
      uri={profile?.avatar_url}
      size={24}
      status={myStatus}
      ring={focused ? colors.accent : undefined}
    />
  );
}

export default function TabsLayout() {
  const { totalLoud } = useUnread();
  // RN tabBarBadge accepts a string/number, or undefined to hide. Cap
  // at 99+ so the badge stays the right size next to the icon.
  const messagesBadge = totalLoud === 0 ? undefined : totalLoud > 99 ? '99+' : totalLoud;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accentTx,
        tabBarInactiveTintColor: colors.textDim,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="channels"
        options={{
          title: 'Messages',
          tabBarIcon: tabIcon(MessageSquare),
          headerShown: false,
          tabBarBadge: messagesBadge,
          tabBarBadgeStyle: { backgroundColor: colors.danger, color: '#fff' },
        }}
      />
      <Tabs.Screen name="calendar" options={{ title: 'Calendar', tabBarIcon: tabIcon(CalendarIcon), headerShown: false }} />
      <Tabs.Screen name="board" options={{ title: 'Board', tabBarIcon: tabIcon(SquareKanban), headerShown: false }} />
      <Tabs.Screen name="ai" options={{ title: 'Huddle AI', tabBarIcon: tabIcon(Sparkles), headerShown: false }} />
      <Tabs.Screen
        name="you"
        options={{
          title: 'You',
          headerShown: false,
          tabBarIcon: ({ focused }) => <MeTabIcon focused={focused} />,
        }}
      />
    </Tabs>
  );
}
