import { useEffect, useRef } from 'react';
import { Modal, Pressable, View, Text, Animated, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BarChart3, Image as ImageIcon, Sticker, Smile } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, radius, space } from '@/theme';

const SHEET_HEIGHT = 300;

type Props = {
  visible: boolean;
  onClose: () => void;
  onPickPhoto: () => void;
  onPickGif: () => void;
  onPickEmoji: () => void;
  onPickPoll: () => void;
};

// Bottom-sheet "insert" menu for the composer. Poll / Photo / GIF / Emoji.
// Same slide+backdrop pattern as MessageActionSheet so the affordances feel
// consistent.
export function ComposerMenu({ visible, onClose, onPickPhoto, onPickGif, onPickEmoji, onPickPoll }: Props) {
  const slideY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  // iOS only allows one native modal at a time. Close ours first, wait for
  // dismissal to finish, then trigger the next presentation (image picker,
  // GIF page-sheet, emoji panel). Without this delay the system silently
  // drops the second present.
  const closeThen = (action: () => void) => {
    onClose();
    setTimeout(action, 260);
  };

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
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
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
            <MenuRow icon={BarChart3} label="Create poll" onPress={() => closeThen(onPickPoll)} />
            <MenuRow icon={ImageIcon} label="Photo" onPress={() => closeThen(onPickPhoto)} />
            <MenuRow icon={Sticker} label="GIF" onPress={() => closeThen(onPickGif)} />
            <MenuRow icon={Smile} label="Emoji" onPress={() => closeThen(onPickEmoji)} />
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function MenuRow({ icon: Icon, label, onPress }: { icon: LucideIcon; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(5), paddingVertical: space(3.5) }}
    >
      <Icon size={22} color={colors.text} style={{ marginRight: space(3) }} />
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}
