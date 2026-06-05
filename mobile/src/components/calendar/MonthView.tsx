// Month view — port of `MonthView` from the design prototype.
// 7-column date grid with leading/trailing days from neighboring months
// dimmed, channel-colored dots under each day, and a mini agenda below
// for the currently-selected day. Subscribed ICS events render as gray
// dots + agenda rows alongside internal scheduled calls.

import { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tabBarClearance } from '@/theme';
import type { Channel } from '@/lib/api';
import type { ScheduledCall } from '@/lib/scheduledCalls';
import type { IcsEvent } from '@/lib/ics';
import { C, addDays, channelColorForChannel, fmtTime, icsAllDayOnDay, sameDay, startOfDay } from './tokens';
import { HuddleMiniMark } from './atoms';

type Props = {
  anchorMonth: Date; // any date inside the month being shown
  selectedDay: Date;
  events: ScheduledCall[];
  icsEvents: IcsEvent[];
  channels: Channel[];
  onSelectDay: (d: Date) => void;
  onTapEvent: (id: string) => void;
};

// Unified agenda row — internal calls are tappable, ICS rows are
// display-only (they have no detail screen, same as the other views).
type AgendaItem = {
  key: string;
  title: string;
  subtitle: string;
  color: string;
  isHuddle: boolean;
  allDay: boolean;
  start: Date;
  end: Date | null;
  scheduledCallId: string | null;
};

type CellDay = { date: Date; dim: boolean };

function monthCells(anchor: Date): CellDay[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const leading = first.getDay(); // 0=Sun
  const cells: CellDay[] = [];
  for (let i = leading; i > 0; i--) {
    cells.push({ date: addDays(first, -i), dim: true });
  }
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push({ date: new Date(anchor.getFullYear(), anchor.getMonth(), d), dim: false });
  }
  // Round out to a multiple of 7 so the grid never has a half-row.
  while (cells.length % 7 !== 0) {
    cells.push({ date: addDays(cells[cells.length - 1].date, 1), dim: true });
  }
  return cells;
}

