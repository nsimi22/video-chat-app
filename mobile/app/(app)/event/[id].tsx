import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, HelpCircle, X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { listChannels, listTeamProfiles, type Channel, type Profile } from '@/lib/api';
import {
  clearRsvp,
  deleteScheduledCall,
  getScheduledCall,
  loadAttendees,
  setRsvp,
  subscribeCallAttendees,
  type Attendee,
  type AttendeeStatus,
  type ScheduledCall,
} from '@/lib/scheduledCalls';
import { C, channelColorForChannel, fmtTime } from '@/components/calendar/tokens';
import { HuddleMiniMark } from '@/components/calendar/atoms';
import { Avatar } from '@/components/ui';
import { ScheduleCallSheet } from '@/components/ScheduleCallSheet';

// Human label for a scheduled_calls.rrule body (kept simple — matches the
// Repeat options the schedule sheet offers).
function repeatLabel(rrule: string): string {
  if (!rrule) return '';
  const s = rrule.toUpperCase();
  if (/FREQ=DAILY/.test(s)) return 'Every day';
  if (/FREQ=WEEKLY/.test(s)) return /BYDAY=MO,TU,WE,TH,FR/.test(s) ? 'Every weekday' : 'Every week';
  if (/FREQ=MONTHLY/.test(s)) return 'Every month';
  return 'Repeats';
}

// Event detail screen — port of `EventDetail` from the design prototype.
// Surfaces channel, date+time, duration, recurrence (Repeat), notes, and the
// RSVP + attendee list. Owners get Edit (opens the schedule sheet in edit mode)
// and Delete. `Alert` / external-calendar-sync rows are still omitted (no
// backend for them).

