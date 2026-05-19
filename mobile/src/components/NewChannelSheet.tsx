import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { createChannel, slugifyChannelName, type Channel, type Profile } from '@/lib/api';
import { colors, radius, space } from '@/theme';
import { Avatar } from './ui';

// Mirror of desktop's `#create-channel-modal` (renderer/index.html ~349).
// Same fields, same flow: name → topic (optional) → private toggle that
// reveals a member picker. Mobile presentation is a pageSheet matching
// the ScheduleCallSheet pattern.

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated?: (channel: Channel) => void;
  teamId: string;
  creatorId: string;
  // Used to populate the private-channel invite picker. Excludes the creator
  // (they're added by the on_channel_after_insert trigger).
  roster: Profile[];
};

export function NewChannelSheet({ visible, onClose, onCreated, teamId, creatorId, roster }: Props) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName('');
    setTopic('');
    setIsPrivate(false);
    setInvitedIds(new Set());
    setSaving(false);
  }, [visible]);

  const slug = useMemo(() => slugifyChannelName(name), [name]);
  // Don't let the user create with an unusable name. Desktop's button is
  // always enabled and we throw on submit; here we disable + show the
  // hint so it's clear before they tap.
  const canCreate = !!slug && !saving;

  const eligibleInvitees = useMemo(
    () => roster.filter((p) => p.user_id !== creatorId).sort((a, b) => a.name.localeCompare(b.name)),
    [roster, creatorId],
  );

  function toggleInvite(uid: string) {
    setInvitedIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  async function save() {
    if (!slug) {
      Alert.alert('Pick a channel name', 'Use 2+ characters; letters, numbers, dashes and underscores only.');
      return;
    }
    setSaving(true);
    try {
      const created = await createChannel({
        teamId,
        creatorId,
        name,
        topic: topic.trim(),
        isPrivate,
        memberUserIds: isPrivate ? Array.from(invitedIds) : undefined,
      });
      onCreated?.(created);
      onClose();
    } catch (err) {
      Alert.alert('Could not create channel', (err as Error)?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header: Cancel · Title · Create (mirrors desktop's btn-row) */}
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
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>Create a channel</Text>
          <TouchableOpacity onPress={save} disabled={!canCreate}>
            {saving ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={{ fontSize: 16, color: canCreate ? colors.accent : colors.textDim, fontWeight: '600' }}>
                Create
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }} keyboardShouldPersistTaps="handled">
            <View>
              <Text style={labelStyle}>Name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. design-reviews"
                placeholderTextColor={colors.textDim}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={30}
                style={inputStyle}
              />
              <Text style={hintStyle}>
                {slug ? `Will be created as #${slug}` : 'Letters, numbers, dashes and underscores. 2–30 characters.'}
              </Text>
            </View>

            <View>
              <Text style={labelStyle}>Topic (optional)</Text>
              <TextInput
                value={topic}
                onChangeText={setTopic}
                placeholder="What's this channel for?"
                placeholderTextColor={colors.textDim}
                maxLength={200}
                style={inputStyle}
              />
            </View>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                paddingHorizontal: space(3),
                paddingVertical: space(3),
              }}
            >
              <View style={{ flex: 1, paddingRight: space(3) }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>Private</Text>
                <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>
                  Only invited members can see this channel.
                </Text>
              </View>
              <Switch
                value={isPrivate}
                onValueChange={setIsPrivate}
                trackColor={{ true: colors.accent, false: colors.border }}
              />
            </View>

            {isPrivate && (
              <View>
                <Text style={labelStyle}>Invite members</Text>
                {eligibleInvitees.length === 0 ? (
                  <Text style={hintStyle}>No teammates to invite yet.</Text>
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
                    {eligibleInvitees.map((p, i) => {
                      const selected = invitedIds.has(p.user_id);
                      return (
                        <TouchableOpacity
                          key={p.user_id}
                          onPress={() => toggleInvite(p.user_id)}
                          activeOpacity={0.7}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: space(3),
                            paddingHorizontal: space(3),
                            paddingVertical: space(3),
                            borderBottomWidth: i === eligibleInvitees.length - 1 ? 0 : 1,
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
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const labelStyle = {
  color: colors.textDim,
  fontSize: 12,
  fontWeight: '600' as const,
  letterSpacing: 0.5,
  textTransform: 'uppercase' as const,
  marginBottom: space(2),
};

const inputStyle = {
  color: colors.text,
  backgroundColor: colors.surface,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingHorizontal: space(3),
  paddingVertical: space(3),
  fontSize: 15,
};

const hintStyle = {
  color: colors.textDim,
  fontSize: 12,
  marginTop: space(2),
};
