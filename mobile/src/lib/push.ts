import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
