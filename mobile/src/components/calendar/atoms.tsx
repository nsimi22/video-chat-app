// Shared atoms used by Week / 3-day / Month / Detail. Kept tiny so each
// view stays focused on layout. The miniature huddle-arcs glyph here is
// the same geometry as components/ui.tsx Logo, just sized small enough to
// fit inside an event block (prototype rendered it at 9–11 px).

import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { C } from './tokens';
import type { ScheduledCall } from '@/lib/scheduledCalls';

export function HuddleMiniMark({ size = 11, color = C.accent }: { size?: number; color?: string }) {
  // Same construction as the design prototype's inline svg — center dot +
  // half-arc + two upper quarter-arcs in the brand color. Scaled to fit
  // beside the event title.
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200">
      <Circle cx={100} cy={120} r={22} fill={color} />
      <Path d="M 50 120 A 50 50 0 0 1 150 120" fill="none" stroke={color} strokeWidth={22} strokeLinecap="round" />
      <Path d="M 30 120 A 70 70 0 0 1 90 51.6" fill="none" stroke={color} strokeWidth={22} strokeLinecap="round" />
      <Path d="M 110 51.6 A 70 70 0 0 1 170 120" fill="none" stroke={color} strokeWidth={22} strokeLinecap="round" />
    </Svg>
  );
}

export function Hair({ inset = 0, color = C.hair }: { inset?: number; color?: string }) {
  return <View style={{ height: 0.5, backgroundColor: color, marginLeft: inset }} />;
}

// Channel slug stripped of leading `#`. For DM channels (`dm:…`) the
// channel name carries the other user's display name already, so we
// return it verbatim. Used for the channel pill on event blocks.
export function channelDisplayName(channelName: string): string {
  if (!channelName) return '';
  return channelName.replace(/^#/, '');
}

// Tiny helpers shared by views — derive sort key + title.
export function eventSortKey(c: ScheduledCall): number {
  return c.startsAt.getTime();
}

export function eventEndMs(c: ScheduledCall): number {
  return c.startsAt.getTime() + c.durationMin * 60 * 1000;
}
