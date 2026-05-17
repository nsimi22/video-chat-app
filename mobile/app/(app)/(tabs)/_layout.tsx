import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '@/theme';

// Bottom tab bar for the signed-in app: Channels / People / Settings.
// The chat (channel/[id]) and call (call/[id]) screens live one level up at
// the (app) Stack so they push *over* the tab bar.
const tabIcon = (glyph: string) => ({ focused, color }: { focused: boolean; color: string }) => (
  <Text style={{ fontSize: focused ? 22 : 20, color, opacity: focused ? 1 : 0.7 }}>{glyph}</Text>
);

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
      <Tabs.Screen name="channels" options={{ title: 'Channels', tabBarIcon: tabIcon('💬'), headerShown: false }} />
      <Tabs.Screen name="people" options={{ title: 'People', tabBarIcon: tabIcon('👥') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: tabIcon('⚙️') }} />
    </Tabs>
  );
}
