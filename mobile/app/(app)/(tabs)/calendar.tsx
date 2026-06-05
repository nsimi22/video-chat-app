// Calendar tab — host for the three view modes from the design prototype
// (Week / 3-day / Month). The host owns the team data, the realtime sub,
// the ICS subscription poll, and the selected-day cursor; the child
// views are presentational.
//
// Pure-black background + tight hairlines match the design's pure-iCal
// surface; this overrides the global @/theme `colors.bg` for *this tab
// only* (chat + people + settings keep their original palette).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, router } from 'expo-router';
import { Plus, Search } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { listChannels, type Channel } from '@/lib/api';
import {
  loadScheduledCalls,
  subscribeScheduledCalls,
  type ScheduledCall,
} from '@/lib/scheduledCalls';
import { parseIcs, type IcsEvent } from '@/lib/ics';
import { getCalendarSubscriptions, type CalendarSubscription } from '@/lib/integrations';
import { WeekView } from '@/components/calendar/WeekView';
import { ThreeDayView } from '@/components/calendar/ThreeDayView';
import { MonthView } from '@/components/calendar/MonthView';
import { ScheduleCallSheet } from '@/components/ScheduleCallSheet';
import { C, addDays, sameDay, startOfDay } from '@/components/calendar/tokens';

type Mode = 'week' | '3day' | 'month';

const UPCOMING_HORIZON_DAYS = 60;
const ICS_MAX_HORIZON_MS = UPCOMING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
// Symmetric 60-day window into the past so scrolled-back weeks still show
// subscribed-calendar events. (Truly unbounded ICS history isn't practical —
// recurring feeds expand to thousands of occurrences.)
const ICS_BACKLOG_MS = UPCOMING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
const ICS_POLL_MS = 15 * 60 * 1000;
// Per-feed network deadline. A slow / unresponsive ICS endpoint mustn't
// stall the tab — the polling timer will retry on its next tick anyway.
const ICS_FETCH_TIMEOUT_MS = 10_000;

