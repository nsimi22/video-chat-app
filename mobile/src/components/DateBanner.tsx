import { Text, View } from 'react-native';
import { colors, space } from '@/theme';

// Day separator dropped between messages in the chat list whenever the
// local-day flips (or above the very first / oldest message). Mirrors
// the desktop renderer's `.date-divider` (#158). Renders a thin hairline
// on either side of a small uppercase pill — small enough that it
// doesn't compete with messages for attention, prominent enough that
// the user can pick out which day each chunk of conversation belongs
// to without hovering an individual timestamp.

// Date getters already operate in the user's local timezone, so a
// per-component compare gives the right answer for two messages that
// span local midnight. Cheaper than toLocaleDateString equality on
// the render hot path (called per FlatList item).
export function isSameLocalDay(tsA: string | Date, tsB: string | Date): boolean {
  const a = new Date(tsA);
  const b = new Date(tsB);
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// "Today" / "Yesterday" / "Tuesday, May 26" — collapses recent days
// into friendly labels so the banner doesn't read like a log. Year is
// omitted in the current calendar year, included when scrolling back
// into a prior year so the archive isn't ambiguous.
export function formatDateBanner(ts: string | Date): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameLocalDay(d, today)) return 'Today';
  if (isSameLocalDay(d, yesterday)) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  // `undefined` falls back to the device default locale. Older Hermes /
  // JSC engines on Android reject the empty-array form with a "locale
  // not supported" error; undefined is the spec-blessed default-locale
  // argument and works on every JS engine RN ships with.
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// "Today 8:04 PM" / "Yesterday 8:04 PM" / "Wednesday 8:04 PM" — the day
// a message was sent, inline beside the time, so you don't have to scroll
// to its date banner to place it. Past a week the weekday names start
// repeating and read ambiguously, so we switch to a numeric date
// ("5/22 8:04 PM"), mirroring the friendly→explicit escalation in
// formatDateBanner above. Kept in lockstep with the desktop renderer's
// _formatMessageTime so both clients behave the same. `undefined` (not
// []) is the locale arg — older Android Hermes/JSC reject the empty-array
// form (see the note in formatDateBanner).
export function formatMessageTime(ts: string | Date): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameLocalDay(d, today)) return `Today ${time}`;
  if (isSameLocalDay(d, yesterday)) return `Yesterday ${time}`;
  // Local-midnight day delta for the week boundary — calendar days, not
  // 24h spans, so it doesn't drift with time-of-day.
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAgo = Math.round((startToday.getTime() - startMsg.getTime()) / 86400000);
  if (daysAgo >= 7) {
    const sameYear = d.getFullYear() === today.getFullYear();
    const date = d.toLocaleDateString(undefined, {
      month: 'numeric', day: 'numeric',
      ...(sameYear ? {} : { year: '2-digit' }),
    });
    return `${date} ${time}`;
  }
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`;
}

export function DateBanner({ ts }: { ts: string | Date }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: space(3),
        marginBottom: space(1.5),
        marginHorizontal: space(3),
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      {/* Container styles (border, background, radius) live on a View
          wrapper — RN renders border + backgroundColor on Text reliably
          on iOS but inconsistently on Android (text clipping, missing
          borders, padding misalignment). Splitting keeps the styling
          cross-platform safe and lets the inner Text only carry
          type-specific rules. */}
      <View
        style={{
          marginHorizontal: space(2.5),
          paddingHorizontal: 10,
          paddingVertical: 2,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 12,
          backgroundColor: colors.bg,
          overflow: 'hidden',
        }}
      >
        <Text
          // allowFontScaling left at the default — the banner has flexible
          // height so the user's text-size preference can scale this label
          // without overlapping anything (unlike the fixed-height unread
          // pill in #160).
          style={{
            fontSize: 11,
            fontWeight: '600',
            color: colors.textDim,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
          }}
        >
          {formatDateBanner(ts)}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
}
