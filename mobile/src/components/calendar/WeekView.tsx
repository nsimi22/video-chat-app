// Week view (home) — port of `WeekView` from the design prototype.
// Top: 7-day strip with today pill highlight + 1–3 per-day event dots.
// Bottom: scrollable 24h timeline for the currently-selected day with
// channel-tinted event blocks + a red current-time bar.

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
  startOfDay,
} from './tokens';
import { HuddleMiniMark } from './atoms';

type Props = {
  weekStart: Date;
  selectedDay: Date;
  events: ScheduledCall[];
  icsEvents: IcsEvent[];
  channels: Channel[];
  onSelectDay: (d: Date) => void;
  onTapEvent: (id: string) => void;
};

// Lightweight overlay shape — both internal scheduled_calls and external
// ICS events flow into the same rendering path, so we normalize here.
type Block = {
  key: string;
  kind: 'huddle' | 'ics';
  title: string;
  startHour: number;
  endHour: number;
  color: string;
  channelName: string;
  isHuddle: boolean;
  // The sender of this block to the surrounding screen — null for ICS rows
  // (they can't be tapped through to a detail screen since they're not in
  // our table).
  scheduledCallId: string | null;
};

// Block + the side-by-side lane assignment from layoutOverlaps().
type LaidBlock = Block & { col: number; cols: number };

export function WeekView({
  weekStart,
  selectedDay,
  events,
  icsEvents,
  channels,
  onSelectDay,
  onTapEvent,
}: Props) {
  const insets = useSafeAreaInsets();
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  // dot indicators under each day in the strip — show up to 3 channel colors.
  const dotsByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    const all: { date: Date; color: string }[] = [];
    for (const e of events) {
      const ch = channelById.get(e.channelId);
      all.push({ date: e.startsAt, color: channelColorForChannel(e.channelId, ch?.type) });
    }
    for (const day of days) {
      const colors: string[] = [];
      const seen = new Set<string>();
      // All-day ICS events can span several days — count them on every
      // covered day, not just DTSTART's.
      for (const e of icsEvents) {
        if (!e.start) continue;
        const hit = e.allDay ? icsAllDayOnDay(e, day) : sameDay(e.start, day);
        if (hit && !seen.has(C.text2)) {
          seen.add(C.text2);
          colors.push(C.text2);
        }
      }
      for (const item of all) {
        if (colors.length === 3) break;
        if (!sameDay(item.date, day)) continue;
        if (seen.has(item.color)) continue;
        seen.add(item.color);
        colors.push(item.color);
        if (colors.length === 3) break;
      }
      map.set(day.toDateString(), colors);
    }
    return map;
  }, [days, events, icsEvents, channelById]);

  const blocks = useMemo<LaidBlock[]>(() => {
    const out: Block[] = [];
    for (const e of events) {
      if (!sameDay(e.startsAt, selectedDay)) continue;
      const ch = channelById.get(e.channelId);
      const start = hourOf(e.startsAt);
      const end = Math.min(DAY_END, start + e.durationMin / 60);
      out.push({
        key: 'h:' + e.id,
        kind: 'huddle',
        title: e.title,
        startHour: start,
        endHour: end,
        color: channelColorForChannel(e.channelId, ch?.type),
        channelName: ch?.name ?? e.channelId,
        isHuddle: true,
        scheduledCallId: e.id,
      });
    }
    for (const e of icsEvents) {
      if (!e.start || !sameDay(e.start, selectedDay) || e.allDay) continue;
      const start = hourOf(e.start);
      // An event that crosses midnight ends on a later day — hourOf() only
      // reads clock time, so it would yield endHour < startHour (negative
      // duration + corrupted overlap lanes). Clamp the block to midnight.
      const end = !e.end ? start + 0.5 : sameDay(e.end, e.start) ? hourOf(e.end) : DAY_END;
      out.push({
        key: 'i:' + (e.uid || `${e.title}:${e.start.toISOString()}`),
        kind: 'ics',
        title: e.title || '(untitled)',
        startHour: start,
        endHour: Math.min(DAY_END, Math.max(end, start + 0.25)),
        color: C.text2,
        channelName: '',
        isHuddle: false,
        scheduledCallId: null,
      });
    }
    // Overlapping events split the lane side-by-side instead of stacking.
    return layoutOverlaps(out);
  }, [events, icsEvents, selectedDay, channelById]);

  // All-day ICS events covering the selected day — rendered as a banner
  // strip pinned above the timeline (they have no meaningful hour).
  const allDayItems = useMemo(
    () => icsEvents.filter((e) => icsAllDayOnDay(e, selectedDay)),
    [icsEvents, selectedDay],
  );

  const isToday = sameDay(selectedDay, new Date());
  const nowHour = hourOf(new Date());

  // Anchor initial scroll at 7am (the prototype's day-start). Once the
  // user scrolls we don't yank them back — only on mount + when the
  // selected day changes back to "today" do we re-anchor.
  const scrollRef = useRef<ScrollView | null>(null);
  useEffect(() => {
    const y = (DAY_BUSINESS_START - DAY_START) * HOUR_PX;
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [selectedDay]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* day strip */}
      <View style={{ paddingHorizontal: 4, paddingTop: 6, paddingBottom: 12, borderBottomWidth: 0.5, borderBottomColor: C.hair }}>
        <View style={{ flexDirection: 'row' }}>
          {days.map((day) => {
            const today = sameDay(day, new Date());
            const selected = sameDay(day, selectedDay);
            const dots = dotsByDay.get(day.toDateString()) ?? [];
            const label = day.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase();
            return (
              <TouchableOpacity
                key={day.toISOString()}
                onPress={() => onSelectDay(day)}
                activeOpacity={0.75}
                style={{ flex: 1, alignItems: 'center', paddingVertical: 8, gap: 6 }}
              >
                <Text style={{ fontSize: 11, fontWeight: '500', color: today ? C.accent : C.text2, letterSpacing: 0.4 }}>
                  {label}
                </Text>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: today ? C.accent : selected ? C.surface2 : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 18, fontWeight: today || selected ? '600' : '400', color: today ? '#fff' : C.text }}>
                    {day.getDate()}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 3, height: 4 }}>
                  {dots.map((color, i) => (
                    <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: today ? '#fff' : color }} />
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* all-day banner strip */}
      {allDayItems.length > 0 && (
        <View style={{ borderBottomWidth: 0.5, borderBottomColor: C.hair, paddingVertical: 6, paddingLeft: 56, paddingRight: 12, gap: 4 }}>
          {allDayItems.map((e) => (
            <View
              key={'ad:' + (e.uid || `${e.title}:${e.start?.toISOString()}`)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: C.surface2,
                borderLeftWidth: 3,
                borderLeftColor: C.text2,
                borderRadius: 6,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            >
              <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: '#fff', flex: 1 }}>
                {e.title || '(untitled)'}
              </Text>
              <Text style={{ fontSize: 11, fontWeight: '500', color: C.text2 }}>All day</Text>
            </View>
          ))}
        </View>
      )}

      {/* timeline */}
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: tabBarClearance(insets.bottom) }}
      >
        <Timeline
          blocks={blocks}
          isToday={isToday}
          nowHour={nowHour}
          onTapBlock={onTapEvent}
        />
      </ScrollView>
    </View>
  );
}

