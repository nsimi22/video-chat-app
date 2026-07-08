import { useEffect, useRef } from 'react';
import { Animated, Linking, Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CalendarClock, MapPin, Video, X } from 'lucide-react-native';
import type { IcsEvent } from '@/lib/ics';
import { C, fmtTime } from '@/components/calendar/tokens';

// Read-only details for an EXTERNAL (subscribed .ics) calendar event, with a
// Join button when a meeting link was parsed out of the VEVENT. External
// events aren't in our scheduled_calls table, so they can't route to the
// internal detail screen — this bottom sheet is their tap target. Mirrors the
// desktop calendar's details popover (which also exposes Join for Teams/Zoom/
// Meet/Webex links). Join is ungated (joinable any time), matching desktop.

const SHEET_MAX = 460;

function fmtRange(e: IcsEvent): string {
  if (!e.start) return '';
  const day = e.start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (e.allDay) return `${day} · All day`;
  const end = e.end && e.end.getTime() > e.start.getTime() ? ` – ${fmtTime(e.end)}` : '';
  return `${day} · ${fmtTime(e.start)}${end}`;
}

export function EventDetailsSheet({ event, onClose }: { event: IcsEvent | null; onClose: () => void }) {
  const visible = event !== null;
  const slideY = useRef(new Animated.Value(SHEET_MAX)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, useNativeDriver: true, friction: 9, tension: 90 }),
        Animated.timing(backdrop, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: SHEET_MAX, duration: 160, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, backdrop]);

  const meetingUrl = event?.meetingUrl ?? '';
  const provider = event?.provider ?? '';

  const onJoin = () => {
    if (!meetingUrl) return;
    Linking.openURL(meetingUrl).catch(() => {});
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose}>
          <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', opacity: backdrop }} />
        </Pressable>
        <Animated.View
          style={{
            backgroundColor: C.surface1,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            transform: [{ translateY: slideY }],
          }}
        >
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: 12 }}>
            <View style={{ alignSelf: 'center', width: 40, height: 4, backgroundColor: C.surface3, borderRadius: 2, marginTop: 10, marginBottom: 8 }} />

            <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Text style={{ flex: 1, fontSize: 20, fontWeight: '700', color: '#fff', letterSpacing: -0.3 }}>
                  {event?.title || '(untitled)'}
                </Text>
                <TouchableOpacity onPress={onClose} hitSlop={10}>
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.surface3, alignItems: 'center', justifyContent: 'center' }}>
                    <X size={15} color={C.text2} />
                  </View>
                </TouchableOpacity>
              </View>

              {/* Time */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
                <CalendarClock size={16} color={C.text2} />
                <Text style={{ fontSize: 14, color: C.text, flex: 1 }}>{event ? fmtRange(event) : ''}</Text>
              </View>

              {/* Location */}
              {event?.location ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <MapPin size={16} color={C.text2} />
                  <Text style={{ fontSize: 14, color: C.text, flex: 1 }} numberOfLines={2}>{event.location}</Text>
                </View>
              ) : null}

              {/* Subscribed-calendar marker */}
              <Text style={{ fontSize: 12, color: C.text3, marginTop: 12 }}>Subscribed calendar</Text>

              {/* Notes */}
              {event?.description ? (
                <View style={{ marginTop: 14, backgroundColor: C.surface2, borderRadius: 12, padding: 12 }}>
                  <Text style={{ fontSize: 13, color: C.text, lineHeight: 20 }} numberOfLines={6}>
                    {event.description}
                  </Text>
                </View>
              ) : null}

              {/* Join CTA */}
              {meetingUrl ? (
                <TouchableOpacity
                  onPress={onJoin}
                  activeOpacity={0.85}
                  style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, backgroundColor: C.accent, borderRadius: 12 }}
                >
                  <Video size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                    {provider ? `Join ${provider}` : 'Join meeting'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}
