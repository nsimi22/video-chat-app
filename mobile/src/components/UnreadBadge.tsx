import { Text, View } from 'react-native';
import { useUnread } from '@/context/UnreadContext';
import { colors } from '@/theme';

// Pill shown to the right of a channel/DM row in the channels list.
// `loud` (DM, @mention, @here, @channel) renders the colored badge with
// a count; non-loud channel chatter renders a small muted dot so the
// user notices the activity without it competing for attention with a
// real ping. Hidden entirely at zero.
export function UnreadBadge({ channelId }: { channelId: string }) {
  const { unreadFor } = useUnread();
  const entry = unreadFor(channelId);
  if (!entry || entry.count === 0) return null;

  if (!entry.loud) {
    // Muted dot — no count, no color. Matches Slack's "channel has
    // activity but you weren't pinged" affordance.
    return (
      <View
        accessibilityLabel="Unread messages"
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: colors.textDim,
        }}
      />
    );
  }

  // Loud — red pill with a count. Cap the displayed count so a runaway
  // channel doesn't blow the row layout sideways. The actual count is
  // still in the accessibility label for screen readers.
  const display = entry.count > 99 ? '99+' : String(entry.count);
  return (
    <View
      accessibilityLabel={`${entry.count} unread ${entry.count === 1 ? 'message' : 'messages'}`}
      style={{
        minWidth: 22,
        height: 20,
        // Half-height rounding gives a true pill regardless of width
        // (theme.radius only goes up to `lg`, no dedicated pill token).
        borderRadius: 10,
        paddingHorizontal: 6,
        backgroundColor: colors.danger,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{display}</Text>
    </View>
  );
}