function Timeline({
  blocks,
  isToday,
  nowHour,
  onTapBlock,
}: {
  blocks: LaidBlock[];
  isToday: boolean;
  nowHour: number;
  onTapBlock: (id: string) => void;
}) {
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  return (
    <View style={{ position: 'relative', paddingTop: 8, height: (DAY_END - DAY_START) * HOUR_PX + 16 }}>
      {hours.map((h) => (
        <View key={h} style={{ height: HOUR_PX, position: 'relative' }}>
          <Text
            style={{
              position: 'absolute',
              left: 8,
              top: -7,
              width: 42,
              textAlign: 'right',
              fontSize: 11,
              color: C.text3,
              fontVariant: ['tabular-nums'],
            }}
          >
            {fmtHourLabel(h)}
          </Text>
          <View
            style={{
              position: 'absolute',
              left: 56,
              right: 12,
              top: 0,
              height: 0.5,
              backgroundColor: C.hair,
            }}
          />
        </View>
      ))}

      {/* Lane container — blocks position with % left/width inside it so
          overlapping events render side by side. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, bottom: 0, left: 56, right: 12 }}>
        {blocks.map((b) => (
          <EventBlock key={b.key} block={b} onPress={onTapBlock} />
        ))}
      </View>

      {isToday && <CurrentTimeBar nowHour={nowHour} />}
    </View>
  );
}

function EventBlock({ block, onPress }: { block: LaidBlock; onPress: (id: string) => void }) {
  const top = (block.startHour - DAY_START) * HOUR_PX + 8;
  const height = Math.max(28, (block.endHour - block.startHour) * HOUR_PX - 2);
  const startDate = new Date();
  startDate.setHours(Math.floor(block.startHour), Math.round((block.startHour % 1) * 60), 0, 0);
  const endDate = new Date();
  endDate.setHours(Math.floor(block.endHour), Math.round((block.endHour % 1) * 60), 0, 0);
  const disabled = !block.scheduledCallId;
  const narrow = block.cols > 1;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top,
        height,
        left: `${(block.col / block.cols) * 100}%`,
        width: `${100 / block.cols}%`,
        paddingRight: block.col < block.cols - 1 ? 3 : 0,
      }}
    >
      <TouchableOpacity
        onPress={() => block.scheduledCallId && onPress(block.scheduledCallId)}
        activeOpacity={disabled ? 1 : 0.7}
        disabled={disabled}
        style={{
          flex: 1,
          backgroundColor: block.color + '22',
          borderLeftWidth: 3,
          borderLeftColor: block.color,
          borderRadius: 6,
          paddingHorizontal: narrow ? 7 : 10,
          paddingVertical: 6,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          {block.isHuddle && <HuddleMiniMark size={11} color={block.color} />}
          <Text numberOfLines={narrow ? 2 : 1} style={{ fontSize: narrow ? 12 : 13, fontWeight: '600', color: '#fff', flex: 1 }}>
            {block.title}
          </Text>
        </View>
        {/* Hide the time row when the tile isn't tall enough to fit both
            the title and the time without clipping (≤ 30-min events
            render at the floor of 28px, which only fits the title).
            The week scale also surfaces it via the timeline gridline. */}
        {height >= 44 && (
          <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: '500', color: block.color, opacity: 0.9 }}>
            {fmtTime(startDate)} – {fmtTime(endDate)}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

function CurrentTimeBar({ nowHour }: { nowHour: number }) {
  const y = (nowHour - DAY_START) * HOUR_PX + 8;
  const now = new Date();
  const label = `${((now.getHours() + 11) % 12) + 1}:${String(now.getMinutes()).padStart(2, '0')}`;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 8, right: 12, top: y, flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Text style={{ width: 44, textAlign: 'right', fontSize: 11, color: C.red, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.red, marginLeft: 4 }} />
      <View style={{ flex: 1, height: 1.5, backgroundColor: C.red, marginLeft: -2 }} />
    </View>
  );
}
