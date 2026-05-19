import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, Search } from 'lucide-react-native';
import { createGroupDm, openDm, type Channel, type Profile } from '@/lib/api';
import { colors, radius, space } from '@/theme';
import { Avatar } from './ui';

// Mirror of desktop's `#dm-picker` modal. One selection → 1:1 DM via
// openDm; two or more → group DM via createGroupDm. Title + hint shift
// to reflect the current selection count (matches desktop's runtime
// dm-picker-title updates).

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpened?: (channel: Channel) => void;
  teamId: string;
  creatorId: string;
  roster: Profile[];
};

export function NewDmSheet({ visible, onClose, onOpened, teamId, creatorId, roster }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setSelectedIds(new Set());
    setSaving(false);
  }, [visible]);

  const eligible = useMemo(
    () => roster.filter((p) => p.user_id !== creatorId).sort((a, b) => a.name.localeCompare(b.name)),
    [roster, creatorId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((p) => p.name.toLowerCase().includes(q));
  }, [eligible, query]);

  // Always show selected people at the top even if they don't match the
  // current query — otherwise the count chip would lie ("3 selected" with
  // 0 of them visible).
  const selectedProfiles = useMemo(
    () => eligible.filter((p) => selectedIds.has(p.user_id)),
    [eligible, selectedIds],
  );

  function toggle(uid: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  const count = selectedIds.size;
  const title = count >= 2 ? 'Start a group chat' : 'Start a direct message';
  const ctaLabel = count >= 2 ? `Start group (${count + 1})` : 'Start chat';
  const canSubmit = count >= 1 && !saving;

  async function submit() {
    if (!canSubmit) return;
    const ids = [...selectedIds];
    setSaving(true);
    try {
      let channel: Channel;
      if (ids.length === 1) {
        const other = eligible.find((p) => p.user_id === ids[0]);
        channel = await openDm(teamId, creatorId, ids[0], other?.name);
      } else {
        const names = ids
          .map((uid) => eligible.find((p) => p.user_id === uid)?.name)
          .filter((n): n is string => !!n);
        channel = await createGroupDm({
          teamId,
          creatorId,
          otherUserIds: ids,
          otherUserNames: names,
        });
      }
      onOpened?.(channel);
      onClose();
    } catch (err) {
      Alert.alert('Could not start chat', (err as Error)?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header: Cancel · Title · Submit */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: space(4),
            paddingVertical: space(2),
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <TouchableOpacity onPress={onClose} disabled={saving}>
            <Text style={{ fontSize: 16, color: colors.accent }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }} numberOfLines={1}>
            {title}
          </Text>
          <TouchableOpacity onPress={submit} disabled={!canSubmit}>
            {saving ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text
                style={{
                  fontSize: 16,
                  color: canSubmit ? colors.accent : colors.textDim,
                  fontWeight: '600',
                }}
              >
                Start
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={{ padding: space(4), gap: space(3) }}>
            <Text style={{ color: colors.textDim, fontSize: 13 }}>
              Pick one person, or several for a group.
            </Text>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space(2),
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                paddingHorizontal: space(3),
              }}
            >
              <Search size={16} color={colors.textDim} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search teammates"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  flex: 1,
                  color: colors.text,
                  paddingVertical: space(3),
                  fontSize: 15,
                }}
              />
            </View>

            {selectedProfiles.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: space(2) }}
              >
                {selectedProfiles.map((p) => (
                  <TouchableOpacity
                    key={p.user_id}
                    onPress={() => toggle(p.user_id)}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space(2),
                      paddingHorizontal: space(3),
                      paddingVertical: space(1.5),
                      borderRadius: 999,
                      backgroundColor: colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Avatar
                      name={p.name}
                      color={p.color}
                      size={20}
                      uri={p.avatar_url ?? undefined}
                    />
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500' }}>{p.name}</Text>
                    <Text style={{ color: colors.textDim, fontSize: 14, fontWeight: '700', marginLeft: 2 }}>
                      ×
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(8) }}
          >
            {filtered.length === 0 ? (
              <Text style={{ color: colors.textDim, fontSize: 13, paddingVertical: space(6), textAlign: 'center' }}>
                {query ? 'No teammates match that search.' : 'No teammates to chat with yet.'}
              </Text>
            ) : (
              <View
                style={{
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radius.md,
                  overflow: 'hidden',
                }}
              >
                {filtered.map((p, i) => {
                  const selected = selectedIds.has(p.user_id);
                  return (
                    <TouchableOpacity
                      key={p.user_id}
                      onPress={() => toggle(p.user_id)}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: space(3),
                        paddingHorizontal: space(3),
                        paddingVertical: space(3),
                        borderBottomWidth: i === filtered.length - 1 ? 0 : 1,
                        borderBottomColor: colors.border,
                      }}
                    >
                      <Avatar
                        name={p.name}
                        color={p.color}
                        size={30}
                        uri={p.avatar_url ?? undefined}
                      />
                      <Text style={{ flex: 1, color: colors.text, fontSize: 15 }} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: selected ? colors.accent : 'transparent',
                          borderWidth: selected ? 0 : 1.5,
                          borderColor: colors.border,
                        }}
                      >
                        {selected && <Check size={14} color="#fff" strokeWidth={3} />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
