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
import DateTimePicker from '@react-native-community/datetimepicker';
import { createScheduledCall } from '@/lib/scheduledCalls';
import type { Channel } from '@/lib/api';
import { C, channelColorForChannel, fmtTime } from './calendar/tokens';

// Create event — port of `CreateEvent` from the design prototype. Stack:
//   - title card (large editable title + secondary line for notes preview)
//   - time card (Starts / Ends rows that expand to inline iOS pickers)
//   - calendar card (channel picker; we don't have repeat/alert/sync yet)
//
// I'm explicitly NOT shipping the design's `Repeat`, `Alert`, `Google
// Calendar`, `Outlook` rows because those features aren't in the
// `scheduled_calls` schema — wiring them as no-op toggles would mislead
// the user. Add them back here when the backend supports them.

type Props = {
  visible: boolean;
  onClose: () => void;
  onScheduled?: () => void;
  teamId: string;
  userId: string;
  channels: Channel[];
  defaultChannelId?: string | null;
};

const DURATION_OPTIONS = [15, 30, 45, 60, 90] as const;
const DEFAULT_DURATION = 30;

function nextRoundedStart(): Date {
  const ms5 = 5 * 60 * 1000;
  const soon = Date.now() + ms5;
  return new Date(Math.ceil(soon / ms5) * ms5);
}

