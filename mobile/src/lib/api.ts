import * as Crypto from 'expo-crypto';
// SDK 54 split expo-file-system into a new File/Directory API. The
// `/legacy` export keeps `EncodingType` and async helpers; size is now
// always returned by `getInfoAsync` so the old `{ size: true }` option
// is gone. Migrating to the new API is a separate follow-up.
import * as FileSystem from 'expo-file-system/legacy';
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
// Both `type` and `contentType` carry the MIME — desktop (renderer/chat.js)
// writes `contentType`, mobile originally wrote `type`. We read either and
// write both so attachments render bidirectionally.
export type Attachment = { url: string; name: string; size?: number; type?: string; contentType?: string };
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

  // Plain `.insert()` rather than `.upsert(..., { ignoreDuplicates: true })`.
  // The upsert variant failed `channels_insert` RLS (42501) on React
  // Native even when the server confirmed auth.uid() === meId,
  // role='authenticated', and is_team_member(team_id)=true (verified via
  // a temporary whoami() RPC). Plain insert with the same body succeeds.
  // The desktop renderer still uses upsert and works under Electron's
  // fetch; the discrepancy looks like an RN-fetch quirk with
  // `Prefer: resolution=ignore-duplicates`. We tolerate 23505 below for
  // the "DM row already exists (created by the other side)" case, which
  // is exactly the no-op the upsert was achieving.
  const { error: chErr } = await supabase
    .from('channels')
    .insert({ team_id: teamId, id, name: otherName ?? 'Direct message', topic: '', type: 'dm', protected: false, created_by: meId });
  if (chErr && chErr.code !== '23505') {
    console.warn('openDm channels.insert failed', { teamId, meId, otherId, id, code: chErr.code, message: chErr.message, details: chErr.details, hint: chErr.hint });
    throw new Error(`${chErr.message}${chErr.code ? ` [${chErr.code}]` : ''}${chErr.hint ? ` — ${chErr.hint}` : ''}`);
  }
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

// Channel-name slugifier — mirrors renderer/api.js slugify(). Lowercases,
// strips non-`[a-z0-9_-]` to dashes, trims edge dashes, caps at 30 chars,
// and refuses anything that resolves to a `dm:`-prefixed id.
export function slugifyChannelName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  if (id.length < 2) return null;
  if (id.startsWith('dm:')) return null;
  return id;
}

// Public/private channel create. Mirrors renderer/api.js createChannel —
// idempotent (returns the existing row if the slug is taken in this team),
// careful not to chain .select() on the insert because the channels_read
// RLS for private/dm types is gated on is_channel_member, and the
// on_channel_after_insert trigger that grants membership fires AFTER
// RETURNING evaluates. For private channels, invited memberUserIds are
// inserted into channel_members after the channel row lands.
export async function createChannel(args: {
  teamId: string;
  creatorId: string;
  name: string;
  topic?: string;
  isPrivate?: boolean;
  // Direct uuids on mobile — avoids the renderer's name-lookup round-trip,
  // since the channel-create UI will have the people picker handing us
  // ids already.
  memberUserIds?: string[];
}): Promise<Channel> {
  const id = slugifyChannelName(args.name);
  if (!id) throw new Error('invalid channel name');
  const { data: existing } = await supabase
    .from('channels')
    .select('*')
    .eq('team_id', args.teamId)
    .eq('id', id)
    .maybeSingle();
  if (existing) return existing as Channel;
  const type = args.isPrivate ? 'private' : 'public';
  const { error } = await supabase.from('channels').insert({
    team_id: args.teamId,
    id,
    name: id,
    topic: args.topic ?? '',
    type,
    protected: false,
    created_by: args.creatorId,
  });
  if (error) throw error;
  if (args.isPrivate && args.memberUserIds?.length) {
    // Surface batch failures: silently swallowing would leave a private
    // channel without its invitees, which surfaces as "exists but
    // invisible" to everyone except the creator. Dedup the caller's
    // ids first — channel_members has a composite-PK on
    // (team_id,channel_id,user_id), so a duplicate would 23505 the
    // whole atomic insert.
    const rows = [...new Set(args.memberUserIds)]
      .filter((uid) => uid && uid !== args.creatorId)
      .map((uid) => ({ team_id: args.teamId, channel_id: id, user_id: uid }));
    if (rows.length) {
      const { error: memErr } = await supabase.from('channel_members').insert(rows);
      if (memErr) throw memErr;
    }
  }
  return {
    team_id: args.teamId,
    id,
    name: id,
    topic: args.topic ?? '',
    type,
    protected: false,
    created_by: args.creatorId,
  };
}

