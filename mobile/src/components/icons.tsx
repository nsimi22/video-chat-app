import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/theme';

// Inline SVG icons. Same Feather-style stroke geometry the desktop renderer
// uses (renderer/icons.js) so mobile and desktop share a visual vocabulary.
// Add new icons here rather than mixing emoji into the UI.

type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
};

// Classic handset shape from Feather Icons. viewBox 24, stroke-linejoin round.
export function PhoneIcon({ size = 22, color = colors.accent, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Svg>
  );
}

// Power-button-shaped "hang up / leave call" glyph — matches renderer/icons.js's
// `phoneDown`. Kept here so an in-call leave button can grow into using it.
export function PhoneDownIcon({ size = 22, color = colors.danger, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <Path d="M12 2v10" />
    </Svg>
  );
}
