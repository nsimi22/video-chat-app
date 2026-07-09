import { Text, TouchableOpacity, View } from 'react-native';
import { toggleReaction, type Message } from '@/lib/api';
import { colors, space } from '@/theme';

// Reaction pills under a message — tap to toggle your reaction. Shared by the
// channel and thread views. Pass `onLongPress` to route a long-press to the
// reactor sheet (channel does; thread omits it). Renders nothing when the
// message has no reactions.
export function ReactionPills({
  message,
  userId,
  onLongPress,
}: {
  message: Message;
  userId: string | null;
  onLongPress?: (emoji: string, userIds: string[]) => void;
}) {
  const reactions = message.reactions;
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: space(1.5) }}>
      {Object.entries(reactions).map(([emoji, users]) => (
        <TouchableOpacity
          key={emoji}
          onPress={() => toggleReaction(message.id, emoji, userId ?? '').catch(() => {})}
          onLongPress={onLongPress ? () => onLongPress(emoji, users) : undefined}
          delayLongPress={onLongPress ? 350 : undefined}
          style={{ flexDirection: 'row', backgroundColor: users.includes(userId ?? '') ? colors.accent : colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 }}
        >
          <Text style={{ color: colors.text, fontSize: 12 }}>{emoji} {users.length}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
