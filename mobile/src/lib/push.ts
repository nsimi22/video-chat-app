import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Registers this device for Expo push and stores the token in public.device_tokens
// (RLS: owner-only). The `notify-on-message` Edge Function reads from that table.
//
// Each step logs explicitly so a TestFlight build can be wired to a console
// session (Xcode → Devices and Simulators → View Device Logs, or
// `eas device:logs`) and the first failing step shows up. Earlier this
// function swallowed every error via `.catch(() => {})` in the caller,
// which made "push doesn't work" un-debuggable.
export async function registerForPush(userId: string): Promise<void> {
  if (!Device.isDevice) {
    console.log('[push] skipped: simulator or non-device');
    return;
  }

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      console.log('[push] requesting permission (current:', existing, ')');
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') {
      console.warn('[push] permission not granted (' + status + ') — device will not receive notifications');
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
    if (!projectId) {
      console.error('[push] no EAS projectId in app.json (extra.eas.projectId) — token fetch will fail');
      return;
    }

    let tokenResp;
    try {
      tokenResp = await Notifications.getExpoPushTokenAsync({ projectId });
    } catch (err) {
      console.error('[push] getExpoPushTokenAsync failed:', err);
      throw err;
    }
    const token = tokenResp.data;
    console.log('[push] got token', token.slice(0, 18) + '…');

    const { error } = await supabase.from('device_tokens').upsert(
      {
        user_id: userId,
        token,
        platform: Platform.OS,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (error) {
      console.error('[push] device_tokens upsert failed:', error.message, error.details);
      throw error;
    }
    console.log('[push] registered ok');
  } catch (err) {
    // Re-throw so the caller's diagnostic logging fires too.
    throw err;
  }
}