export function MonthView({ anchorMonth, selectedDay, events, icsEvents, channels, onSelectDay, onTapEvent }: Props) {
  const insets = useSafeAreaInsets();
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const cells = useMemo(() => monthCells(anchorMonth), [anchorMonth]);

  // dot colors per day. Up to 3 distinct colors, in event order; ICS
  // events contribute a gray dot (multi-day all-day spans on every
  // covered day).
  const dotsByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    const push = (k: string, color: string) => {
      const list = map.get(k) ?? [];
      if (!list.includes(color) && list.length < 3) list.push(color);
      map.set(k, list);
    };
    const sorted = [...events].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (const e of sorted) {
      const ch = channelById.get(e.channelId);
      push(startOfDay(e.startsAt).toDateString(), channelColorForChannel(e.channelId, ch?.type));
    }
    for (const e of icsEvents) {
      if (!e.start) continue;
      if (e.allDay) {
        // Walk covered days ([DTSTART, DTEND) — exclusive end), bounded
        // so a malformed years-long span can't spin.
        let d = startOfDay(e.start);
        for (let i = 0; i < 62 && icsAllDayOnDay(e, d); i++) {
          push(d.toDateString(), C.text2);
          d = addDays(d, 1);
        }
      } else {
        push(startOfDay(e.start).toDateString(), C.text2);
      }
    }
    return map;
  }, [events, icsEvents, channelById]);

  const dayAgenda = useMemo<AgendaItem[]>(() => {
    const out: AgendaItem[] = [];
    for (const e of events) {
      if (!sameDay(e.startsAt, selectedDay)) continue;
      const ch = channelById.get(e.channelId);
      out.push({
        key: 'h:' + e.id,
        title: e.title,
        subtitle: `# ${ch?.name ?? e.channelId}`,
        color: channelColorForChannel(e.channelId, ch?.type),
        isHuddle: true,
        allDay: false,
        start: e.startsAt,
        end: new Date(e.startsAt.getTime() + e.durationMin * 60 * 1000),
        scheduledCallId: e.id,
      });
    }
    for (const e of icsEvents) {
      if (!e.start) continue;
      const hit = e.allDay ? icsAllDayOnDay(e, selectedDay) : sameDay(e.start, selectedDay);
      if (!hit) continue;
      out.push({
        key: 'i:' + (e.uid || `${e.title}:${e.start.toISOString()}`),
        title: e.title || '(untitled)',
        subtitle: e.location || 'Subscribed calendar',
        color: C.text2,
        isHuddle: false,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        scheduledCallId: null,
      });
    }
    // All-day first, then chronological.
    out.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
    return out;
  }, [events, icsEvents, selectedDay, channelById]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: tabBarClearance(insets.bottom) }}>
        {/* weekday header */}
        <View style={{ flexDirection: 'row', paddingTop: 10, paddingBottom: 6, borderBottomWidth: 0.5, borderBottomColor: C.hair }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
            <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: C.text3, fontWeight: '600', letterSpacing: 0.5 }}>
              {w}
            </Text>
          ))}
        </View>
        {/* date grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {cells.map((cell) => {
            const today = sameDay(cell.date, new Date());
            const selected = !cell.dim && sameDay(cell.date, selectedDay);
            const dots = dotsByDay.get(startOfDay(cell.date).toDateString()) ?? [];
            return (
              <TouchableOpacity
                key={cell.date.toISOString()}
                onPress={() => !cell.dim && onSelectDay(cell.date)}
                activeOpacity={cell.dim ? 1 : 0.7}
                disabled={cell.dim}
                style={{
                  width: `${100 / 7}%`,
                  aspectRatio: 1 / 1.05,
                  alignItems: 'center',
                  paddingVertical: 6,
                  borderBottomWidth: 0.5,
                  borderBottomColor: C.hair,
                }}
              >
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: today ? C.accent : selected ? C.surface2 : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 15,
                      fontWeight: today || selected ? '600' : '400',
                      color: cell.dim ? C.text3 : today ? '#fff' : C.text,
                    }}
                  >
                    {cell.date.getDate()}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 2, marginTop: 4, height: 4 }}>
                  {dots.map((color, i) => (
                    <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* agenda for selected day */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.text2, letterSpacing: 0.6, marginBottom: 10 }}>
            {selectedDay.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase()} ·{' '}
            {selectedDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}
          </Text>
          {dayAgenda.length === 0 ? (
            <Text style={{ color: C.text3, fontSize: 13, paddingVertical: 16 }}>Nothing scheduled.</Text>
          ) : (
            dayAgenda.map((item) => {
              const disabled = !item.scheduledCallId;
              return (
                <TouchableOpacity
                  key={item.key}
                  onPress={() => item.scheduledCallId && onTapEvent(item.scheduledCallId)}
                  activeOpacity={disabled ? 1 : 0.7}
                  disabled={disabled}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 0.5, borderTopColor: C.hair }}
                >
                  <View style={{ width: 4, alignSelf: 'stretch', backgroundColor: item.color, borderRadius: 2 }} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {item.isHuddle && <HuddleMiniMark size={11} color={item.color} />}
                      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: '#fff', flex: 1 }}>{item.title}</Text>
                    </View>
                    <Text numberOfLines={1} style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>{item.subtitle}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {item.allDay ? (
                      <Text style={{ fontSize: 12, color: C.text2 }}>All day</Text>
                    ) : (
                      <>
                        <Text style={{ fontSize: 12, color: C.text2, fontVariant: ['tabular-nums'] }}>{fmtTime(item.start)}</Text>
                        {item.end && (
                          <Text style={{ fontSize: 12, color: C.text3, fontVariant: ['tabular-nums'] }}>{fmtTime(item.end)}</Text>
                        )}
                      </>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}
