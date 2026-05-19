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
  if (error) {
    // Surface the function's actual JSON body so failures (membership, secrets,
    // missing session) don't all collapse to "non-2XX". The Supabase FunctionsHttpError
    // hangs the underlying Response on .context, and we re-read it as text.
    let detail = '';
    try {
      const resp = (error as { context?: Response }).context;
      if (resp && typeof resp.text === 'function') detail = await resp.text();
    } catch {}
    throw new Error(`livekit-token failed: ${error.message}${detail ? ` — ${detail}` : ''}`);
  }
  if (!data?.token || !data?.url) throw new Error('livekit-token returned no token');
  return data;
}
