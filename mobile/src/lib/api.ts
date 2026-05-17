import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import { supabase } from './supabase';

// Thin data layer mirroring the relevant parts of renderer/api.js (HuddleClient).
// Backend is unchanged — same tables, RPCs, Storage buckets, RLS.

export type Team = { id: string; name: string };
export type Channel = {
  team_id: string;
  id: string;
  name: string;
  topic: string | null;
  type: 'public' | 'private' | 'dm';
  protected: boolean;
  created_by?: string | null;
};
export type Profile = { user_id: string; name: string; color: string | null; bio?: string | null; avatar_url?: string | null };
export type Attachment = { url: string; name: string; size?: number; type?: string };
export type Message = {
  id: string;
  team_id: string;
  channel_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  attachments: Attachment[] | null;
  reactions: Record<string, string[]> | null;
  mentions: string[] | null;
  ts: string;
  edited_ts: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  // AI-message flags (huddle_ai_message_flags migration). author_id is still
  // the human who invoked the AI — these just let the UI render it distinctly.
  ai_generated?: boolean | null;
  ai_model?: string | null;
};

export async function listTeams(): Promise<Team[]> {
  const { data: mem, error } = await supabase.from('team_members').select('team_id');
  if (error) throw error;
  const ids = (mem ?? []).map((m) => m.team_id);
  if (!ids.length) return [];
  const { data, error: tErr } = await supabase.from('teams').select('id,name').in('id', ids);
  if (tErr) throw tErr;
  return data ?? [];
}

export async function listChannels(teamId: string): Promise<Channel[]> {
  const { data, error } = await supabase.from('channels').select('*').eq('team_id', teamId);
  if (error) throw error;
  return (data ?? []) as Channel[];
}

// Open-or-create a 1:1 DM channel with another team member. Mirrors
// renderer/api.js createDm: the channel id is deterministic from the sorted
// pair of uuids, so re-opening returns the same row. on_channel_after_insert
// adds the creator to channel_members; we upsert ourselves defensively (no-op
// when the trigger already added us) and only upsert the peer if we created
// the channel (the only branch where channel_members_insert_self lets us
// insert someone else's row).
export async function openDm(teamId: string, meId: string, otherId: string, otherName?: string): Promise<Channel> {
  if (meId === otherId) throw new Error("can't DM yourself");
  const id = 'dm:' + (meId < otherId ? `${meId}::${otherId}` : `${otherId}::${meId}`);
  const { error: chErr } = await supabase
    .from('channels')
    .upsert(
      { team_id: teamId, id, name: otherName ?? 'Direct message', topic: '', type: 'dm', protected: false, created_by: meId },
      { onConflict: 'team_id,id', ignoreDuplicates: true },
    );
  if (chErr && chErr.code !== '23505') throw chErr;
  const { error: meErr } = await supabase
    .from('channel_members')
    .upsert(
      { team_id: teamId, channel_id: id, user_id: meId },
      { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true },
    );
  if (meErr) throw meErr;
  const { data: ch, error: selErr } = await supabase
    .from('channels').select('*').eq('team_id', teamId).eq('id', id).single();
  if (selErr) throw selErr;
  if (ch.created_by === meId) {
    const { error: peerErr } = await supabase
      .from('channel_members')
      .upsert(
        { team_id: teamId, channel_id: id, user_id: otherId },
        { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true },
      );
    if (peerErr) throw peerErr;
  }
  return ch as Channel;
}

export async function listTeamProfiles(teamId: string): Promise<Profile[]> {
  const { data: mem, error } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
  if (error) throw error;
  const ids = (mem ?? []).map((m) => m.user_id);
  if (!ids.length) return [];
  const { data, error: pErr } = await supabase.from('profiles').select('user_id,name,color,avatar_url,bio').in('user_id', ids);
  if (pErr) throw pErr;
  return (data ?? []) as Profile[];
}

const PAGE = 50;

export async function fetchMessages(
  teamId: string,
  channelId: string,
  before?: string,
): Promise<Message[]> {
  let q = supabase
    .from('messages')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId)
    .is('parent_id', null)
    .order('ts', { ascending: false })
    .limit(PAGE);
  if (before) q = q.lt('ts', before);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as Message[]).reverse();
}

