// Dark, Apple-ish palette to roughly match the desktop renderer (renderer/styles.css).
// Brand colors are sourced from the canonical Huddle logo SVGs in assets/brand/.
export const colors = {
  bg: '#0b0b0d',
  surface: '#161618',
  surfaceAlt: '#1f1f23',
  border: '#2a2a2e',
  text: '#f2f2f5',
  textDim: '#9a9aa2',
  accent: '#5b8cff',
  brandBlue: '#2e63e6',  // logo dot + favicon background
  brandNavy: '#16213d',  // logo arcs (full-color variant)
  danger: '#ff5b5b',
  online: '#34c759',
};

export const radius = { sm: 8, md: 12, lg: 18 };
export const space = (n: number) => n * 4;
