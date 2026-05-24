import { Platform } from 'react-native';
import notifee, { AndroidImportance, type Notification } from '@notifee/react-native';

// Android foreground service for in-progress calls.
//
// Why: without a Service declared as `foregroundServiceType=microphone`,
// the OS aggressively suspends our process the moment the user
// navigates away. WebRTC peer-connections die within seconds to
// minutes (varies wildly by OEM battery management). The user sees
// the floating tile freeze, then the call dies, even though the JS
// thinks it's still alive.
//
// What: we attach a persistent notification ("Huddle call in progress")
// to the same Notifee `ForegroundService` declared in the manifest
// (see plugins/withForegroundService.js). Tap → returns to the app.
// Service stops when `stopCallForegroundService` is called (i.e. when
// the call actually ends).
//
// iOS: no-op. The `audio` UIBackgroundMode + LiveKit's iosPIP combo
// handles backgrounding without an Android-style service.

const CHANNEL_ID = 'huddle-active-call';
const NOTIFICATION_ID = 'huddle-active-call-notification';

let handlerRegistered = false;

// Notifee requires us to register a single foreground-service handler
// at app startup, BEFORE displayNotification with asForegroundService
// is called. The returned promise stays unresolved while the service
// runs — there's no per-tick work to do; we're keeping the process
// alive for LiveKit, not running our own loop.
export function registerCallForegroundServiceHandler() {
  if (Platform.OS !== 'android') return;
  if (handlerRegistered) return;
  handlerRegistered = true;
  notifee.registerForegroundService((_notification: Notification) => {
    return new Promise(() => {
      // Intentionally never resolves: notifee tears the service down
      // when stopForegroundService() is called from our endCall path.
    });
  });
}

export async function startCallForegroundService(label: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    // Channel must exist before any notification on it. Creating an
    // existing channel is a no-op so it's safe to call every time.
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Active call',
      importance: AndroidImportance.HIGH,
    });
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Huddle call in progress',
      body: `${label} • Tap to return`,
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        ongoing: true,
        // Tap routes to the app's launcher activity. Once the app is
        // foregrounded, normal navigation takes the user back to the
        // call screen via the floater / activeCall route guard.
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch (err) {
    // Surface but don't throw — the call itself can still proceed,
    // it just won't survive backgrounding. Caller log only.
    console.warn('[call] failed to start foreground service', err);
  }
}

export async function stopCallForegroundService(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.stopForegroundService();
  } catch (err) {
    console.warn('[call] failed to stop foreground service', err);
  }
}
