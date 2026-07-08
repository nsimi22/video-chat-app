// 3-day view — port of `ThreeDayView` from the design prototype.
// Three vertical day columns sharing one hour gutter; today's column gets
// a subtle accent wash + the current-time bar scoped to it.

import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tabBarClearance } from '@/theme';
import type { Channel } from '@/lib/api';
import type { ScheduledCall } from '@/lib/scheduledCalls';
import type { IcsEvent } from '@/lib/ics';
import {
  C,
  DAY_BUSINESS_START,
  DAY_END,
  DAY_START,
  HOUR_PX,
  addDays,
  channelColorForChannel,
  fmtHourLabel,
  fmtTime,
  hourOf,
  icsAllDayOnDay,
  layoutOverlaps,
  sameDay,
} from './tokens';
import { HuddleMiniMark } from './atoms';

type Props = {
  anchorDay: Date; // middle column
  events: ScheduledCall[];
  icsEvents: IcsEvent[];
  channels: Channel[];
  onTapEvent: (id: string) => void;
  onTapIcs: (e: IcsEvent) => void;
  onSelectDay: (d: Date) => void;
};

type ColBlock = {
  key: string;
  title: string;
  startHour: number;
  endHour: number;
  color: string;
  isHuddle: boolean;
  scheduledCallId: string | null;
  icsEvent: IcsEvent | null;
};

// ColBlock + the side-by-side lane assignment from layoutOverlaps().
type LaidColBlock = ColBlock & { col: number; cols: number };

export function ThreeDayView({ anchorDay, events, icsEvents, channels, onTapEvent, onTapIcs, onSelectDay }: Props) {
  const insets = useSafeAreaInsets();
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const days = useMemo(
    () => [addDays(anchorDay, -1), anchorDay, addDays(anchorDay, 1)],
    [anchorDay],
  );

  const blocksByDay = useMemo(() => {
    const raw = new Map<string, ColBlock[]>();
    const out = raw;
    for (const d of days) out.set(d.toDateString(), []);
    for (const e of events) {
      const key = e.startsAt.toDateString();
      if (!out.has(key)) continue;
      const ch = channelById.get(e.channelId);
      const start = hourOf(e.startsAt);
      out.get(key)!.push({
        key: 'h:' + e.id,
        title: e.title,
        startHour: start,
        endHour: Math.min(DAY_END, start + e.durationMin / 60),
        color: channelColorForChannel(e.channelId, ch?.type),
        isHuddle: true,
        scheduledCallId: e.id,
        icsEvent: null,
      });
    }
    for (const e of icsEvents) {
      if (!e.start || e.allDay) continue;
      const key = e.start.toDateString();
      if (!out.has(key)) continue;
      const start = hourOf(e.start);
      // Cross-midnight events would get endHour < startHour (hourOf reads
      // clock time only) — clamp the block to midnight. See WeekView.
      const end = !e.end ? start + 0.5 : sameDay(e.end, e.start) ? hourOf(e.end) : DAY_END;
      out.get(key)!.push({
        key: 'i:' + (e.uid || `${e.title}:${e.start.toISOString()}`),
        title: e.title || '(untitled)',
        startHour: start,
        endHour: Math.min(DAY_END, Math.max(end, start + 0.25)),
        color: C.text2,
        isHuddle: false,
        scheduledCallId: null,
        icsEvent: e,
      });
    }
    // Overlapping events within a day split the column side-by-side.
    const laid = new Map<string, LaidColBlock[]>();
    for (const [key, list] of raw) laid.set(key, layoutOverlaps(list));
    return laid;
  }, [days, events, icsEvents, channelById]);

  // All-day ICS events per column — banner chips above the hour grid.
  const allDayByDay = useMemo(() => {
    const out = new Map<string, IcsEvent[]>();
    for (const d of days) {
      out.set(d.toDateString(), icsEvents.filter((e) => icsAllDayOnDay(e, d)));
    }
    return out;
  }, [days, icsEvents]);
  const hasAllDay = days.some((d) => (allDayByDay.get(d.toDateString()) ?? []).length > 0);

  const now = new Date();
  const nowHour = hourOf(now);

  const scrollRef = useRef<ScrollView | null>(null);
  useEffect(() => {
    const y = (DAY_BUSINESS_START - DAY_START) * HOUR_PX;
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [anchorDay]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* day strip — gutter-padded so labels align with columns below */}
      <View
        style={{
          flexDirection: 'row',
          paddingLeft: 44,
          paddingVertical: 8,
          borderBottomWidth: 0.5,
          borderBottomColor: C.hair,
        }}
      >
        {days.map((day) => {
          const today = sameDay(day, new Date());
          const label = day.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase();
          return (
            <TouchableOpacity
              key={day.toISOString()}
              onPress={() => onSelectDay(day)}
              activeOpacity={0.75}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 6, gap: 4 }}
            >
              <Text style={{ fontSize: 11, fontWeight: '500', color: today ? C.accent : C.text2, letterSpacing: 0.4 }}>
                {label}
              </Text>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: today ? C.accent : 'transparent',
                }}
              >
                <Text style={{ fontSize: 16, fontWeight: today ? '600' : '400', color: today ? '#fff' : C.text }}>
                  {day.getDate()}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* all-day banner row — one cell per column, sharing the hour gutter */}
      {hasAllDay && (
        <View style={{ flexDirection: 'row', paddingLeft: 44, paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: C.hair }}>
          {days.map((day, idx) => {
            const items = allDayByDay.get(day.toDateString()) ?? [];
            return (
              <View
                key={day.toISOString()}
                style={{
                  flex: 1,
                  gap: 3,
                  paddingHorizontal: 2,
                  borderRightWidth: idx < days.length - 1 ? 0.5 : 0,
                  borderRightColor: C.hair,
                }}
              >
                {items.map((e) => (
                  <TouchableOpacity
                    key={'ad:' + (e.uid || `${e.title}:${e.start?.toISOString()}`)}
                    onPress={() => onTapIcs(e)}
                    activeOpacity={0.7}
                    style={{
                      backgroundColor: C.surface2,
                      borderLeftWidth: 2.5,
                      borderLeftColor: C.text2,
                      borderRadius: 4,
                      paddingHorizontal: 5,
                      paddingVertical: 3,
                    }}
                  >
                    <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: '600', color: '#fff' }}>
                      {e.title || '(untitled)'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            );
          })}
        </View>
      )}

      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: tabBarClearance(insets.bottom) }}>
        <Grid days={days} blocksByDay={blocksByDay} nowHour={nowHour} onTapBlock={onTapEvent} onTapIcs={onTapIcs} />
      </ScrollView>
    </View>
  );
}

