import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Avatar } from './ui';
import type { Profile } from '@/lib/api';
import { colors, radius, space } from '@/theme';

// Lives directly above the composer in channel/[id].tsx, in the same slot
// as SlashSuggest. Returns null when the caret isn't on an in-progress
// `@<partial>` token, so the parent can mount this unconditionally.
//
// The `@` only triggers when it sits at the start of the text or right
// after whitespace — that way an email address `nick@example.com` mid-
// sentence doesn't pop the picker the moment the user types the `@`.

type Props = {
  text: string;
  caretPos: number;
  roster: Profile[];
  meId: string | null;
  onSelect: (p: Profile) => void;
};

// Exported so the parent can reuse it for the insert-token logic
// (replace the same substring it triggers on).
export const MENTION_TOKEN_RE = /(?:^|\s)@(\w*)$/;

export function MentionSuggest({ text, caretPos, roster, meId, onSelect }: Props) {
  const before = text.slice(0, caretPos);
  const m = MENTION_TOKEN_RE.exec(before);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const candidates = roster
    .filter((p) => p.user_id !== meId)
    .filter((p) => !q || (p.name ?? '').toLowerCase().includes(q))
    .sort((a, b) => {
      // Prefix matches float above contains-only matches; alphabetical tiebreak.
      const an = (a.name ?? '').toLowerCase();
      const bn = (b.name ?? '').toLowerCase();
      const ap = an.startsWith(q);
      const bp = bn.startsWith(q);
      if (ap !== bp) return ap ? -1 : 1;
      return an.localeCompare(bn);
    })
    .slice(0, 8);
  if (candidates.length === 0) return null;
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface,
        maxHeight: 240,
      }}
    >
      <ScrollView keyboardShouldPersistTaps="always">
        {candidates.map((p) => (
          <TouchableOpacity
            key={p.user_id}
            onPress={() => onSelect(p)}
            activeOpacity={0.7}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space(3),
              paddingHorizontal: space(4),
              paddingVertical: space(2.5),
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Avatar name={p.name} color={p.color} size={26} uri={p.avatar_url ?? undefined} />
            <Text style={{ flex: 1, color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>@{p.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}
