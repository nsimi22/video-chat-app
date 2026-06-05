import { Platform } from 'react-native';

// Unified Huddle design tokens — ported from the Claude Design handoff
// (huddle-mobile/Huddle Mobile Prototype.html, :root oklch vars), converted
// to sRGB hex because React Native doesn't parse oklch(). The warm-charcoal
// + indigo palette replaces the original cool blue-black mobile theme and
// matches the unified design system the desktop redesign targets.
// Brand colors are sourced from the canonical Huddle logo SVGs in assets/brand/.
export const colors = {
  bg: '#0f0e0c',          // --bg-0  oklch(0.165 0.004 70)
  surface: '#191715',     // --bg-1  oklch(0.205 0.005 70)
  surfaceAlt: '#201e1b',  // --bg-2  oklch(0.235 0.006 70)
  raised: '#2a2724',      // --bg-3  oklch(0.275 0.007 70)
  border: '#353230',      // --line  oklch(0.32 0.006 70)
  borderSoft: 'rgba(43,40,38,0.6)', // --line-soft oklch(0.28 0.006 70 / 0.6)
  text: '#f2f0ed',        // --tx-hi    oklch(0.955 0.004 70)
  textMid: '#aeaaa6',     // --tx-mid   oklch(0.74 0.007 70)
  textDim: '#7a7773',     // --tx-lo    oklch(0.57 0.007 70)
  textFaint: '#5a5754',   // --tx-faint oklch(0.46 0.006 70)
  accent: '#4fa3f4',      // --accent     oklch(0.70 0.145 250)
  accentHi: '#66b6ff',    // --accent-hi  oklch(0.76 0.14 250)
  accentTx: '#8ccaff',    // --accent-tx  oklch(0.82 0.11 250)
  accentDim: 'rgba(79,163,244,0.16)', // --accent-dim
  live: '#50bfbe',        // --live oklch(0.74 0.10 195)
  liveDim: 'rgba(80,191,190,0.16)',
  online: '#67d283',      // --online oklch(0.78 0.15 150)
  away: '#ffd60a',        // bright yellow (brightened from the design's oklch(0.80 0.13 80) per Nick; matches desktop)
  brb: '#e98a47',         // warm orange, slots between away and busy
  busy: '#ec5b57',        // --busy   oklch(0.66 0.18 25) — red
  danger: '#e64343',      // --danger oklch(0.62 0.20 25)
  brandBlue: '#2e63e6',   // logo dot + favicon background
  brandNavy: '#16213d',   // logo arcs (full-color variant)
};

export const radius = { sm: 8, md: 12, lg: 18 };
export const space = (n: number) => n * 4;

// ── Floating liquid-glass tab bar metrics ──
// The bar (app/(app)/(tabs)/_layout.tsx) floats over full-height content,
// so root tab screens pad their scroll content by tabBarClearance() and
// FloatingCall snaps its bottom corner above tabBarOffset() + TAB_BAR_HEIGHT.
export const TAB_BAR_HEIGHT = 64;
export const tabBarOffset = (insetBottom: number) =>
  Math.max(insetBottom, Platform.OS === 'ios' ? 16 : 12);
export const tabBarClearance = (insetBottom: number) =>
  tabBarOffset(insetBottom) + TAB_BAR_HEIGHT + 20;

// Presence status → dot color. Green available, yellow away, orange BRB,
// red unavailable, faint offline. Wire values shared with desktop
// (renderer/api.js PRESENCE_STATES).
export type PresenceStatus = 'active' | 'away' | 'brb' | 'unavailable' | 'offline';
export function statusColor(s: PresenceStatus | string | null | undefined): string {
  return s === 'active' || s === 'online' ? colors.online
    : s === 'away' ? colors.away
    : s === 'brb' ? colors.brb
    : s === 'unavailable' || s === 'busy' ? colors.busy
    : colors.textFaint;
}
