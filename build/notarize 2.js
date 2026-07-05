// electron-builder `afterSign` hook: notarize the signed macOS .app with
// Apple's notarytool. Uses @electron/notarize directly rather than
// electron-builder's built-in `notarize` flag, which has regressions in
// 24.13.3 (electron-userland/electron-builder#8103).
//
// Skips cleanly when the Apple credentials aren't present (e.g. local
// `npm run dist:mac` without secrets) so unsigned dev builds still work.
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] submitting ${appName}.app to notarytool …`);
  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done.');
};