// RSVP choices — colors echo the presence palette (going=green, maybe=amber,
// declined=red). Tapping the active one again retracts the RSVP.
const RSVP_OPTIONS: { status: AttendeeStatus; label: string; icon: typeof Check; color: string }[] = [
  { status: 'going', label: 'Going', icon: Check, color: '#67d283' },
  { status: 'maybe', label: 'Maybe', icon: HelpCircle, color: '#ffd60a' },
  { status: 'declined', label: 'Declined', icon: X, color: C.red },
];

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { activeTeam, userId } = useAuth();
  const [event, setEvent] = useState<ScheduledCall | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [channels, setChannels] = useState<Channel[]>([]);
  const [rsvpBusy, setRsvpBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!activeTeam || !id) {
      setLoading(false);
      return;
    }
    try {
      const found = await getScheduledCall(id);
      setEvent(found);
      if (found) {
        const [chs, roster, atts] = await Promise.all([
          listChannels(activeTeam.id),
          listTeamProfiles(activeTeam.id),
          loadAttendees(found.id),
        ]);
        setChannels(chs);
        setChannel(chs.find((c) => c.id === found.channelId) ?? null);
        setProfiles(new Map(roster.map((p) => [p.user_id, p])));
        setAttendees(atts);
      }
    } catch (e) {
      console.warn('event load failed', e);
    } finally {
      // Always clear `loading` — an early return or a failed fetch would
      // otherwise leave the screen stuck on its spinner forever.
      setLoading(false);
    }
  }, [activeTeam, id]);

  useEffect(() => {
    load();
  }, [load]);

  // Live-update the attendee list as teammates RSVP while this screen is open.
  useEffect(() => {
    if (!activeTeam || !id) return;
    const unsub = subscribeCallAttendees(activeTeam.id, (evt) => {
      if (evt.callId !== id || !evt.userId) return;
      setAttendees((prev) => {
        if (evt.eventType === 'DELETE') return prev.filter((a) => a.userId !== evt.userId);
        const next = prev.filter((a) => a.userId !== evt.userId);
        if (evt.status) next.push({ userId: evt.userId!, status: evt.status });
        return next;
      });
    });
    return unsub;
  }, [activeTeam, id]);

  const myStatus: AttendeeStatus | null = attendees.find((a) => a.userId === userId)?.status ?? null;

  const onRsvp = useCallback(
    async (status: AttendeeStatus) => {
      if (!id || !userId || rsvpBusy) return;
      setRsvpBusy(true);
      // Optimistic: reflect the tap immediately; the realtime echo reconciles.
      const retract = myStatus === status;
      setAttendees((prev) => {
        const next = prev.filter((a) => a.userId !== userId);
        if (!retract) next.push({ userId, status });
        return next;
      });
      try {
        if (retract) await clearRsvp(id, userId);
        else await setRsvp(id, userId, status);
      } catch (err) {
        // Roll back to the server truth on failure.
        const fresh = await loadAttendees(id).catch(() => null);
        if (fresh) setAttendees(fresh);
        Alert.alert('Could not update RSVP', (err as Error)?.message ?? String(err));
      } finally {
        setRsvpBusy(false);
      }
    },
    [id, userId, myStatus, rsvpBusy],
  );

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
        {ownedByMe && (
          <TouchableOpacity onPress={() => setEditing(true)} hitSlop={10} activeOpacity={0.7}>
            <Text style={{ fontSize: 16, color: C.accent, fontWeight: '600' }}>Edit</Text>
          </TouchableOpacity>
        )}
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
          {event.rrule ? (
            <DetailRow label="Repeats">
              <Text style={{ color: C.text, fontSize: 14 }}>{repeatLabel(event.rrule)}</Text>
            </DetailRow>
          ) : null}
          <DetailRow label="Scheduled by" last>
            <Text style={{ color: ownedByMe ? C.accent : C.text2, fontSize: 14 }}>{ownedByMe ? 'You' : 'Teammate'}</Text>
          </DetailRow>
        </View>

        {/* RSVP control */}
        <View style={{ marginHorizontal: 16, marginTop: 20 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: C.text2, letterSpacing: 0.4, marginBottom: 8 }}>
            YOUR RSVP
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {RSVP_OPTIONS.map((opt) => {
              const active = myStatus === opt.status;
              return (
                <TouchableOpacity
                  key={opt.status}
                  onPress={() => onRsvp(opt.status)}
                  disabled={rsvpBusy}
                  activeOpacity={0.8}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    paddingVertical: 11,
                    borderRadius: 12,
                    backgroundColor: active ? opt.color + '26' : C.surface1,
                    borderWidth: 1,
                    borderColor: active ? opt.color : 'transparent',
                  }}
                >
                  <opt.icon size={15} color={active ? opt.color : C.text2} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: active ? opt.color : C.text2 }}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Attendees, grouped by status */}
        {attendees.length > 0 && (
          <View style={{ marginHorizontal: 16, marginTop: 20, backgroundColor: C.surface1, borderRadius: 14, overflow: 'hidden' }}>
            {RSVP_OPTIONS.map((opt, gi) => {
              const group = attendees.filter((a) => a.status === opt.status);
              if (!group.length) return null;
              return (
                <View key={opt.status} style={{ padding: 14, borderTopWidth: gi === 0 ? 0 : 0.5, borderTopColor: C.hair }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: opt.color, letterSpacing: 0.4, marginBottom: 10 }}>
                    {opt.label.toUpperCase()} · {group.length}
                  </Text>
                  <View style={{ gap: 10 }}>
                    {group.map((a) => {
                      const p = profiles.get(a.userId);
                      const name = a.userId === userId ? 'You' : (p?.name ?? 'Teammate');
                      return (
                        <View key={a.userId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Avatar name={p?.name ?? name} color={p?.color} uri={p?.avatar_url} size={28} />
                          <Text style={{ fontSize: 14, color: C.text }}>{name}</Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        )}

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

      {activeTeam && userId && (
        <ScheduleCallSheet
          visible={editing}
          onClose={() => setEditing(false)}
          teamId={activeTeam.id}
          userId={userId}
          channels={channels}
          editCall={event}
          onScheduled={() => { setEditing(false); load(); }}
        />
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
