// Expo config plugin that wires up the Android foreground service used
// to keep a LiveKit call alive while the app is backgrounded.
//
// On Android, without a foreground service the OS will eventually
// throttle and kill our process while we're not in front. WebRTC
// peer-connection survival requires (a) the FOREGROUND_SERVICE family
// of permissions, (b) a Service entry in the manifest declared with
// the right `foregroundServiceType`, and (c) at runtime, something
// that actually starts the service.
//
// (a) and (b) live here in this plugin. (c) is `@notifee/react-native`,
// which provides the runtime API (`displayNotification({ android:
// { asForegroundService: true } })`) and ships its own ForegroundService
// class — we just need to declare it in our merged manifest with the
// `microphone` type. iOS is unaffected; the `audio` UIBackgroundMode
// already keeps the process alive while a mic/audio track is playing.
//
// Reference: notifee's own docs at
// https://notifee.app/react-native/docs/android/foreground-service

const { withAndroidManifest } = require('@expo/config-plugins');

const NOTIFEE_SERVICE_NAME = 'app.notifee.core.ForegroundService';
// `microphone` covers the typical "audio call in background" case.
// We deliberately don't claim `camera` here — iOS already stops the
// local camera on background and Android's behaviour is similar; if
// we ever want background video capture we can add `camera|microphone`.
// `mediaPlayback` is included so remote audio/video playback during a
// backgrounded call counts as a sanctioned foreground use.
const FOREGROUND_SERVICE_TYPE = 'microphone|mediaPlayback';

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

function ensurePermission(manifest, name) {
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  const exists = manifest['uses-permission'].some(
    (p) => p.$ && p.$['android:name'] === name,
  );
  if (!exists) {
    manifest['uses-permission'].push({ $: { 'android:name': name } });
  }
}

function ensureNotifeeService(application) {
  application.service = application.service || [];
  const exists = application.service.some(
    (s) => s.$ && s.$['android:name'] === NOTIFEE_SERVICE_NAME,
  );
  if (exists) return;
  application.service.push({
    $: {
      'android:name': NOTIFEE_SERVICE_NAME,
      'android:foregroundServiceType': FOREGROUND_SERVICE_TYPE,
      // Don't auto-restart the service if our process is killed —
      // the call is over and there's nothing to do. The next call
      // start brings the service up fresh.
      'android:stopWithTask': 'true',
    },
  });
}

module.exports = function withForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    PERMISSIONS.forEach((p) => ensurePermission(manifest, p));
    const application = manifest.application && manifest.application[0];
    if (application) {
      ensureNotifeeService(application);
    }
    return cfg;
  });
};
