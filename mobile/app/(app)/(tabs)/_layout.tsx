import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar as CalendarIcon, MessageSquare, Sparkles, SquareKanban } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useUnread } from '@/context/UnreadContext';
import { usePresence } from '@/context/PresenceContext';
import { useAuth } from '@/context/AuthContext';
import { getProfile, type Profile } from '@/lib/api';
import { Avatar } from '@/components/ui';
import { colors, tabBarOffset } from '@/theme';

// Bottom tab bar for the signed-in app — mirrors the design prototype's
// five destinations: Messages · Calendar · Board · Huddle AI · You.
// People folds into Messages (Team section); Settings lives inside You.
// The chat (channel/[id]) and call (call/[id]) screens live one level up
// at the (app) Stack so they push *over* the tab bar.
const tabIcon = (Icon: LucideIcon) => {
  // Named so react/display-name is satisfied — the variable name becomes the
  // component's display name in dev tools / warnings.
  const TabBarIcon = ({ focused, color }: { focused: boolean; color: string }) => (
    <Icon size={focused ? 24 : 22} color={color} strokeWidth={focused ? 2.4 : 2} />
  );
  return TabBarIcon;
};

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

// ── Floating liquid-glass bottom nav (design prototype PTabBar) ──
// A translucent pill that hovers over full-height content: backdrop blur,
// specular top sheen, hairline rim, drop shadow, and an accent glass
// lozenge behind the active tab. Content scrolls *under* the glass — root
// screens pad their scroll content with tabBarClearance(insets.bottom).
// Same glass treatment on iOS and Android, matching the prototype.
const GLASS_BG = 'rgba(42,39,36,0.5)'; // raised #2a2724 at 50% over the blur

function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';
  const pillRadius = ios ? 30 : 26;
  return (
    <View
      style={{
        position: 'absolute',
        left: ios ? 12 : 10,
        right: ios ? 12 : 10,
        bottom: tabBarOffset(insets.bottom),
        borderRadius: pillRadius,
        // soft drop shadow lifts the pill off the content
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 14 },
        shadowOpacity: 0.5,
        shadowRadius: 24,
        elevation: 16,
      }}
    >
      <View style={{ borderRadius: pillRadius, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(245,245,245,0.13)' }}>
        <BlurView
          intensity={50}
          tint="dark"
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_BG }]} />
        {/* specular top sheen + bottom inner shading = the "liquid glass" read */}
        <LinearGradient
          colors={['rgba(255,255,255,0.13)', 'rgba(255,255,255,0)']}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '58%' }}
          pointerEvents="none"
        />
        <LinearGradient
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.26)']}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18 }}
          pointerEvents="none"
        />
        <View style={{ flexDirection: 'row', paddingTop: 7, paddingHorizontal: 6, paddingBottom: 8 }}>
          {state.routes.map((route, i) => {
            const { options } = descriptors[route.key];
            const focused = state.index === i;
            const color = focused ? colors.accentTx : colors.textMid;
            const badge = options.tabBarBadge;
            const onPress = () => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
            };
            return (
              <Pressable key={route.key} onPress={onPress} style={{ flex: 1, alignItems: 'center', paddingTop: 5, paddingBottom: 3 }}>
                {/* active glass lozenge */}
                {focused && (
                  <View
                    style={{
                      position: 'absolute',
                      top: -1,
                      bottom: -1,
                      left: 7,
                      right: 7,
                      borderRadius: 18,
                      backgroundColor: 'rgba(79,163,244,0.22)',
                      borderWidth: 1,
                      borderColor: 'rgba(79,163,244,0.4)',
                    }}
                  />
                )}
                <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                  {options.tabBarIcon?.({ focused, color, size: 24 })}
                  {badge != null && (
                    <View
                      style={{
                        position: 'absolute',
                        top: -4,
                        right: -8,
                        minWidth: 16,
                        height: 16,
                        paddingHorizontal: 4,
                        borderRadius: 8,
                        backgroundColor: colors.danger,
                        borderWidth: 2,
                        borderColor: colors.raised,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{badge}</Text>
                    </View>
                  )}
                </View>
                <Text style={{ fontSize: 10, fontWeight: focused ? '700' : '500', color, marginTop: 3, letterSpacing: -0.1 }}>
                  {options.title ?? route.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export default function TabsLayout() {
  const { totalLoud } = useUnread();
  // tabBarBadge accepts a string/number, or undefined to hide. Cap
  // at 99+ so the badge stays the right size next to the icon.
  const messagesBadge = totalLoud === 0 ? undefined : totalLoud > 99 ? '99+' : totalLoud;
  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
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
        }}
      />
      <Tabs.Screen name="calendar" options={{ title: 'Calendar', tabBarIcon: tabIcon(CalendarIcon), headerShown: false }} />
      <Tabs.Screen name="board" options={{ title: 'Board', tabBarIcon: tabIcon(SquareKanban), headerShown: false }} />
      <Tabs.Screen
        name="ai"
        options={{
          title: 'Huddle AI',
          headerShown: false,
          // The AI sparkles fill in when active (prototype PTabBar).
          tabBarIcon: ({ focused, color }) => (
            <Sparkles size={focused ? 24 : 22} color={color} strokeWidth={focused ? 2.4 : 2} fill={focused ? color : 'none'} />
          ),
        }}
      />
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
