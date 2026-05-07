// Supabase-backed API for the Huddle renderer.
//
// Replaces the old WebSocket signaling server. Major moving parts:
//
//   HuddleClient (event target) — initialized after sign-in. Carries the
//     active team + user, owns the realtime channel for signaling/presence/
//     drawing/typing broadcasts, and dispatches the same events the old
//     MeshClient produced (`welcome`, `peer-joined`, `peer-left`, `signal`,
//     `screen-announce`, `screen-stop`, `draw`, `chat-message`, etc.) so
//     downstream code (chat.js, app.js, webrtc.js) keeps the same shape.
//
//   Auth — `signInWithOtp({ email })` + `verifyOtp({ email, token, type:
//     'email' })`. Works in Electron without custom URL schemes; user copies
//     the 6-digit code from the magic-link email.
//
//   Storage — public `uploads/<user_id>/<uuid>/<filename>` bucket; clients
//     upload directly using their session.
//
// Realtime topics (one per team):
//   `team:<team_id>`              presence + signaling + typing
//   `screen:<stream_id>`          per-shared-screen drawing strokes

(function () {
  let _supabase = null;
  let _config = null;

  async function getSupabase() {
    if (_supabase) return _supabase;
    _config = await window.huddle.getSupabaseConfig();
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('supabase-js UMD bundle not loaded; run `npm install` to populate renderer/vendor/.');
    }
    _supabase = window.supabase.createClient(_config.url, _config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return _supabase;
  }

  // --- Slug helpers (mirror the old server) -------------------------------
  function slugify(raw, { min = 2, max = 30, allowDmPrefix = false } = {}) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max);
    if (id.length < min) return null;
    if (!allowDmPrefix && id.startsWith('dm:')) return null;
    return id;
  }
  const slugifyTeamName = (raw) => slugify(raw);
  const slugifyChannelName = (raw) => slugify(raw);

  // --- Mention extraction (client-side; we no longer have a server doing it)
  function extractMentions(text, names) {
    if (!text || !names || !names.length) return [];
    const set = new Set();
    const lookup = new Map(names.map((n) => [n.toLowerCase(), n]));
    const re = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,31})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = lookup.get(m[2].toLowerCase());
      if (hit) set.add(hit);
    }
    return [...set];
  }

  // ========================================================================
  // HuddleClient
  // ========================================================================
  class HuddleClient extends EventTarget {
    constructor({ supabase, session, profile, team }) {
      super();
      this.supabase = supabase;
      this.session = session;
      this.user = session.user;
      this.profile = profile;
      this.team = team; // {id, name}
      this.peerId = session.user.id; // user uuid doubles as peer id
      this.name = profile.name;
      this.color = profile.color;
      // Mirrors the MeshClient's API for the rest of the renderer:
      this.peerInfo = new Map(); // user_id -> { id, name, color }
      this.remoteScreenLabels = new Map();
      this.activeScreens = new Map(); // streamId -> { from, label, owner: bool }
      this.url = _config.url;
      this._teamChannel = null;
      this._screenChannels = new Map();     // streamId -> RealtimeChannel
      this._whiteboardChannels = new Map(); // whiteboardId -> RealtimeChannel
      this._dbChannel = null;               // postgres_changes subscription
    }

    async start() {
      // Subscribe to the team broadcast/presence channel and the postgres
      // changes for chat messages. After both subscribe, dispatch a single
      // `welcome` event mirroring the old server's behaviour so the rest of
      // the renderer can boot exactly the same way.
      await this._joinTeamChannel();
      await this._subscribeToMessages();
      await this._loadInitialChannels();
      this._dispatchWelcome();
    }

    stop() {
      try { this._teamChannel?.unsubscribe(); } catch {}
      try { this._dbChannel?.unsubscribe(); } catch {}
      // Channel maps now store readiness promises — resolve before unsubscribing.
      for (const p of this._screenChannels.values()) {
        Promise.resolve(p).then((ch) => { try { ch.unsubscribe(); } catch {} }).catch(() => {});
      }
      for (const p of this._whiteboardChannels.values()) {
        Promise.resolve(p).then((ch) => { try { ch.unsubscribe(); } catch {} }).catch(() => {});
      }
      this._screenChannels.clear();
      this._whiteboardChannels.clear();
    }

    // --- Team channel: presence + signaling + typing + announcements -----

    async _joinTeamChannel() {
      const topic = `team:${this.team.id}`;
      const ch = this.supabase.channel(topic, {
        config: {
          presence: { key: this.peerId },
          broadcast: { self: false, ack: false },
          private: true,
        },
      });
      this._teamChannel = ch;

      // Presence drives the peer roster.
      ch.on('presence', { event: 'sync' }, () => {
        const newState = ch.presenceState();
        const seen = new Set();
        for (const key of Object.keys(newState)) {
          const meta = newState[key][0];
          if (!meta) continue;
          seen.add(key);
          if (key === this.peerId) continue;
          if (!this.peerInfo.has(key)) {
            const peer = { id: key, name: meta.name, color: meta.color };
            this.peerInfo.set(key, peer);
            this.dispatchEvent(new CustomEvent('peer-joined', { detail: peer }));
          }
        }
        for (const id of [...this.peerInfo.keys()]) {
          if (!seen.has(id)) {
            this.peerInfo.delete(id);
            this.dispatchEvent(new CustomEvent('peer-left', { detail: id }));
          }
        }
      });

      ch.on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (payload.to !== this.peerId) return;
        this.dispatchEvent(new CustomEvent('signal', { detail: { from: payload.from, payload: payload.payload } }));
      });
      ch.on('broadcast', { event: 'screen-announce' }, ({ payload }) => {
        this.activeScreens.set(payload.streamId, { fromId: payload.from, label: payload.label });
        this.remoteScreenLabels.set(payload.streamId, { label: payload.label, fromName: payload.fromName, from: payload.from });
        // Receivers also need to join the per-screen broadcast channel, otherwise
        // drawing strokes from other peers never reach this client.
        this._ensureScreenChannel(payload.streamId).catch(() => {});
        this.dispatchEvent(new CustomEvent('screen-announce', { detail: payload }));
      });
      ch.on('broadcast', { event: 'screen-stop' }, ({ payload }) => {
        this.activeScreens.delete(payload.streamId);
        this.remoteScreenLabels.delete(payload.streamId);
        const cached = this._screenChannels.get(payload.streamId);
        if (cached) {
          Promise.resolve(cached).then((c) => { try { c.unsubscribe(); } catch {} }).catch(() => {});
          this._screenChannels.delete(payload.streamId);
        }
        this.dispatchEvent(new CustomEvent('screen-stop', { detail: payload }));
      });
      ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
        this.dispatchEvent(new CustomEvent('typing', { detail: payload }));
      });

      await new Promise((resolve, reject) => {
        ch.subscribe(async (status, err) => {
          if (status === 'SUBSCRIBED') {
            await ch.track({ name: this.name, color: this.color, online_at: new Date().toISOString() });
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            reject(err || new Error('realtime ' + status));
          }
        });
      });
    }

    // --- Postgres changes: live chat messages, channel additions ---------

    async _subscribeToMessages() {
      const ch = this.supabase.channel(`db:team:${this.team.id}`);
      this._dbChannel = ch;
      const teamFilter = `team_id=eq.${this.team.id}`;
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: teamFilter },
        (p) => this.dispatchEvent(new CustomEvent('chat-message', { detail: { message: this._marshalMessage(p.new) } })));
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: teamFilter },
        (p) => this.dispatchEvent(new CustomEvent('chat-update', { detail: { message: this._marshalMessage(p.new) } })));
      ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: teamFilter },
        (p) => this.dispatchEvent(new CustomEvent('chat-message-deleted', { detail: { channelId: p.old.channel_id, messageId: p.old.id } })));
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channels', filter: teamFilter },
        (p) => this.dispatchEvent(new CustomEvent('chat-channel-added', { detail: { channel: this._marshalChannel(p.new) } })));
      ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'channels', filter: teamFilter },
        (p) => this.dispatchEvent(new CustomEvent('chat-channel-removed', { detail: { channelId: p.old.id } })));
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channel_members', filter: teamFilter },
        async (p) => {
          // A member was added to a private channel — if it's us, fetch the
          // channel meta + member names and announce it client-side so it
          // appears in the sidebar (we couldn't have read it before this).
          if (p.new.user_id !== this.peerId) return;
          const { data } = await this.supabase
            .from('channels').select('*').eq('team_id', p.new.team_id).eq('id', p.new.channel_id).maybeSingle();
          if (!data) return;
          const meta = this._marshalChannel(data);
          if (meta.type !== 'public') {
            const { data: rows } = await this.supabase
              .from('channel_members')
              .select('profiles!inner(name)')
              .eq('team_id', p.new.team_id).eq('channel_id', p.new.channel_id);
            meta.members = (rows || []).map((r) => r.profiles.name);
          }
          this.dispatchEvent(new CustomEvent('chat-channel-added', { detail: { channel: meta } }));
        });
      await new Promise((resolve, reject) => {
        ch.subscribe((status, err) => {
          if (status === 'SUBSCRIBED') resolve();
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') reject(err || new Error('db channel ' + status));
        });
      });
    }

    async _loadInitialChannels() {
      const { data: channels } = await this.supabase
        .from('channels').select('*').eq('team_id', this.team.id);
      this._initialChannels = (channels || []).map((c) => this._marshalChannel(c));
      // Pull member lists for private/dm channels we belong to.
      const memberIdsByChannel = new Map();
      for (const c of this._initialChannels) {
        if (c.type === 'public') continue;
        const { data: rows } = await this.supabase
          .from('channel_members').select('user_id').eq('team_id', this.team.id).eq('channel_id', c.id);
        memberIdsByChannel.set(c.id, (rows || []).map((r) => r.user_id));
      }
      // Resolve user_ids to display names.
      const allIds = new Set();
      for (const ids of memberIdsByChannel.values()) for (const id of ids) allIds.add(id);
      let nameById = new Map();
      if (allIds.size) {
        const { data: profs } = await this.supabase
          .from('profiles').select('user_id,name').in('user_id', [...allIds]);
        nameById = new Map((profs || []).map((p) => [p.user_id, p.name]));
      }
      for (const c of this._initialChannels) {
        if (memberIdsByChannel.has(c.id)) {
          c.members = memberIdsByChannel.get(c.id).map((id) => nameById.get(id) || '');
        }
      }
    }

    _dispatchWelcome() {
      this.dispatchEvent(new CustomEvent('welcome', {
        detail: {
          peerId: this.peerId,
          you: { id: this.peerId, name: this.name, color: this.color },
          team: this.team,
          channels: this._initialChannels || [],
          peers: [...this.peerInfo.values()],
          activeScreens: [...this.activeScreens.entries()].map(([streamId, info]) => ({
            streamId, from: info.fromId, fromName: this.peerInfo.get(info.fromId)?.name || 'someone', label: info.label,
          })),
        },
      }));
      this.dispatchEvent(new CustomEvent('connected', { detail: { isFirst: true } }));
    }

    // --- Outgoing operations --------------------------------------------

    sendSignal(to, payload) {
      this._teamChannel?.send({ type: 'broadcast', event: 'signal', payload: { from: this.peerId, to, payload } });
    }
    sendScreenAnnounce(streamId, label) {
      this._teamChannel?.send({ type: 'broadcast', event: 'screen-announce', payload: { from: this.peerId, fromName: this.name, streamId, label } });
      this.activeScreens.set(streamId, { fromId: this.peerId, label });
      // Owner also subscribes so they receive strokes drawn by other peers.
      this._ensureScreenChannel(streamId).catch(() => {});
    }
    sendScreenStop(streamId) {
      this._teamChannel?.send({ type: 'broadcast', event: 'screen-stop', payload: { from: this.peerId, streamId } });
      this.activeScreens.delete(streamId);
      const cached = this._screenChannels.get(streamId);
      if (cached) {
        Promise.resolve(cached).then((c) => { try { c.unsubscribe(); } catch {} }).catch(() => {});
        this._screenChannels.delete(streamId);
      }
    }
    sendTyping(channelId, parentId) {
      this._teamChannel?.send({
        type: 'broadcast', event: 'typing',
        payload: { from: this.peerId, fromName: this.name, channelId, parentId: parentId || null },
      });
    }

    // Drawing strokes ride on a per-screen private channel so peers who
    // aren't viewing/annotating that screen don't pay the bandwidth cost.
    sendDraw(streamId, stroke) {
      this._ensureScreenChannel(streamId).then((ch) => {
        ch.send({ type: 'broadcast', event: 'draw', payload: { from: this.peerId, streamId, stroke } });
      }).catch((err) => console.warn('[draw] channel not ready', err));
    }
    // Returns a promise that resolves to a fully-subscribed RealtimeChannel.
    // Caching the *promise* (not the channel) is important: a second caller
    // arriving during subscription waits on the same handshake instead of
    // grabbing an unsubscribed handle and sending into the void.
    _ensureScreenChannel(streamId) {
      const cached = this._screenChannels.get(streamId);
      if (cached) return Promise.resolve(cached);
      const ch = this.supabase.channel(`screen:${streamId}`, { config: { broadcast: { self: false }, private: true } });
      ch.on('broadcast', { event: 'draw' }, ({ payload }) => {
        this.dispatchEvent(new CustomEvent('draw', { detail: payload }));
      });
      const ready = new Promise((res, rej) => {
        ch.subscribe((s, e) => {
          if (s === 'SUBSCRIBED') res(ch);
          else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') rej(e);
        });
      });
      this._screenChannels.set(streamId, ready);
      // If the subscribe ever fails, drop the cache so the next caller can retry.
      ready.catch(() => this._screenChannels.delete(streamId));
      return ready;
    }

    // --- Chat operations (DB-backed) ------------------------------------

    async loadHistory(channelId, { before, limit = 50 } = {}) {
      let q = this.supabase.from('messages').select('*')
        .eq('team_id', this.team.id).eq('channel_id', channelId)
        .order('ts', { ascending: false }).limit(limit);
      if (before) q = q.lt('ts', new Date(before).toISOString());
      const { data, error } = await q;
      if (error) throw error;
      const messages = (data || []).reverse().map((m) => this._marshalMessage(m));
      // We only know hasMore by overflow probing: ask for one extra and trim.
      let hasMore = false;
      if (messages.length === limit) {
        const oldest = messages[0].ts;
        const { count } = await this.supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('team_id', this.team.id).eq('channel_id', channelId).lt('ts', new Date(oldest).toISOString());
        hasMore = (count || 0) > 0;
      }
      return { messages, hasMore };
    }

    async sendMessage({ channelId, parentId, text, attachments }) {
      const knownNames = [...this.peerInfo.values()].map((p) => p.name).concat(this.name);
      const mentions = extractMentions(text, knownNames);
      const { error } = await this.supabase.from('messages').insert({
        team_id: this.team.id, channel_id: channelId, parent_id: parentId || null,
        author_id: this.peerId, author_name: this.name, author_color: this.color,
        body: text || '', attachments: attachments || [], reactions: {}, mentions,
      });
      if (error) console.warn('sendMessage failed', error);
    }

    // Same shape as sendMessage but flags the row as AI-generated. The
    // human author still owns the row (RLS-wise) so they can edit/delete;
    // the renderer styles it with a robot avatar + model badge.
    async sendAiMessage({ channelId, parentId, text, model, attachments }) {
      const knownNames = [...this.peerInfo.values()].map((p) => p.name).concat(this.name);
      const mentions = extractMentions(text, knownNames);
      const { error } = await this.supabase.from('messages').insert({
        team_id: this.team.id, channel_id: channelId, parent_id: parentId || null,
        author_id: this.peerId, author_name: this.name, author_color: this.color,
        body: text || '', attachments: attachments || [], reactions: {}, mentions,
        ai_generated: true, ai_model: model || null,
      });
      if (error) console.warn('sendAiMessage failed', error);
    }

    async editMessage(messageId, text) {
      const knownNames = [...this.peerInfo.values()].map((p) => p.name).concat(this.name);
      const mentions = extractMentions(text, knownNames);
      const { error } = await this.supabase.from('messages').update({
        body: text, edited_ts: new Date().toISOString(), mentions,
      }).eq('id', messageId);
      if (error) console.warn('editMessage failed', error);
    }

    async deleteMessage(messageId) {
      const { error } = await this.supabase.from('messages').delete().eq('id', messageId);
      if (error) console.warn('deleteMessage failed', error);
    }

    // Reactions live on a jsonb column. We read-modify-write under a
    // optimistic concurrency model; collisions are rare and self-healing.
    async toggleReaction(messageId, emoji) {
      const { data, error } = await this.supabase.from('messages').select('reactions').eq('id', messageId).single();
      if (error || !data) return;
      const r = { ...(data.reactions || {}) };
      const list = Array.isArray(r[emoji]) ? r[emoji].slice() : [];
      const idx = list.indexOf(this.peerId);
      if (idx === -1) list.push(this.peerId); else list.splice(idx, 1);
      if (list.length === 0) delete r[emoji]; else r[emoji] = list;
      await this.supabase.from('messages').update({ reactions: r }).eq('id', messageId);
    }

    async createChannel({ name, topic, isPrivate, memberNames }) {
      const id = slugifyChannelName(name);
      if (!id) throw new Error('invalid channel name');
      const { data: existing } = await this.supabase.from('channels').select('*').eq('team_id', this.team.id).eq('id', id).maybeSingle();
      if (existing) return this._marshalChannel(existing);
      const { data: created, error } = await this.supabase.from('channels').insert({
        team_id: this.team.id, id, name: id, topic: topic || '',
        type: isPrivate ? 'private' : 'public', protected: false, created_by: this.peerId,
      }).select('*').single();
      if (error) throw error;
      const meta = this._marshalChannel(created);
      if (isPrivate) {
        const invited = memberNames?.length
          ? Array.from(new Set([this.name, ...memberNames]))
          : [this.name];
        if (memberNames?.length) {
          const { data: members } = await this.supabase
            .from('team_members')
            .select('user_id, profiles!inner(name)')
            .eq('team_id', this.team.id);
          const idByName = new Map((members || []).map((m) => [m.profiles.name, m.user_id]));
          const rows = memberNames.map((n) => idByName.get(n)).filter(Boolean)
            .map((uid) => ({ team_id: this.team.id, channel_id: id, user_id: uid }));
          if (rows.length) await this.supabase.from('channel_members').insert(rows);
        }
        meta.members = invited;
      }
      return meta;
    }

    async createDm(otherUserName) {
      const { data: members } = await this.supabase
        .from('team_members')
        .select('user_id, profiles!inner(name)')
        .eq('team_id', this.team.id);
      const other = (members || []).find((m) => m.profiles.name === otherUserName);
      if (!other) throw new Error('peer not found');
      const a = this.peerId, b = other.user_id;
      const id = 'dm:' + (a < b ? `${a}::${b}` : `${b}::${a}`);
      const { data: existing } = await this.supabase.from('channels').select('*').eq('team_id', this.team.id).eq('id', id).maybeSingle();
      if (existing) {
        const meta = this._marshalChannel(existing);
        meta.members = [this.name, otherUserName];
        return meta;
      }
      const { data: created, error } = await this.supabase.from('channels').insert({
        team_id: this.team.id, id, name: otherUserName, topic: '',
        type: 'dm', protected: false, created_by: this.peerId,
      }).select('*').single();
      if (error) throw error;
      await this.supabase.from('channel_members').insert([
        { team_id: this.team.id, channel_id: id, user_id: a },
        { team_id: this.team.id, channel_id: id, user_id: b },
      ]);
      const meta = this._marshalChannel(created);
      meta.members = [this.name, otherUserName];
      return meta;
    }

    async deleteChannel(channelId) {
      const { error } = await this.supabase.from('channels').delete().eq('team_id', this.team.id).eq('id', channelId);
      if (error) console.warn('deleteChannel failed', error);
    }

    async searchMessages(query, channelId) {
      let q = this.supabase.from('messages').select('*').eq('team_id', this.team.id);
      if (channelId) q = q.eq('channel_id', channelId);
      // ilike on body covers substring search; no fancy ranking.
      q = q.ilike('body', `%${query.replace(/[%_]/g, '\\$&')}%`).order('ts', { ascending: false }).limit(200);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map((m) => this._marshalMessage(m));
    }

    // --- Whiteboards (one per channel) ----------------------------------
    //
    // Live strokes go over a per-board Realtime broadcast channel so peers
    // see drawing as it happens. Completed strokes are persisted as
    // polylines so latecomers can replay the canvas.

    async getOrCreateWhiteboard(channelId) {
      const { data: existing } = await this.supabase
        .from('whiteboards').select('*')
        .eq('team_id', this.team.id).eq('channel_id', channelId).maybeSingle();
      if (existing) return existing;
      const { data: created, error } = await this.supabase
        .from('whiteboards').insert({
          team_id: this.team.id, channel_id: channelId, created_by: this.peerId,
        }).select('*').single();
      if (error) throw error;
      return created;
    }

    async fetchWhiteboardStrokes(whiteboardId) {
      const { data, error } = await this.supabase
        .from('whiteboard_strokes').select('id, data')
        .eq('whiteboard_id', whiteboardId).order('id', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    async persistWhiteboardStroke(whiteboardId, polyline) {
      // team_id/channel_id are derived server-side from the whiteboard_id
      // FK + RLS join — passing them client-side could be spoofed.
      await this.supabase.from('whiteboard_strokes').insert({
        whiteboard_id: whiteboardId,
        author_id: this.peerId,
        data: polyline,
      });
    }

    async clearWhiteboard(whiteboardId) {
      // Live viewers get a "clear" stroke via broadcast; persistent state is
      // wiped by deleting every stroke row. New viewers fetch zero rows on
      // open and start blank.
      await this.supabase.from('whiteboard_strokes').delete().eq('whiteboard_id', whiteboardId);
    }

    // Subscribe to live strokes on a whiteboard. Idempotent — repeated calls
    // for the same whiteboardId await the cached subscription. The latest
    // onStroke replaces the previous handler. Topic is `team:<id>:wb:<uuid>`
    // so the realtime broadcast policy can gate by team membership instead
    // of relying on the UUID being secret.
    async ensureWhiteboardChannel(whiteboardId, onStroke) {
      const cached = this._whiteboardChannels.get(whiteboardId);
      if (cached) {
        const ch = await Promise.resolve(cached);
        ch._onStroke = onStroke;
        return ch;
      }
      const topic = `team:${this.team.id}:wb:${whiteboardId}`;
      const ch = this.supabase.channel(topic, { config: { broadcast: { self: false }, private: true } });
      ch._onStroke = onStroke;
      ch.on('broadcast', { event: 'stroke' }, ({ payload }) => ch._onStroke?.(payload));
      const ready = new Promise((res, rej) => {
        ch.subscribe((s, e) => {
          if (s === 'SUBSCRIBED') res(ch);
          else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') rej(e);
        });
      });
      this._whiteboardChannels.set(whiteboardId, ready);
      ready.catch(() => this._whiteboardChannels.delete(whiteboardId));
      return ready;
    }

    sendWhiteboardStroke(whiteboardId, stroke) {
      const cached = this._whiteboardChannels.get(whiteboardId);
      if (!cached) return;
      Promise.resolve(cached).then((ch) =>
        ch.send({ type: 'broadcast', event: 'stroke', payload: { from: this.peerId, stroke } })
      ).catch((err) => console.warn('[whiteboard] send before subscribe', err));
    }

    closeWhiteboardChannel(whiteboardId) {
      const cached = this._whiteboardChannels.get(whiteboardId);
      if (cached) {
        Promise.resolve(cached).then((ch) => { try { ch.unsubscribe(); } catch {} }).catch(() => {});
        this._whiteboardChannels.delete(whiteboardId);
      }
    }

    // --- File uploads (Supabase Storage) --------------------------------

    async uploadFile(file) {
      const cleanName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file';
      const objectPath = `${this.peerId}/${crypto.randomUUID()}/${cleanName}`;
      const { error } = await this.supabase.storage.from('uploads').upload(objectPath, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
      if (error) throw error;
      const { data } = this.supabase.storage.from('uploads').getPublicUrl(objectPath);
      return {
        url: data.publicUrl,
        name: cleanName,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      };
    }

    // --- Marshalling: DB row -> wire shape the renderer already speaks ---
    _marshalMessage(row) {
      return {
        id: row.id,
        channelId: row.channel_id,
        parentId: row.parent_id,
        authorId: row.author_id,
        authorName: row.author_name,
        authorColor: row.author_color,
        text: row.body || '',
        attachments: row.attachments || [],
        reactions: row.reactions || {},
        mentions: row.mentions || [],
        ts: new Date(row.ts).getTime(),
        editedTs: row.edited_ts ? new Date(row.edited_ts).getTime() : null,
        aiGenerated: !!row.ai_generated,
        aiModel: row.ai_model || null,
      };
    }
    _marshalChannel(row) {
      const out = {
        id: row.id, name: row.name, topic: row.topic || '',
        type: row.type, protected: !!row.protected, createdBy: row.created_by,
      };
      // members are populated separately for private/dm.
      return out;
    }
  }

  // ========================================================================
  // Auth flow + team join (top-level helpers)
  // ========================================================================

  async function sendOtp(email) {
    const sb = await getSupabase();
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
  }

  async function verifyOtp(email, token) {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    return data.session;
  }

  async function ensureProfile(name, color) {
    const sb = await getSupabase();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('not authenticated');
    // Insert if missing; otherwise update the display name + color.
    const { data: existing } = await sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    if (!existing) {
      await sb.from('profiles').insert({ user_id: user.id, name, color });
    } else if (existing.name !== name || (color && existing.color !== color)) {
      await sb.from('profiles').update({ name, color: color || existing.color }).eq('user_id', user.id);
    }
    return (await sb.from('profiles').select('*').eq('user_id', user.id).single()).data;
  }

  async function listMyTeams() {
    const sb = await getSupabase();
    const { data, error } = await sb.from('team_members').select('team_id, teams!inner(id, name)');
    if (error) throw error;
    return (data || []).map((r) => r.teams);
  }

  async function joinOrCreateTeam(rawName) {
    const sb = await getSupabase();
    const id = slugifyTeamName(rawName);
    if (!id) throw new Error('invalid team name');
    const { data: { user } } = await sb.auth.getUser();
    // If team exists, just insert the membership row.
    const { data: existing } = await sb.from('teams').select('id, name').eq('id', id).maybeSingle();
    if (existing) {
      await sb.from('team_members').upsert({ team_id: id, user_id: user.id });
      return existing;
    }
    // Otherwise create — RLS lets any authenticated user create a team, and
    // the team_after_insert trigger seeds defaults + adds creator as member.
    // Don't chain .select() here: at RETURNING time the AFTER trigger hasn't
    // run yet, so the SELECT policy (is_team_member) would reject the row
    // and throw "new row violates row-level security policy for table teams"
    // even though the insert itself succeeded.
    const { error } = await sb.from('teams').insert({
      id, name: id, created_by: user.id,
    });
    if (error) throw error;
    return { id, name: id };
  }

  async function startHuddle(team) {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    const profile = (await sb.from('profiles').select('*').eq('user_id', session.user.id).single()).data;
    const client = new HuddleClient({ supabase: sb, session, profile, team });
    await client.start();
    return client;
  }

  async function signOut() {
    const sb = await getSupabase();
    await sb.auth.signOut();
  }

  // --- Per-user integration settings (Jira host/email/token, Tenor key, …) -
  // Stored in Supabase under public.user_integrations, RLS-gated to the
  // signed-in user's row.
  async function loadSettings() {
    const sb = await getSupabase();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return {};
    const { data } = await sb.from('user_integrations').select('settings').eq('user_id', user.id).maybeSingle();
    return data?.settings || {};
  }

  async function saveSettings(settings) {
    const sb = await getSupabase();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('not authenticated');
    const { error } = await sb.from('user_integrations').upsert({
      user_id: user.id, settings,
    });
    if (error) throw error;
  }

  async function getActiveSession() {
    const sb = await getSupabase();
    const { data } = await sb.auth.getSession();
    return data.session;
  }

  window.huddleApi = {
    getSupabase,
    sendOtp, verifyOtp, ensureProfile,
    listMyTeams, joinOrCreateTeam, startHuddle,
    signOut, getActiveSession,
    loadSettings, saveSettings,
    HuddleClient,
  };
})();
