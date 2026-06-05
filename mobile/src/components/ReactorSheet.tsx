import { useEffect, useRef } from 'react';
import { Modal, Pressable, ScrollView, View, Text, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';
import type { Profile } from '@/lib/api';

// Mobile counterpart of the desktop reactor-on-hover tooltip (#159).
// Mobile has no hover surface, so the equivalent is a bottom sheet
// opened by long-pressing a reaction pill on a message. The sheet
// shows the emoji prominently with a list of everyone who reacted
// (avatar + name, self labelled as "You"). Tap-to-toggle on the pill
// itself is unchanged — only long-press routes here.

const SHEET_HEIGHT = 420;

type Props = {
  open: boolean;
  emoji: string | null;
  userIds: string[];
  profiles: Profile[];
  meId: string | null;
  onClose: () => void;
};

export function ReactorSheet({ open, emoji, userIds, profiles, meId, onClose }: Props) {
  const slideY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (open) {
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 90 }),
        Animated.timing(backdrop, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: SHEET_HEIGHT, duration: 160, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start();
    }
  }, [open, slideY, backdrop]);

  // Self first when present, mirroring desktop's tooltip ordering.
  // Falls back to a generic label when the id can't be resolved
  // against the team roster (former teammate who reacted to an old
  // message, for instance) so reactors don't render as raw UUIDs.
  const entries = (() => {
    if (!emoji) return [] as { id: string; label: string; profile?: Profile; isMe: boolean }[];
    const rows: { id: string; label: string; profile?: Profile; isMe: boolean }[] = [];
    const seen = new Set<string>();
    if (meId && userIds.includes(meId)) {
      seen.add(meId);
      const p = profiles.find((x) => x.user_id === meId);
      rows.push({ id: meId, label: 'You', profile: p, isMe: true });
    }
    for (const uid of userIds) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      const p = profiles.find((x) => x.user_id === uid);
      rows.push({ id: uid, label: p?.name ?? 'Unknown', profile: p, isMe: false });
    }
    return rows;
  })();

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose}>
          <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', opacity: backdrop }} />
        </Pressable>
        <Animated.View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            maxHeight: SHEET_HEIGHT,
            transform: [{ translateY: slideY }],
          }}
        >
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
            {/* Grabber — same affordance as MessageActionSheet so users
                recognize the gesture target without it being interactive. */}
            <View style={{ alignItems: 'center', paddingTop: space(2) }}>
              <View style={{ width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2 }} />
            </View>
            <View style={{ paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(2), alignItems: 'center' }}>
              <Text style={{ fontSize: 36 }}>{emoji ?? ''}</Text>
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: space(1) }}>
                {entries.length} {entries.length === 1 ? 'reaction' : 'reactions'}
              </Text>
            </View>
            <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ paddingBottom: space(2) }}>
              {entries.map((row) => (
                <View
                  key={row.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: space(4),
                    paddingVertical: space(2.5),
                  }}
                >
                  <Avatar
                    name={row.profile?.name ?? '?'}
                    color={row.profile?.color}
                    uri={row.profile?.avatar_url}
                    size={32}
                  />
                  <Text style={{ color: colors.text, fontSize: 15, marginLeft: space(3), flex: 1 }} numberOfLines={1}>
                    {row.label}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}
