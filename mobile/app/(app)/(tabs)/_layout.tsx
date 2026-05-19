import { Tabs } from 'expo-router';
import { Calendar as CalendarIcon, MessageSquare, Users, Settings as SettingsIcon } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '@/theme';

// Bottom tab bar for the signed-in app: Messages / People / Settings.
// The chat (channel/[id]) and call (call/[id]) screens live one level up at
// the (app) Stack so they push *over* the tab bar.
const tabIcon =
  (Icon: LucideIcon) =>
  ({ focused, color }: { focused: boolean; color: string }) =>
    <Icon size={focused ? 24 : 22} color={color} strokeWidth={focused ? 2.4 : 2} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="channels" options={{ title: 'Messages', tabBarIcon: tabIcon(MessageSquare), headerShown: false }} />
      <Tabs.Screen name="people" options={{ title: 'People', tabBarIcon: tabIcon(Users) }} />
      <Tabs.Screen name="calendar" options={{ title: 'Calendar', tabBarIcon: tabIcon(CalendarIcon), headerShown: false }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: tabIcon(SettingsIcon) }} />
    </Tabs>
  );
}
