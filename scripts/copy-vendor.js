// Copies third-party browser bundles into renderer/vendor/ so the
// renderer can <script src="vendor/..."> them without an external
// CDN. Runs from `npm postinstall` (see package.json).
//
// Currently covers:
//   - @supabase/supabase-js UMD bundle
//   - @mediapipe/selfie_segmentation (JS + WASM + model assets) for
//     the call-time background-blur pipeline
const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'renderer', 'vendor');

function tryResolve(rel) {
  try { return require.resolve(rel); } catch { return null; }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[copy-vendor] ${path.relative(process.cwd(), dst)} ← ${path.relative(process.cwd(), src)}`);
}

// Copy every regular file in a directory that passes `predicate`,
// non-recursively. MediaPipe ships flat (no nested dirs that the
// runtime needs) so flat copy is sufficient and avoids surprises
// from copying junk like .vscode/ or doc folders.
function copyFlatDir(srcDir, dstDir, predicate) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[copy-vendor] missing source dir: ${srcDir}`);
    return 0;
  }
  let n = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    let stat;
    try { stat = fs.statSync(src); } catch { continue; }
    if (!stat.isFile()) continue;
    if (predicate && !predicate(name)) continue;
    copyFile(src, path.join(dstDir, name));
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Supabase UMD
// ---------------------------------------------------------------------------
const supabaseCandidates = [
  '@supabase/supabase-js/dist/umd/supabase.js',
  '@supabase/supabase-js/dist/umd/supabase.min.js',
];
let supabaseSrc = null;
for (const c of supabaseCandidates) { supabaseSrc = tryResolve(c); if (supabaseSrc) break; }
if (supabaseSrc) {
  copyFile(supabaseSrc, path.join(VENDOR_DIR, 'supabase.js'));
} else {
  console.warn('[copy-vendor] supabase-js UMD not found; run `npm install` first.');
}

// ---------------------------------------------------------------------------
// MediaPipe Selfie Segmentation
//
// The runtime loads its WASM + binarypb model via a locateFile()
// callback at construction time, so we mirror the whole package next
// to selfie_segmentation.js. Skip package metadata + docs — they
// aren't needed at runtime.
// ---------------------------------------------------------------------------
const mp = tryResolve('@mediapipe/selfie_segmentation/selfie_segmentation.js');
if (mp) {
  const srcDir = path.dirname(mp);
  const dstDir = path.join(VENDOR_DIR, 'mediapipe', 'selfie_segmentation');
  const n = copyFlatDir(srcDir, dstDir, (name) =>
    !/^(package\.json|README|LICENSE|CHANGELOG)/i.test(name),
  );
  if (n === 0) {
    console.warn(`[copy-vendor] mediapipe source dir was empty: ${srcDir}`);
  }
} else {
  console.warn('[copy-vendor] @mediapipe/selfie_segmentation not found; background-blur will be unavailable.');
}
