import { supabase } from './supabase';

export type LiveKitGrant = {
  token: string;
  url: string;
  room: string;
};

// Calls the `livekit-token` Supabase Edge Function, which verifies the caller's
// session + channel membership and mints a LiveKit access token. The LiveKit API
// secret never leaves the server.
export async function getCallToken(
  teamId: string,
  channelId: string,
): Promise<LiveKitGrant> {
  const { data, error } = await supabase.functions.invoke<LiveKitGrant>(
    'livekit-token',
    { body: { team_id: teamId, channel_id: channelId } },
  );
  if (error) throw error;
  if (!data?.token || !data?.url) throw new Error('livekit-token returned no token');
  return data;
}
