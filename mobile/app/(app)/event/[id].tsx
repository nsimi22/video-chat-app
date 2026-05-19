import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { listChannels, type Channel } from '@/lib/api';
import { deleteScheduledCall, loadScheduledCalls, type ScheduledCall } from '@/lib/scheduledCalls';
import { C, channelColorForChannel, fmtTime } from '@/components/calendar/tokens';
import { HuddleMiniMark } from '@/components/calendar/atoms';

// Event detail screen — port of `EventDetail` from the design prototype.
// Read-only on `Repeat`, `Alert`, `Sync` because those features don't
// exist in our `scheduled_calls` schema yet; rendering them as fake
// "Weekly · Tue" rows would mislead the user. We surface the fields we
// actually have: channel, date+time, duration, notes (description).
//
// Identified by stable Supabase id rather than fetched-on-mount lookup —
// we just re-pull the team's upcoming list and find the row. That keeps
// the data-layer surface small (no per-id getScheduledCall fn yet).

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { activeTeam, userId } = useAuth();
  const [event, setEvent] = useState<ScheduledCall | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeTeam || !id) return;
      const [calls, channels] = await Promise.all([
        loadScheduledCalls(activeTeam.id, { from: new Date(0) }),
        listChannels(activeTeam.id),
      ]);
      if (cancelled) return;
      const found = calls.find((c) => c.id === id) ?? null;
      setEvent(found);
      setChannel(found ? channels.find((c) => c.id === found.channelId) ?? null : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTeam, id]);

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.accent} />
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, padding: 24 }}>
        <Text style={{ color: C.text2, fontSize: 16 }}>This event no longer exists.</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: C.accent, fontSize: 16 }}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const color = channelColorForChannel(event.channelId, channel?.type);
  const endDate = new Date(event.startsAt.getTime() + event.durationMin * 60 * 1000);
  const ownedByMe = event.createdBy === userId;

  function onDelete() {
    Alert.alert(
      'Cancel scheduled call',
      `Cancel “${event!.title}”?`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel call',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteScheduledCall(event!.id);
              router.back();
            } catch (err) {
              Alert.alert('Could not cancel', (err as Error)?.message ?? String(err));
            }
          },
        },
      ],
    );
  }

  const channelName = channel?.name ?? event.channelId;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.surface3, alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} color={C.text2} />
          </View>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Channel pill + title + time */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: color + '26' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
            <Text style={{ fontSize: 12, fontWeight: '600', color }}># {channelName}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <HuddleMiniMark size={20} color={color} />
            <Text style={{ flex: 1, fontSize: 28, fontWeight: '700', color: '#fff', letterSpacing: -0.6, lineHeight: 32 }}>
              {event.title}
            </Text>
          </View>
          <Text style={{ fontSize: 14, color: C.text2, marginTop: 6 }}>
            {event.startsAt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · {fmtTime(event.startsAt)} – {fmtTime(endDate)}
          </Text>
        </View>

        {/* Details card */}
        <View style={{ marginHorizontal: 16, marginTop: 24, backgroundColor: C.surface1, borderRadius: 14, overflow: 'hidden' }}>
          <DetailRow label="Calendar" valueColor={color}>
            <Text style={{ color, fontSize: 14 }}># {channelName}</Text>
          </DetailRow>
          <DetailRow label="Duration">
            <Text style={{ color: C.text, fontSize: 14 }}>{event.durationMin} min</Text>
          </DetailRow>
          <DetailRow label="Scheduled by" last>
            <Text style={{ color: ownedByMe ? C.accent : C.text2, fontSize: 14 }}>{ownedByMe ? 'You' : 'Teammate'}</Text>
          </DetailRow>
        </View>

        {/* Notes */}
        {event.description ? (
          <View style={{ marginHorizontal: 16, marginTop: 20, backgroundColor: C.surface1, borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: C.text2, letterSpacing: 0.4, marginBottom: 6 }}>NOTES</Text>
            <Text style={{ fontSize: 14, color: C.text, lineHeight: 21 }}>{event.description}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Delete CTA — only for the owner. */}
      {ownedByMe && (
        <View style={{ position: 'absolute', bottom: 24, left: 16, right: 16 }}>
          <TouchableOpacity
            onPress={onDelete}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, backgroundColor: C.surface1, borderRadius: 14, alignItems: 'center' }}
          >
            <Text style={{ color: C.red, fontSize: 16, fontWeight: '500' }}>Delete Event</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
  valueColor?: string;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: last ? 0 : 0.5,
        borderBottomColor: C.hair,
      }}
    >
      <Text style={{ fontSize: 14, color: C.text2 }}>{label}</Text>
      {children}
    </View>
  );
}
