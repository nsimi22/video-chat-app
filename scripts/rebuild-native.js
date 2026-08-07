// Rebuilds native addons (node-pty) against Electron's ABI, and ensures the
// Electron binary itself is downloaded at install time. Runs from
// `npm postinstall`, after copy-vendor.
//
// Skips gracefully when the rebuild toolchain isn't installed. The
// `Desktop (syntax)` CI job installs with `npm ci --omit=dev`, which omits
// @electron/rebuild (a devDependency) and Electron itself — the rebuild
// can't (and needn't) run there, and the postinstall must not fail. Real
// installer builds (release.yml) install devDeps, so the rebuild runs.
//
// Invoked via node (not a shell one-liner) so it stays cross-platform —
// the release matrix builds on Windows too, where `command -v` / `|| true`
// wouldn't work.
const { spawnSync } = require('child_process');
const path = require('path');

function resolvable(mod) {
  try { require.resolve(mod); return true; } catch { return false; }
}

// Nothing to rebuild without node-pty; nothing to rebuild *against* without
// Electron + the rebuild toolchain.
if (!resolvable('node-pty/package.json')) {
  console.log('[rebuild-native] node-pty not installed — nothing to rebuild.');
  process.exit(0);
}
if (!resolvable('@electron/rebuild') || !resolvable('electron/package.json')) {
  console.log('[rebuild-native] @electron/rebuild or electron absent (e.g. --omit=dev) — skipping node-pty rebuild.');
  process.exit(0);
}

// Electron 43 dropped its npm install script — the ~100 MB binary now
// downloads lazily on the first `require('electron')` instead of at install
// time. Trigger that download here so a failure (offline / behind a proxy)
// surfaces during install rather than mid-launch, and so `npm ci --omit=dev`
// (which skips Electron entirely, above) stays the only path that doesn't
// fetch it. install.js is idempotent — a no-op when the binary already exists.
const electronDir = path.dirname(require.resolve('electron/package.json'));
console.log('[rebuild-native] ensuring Electron binary is downloaded…');
const dl = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
if (dl.error) {
  console.error('[rebuild-native] failed to launch Electron install:', dl.error.message);
  process.exit(1);
}
if (dl.status) process.exit(dl.status);

// Resolve the CLI's JS entry from the package's own `bin` field and run it
// with the current node binary in an argv array — no `.bin/*.cmd` shim and
// no `shell:true`, which on Windows would break under install paths that
// contain spaces (e.g. C:\Users\First Last\...).
const rebuildDir = path.dirname(require.resolve('@electron/rebuild/package.json'));
const rebuildPkg = require('@electron/rebuild/package.json');
const cliRel = typeof rebuildPkg.bin === 'string'
  ? rebuildPkg.bin
  : (rebuildPkg.bin && rebuildPkg.bin['electron-rebuild']);
if (!cliRel) {
  console.warn('[rebuild-native] could not resolve electron-rebuild CLI entry — skipping.');
  process.exit(0);
}
const cli = path.join(rebuildDir, cliRel);
console.log('[rebuild-native] rebuilding node-pty against Electron ABI…');
const res = spawnSync(process.execPath, [cli, '-f', '-w', 'node-pty'], { stdio: 'inherit' });
if (res.error) {
  console.error('[rebuild-native] failed to launch electron-rebuild:', res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
