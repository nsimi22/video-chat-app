// Copies the @supabase/supabase-js UMD bundle into renderer/vendor/ so the
// renderer can <script src="vendor/supabase.js"> it without an external CDN.
const fs = require('fs');
const path = require('path');

function tryResolve(rel) {
  try { return require.resolve(rel); } catch { return null; }
}

const candidates = [
  '@supabase/supabase-js/dist/umd/supabase.js',
  '@supabase/supabase-js/dist/umd/supabase.min.js',
];
let src = null;
for (const c of candidates) { src = tryResolve(c); if (src) break; }
if (!src) {
  console.warn('[copy-vendor] supabase-js UMD not found; run `npm install` first.');
  process.exit(0);
}

const dst = path.join(__dirname, '..', 'renderer', 'vendor', 'supabase.js');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log(`[copy-vendor] ${path.relative(process.cwd(), dst)} ← ${path.relative(process.cwd(), src)}`);