function Grid({
  days,
  blocksByDay,
  nowHour,
  onTapBlock,
  onTapIcs,
}: {
  days: Date[];
  blocksByDay: Map<string, LaidColBlock[]>;
  nowHour: number;
  onTapBlock: (id: string) => void;
  onTapIcs: (e: IcsEvent) => void;
}) {
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const gutter = 44;
  const totalHeight = (DAY_END - DAY_START) * HOUR_PX + 16;

  return (
    <View style={{ position: 'relative', paddingTop: 8, height: totalHeight }}>
      {/* hour rows + gutter labels */}
      {hours.map((h) => (
        <View key={h} style={{ height: HOUR_PX, position: 'relative' }}>
          <Text
            style={{
              position: 'absolute',
              left: 4,
              top: -7,
              width: gutter - 8,
              textAlign: 'right',
              fontSize: 10,
              color: C.text3,
              fontVariant: ['tabular-nums'],
            }}
          >
            {fmtHourLabel(h)}
          </Text>
          <View style={{ position: 'absolute', left: gutter, right: 0, top: 0, height: 0.5, backgroundColor: C.hair }} />
        </View>
      ))}

      {/* day columns */}
      <View style={{ position: 'absolute', top: 8, bottom: 0, left: gutter, right: 0, flexDirection: 'row' }}>
        {days.map((day, idx) => {
          const today = sameDay(day, new Date());
          const cols = blocksByDay.get(day.toDateString()) ?? [];
          return (
            <View
              key={day.toISOString()}
              style={{
                flex: 1,
                position: 'relative',
                borderRightWidth: idx < days.length - 1 ? 0.5 : 0,
                borderRightColor: C.hair,
              }}
            >
              {today && (
                <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(74,139,245,0.04)' }} />
              )}
              {cols.map((b) => (
                <ColumnEventBlock key={b.key} block={b} onPress={onTapBlock} onPressIcs={onTapIcs} />
              ))}
              {today && <ColumnNowBar nowHour={nowHour} />}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ColumnEventBlock({ block, onPress, onPressIcs }: { block: LaidColBlock; onPress: (id: string) => void; onPressIcs: (e: IcsEvent) => void }) {
  const top = (block.startHour - DAY_START) * HOUR_PX;
  const height = Math.max(20, (block.endHour - block.startHour) * HOUR_PX - 2);
  const startDate = new Date();
  startDate.setHours(Math.floor(block.startHour), Math.round((block.startHour % 1) * 60), 0, 0);
  const onPressBlock = () => {
    if (block.scheduledCallId) onPress(block.scheduledCallId);
    else if (block.icsEvent) onPressIcs(block.icsEvent);
  };
  // % lane math inside the day column — overlapping events sit side by side.
  const laneLeft = (block.col / block.cols) * 100;
  const laneWidth = 100 / block.cols;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top,
        height,
        left: `${laneLeft}%`,
        width: `${laneWidth}%`,
        paddingLeft: block.col === 0 ? 1 : 0,
        paddingRight: block.col === block.cols - 1 ? 3 : 2,
      }}
    >
      <TouchableOpacity
        onPress={onPressBlock}
        activeOpacity={0.7}
        style={{
          flex: 1,
          backgroundColor: block.color + '26',
          borderLeftWidth: 2.5,
          borderLeftColor: block.color,
          borderRadius: 5,
          paddingHorizontal: block.cols > 1 ? 4 : 7,
          paddingVertical: 5,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          {block.isHuddle && <HuddleMiniMark size={9} color={block.color} />}
          <Text numberOfLines={block.cols > 1 ? 2 : 1} style={{ fontSize: block.cols > 1 ? 10 : 11, fontWeight: '600', color: '#fff', flex: 1, lineHeight: 13 }}>
            {block.title}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ fontSize: 9.5, color: block.color, fontWeight: '500', lineHeight: 12 }}>
          {fmtTime(startDate)}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function ColumnNowBar({ nowHour }: { nowHour: number }) {
  const y = (nowHour - DAY_START) * HOUR_PX;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: -4, right: 0, top: y, flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.red }} />
      <View style={{ flex: 1, height: 1.5, backgroundColor: C.red, marginLeft: -4 }} />
    </View>
  );
}
