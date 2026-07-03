// Rebuilds native addons (node-pty) against Electron's ABI. Runs from
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

const bin = path.join(
  __dirname, '..', 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild',
);
console.log('[rebuild-native] rebuilding node-pty against Electron ABI…');
const res = spawnSync(bin, ['-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (res.error) {
  console.error('[rebuild-native] failed to launch electron-rebuild:', res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