export function ScheduleCallSheet({
  visible,
  onClose,
  onScheduled,
  teamId,
  userId,
  channels,
  defaultChannelId,
}: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<Date>(() => nextRoundedStart());
  const [durationMin, setDurationMin] = useState<number>(DEFAULT_DURATION);
  const [openPicker, setOpenPicker] = useState<'startsDate' | 'startsTime' | null>(null);
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const eligibleChannels = useMemo(
    () => channels.filter((c) => c.type !== 'dm').sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  );

  useEffect(() => {
    if (!visible) return;
    setTitle('');
    setDescription('');
    setStartsAt(nextRoundedStart());
    setDurationMin(DEFAULT_DURATION);
    setOpenPicker(null);
    setShowChannelPicker(false);
    const fallback = eligibleChannels[0]?.id ?? null;
    const preferred = defaultChannelId && eligibleChannels.some((c) => c.id === defaultChannelId)
      ? defaultChannelId
      : fallback;
    setChannelId(preferred);
  }, [visible, defaultChannelId, eligibleChannels]);

  const selectedChannel = eligibleChannels.find((c) => c.id === channelId);
  const channelColor = selectedChannel
    ? channelColorForChannel(selectedChannel.id, selectedChannel.type)
    : C.accent;
  const endDate = new Date(startsAt.getTime() + durationMin * 60 * 1000);

  async function save() {
    const t = title.trim();
    if (!t) {
      Alert.alert('Title required', 'Give the call a short title.');
      return;
    }
    if (!channelId) {
      Alert.alert('Channel required', 'Pick a channel to host the call.');
      return;
    }
    // The date picker enforces minimumDate=today, but the time picker can
    // still land before "right now" — guard so we don't write a row that
    // the realtime listener would surface in the past column.
    if (startsAt.getTime() <= Date.now()) {
      Alert.alert('Pick a future time', 'The event must start later than right now.');
      return;
    }
    setSaving(true);
    try {
      await createScheduledCall({
        teamId,
        channelId,
        createdBy: userId,
        title: t,
        description: description.trim(),
        startsAt,
        durationMin,
      });
      onScheduled?.();
      onClose();
    } catch (err) {
      Alert.alert('Could not schedule', (err as Error)?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        {/* Header */}
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <TouchableOpacity onPress={onClose} disabled={saving}>
            <Text style={{ fontSize: 16, color: C.accent }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>New Event</Text>
          <TouchableOpacity onPress={save} disabled={saving}>
            {saving ? (
              <ActivityIndicator color={C.accent} />
            ) : (
              <Text style={{ fontSize: 16, color: C.accent, fontWeight: '600' }}>Add</Text>
            )}
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            {/* Title card */}
            <View style={{ marginHorizontal: 16, marginTop: 16, backgroundColor: C.surface1, borderRadius: 14, padding: 16 }}>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="Title"
                placeholderTextColor={C.text3}
                autoFocus
                style={{ fontSize: 22, fontWeight: '600', color: '#fff', letterSpacing: -0.4, padding: 0 }}
                maxLength={200}
              />
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Location, video link, or notes"
                placeholderTextColor={C.text3}
                multiline
                style={{ fontSize: 14, color: C.text, marginTop: 6, padding: 0, minHeight: 20 }}
              />
            </View>

            {/* Time card */}
            <View style={{ marginHorizontal: 16, marginTop: 16, backgroundColor: C.surface1, borderRadius: 14, overflow: 'hidden' }}>
              <FormRow
                label="Starts"
                expanded={openPicker === 'startsDate' || openPicker === 'startsTime'}
                onPress={() => setOpenPicker((p) => (p === 'startsDate' ? null : 'startsDate'))}
                value={
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 14, color: openPicker === 'startsDate' ? C.accent : C.accent }}>
                      {startsAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Text>
                    <TouchableOpacity onPress={() => setOpenPicker((p) => (p === 'startsTime' ? null : 'startsTime'))} hitSlop={6}>
                      <Text style={{ fontSize: 14, color: openPicker === 'startsTime' ? C.accent : C.accent }}>
                        {fmtTime(startsAt)}
                      </Text>
                    </TouchableOpacity>
                  </View>
                }
              />
              {openPicker === 'startsDate' && (
                <View style={{ backgroundColor: C.surface2, paddingVertical: 4 }}>
                  <DateTimePicker
                    value={startsAt}
                    mode="date"
                    display="inline"
                    minimumDate={new Date(new Date().setHours(0, 0, 0, 0))}
                    onChange={(_, d) => {
                      if (d) {
                        const next = new Date(startsAt);
                        next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                        setStartsAt(next);
                      }
                    }}
                    themeVariant="dark"
                  />
                </View>
              )}
              {openPicker === 'startsTime' && (
                <View style={{ backgroundColor: C.surface2, paddingVertical: 8, alignItems: 'center' }}>
                  <DateTimePicker
                    value={startsAt}
                    mode="time"
                    display="spinner"
                    minuteInterval={5}
                    onChange={(_, d) => {
                      if (d) {
                        const next = new Date(startsAt);
                        next.setHours(d.getHours(), d.getMinutes(), 0, 0);
                        setStartsAt(next);
                      }
                    }}
                    themeVariant="dark"
                  />
                </View>
              )}
              <FormRow
                label="Ends"
                value={
                  <Text style={{ fontSize: 14, color: C.text2 }}>
                    {endDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtTime(endDate)}
                  </Text>
                }
                disabled
              />
              <FormRow
                label="Duration"
                last
                value={
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                    {DURATION_OPTIONS.map((mins) => {
                      const selected = mins === durationMin;
                      return (
                        <TouchableOpacity
                          key={mins}
                          onPress={() => setDurationMin(mins)}
                          activeOpacity={0.7}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor: selected ? C.accent + '22' : 'transparent',
                            borderWidth: 1,
                            borderColor: selected ? C.accent : C.surface3,
                          }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: selected ? '600' : '500', color: selected ? C.accent : C.text2 }}>
                            {mins}m
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                }
              />
            </View>

            {/* Calendar card */}
            <View style={{ marginHorizontal: 16, marginTop: 16, backgroundColor: C.surface1, borderRadius: 14, overflow: 'hidden' }}>
              <FormRow
                label="Calendar"
                last={!showChannelPicker}
                onPress={() => setShowChannelPicker((v) => !v)}
                value={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: channelColor }} />
                    <Text style={{ fontSize: 14, color: C.text }}>
                      {selectedChannel ? `# ${selectedChannel.name}` : 'Select a channel'}
                    </Text>
                  </View>
                }
              />
              {showChannelPicker && (
                <View style={{ backgroundColor: C.surface2, maxHeight: 260 }}>
                  <ScrollView nestedScrollEnabled>
                    {eligibleChannels.length === 0 ? (
                      <Text style={{ padding: 16, color: C.text3 }}>No channels to schedule into.</Text>
                    ) : (
                      eligibleChannels.map((c, i) => {
                        const selected = c.id === channelId;
                        const color = channelColorForChannel(c.id, c.type);
                        return (
                          <TouchableOpacity
                            key={c.id}
                            onPress={() => {
                              setChannelId(c.id);
                              setShowChannelPicker(false);
                            }}
                            activeOpacity={0.7}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 10,
                              paddingHorizontal: 16,
                              paddingVertical: 12,
                              borderBottomWidth: i === eligibleChannels.length - 1 ? 0 : 0.5,
                              borderBottomColor: C.hair,
                              backgroundColor: selected ? C.surface3 : 'transparent',
                            }}
                          >
                            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
                            <Text style={{ fontSize: 15, color: C.text, flex: 1 }}># {c.name}</Text>
                            {selected && <Text style={{ fontSize: 14, color: C.accent }}>✓</Text>}
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function FormRow({
  label,
  value,
  onPress,
  last,
  disabled,
  expanded,
}: {
  label: string;
  value: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}) {
  const inner = (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: last ? 0 : 0.5,
        borderBottomColor: C.hair,
        gap: 12,
        backgroundColor: expanded ? C.surface2 : 'transparent',
      }}
    >
      <Text style={{ fontSize: 15, color: C.text }}>{label}</Text>
      <View style={{ flexShrink: 1 }}>{value}</View>
    </View>
  );
  if (onPress && !disabled) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {inner}
      </TouchableOpacity>
    );
  }
  return inner;
}
