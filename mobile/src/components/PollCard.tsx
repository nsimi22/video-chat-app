import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { BarChart3 } from 'lucide-react-native';
import { closePoll, togglePollVote, type Message, type Profile } from '@/lib/api';
import { Avatar } from '@/components/ui';
import { colors, radius, space } from '@/theme';

// Interactive poll card rendered in place of the message body — mobile port
// of desktop's _renderPollCard (renderer/chat.js). Tapping an option toggles
// the vote through the toggle_poll_vote RPC; the messages UPDATE rides the
// existing realtime subscription and re-renders the card with fresh tallies.
export function PollCard({
  message,
  meId,
  roster,
}: {
  message: Message;
  meId: string | null;
  roster: Profile[];
}) {
  const poll = message.meta?.poll;
  if (!poll) return null;
  const votes = poll.votes ?? {};
  const closed = !!poll.closed_at;
  const mine = message.author_id === meId;
  // Percentages are share-of-voters: in a multi-answer poll each bar reads
  // "X% of voters picked this" (bars can sum past 100%), consistent with
  // the distinct-voter count in the footer. Single-choice: identical.
  const voterCount = new Set(Object.values(votes).flat()).size;
  const profileFor = (uid: string) => roster.find((p) => p.user_id === uid);

  return (
    <View
      style={{
        marginTop: space(1),
        maxWidth: 320,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surfaceAlt,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), padding: space(3), borderBottomWidth: 1, borderBottomColor: colors.borderSoft }}>
        <View style={{ width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentDim }}>
          <BarChart3 size={15} color={colors.accentTx} strokeWidth={2.2} />
        </View>
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '700', color: colors.text, lineHeight: 19 }}>{poll.question}</Text>
      </View>
      <View style={{ padding: space(3), gap: space(2) }}>
        {poll.options.map((opt) => {
          const voters = Array.isArray(votes[opt.id]) ? votes[opt.id] : [];
          const minePick = !!meId && voters.includes(meId);
          const pct = voterCount ? Math.round((voters.length / voterCount) * 100) : 0;
          return (
            <TouchableOpacity
              key={opt.id}
              disabled={closed}
              onPress={() => togglePollVote(message.id, opt.id).catch((e) => Alert.alert('Vote failed', e?.message ?? String(e)))}
              activeOpacity={0.75}
              style={{
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: minePick ? colors.accent : colors.border,
                backgroundColor: colors.bg,
                overflow: 'hidden',
              }}
            >
              {/* result bar fills behind the row content */}
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${pct}%`,
                  backgroundColor: minePick ? colors.accentDim : colors.surfaceAlt,
                }}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(2.75), paddingVertical: space(2.25) }}>
                <View
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: poll.multi ? 4 : 9,
                    borderWidth: 2,
                    borderColor: minePick ? colors.accent : colors.border,
                    backgroundColor: minePick ? colors.accent : 'transparent',
                  }}
                />
                <Text style={{ flex: 1, fontSize: 13.5, fontWeight: minePick ? '600' : '500', color: colors.text }}>{opt.text}</Text>
                {/* up-to-3 voter mini avatars (design kit poll card) */}
                <View style={{ flexDirection: 'row' }}>
                  {voters.slice(0, 3).map((uid, vi) => {
                    const p = profileFor(uid);
                    return (
                      <View key={uid} style={{ marginLeft: vi ? -6 : 0 }}>
                        <Avatar name={p?.name ?? '?'} color={p?.color} uri={p?.avatar_url} size={17} />
                      </View>
                    );
                  })}
                </View>
                {voters.length > 0 && (
                  <Text style={{ fontSize: 12, fontWeight: '700', color: minePick ? colors.accentTx : colors.textDim, fontVariant: ['tabular-nums'] }}>
                    {voters.length} · {pct}%
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(3), paddingBottom: space(2.75) }}>
        <Text style={{ fontSize: 11.5, color: colors.textDim, flex: 1 }}>
          {closed
            ? `Final results · ${voterCount} ${voterCount === 1 ? 'vote' : 'votes'}`
            : `${voterCount} ${voterCount === 1 ? 'vote' : 'votes'}${poll.multi ? ' · multiple answers' : ''}`}
        </Text>
        {!closed && mine && (
          <TouchableOpacity
            onPress={() =>
              Alert.alert('Close this poll?', 'Voting will be locked and final results shown.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Close poll', style: 'destructive', onPress: () => closePoll(message.id).catch(() => {}) },
              ])
            }
            hitSlop={6}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textDim }}>Close poll</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
