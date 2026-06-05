// One-shot check that the oklch→hex conversions used to build src/theme.ts
// are mathematically exact (standard OKLab math, D65). Note: theme.ts's
// `away` intentionally deviates from the design's oklch(0.80 0.13 80) —
// brightened to #ffd60a per Nick (2026-06-05) to match desktop.
// Run: node scripts/verify-tokens.js
function oklchToHex(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const toSrgb = (x) => {
    x = Math.min(1, Math.max(0, x));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  const hex = (x) => Math.round(toSrgb(x) * 255).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(bb);
}
const expect = {
  '#0f0e0c': [0.165, 0.004, 70], '#191715': [0.205, 0.005, 70], '#201e1b': [0.235, 0.006, 70],
  '#2a2724': [0.275, 0.007, 70], '#353230': [0.32, 0.006, 70], '#2b2826': [0.28, 0.006, 70],
  '#f2f0ed': [0.955, 0.004, 70], '#aeaaa6': [0.74, 0.007, 70], '#7a7773': [0.57, 0.007, 70],
  '#5a5754': [0.46, 0.006, 70], '#4fa3f4': [0.70, 0.145, 250], '#66b6ff': [0.76, 0.14, 250],
  '#8ccaff': [0.82, 0.11, 250], '#50bfbe': [0.74, 0.10, 195], '#67d283': [0.78, 0.15, 150],
  '#e9b452': [0.80, 0.13, 80], '#ec5b57': [0.66, 0.18, 25], '#e64343': [0.62, 0.20, 25],
};
let fail = 0;
for (const [want, v] of Object.entries(expect)) {
  const got = oklchToHex(...v);
  const ok = got === want;
  if (!ok) fail++;
  console.log(ok ? 'OK  ' : 'DIFF', `oklch(${v.join(' ')})`, '->', got, ok ? '' : `(theme has ${want})`);
}
process.exit(fail ? 1 : 0);
