import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Notification payloads we route on. notify-on-call sets `type: 'call'`;
// notify-on-message currently doesn't tag a type, so anything without a
// recognised type falls back to opening the channel.
type CallNotificationData = {
  type: 'call';
  teamId?: string;
  channelId?: string;
  channelName?: string;
};
type MessageNotificationData = {
  teamId?: string;
  channelId?: string;
  messageId?: string;
};

function isCallNotification(data: unknown): data is CallNotificationData {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === 'call';
}

// Routes a tapped notification into the right screen. Idempotent — safe to
// call from both addNotificationResponseReceivedListener (cold-tap) and
// getLastNotificationResponseAsync (warm/launch-from-tap). The auth gate in
// (app)/_layout bounces unauthenticated taps back to the email screen on its
// own; we just push the destination and trust the layout to do the right thing.
export function handleNotificationData(data: unknown): void {
  if (isCallNotification(data)) {
    const channelId = data.channelId;
    if (!channelId) return;
    router.push({
      pathname: '/(app)/call/[id]',
      params: { id: channelId, name: data.channelName ?? 'Call' },
    });
    return;
  }
  const msg = data as MessageNotificationData;
  if (msg?.channelId) {
    router.push({
      pathname: '/(app)/channel/[id]',
      params: { id: msg.channelId },
    });
  }
}

// Sets up the tap handler. Returns the unsubscribe function so the root
// layout can clean up on hot-reload. Also drains the "last response" the
// OS held while the app was cold-started by a tap.
export function attachNotificationTapHandler(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handleNotificationData(response.notification.request.content.data);
  });
  // If the app was launched by tapping a notification (cold start), the
  // listener above won't fire — we have to read the cached response.
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) handleNotificationData(response.notification.request.content.data);
    })
    .catch(() => { /* no cached response */ });
  return () => sub.remove();
}

// Registers this device for Expo push and stores the token in public.device_tokens
// (RLS: owner-only). The `notify-on-message` Edge Function reads from that table.
export async function registerForPush(userId: string): Promise<void> {
  if (!Device.isDevice) return;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    console.warn('[push] permission not granted — device will not receive notifications');
    return;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  const tokenResp = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  const token = tokenResp.data;

  await supabase.from('device_tokens').upsert(
    {
      user_id: userId,
      token,
      platform: Platform.OS,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
}