function startOfWeek(d: Date): Date {
  // Sunday-anchored — matches the design's WEEK array (Sun → Sat).
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function headerTitleFor(mode: Mode, selectedDay: Date): string {
  if (mode === '3day') {
    const start = addDays(selectedDay, -1);
    const end = addDays(selectedDay, 1);
    if (start.getMonth() === end.getMonth()) {
      return `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()}–${end.getDate()}`;
    }
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  return MONTH_FMT.format(selectedDay);
}

export default function CalendarScreen() {
  const { activeTeam, userId } = useAuth();
  const [mode, setMode] = useState<Mode>('week');
  const [selectedDay, setSelectedDay] = useState<Date>(() => startOfDay(new Date()));
  const [scheduled, setScheduled] = useState<Map<string, ScheduledCall>>(new Map());
  const [icsByUrl, setIcsByUrl] = useState<Map<string, IcsEvent[]>>(new Map());
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshSubscriptions = useCallback(async (subs: CalendarSubscription[]) => {
    if (!subs.length) {
      setIcsByUrl(new Map());
      return;
    }
    const results = await Promise.allSettled(
      subs.map(async (s) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), ICS_FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(s.url, { signal: ac.signal });
        } finally {
          clearTimeout(t);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') ?? '';
        if (ct && !/text\/(calendar|plain)|application\/octet-stream/i.test(ct)) {
          console.warn('[calendar] unexpected content-type', s.url, ct);
        }
        const body = await res.text();
        const cutoff = Date.now() + ICS_MAX_HORIZON_MS;
        const floor = Date.now() - ICS_BACKLOG_MS;
        // Cap recurrence expansion at the display cutoff so a weekly rule
        // with no UNTIL doesn't try to emit thousands of occurrences only
        // to have most of them filtered out below.
        const parsed = parseIcs(body, { expandUntil: new Date(cutoff) });
        const horizon = parsed.events.filter(
          (e) => e.start && e.start.getTime() >= floor && e.start.getTime() <= cutoff,
        );
        return { url: s.url, events: horizon };
      }),
    );
    setIcsByUrl((prev) => {
      const next = new Map(prev);
      const liveUrls = new Set(subs.map((s) => s.url));
      for (const u of [...next.keys()]) if (!liveUrls.has(u)) next.delete(u);
      for (const r of results) {
        if (r.status === 'fulfilled') next.set(r.value.url, r.value.events);
        else console.warn('[calendar] ics fetch failed', r.reason);
      }
      return next;
    });
  }, []);

  const initialLoad = useCallback(async () => {
    if (!activeTeam || !userId) return;
    try {
      const [rows, ch, subs] = await Promise.all([
        // No `from` bound — past events stay visible when scrolling back.
        loadScheduledCalls(activeTeam.id),
        listChannels(activeTeam.id),
        getCalendarSubscriptions(userId),
      ]);
      const map = new Map<string, ScheduledCall>();
      for (const r of rows) map.set(r.id, r);
      setScheduled(map);
      setChannels(ch);
      setSubscriptions(subs);
      refreshSubscriptions(subs).catch((err) => console.warn('refreshSubscriptions failed', err));
    } finally {
      setLoading(false);
    }
  }, [activeTeam, userId, refreshSubscriptions]);

  useFocusEffect(useCallback(() => { initialLoad(); }, [initialLoad]));

  useEffect(() => {
    if (!activeTeam) return;
    const unsub = subscribeScheduledCalls(activeTeam.id, (evt) => {
      setScheduled((prev) => {
        const next = new Map(prev);
        if (evt.kind === 'upsert') next.set(evt.row.id, evt.row);
        else next.delete(evt.id);
        return next;
      });
    });
    return unsub;
  }, [activeTeam]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!subscriptions.length) return;
    pollRef.current = setInterval(() => {
      refreshSubscriptions(subscriptions).catch(() => {});
    }, ICS_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [subscriptions, refreshSubscriptions]);

  const events = useMemo(() => [...scheduled.values()], [scheduled]);
  const icsEvents = useMemo(() => [...icsByUrl.values()].flat(), [icsByUrl]);

  const today = new Date();
  const onToday = sameDay(selectedDay, today);
  const weekStart = useMemo(() => startOfWeek(selectedDay), [selectedDay]);

  const headerTitle = headerTitleFor(mode, selectedDay);

  function onTapEvent(id: string) {
    router.push(`/(app)/event/${id}`);
  }

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.accent} />
      </SafeAreaView>
    );
  }

  if (!activeTeam || !userId) {
    return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header — large month title + Today / + actions, matching the
          design prototype's WeekHeader. */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 6,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 22, fontWeight: '700', color: '#fff', letterSpacing: -0.4 }}>
            {headerTitle}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <TouchableOpacity hitSlop={8} onPress={() => {}}>
            <Search size={20} color={C.text2} />
          </TouchableOpacity>
          {!onToday && (
            <TouchableOpacity
              hitSlop={8}
              onPress={() => setSelectedDay(startOfDay(new Date()))}
              activeOpacity={0.7}
            >
              <Text style={{ fontSize: 16, color: C.accent, fontWeight: '500' }}>Today</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity hitSlop={8} onPress={() => setSheetOpen(true)} activeOpacity={0.7}>
            <Plus size={22} color={C.accent} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {/* View-mode switcher */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', gap: 6 }}>
        {(['week', '3day', 'month'] as const).map((m) => {
          const active = mode === m;
          return (
            <TouchableOpacity
              key={m}
              onPress={() => setMode(m)}
              activeOpacity={0.7}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 8,
                backgroundColor: active ? C.surface2 : 'transparent',
                borderWidth: 1,
                borderColor: active ? C.surface3 : 'transparent',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: active ? '600' : '500', color: active ? '#fff' : C.text2 }}>
                {m === 'week' ? 'Week' : m === '3day' ? '3 Day' : 'Month'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {mode === 'week' && (
        <WeekView
          weekStart={weekStart}
          selectedDay={selectedDay}
          events={events}
          icsEvents={icsEvents}
          channels={channels}
          onSelectDay={setSelectedDay}
          onTapEvent={onTapEvent}
        />
      )}
      {mode === '3day' && (
        <ThreeDayView
          anchorDay={selectedDay}
          events={events}
          icsEvents={icsEvents}
          channels={channels}
          onTapEvent={onTapEvent}
          onSelectDay={setSelectedDay}
        />
      )}
      {mode === 'month' && (
        <MonthView
          anchorMonth={selectedDay}
          selectedDay={selectedDay}
          events={events}
          channels={channels}
          onSelectDay={setSelectedDay}
          onTapEvent={onTapEvent}
        />
      )}

      <ScheduleCallSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        teamId={activeTeam.id}
        userId={userId}
        channels={channels}
        defaultChannelId={null}
        onScheduled={() => initialLoad()}
      />
    </SafeAreaView>
  );
}