export async function fetchThread(messageId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`id.eq.${messageId},parent_id.eq.${messageId}`)
    .order('ts', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Message[];
}

export async function sendMessage(args: {
  teamId: string;
  channelId: string;
  authorId: string;
  body: string;
  parentId?: string | null;
  attachments?: Attachment[];
  mentions?: string[];
}): Promise<void> {
  const { error } = await supabase.from('messages').insert({
    team_id: args.teamId,
    channel_id: args.channelId,
    parent_id: args.parentId ?? null,
    author_id: args.authorId,
    body: args.body,
    attachments: args.attachments ?? [],
    mentions: args.mentions ?? [],
    reactions: {},
  });
  if (error) throw error;
}

export async function editMessage(messageId: string, body: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ body, edited_ts: new Date().toISOString() })
    .eq('id', messageId);
  if (error) throw error;
}

export async function deleteMessage(messageId: string): Promise<void> {
  const { error } = await supabase.from('messages').delete().eq('id', messageId);
  if (error) throw error;
}

export async function toggleReaction(messageId: string, emoji: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('messages').select('reactions').eq('id', messageId).single();
  if (error) throw error;
  const r: Record<string, string[]> = { ...(data?.reactions ?? {}) };
  const arr = new Set(r[emoji] ?? []);
  if (arr.has(userId)) arr.delete(userId);
  else arr.add(userId);
  if (arr.size) r[emoji] = [...arr];
  else delete r[emoji];
  const { error: uErr } = await supabase.from('messages').update({ reactions: r }).eq('id', messageId);
  if (uErr) throw uErr;
}

export async function setPin(messageId: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_message_pin', { p_message_id: messageId, p_pin: pinned });
  if (error) throw error;
}

export async function searchMessages(teamId: string, query: string, channelId?: string): Promise<Message[]> {
  let q = supabase.from('messages').select('*').eq('team_id', teamId).ilike('body', `%${query}%`).order('ts', { ascending: false }).limit(50);
  if (channelId) q = q.eq('channel_id', channelId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Message[];
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.rpc('get_profile', { p_user_id: userId });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

function base64ToBytes(b64: string): Uint8Array {
  // atob is available on Hermes (RN >= 0.74) but isn't in React Native's TS lib.
  const bin = (globalThis as unknown as { atob: (s: string) => string }).atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Reading the local file as base64 → ArrayBuffer is the reliable way to upload
// from React Native; `fetch(uri).blob()` is known to produce 0-byte uploads for
// some content:// URIs on Android.
//
// 25 MB cap matches the Supabase Storage default upload limit and keeps us
// from OOM-ing low-end Android devices on a 50 MB gallery video — the base64
// pass roughly doubles in-memory size before we hand bytes to the SDK.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export async function uploadAttachment(userId: string, file: { uri: string; name: string; mime: string }): Promise<Attachment> {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_') || 'file';
  const objectPath = `${userId}/${Crypto.randomUUID()}/${safeName}`;
  const info = await FileSystem.getInfoAsync(file.uri, { size: true });
  if (info.exists && typeof info.size === 'number' && info.size > UPLOAD_MAX_BYTES) {
    throw new Error(`File too large (${(info.size / 1024 / 1024).toFixed(1)} MB; max 25 MB)`);
  }
  const b64 = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = base64ToBytes(b64);
  const { error } = await supabase.storage.from('uploads').upload(objectPath, bytes, {
    contentType: file.mime,
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from('uploads').getPublicUrl(objectPath);
  return { url: data.publicUrl, name: file.name, size: bytes.byteLength, type: file.mime };
}

// Client-side @mention extraction, same approach as the desktop renderer:
// resolve @name tokens against the known team roster.
export function extractMentions(body: string, roster: Profile[]): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([\w.\- ]{2,40})/g)) {
    const name = m[1].trim().toLowerCase();
    const hit = roster.find((p) => p.name?.toLowerCase() === name);
    if (hit) out.add(hit.user_id);
  }
  return [...out];
}
