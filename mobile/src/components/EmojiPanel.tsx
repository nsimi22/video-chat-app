import { useEffect, useRef } from 'react';
import { Modal, Pressable, View, Text, Animated, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, space } from '@/theme';

const SHEET_HEIGHT = 360;

// Curated set of frequently-used emoji. Bigger than the message-action
// reaction set but small enough to fit one sheet without scrolling
// horizontally. Order roughly matches what people reach for first in chat.
const EMOJI = [
  '👍', '👎', '✅', '❌', '🎉', '🔥', '❤️', '😂',
  '😭', '😅', '🙏', '👀', '🤔', '💯', '🚀', '👏',
  '😎', '😬', '🤝', '💪', '🙌', '👋', '💀', '🤷',
  '🫠', '🫡', '😴', '🥹', '😤', '🤯', '🥲', '😮',
];

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
};

// Tap-to-insert emoji grid. Caller wires `onPick` to splice the chosen
// glyph into the composer at the current cursor position (see
// channel/[id].tsx).
export function EmojiPanel({ visible, onClose, onPick }: Props) {
  const slideY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
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
  }, [visible, slideY, backdrop]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose}>
          <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', opacity: backdrop }} />
        </Pressable>
        <Animated.View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            transform: [{ translateY: slideY }],
          }}
        >
          <SafeAreaView edges={['bottom']}>
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                backgroundColor: colors.border,
                borderRadius: 2,
                marginTop: space(2.5),
                marginBottom: space(2),
              }}
            />
            <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space(3), paddingBottom: space(3) }}>
              {EMOJI.map((e) => (
                <TouchableOpacity
                  key={e}
                  onPress={() => onPick(e)}
                  activeOpacity={0.6}
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: radius.sm,
                    margin: space(0.5),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 26 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}
