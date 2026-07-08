import { useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  View,
  Text,
  Animated,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Copy, MessageCircle, Pencil, Pin, Trash2, X } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, radius, space } from '@/theme';
import type { Message } from '@/lib/api';

// Same six the desktop / earlier Alert sheet used.
const QUICK = ['👍', '✅', '🎉', '❤️', '😂', '👀'];

// Approximate height; we slide by this amount. Doesn't need to be exact —
// the sheet anchors to bottom: 0 and overshoots harmlessly.
const SHEET_HEIGHT = 320;

type Props = {
  message: Message | null;
  isMine: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  // Optional — only the channel view passes it (a message inside a thread
  // can't spawn a nested thread).
  onOpenThread?: () => void;
};

export function MessageActionSheet({
  message,
  isMine,
  onClose,
  onReact,
  onCopy,
  onTogglePin,
  onEdit,
  onDelete,
  onOpenThread,
}: Props) {
  const visible = message !== null;
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
          {/* paddingBottom gives the last row breathing room above the home
              indicator — flush sheets read as cut off. Same value across
              every bottom sheet so they feel like one family. */}
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
            {/* Grabber */}
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                backgroundColor: colors.border,
                borderRadius: 2,
                marginTop: space(2.5),
                marginBottom: space(3),
              }}
            />

            {/* Reactions row */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingHorizontal: space(4),
                paddingBottom: space(3),
              }}
            >
              {QUICK.map((e) => (
                <TouchableOpacity
                  key={e}
                  onPress={() => {
                    onReact(e);
                    onClose();
                  }}
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: colors.surfaceAlt,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View
              style={{
                height: 1,
                backgroundColor: colors.border,
                marginHorizontal: space(3),
                marginVertical: space(1),
              }}
            />

            {/* Actions */}
            {onOpenThread && (
              <SheetAction
                icon={MessageCircle}
                label="Reply in thread"
                onPress={() => {
                  onClose();
                  onOpenThread();
                }}
              />
            )}
            <SheetAction
              icon={Copy}
              label="Copy"
              onPress={() => {
                onCopy();
                onClose();
              }}
            />
            <SheetAction
              icon={Pin}
              label={message?.pinned_at ? 'Unpin' : 'Pin'}
              onPress={() => {
                onTogglePin();
                onClose();
              }}
            />
            {/* Edit your own text messages. Hidden for attachment-only
                messages (nothing to edit) — matches the desktop, which
                edits the message body. */}
            {isMine && !!message?.body && (
              <SheetAction
                icon={Pencil}
                label="Edit"
                onPress={() => {
                  onClose();
                  onEdit();
                }}
              />
            )}
            {isMine && (
              <SheetAction
                icon={Trash2}
                label="Delete"
                danger
                onPress={() => {
                  onDelete();
                  onClose();
                }}
              />
            )}
            <SheetAction icon={X} label="Cancel" onPress={onClose} />
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function SheetAction({
  icon: Icon,
  label,
  onPress,
  danger,
}: {
  icon?: LucideIcon;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const color = danger ? colors.danger : colors.text;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space(5),
        paddingVertical: space(3.5),
      }}
    >
      {Icon ? <Icon size={20} color={color} style={{ marginRight: space(3) }} /> : <View style={{ width: 20 + space(3) }} />}
      <Text style={{ color, fontSize: 16, fontWeight: danger ? '600' : '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}
