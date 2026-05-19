import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SLASH_COMMANDS, type SlashCommand } from '@/lib/slash';
import { colors, radius, space } from '@/theme';

// Lives directly above the composer in channel/[id].tsx. Receives the raw
// composer text and decides whether to render the popup. Returns null (no
// rendering) when the text isn't an in-progress command typing — so the
// parent can mount this unconditionally.

type Props = {
  text: string;
  onSelect: (cmd: SlashCommand) => void;
};

export function SlashSuggest({ text, onSelect }: Props) {
  const m = /^\/([\w-]*)$/.exec(text);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const filtered = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  if (filtered.length === 0) return null;
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
        {filtered.map((c) => (
          <TouchableOpacity
            key={c.name}
            onPress={() => onSelect(c)}
            activeOpacity={0.7}
            style={{
              paddingHorizontal: space(4),
              paddingVertical: space(2.5),
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>{c.usage}</Text>
            <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>{c.desc}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}