// Group DM create. Mirrors renderer/api.js createGroupDm but assumes the
// caller hands us uuids directly (no presence cache to consult).
//
// Server-side dedup goes through the `join_dm_by_member_sig` SECURITY
// DEFINER RPC: it takes the canonical sorted-uuid signature, finds an
// existing gdm with that membership, adds the caller to channel_members
// in one atomic step, and returns the channel id (or null on miss). That
// single RPC is what lets channel_members' RLS stay tight — we can't
// self-insert into a gdm we aren't already a member of from client code.
//
// On race (two clicks beat each other to the insert), the (team_id,
// member_sig) partial unique index throws 23505; we recover by re-calling
// the RPC against the winner.
export async function createGroupDm(args: {
  teamId: string;
  creatorId: string;
  otherUserIds: string[];
  // Optional label override. If omitted, the channel.name is left as
  // a comma-joined list of the other participants' display names —
  // caller is expected to pass a resolved name list for the label.
  otherUserNames?: string[];
}): Promise<Channel> {
  const others = [...new Set((args.otherUserIds || []).filter(Boolean))].filter(
    (id) => id !== args.creatorId,
  );
  if (others.length < 2) throw new Error('a group DM needs at least two other people');

  const memberSig = [args.creatorId, ...others].sort().join(',');

  const { data: existingId, error: lookupErr } = await supabase.rpc('join_dm_by_member_sig', {
    t: args.teamId,
    sig: memberSig,
  });
  if (lookupErr) throw lookupErr;
  if (existingId) return await openExistingGroupDm(args.teamId, existingId, others);

  // Build a readable label from the optional names list. Cap at 200 so the
  // channel.name CHECK constraint doesn't trip.
  const sortedNames = (args.otherUserNames ?? others.map(() => 'someone')).slice().sort((a, b) =>
    a.localeCompare(b),
  );
  const label = sortedNames.join(', ').slice(0, 200) || 'Group';

  const id = 'gdm:' + cryptoRandomUuid();
  const { error: chErr } = await supabase.from('channels').insert({
    team_id: args.teamId,
    id,
    name: label,
    topic: '',
    type: 'dm',
    protected: false,
    created_by: args.creatorId,
    member_sig: memberSig,
  });
  if (chErr) {
    if (chErr.code === '23505') {
      const { data: conflictId, error: rpcErr } = await supabase.rpc('join_dm_by_member_sig', {
        t: args.teamId,
        sig: memberSig,
      });
      if (rpcErr) throw rpcErr;
      if (conflictId) return await openExistingGroupDm(args.teamId, conflictId, others);
    }
    throw chErr;
  }

  // Trigger added us; add the rest. Creator branch of channel_members_
  // insert_self lets us insert other users' rows. .insert() is atomic so
  // a single failed row aborts the whole batch — surface that loudly.
  const rows = others.map((uid) => ({ team_id: args.teamId, channel_id: id, user_id: uid }));
  const { error: memErr } = await supabase.from('channel_members').insert(rows);
  if (memErr) throw memErr;

  return {
    team_id: args.teamId,
    id,
    name: label,
    topic: '',
    type: 'dm',
    protected: false,
    created_by: args.creatorId,
  };
}

// Re-open a gdm we found via the dedup RPC. The RPC already added us to
// channel_members; this just makes sure any intended-but-departed
// participants are pulled back in (branch 3 of channel_members_insert_self
// — is_channel_member + type='dm') and returns the channel row.
async function openExistingGroupDm(
  teamId: string,
  channelId: string,
  otherUserIds: string[],
): Promise<Channel> {
  const rows = otherUserIds.map((uid) => ({
    team_id: teamId,
    channel_id: channelId,
    user_id: uid,
  }));
  if (rows.length) {
    const { error: othersErr } = await supabase
      .from('channel_members')
      .upsert(rows, { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true });
    if (othersErr) throw othersErr;
  }
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('team_id', teamId)
    .eq('id', channelId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('dm vanished between lookup and join');
  return data as Channel;
}

// expo-crypto.randomUUID() is sync and matches the renderer's
// `crypto.randomUUID()` semantics — safer than Date.now()+Math.random()
// for collision avoidance even at the channel-id scope.
function cryptoRandomUuid(): string {
  return Crypto.randomUUID();
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

// Fetch up to 500 messages strictly newer than `sinceTs`, in chronological
// order. A single round-trip primitive — callers that need to handle
// long-absence gaps should loop on the result (calling again with the
// last ts they received) until the returned batch is short. Caller-side
// looping keeps this function a thin query and lets the caller stop
// early or merge with other state between batches.
export async function fetchMessagesSince(
  teamId: string,
  channelId: string,
  sinceTs: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId)
    .is('parent_id', null)
    .gt('ts', sinceTs)
    .order('ts', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as Message[];
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
  aiGenerated?: boolean;
  aiModel?: string;
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
    ...(args.aiGenerated ? { ai_generated: true, ai_model: args.aiModel ?? null } : {}),
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

export async function toggleReaction(messageId: string, emoji: string, _userId: string): Promise<void> {
  // Routed through a security-definer RPC because messages_update_own
  // RLS only lets the author UPDATE the row — a direct client UPDATE for
  // a reaction on someone else's message matches zero rows and silently
  // no-ops. The server reads auth.uid() from the JWT, so the userId
  // argument is now ignored (kept in the signature so existing call
  // sites compile unchanged). See migration
  // 20260520000000_huddle_toggle_message_reaction_rpc.
  const { error } = await supabase.rpc('toggle_message_reaction', { p_message_id: messageId, p_emoji: emoji });
  if (error) throw error;
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
  const info = await FileSystem.getInfoAsync(file.uri);
  if (info.exists && info.size > UPLOAD_MAX_BYTES) {
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
  return { url: data.publicUrl, name: file.name, size: bytes.byteLength, type: file.mime, contentType: file.mime };
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
