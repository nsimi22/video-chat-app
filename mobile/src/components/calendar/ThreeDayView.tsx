// 3-day view — port of `ThreeDayView` from the design prototype.
// Three vertical day columns sharing one hour gutter; today's column gets
// a subtle accent wash + the current-time bar scoped to it.

import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
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
  sameDay,
} from './tokens';
import { HuddleMiniMark } from './atoms';

type Props = {
  anchorDay: Date; // middle column
  events: ScheduledCall[];
  icsEvents: IcsEvent[];
  channels: Channel[];
  onTapEvent: (id: string) => void;
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
};

export function ThreeDayView({ anchorDay, events, icsEvents, channels, onTapEvent, onSelectDay }: Props) {
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
    const out = new Map<string, ColBlock[]>();
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
      });
    }
    for (const e of icsEvents) {
      if (!e.start || e.allDay) continue;
      const key = e.start.toDateString();
      if (!out.has(key)) continue;
      const start = hourOf(e.start);
      const end = e.end ? hourOf(e.end) : start + 0.5;
      out.get(key)!.push({
        key: 'i:' + (e.uid || `${e.title}:${e.start.toISOString()}`),
        title: e.title || '(untitled)',
        startHour: start,
        endHour: Math.min(DAY_END, end),
        color: C.text2,
        isHuddle: false,
        scheduledCallId: null,
      });
    }
    return out;
  }, [days, events, icsEvents, channelById]);

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

      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
        <Grid days={days} blocksByDay={blocksByDay} nowHour={nowHour} onTapBlock={onTapEvent} />
      </ScrollView>
    </View>
  );
}

function Grid({
  days,
  blocksByDay,
  nowHour,
  onTapBlock,
}: {
  days: Date[];
  blocksByDay: Map<string, ColBlock[]>;
  nowHour: number;
  onTapBlock: (id: string) => void;
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
                <ColumnEventBlock key={b.key} block={b} onPress={onTapBlock} />
              ))}
              {today && <ColumnNowBar nowHour={nowHour} />}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ColumnEventBlock({ block, onPress }: { block: ColBlock; onPress: (id: string) => void }) {
  const top = (block.startHour - DAY_START) * HOUR_PX;
  const height = Math.max(20, (block.endHour - block.startHour) * HOUR_PX - 2);
  const startDate = new Date();
  startDate.setHours(Math.floor(block.startHour), Math.round((block.startHour % 1) * 60), 0, 0);
  const disabled = !block.scheduledCallId;
  return (
    <TouchableOpacity
      onPress={() => block.scheduledCallId && onPress(block.scheduledCallId)}
      activeOpacity={disabled ? 1 : 0.7}
      disabled={disabled}
      style={{
        position: 'absolute',
        top,
        left: 1,
        right: 3,
        height,
        backgroundColor: block.color + '26',
        borderLeftWidth: 2.5,
        borderLeftColor: block.color,
        borderRadius: 5,
        paddingHorizontal: 7,
        paddingVertical: 5,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}>
        {block.isHuddle && <HuddleMiniMark size={9} color={block.color} />}
        <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: '600', color: '#fff', flex: 1, lineHeight: 14 }}>
          {block.title}
        </Text>
      </View>
      <Text style={{ fontSize: 9.5, color: block.color, fontWeight: '500', lineHeight: 12 }}>
        {fmtTime(startDate)}
      </Text>
    </TouchableOpacity>
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
