import { Text, TouchableOpacity, View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { colors, space } from '@/theme';

// The "Editing message" affordance shown above the composer while an in-place
// edit is in progress. Shared by the channel and thread views so the two can't
// drift. Render it when the useMessageEdit hook's `editing` is set.
export function EditingBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: 2 }}>
      <Pencil size={13} color={colors.accent} />
      <Text style={{ color: colors.textDim, fontSize: 12, flex: 1 }}>Editing message</Text>
      <TouchableOpacity onPress={onCancel} hitSlop={8}>
        <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}
