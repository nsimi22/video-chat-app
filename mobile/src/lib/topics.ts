// Realtime topic + broadcast-event names. These MUST match the strings used by
// the Electron renderer (renderer/api.js, renderer/app.js) and the RLS policies
// in supabase/migrations/*_realtime*. If those ever move into a shared module,
// import from there instead.

export const teamTopic = (teamId: string) => `team:${teamId}`;
export const callTopic = (teamId: string, channelId: string) =>
  `call:${teamId}:${channelId}`;
export const screenTopic = (streamId: string) => `screen:${streamId}`;
export const whiteboardTopic = (teamId: string, whiteboardId: string) =>
  `team:${teamId}:wb:${whiteboardId}`;

export const TeamEvents = {
  typing: 'typing',
  presence: 'presence',
} as const;
