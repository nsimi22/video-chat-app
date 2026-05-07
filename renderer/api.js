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
      // Per-channel call topic (call:<team>:<channel>). Only one active
      // call at a time. Presence on this channel drives WebRTC
      // peer-joined/peer-left events.
      this._callChannel = null;
      this._callChannelId = null;     // channel.id of the active call, if any
      this._callPeerInfo = new Map(); // user_id -> { id, name, color }
      // Lurker subscriptions used by the chat header to render
      // "Start call" / "Join call · N". Keyed by channel.id; values are
      // ready-promises wrapping the RealtimeChannel.
      this._lurkers = new Map();
      this._lurkerCounts = new Map(); // channel.id -> last seen count
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

    async stop() {
      // Channel maps store readiness promises — resolve them and await
      // the unsubscribes before clearing the maps so the page isn't
      // unloaded mid-handshake (which leaks subscriptions server-side).
      const direct = [this._teamChannel, this._dbChannel, this._callChannel];
      const indirect = [...this._screenChannels.values(), ...this._whiteboardChannels.values(), ...this._lurkers.values()];
      const work = direct
        .map((ch) => ch ? Promise.resolve().then(() => ch.unsubscribe()).catch(() => {}) : null)
        .filter(Boolean)
        .concat(indirect.map((p) => Promise.resolve(p).then((ch) => ch.unsubscribe()).catch(() => {})));
      await Promise.allSettled(work);
      this._teamChannel = null;
      this._dbChannel = null;
      this._callChannel = null;
      this._callChannelId = null;
      this._callPeerInfo.clear();
      this._screenChannels.clear();
      this._whiteboardChannels.clear();
      this._lurkers.clear();
      this._lurkerCounts.clear();
    }

    // --- Call channel: per-channel presence + signaling + screen events --
    //
    // Subscribed lazily when the user clicks "Start call" / "Join call".
    // Topic: call:<team_id>:<channel_id>. Presence drives WebRTC
    // peer-joined / peer-left events. Signaling, screen-announce, and
    // screen-stop broadcasts ride this channel too — only call
    // participants pay the bandwidth cost; teammates merely lurking on
    // a channel see counts but no media traffic.
    async joinCall(channelId) {
      if (this._callChannelId === channelId) return; // already in this call
      if (this._callChannel) await this.leaveCall();
      // Drop any lurker subscription on this same channel BEFORE
      // creating the call channel object. supabase.channel(topic)
      // is cached by topic — if a lurker is already subscribed
      // we'd get its (already-SUBSCRIBED) instance back, and
      // ch.on('presence', ...) below would throw "cannot add
      // presence callbacks after subscribe()". Awaiting the
      // unsubscribe ensures supabase-js drops the topic from its
      // internal registry before we ask for a fresh channel.
      await this._dropLurker(channelId);
      const topic = `call:${this.team.id}:${channelId}`;
      const ch = this.supabase.channel(topic, {
        config: {
          presence: { key: this.peerId },
          broadcast: { self: false, ack: false },
          private: true,
        },
      });

      ch.on('presence', { event: 'sync' }, () => {
        const newState = ch.presenceState();
        const seen = new Set();
        for (const key of Object.keys(newState)) {
          const meta = newState[key][0];
          if (!meta) continue;
          seen.add(key);
          if (key === this.peerId) continue;
          if (!this._callPeerInfo.has(key)) {
            const peer = { id: key, name: meta.name, color: meta.color };
            this._callPeerInfo.set(key, peer);
            this.dispatchEvent(new CustomEvent('peer-joined', { detail: peer }));
          }
        }
        for (const id of [...this._callPeerInfo.keys()]) {
          if (!seen.has(id)) {
            this._callPeerInfo.delete(id);
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
        // Receivers also need to join the per-screen broadcast channel,
        // otherwise drawing strokes from other peers never reach them.
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

      await new Promise((resolve, reject) => {
        // Every failure path must unsubscribe before rejecting,
        // otherwise the channel sits subscribed in supabase-js with
        // dangling handlers, and on a slow network we can ghost into
        // call presence after the local UI has already given up.
        const failClean = (err) => {
          try { ch.unsubscribe(); } catch {}
          reject(err);
        };
        // Hard timeout in case Realtime never resolves the subscribe
        // (RLS denial that doesn't surface as CHANNEL_ERROR, network
        // hiccup mid-handshake, etc.). Without this the await hangs
        // forever and the Start-call button stays disabled — the
        // user sees "nothing happens" with no signal in the UI.
        const timer = setTimeout(() => failClean(new Error('realtime call subscribe timed out')), 8000);
        ch.subscribe(async (status, err) => {
          if (status === 'SUBSCRIBED') {
            try {
              // supabase-js track() returns the string 'ok' / 'error'
              // / 'timed out' rather than throwing; we must inspect
              // it before declaring the join complete, otherwise we
              // become a participant with no presence and look like
              // a ghost to other peers.
              const trackResult = await ch.track({ name: this.name, color: this.color, online_at: new Date().toISOString() });
              if (trackResult !== 'ok') {
                clearTimeout(timer);
                failClean(new Error('realtime call presence track ' + trackResult));
                return;
              }
            } catch (e) {
              clearTimeout(timer);
              failClean(e);
              return;
            }
            clearTimeout(timer);
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timer);
            failClean(err || new Error('realtime call ' + status));
          }
        });
      });

      this._callChannel = ch;
      this._callChannelId = channelId;
      // (Lurker for this channel was already dropped at the top of
      // joinCall — see _dropLurker.)
    }

    async leaveCall() {
      if (!this._callChannel) return;
      const ch = this._callChannel;
      const wasIn = this._callChannelId;
      // Emit synthetic peer-left for everyone we were connected to so
      // the renderer (MeshClient + tile grid) drops them cleanly.
      for (const id of [...this._callPeerInfo.keys()]) {
        this.dispatchEvent(new CustomEvent('peer-left', { detail: id }));
      }
      this._callPeerInfo.clear();
      this._callChannel = null;
      this._callChannelId = null;
      // Await the call channel + every per-screen channel before clearing
      // their maps, otherwise we can drop the references mid-handshake
      // and leave subscriptions hanging server-side.
      const screenUnsubs = [...this._screenChannels.values()].map(
        (p) => Promise.resolve(p).then((c) => c.unsubscribe()).catch(() => {})
      );
      await Promise.allSettled([
        Promise.resolve().then(() => ch.unsubscribe()).catch(() => {}),
        ...screenUnsubs,
      ]);
      this._screenChannels.clear();
      this.activeScreens.clear();
      this.remoteScreenLabels.clear();
      this.dispatchEvent(new CustomEvent('call-left', { detail: { channelId: wasIn } }));
    }

    // Subscribe to a call:* topic in lurker mode (presence read, no
    // own-presence track) so the chat header can render
    // "Join call · N" without committing the user to the call. Idempotent
    // per channel id. Returns the latest known participant count.
    async watchCallPresence(channelId) {
      if (this._callChannelId === channelId) {
        // We're a participant — own presence already reports the count.
        return this._callPeerInfo.size + 1;
      }
      const cached = this._lurkers.get(channelId);
      if (cached) {
        await Promise.resolve(cached);
        return this._lurkerCounts.get(channelId) || 0;
      }
      const topic = `call:${this.team.id}:${channelId}`;
      const ch = this.supabase.channel(topic, {
        config: { presence: { key: this.peerId }, broadcast: { self: false, ack: false }, private: true },
      });
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState();
        const count = Object.keys(state).length;
        this._lurkerCounts.set(channelId, count);
        this.dispatchEvent(new CustomEvent('call-presence', { detail: { channelId, count } }));
      });
      const ready = new Promise((res, rej) => {
        ch.subscribe((s, e) => {
          if (s === 'SUBSCRIBED') res(ch);
          else if (s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') rej(e);
        });
      });
      this._lurkers.set(channelId, ready);
      ready.catch(() => this._lurkers.delete(channelId));
      await ready;
      return this._lurkerCounts.get(channelId) || 0;
    }

    unwatchCallPresence(channelId) {
      const cached = this._lurkers.get(channelId);
      if (!cached) return;
      Promise.resolve(cached).then((c) => { try { c.unsubscribe(); } catch {} }).catch(() => {});
      this._lurkers.delete(channelId);
      this._lurkerCounts.delete(channelId);
    }

    // Same as unwatchCallPresence but waits for the unsubscribe to
    // resolve before returning. joinCall needs this synchronous
    // teardown — supabase.channel(topic) is cached by topic, so
    // creating a new channel object while a lurker is still
    // subscribed would hand back the lurker's already-SUBSCRIBED
    // instance, and ch.on('presence', ...) would throw "cannot add
    // presence callbacks after subscribe()".
    async _dropLurker(channelId) {
      const cached = this._lurkers.get(channelId);
      if (!cached) return;
      this._lurkers.delete(channelId);
      this._lurkerCounts.delete(channelId);
      try {
        const c = await Promise.resolve(cached);
        await c.unsubscribe();
      } catch {}
    }

    // Last-known participant count for a watched channel, or 0 if not
    // currently watched. The renderer reads this synchronously while
    // rendering the channel header; it's kept fresh by the lurker's
    // presence-sync handler.
    getCallParticipantCount(channelId) {
      if (this._callChannelId === channelId) return this._callPeerInfo.size + 1;
      return this._lurkerCounts.get(channelId) || 0;
    }

    // Live mirror of the current call membership for the renderer's
    // imperative reads (welcome payload + tile grid bootstrapping).
    get callPeerInfo() { return this._callPeerInfo; }
    get inCallChannelId() { return this._callChannelId; }

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

      // Team presence drives the People sidebar's online dot only — it
      // does NOT drive WebRTC peer creation. WebRTC peer events come from
      // the per-channel call:* topic that joinCall() subscribes to.
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
            this.dispatchEvent(new CustomEvent('member-online', { detail: peer }));
          }
        }
        for (const id of [...this.peerInfo.keys()]) {
          if (!seen.has(id)) {
            this.peerInfo.delete(id);
            this.dispatchEvent(new CustomEvent('member-offline', { detail: id }));
          }
        }
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
      // Signal/screen events ride the call channel — only call
      // participants receive them, so a teammate lurking on chat in
      // a different channel pays no media bandwidth.
      this._callChannel?.send({ type: 'broadcast', event: 'signal', payload: { from: this.peerId, to, payload } });
    }
    sendScreenAnnounce(streamId, label) {
      this._callChannel?.send({ type: 'broadcast', event: 'screen-announce', payload: { from: this.peerId, fromName: this.name, streamId, label } });
      this.activeScreens.set(streamId, { fromId: this.peerId, label });
      // Owner also subscribes so they receive strokes drawn by other peers.
      this._ensureScreenChannel(streamId).catch(() => {});
    }
    sendScreenStop(streamId) {
      this._callChannel?.send({ type: 'broadcast', event: 'screen-stop', payload: { from: this.peerId, streamId } });
      this.activeScreens.delete(streamId);
      const cached = this._screenChannels.get(streamId);
      if (cached) {
        Promise.resolve(cached).then((c) => { try { c.unsubscribe(); } catch {} }).catch(() => {});
        this._screenChannels.delete(streamId);
      }
      // The call channel is configured `broadcast: { self: false }`, so
      // the 'screen-stop' broadcast above doesn't echo back to us —
      // without a local dispatch the renderer never tears down our own
      // screen tile when we stop sharing. Mirror what a remote peer
      // would receive.
      this.dispatchEvent(new CustomEvent('screen-stop', { detail: { from: this.peerId, streamId } }));
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
      // Don't chain .select() on the insert: for private/dm channels the
      // SELECT policy gates RETURNING on `is_channel_member(team_id, id)`,
      // and the on_channel_after_insert trigger that adds the creator to
      // channel_members fires after RETURNING evaluates. Same RLS-with-
      // RETURNING gotcha as team-create — surfaces as "new row violates
      // row-level security policy for table channels", swallowing the
      // follow-up channel_members invites for everyone else.
      const type = isPrivate ? 'private' : 'public';
      const { error } = await this.supabase.from('channels').insert({
        team_id: this.team.id, id, name: id, topic: topic || '',
        type, protected: false, created_by: this.peerId,
      });
      if (error) throw error;
      const meta = {
        id, name: id, topic: topic || '', type, protected: false,
        createdBy: this.peerId, members: undefined,
      };
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
          if (rows.length) {
            const { error: memErr } = await this.supabase.from('channel_members').insert(rows);
            // Surface the failure: silently swallowing it would leave the
            // channel in the DB without the invited members, reproducing
            // the same "exists but invisible" symptom this PR fixes.
            if (memErr) throw memErr;
          }
        }
        meta.members = invited;
      }
      return meta;
    }

    // Last-resort display-name fetch for createDm callers that
    // somehow have a uuid but no name (shouldn't happen given every
    // identity surface in the renderer carries both, but the schema
    // requires the channel row to have *something* in `name`).
    async _fetchDisplayName(userId) {
      try {
        const { data } = await this.supabase.from('profiles').select('name').eq('user_id', userId).maybeSingle();
        return data?.name || null;
      } catch { return null; }
    }

    // Open or create the DM between this client and another team
    // member. Takes the other user's uuid directly (lookup-by-name
    // was fragile: profile renames invalidated callers' cached
    // names, and there's no per-team uniqueness constraint on
    // names so two teammates with the same display name produced
    // an arbitrary winner).
    async createDm(otherUserId, otherUserName) {
      if (!otherUserId) throw new Error('createDm: missing user id');
      const a = this.peerId, b = otherUserId;
      if (a === b) throw new Error("can't DM yourself");
      // Verify the target is a member of the current team. The
      // previous lookup-by-name path enforced this implicitly (only
      // team_members were findable); the uuid path skips it, so
      // without a guard a caller could DM an arbitrary user. The
      // channel_members insert downstream is RLS-gated, but it
      // fires AFTER the channel row is created — without this
      // upfront check we'd leak orphan channel rows on misuse.
      const { data: membership, error: memCheckErr } = await this.supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', this.team.id)
        .eq('user_id', otherUserId)
        .maybeSingle();
      if (memCheckErr) throw memCheckErr;
      if (!membership) throw new Error('not a member of this team');
      const id = 'dm:' + (a < b ? `${a}::${b}` : `${b}::${a}`);
      // Prefer the caller-supplied name, then the live presence
      // cache (fresher than profiles.name when a teammate has
      // renamed since the caller cached its copy), then a DB fetch
      // as a last resort.
      const displayName = otherUserName
        || this.peerInfo.get(otherUserId)?.name
        || (await this._fetchDisplayName(otherUserId))
        || 'unknown';
      const { data: existing } = await this.supabase.from('channels').select('*').eq('team_id', this.team.id).eq('id', id).maybeSingle();
      if (existing) {
        const meta = this._marshalChannel(existing);
        meta.members = [this.name, displayName];
        return meta;
      }
      // Don't chain .select() on the insert: channels_read RLS gates
      // type='dm' rows on `is_channel_member(team_id, id)`, but the
      // on_channel_after_insert trigger that adds the creator to
      // channel_members hasn't fired yet at RETURNING time. The insert
      // itself succeeds (WITH CHECK passes) but RETURNING throws
      // "new row violates row-level security policy for table channels"
      // — the catch then blocks the next two statements (the explicit
      // channel_members rows for both DM participants), so the channel
      // exists in the DB with no members and is invisible to either
      // user next session. Same gotcha as team-create.
      const { error } = await this.supabase.from('channels').insert({
        team_id: this.team.id, id, name: displayName, topic: '',
        type: 'dm', protected: false, created_by: this.peerId,
      });
      if (error) throw error;
      // Trigger added the creator (a). Add the other side explicitly so
      // both participants can see the DM. Surface failures: silently
      // swallowing leaves the DM in the DB with only one member, which
      // makes it disappear for both sides on reload.
      const { error: memErr } = await this.supabase.from('channel_members').upsert([
        { team_id: this.team.id, channel_id: id, user_id: a },
        { team_id: this.team.id, channel_id: id, user_id: b },
      ]);
      if (memErr) throw memErr;
      return {
        id, name: displayName, topic: '', type: 'dm', protected: false,
        createdBy: this.peerId, members: [this.name, displayName],
      };
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

    // Profile-card lookup: returns full profile + email (email gated
    // server-side to teammates only; non-teammates get null). Cached
    // for a few seconds so opening/closing/reopening the same card
    // doesn't re-roundtrip.
    async getProfile(userId) {
      const cached = this._profileCache?.get(userId);
      if (cached && Date.now() - cached.fetchedAt < 30_000) return cached.profile;
      const { data, error } = await this.supabase.rpc('get_profile', { p_user_id: userId });
      if (error) throw error;
      const profile = (data && data[0]) || null;
      if (!this._profileCache) this._profileCache = new Map();
      if (profile) this._profileCache.set(userId, { profile, fetchedAt: Date.now() });
      return profile;
    }

    // Edit-your-own-profile: persists name / color / bio / avatar_url
    // to public.profiles, then re-broadcasts presence so other peers
    // see the new name + color immediately. Avatar URL changes don't
    // need a presence push because avatars are fetched lazily by the
    // profile card; chat avatar circles still re-resolve on next
    // render via getProfile.
    async updateProfile({ name, color, bio, avatar_url }) {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (color !== undefined) patch.color = color;
      if (bio !== undefined) patch.bio = bio;
      if (avatar_url !== undefined) patch.avatar_url = avatar_url;
      if (Object.keys(patch).length === 0) return;
      const { error } = await this.supabase.from('profiles').update(patch).eq('user_id', this.peerId);
      if (error) throw error;
      if (patch.name !== undefined) this.name = patch.name;
      if (patch.color !== undefined) this.color = patch.color;
      this._profileCache?.delete(this.peerId);
      // Re-track team presence so peers re-render with the new
      // identity. The call channel (if any) is left alone — joinCall
      // tracks once and stale name/color in an active call is mostly
      // cosmetic. supabase-js track() returns 'ok' / 'error' /
      // 'timed out' rather than throwing; we don't want to fail the
      // whole save when presence falters (the DB row is already
      // updated, peers will pick up the change on next reconnect),
      // but we should at least surface it so the silent-failure
      // mode is visible during debugging.
      try {
        const trackResult = await this._teamChannel?.track({ name: this.name, color: this.color, online_at: new Date().toISOString() });
        if (trackResult && trackResult !== 'ok') {
          console.warn('updateProfile: presence re-track returned', trackResult);
        }
      } catch (e) {
        console.warn('updateProfile: presence re-track threw', e);
      }
    }

    async uploadAvatar(file) {
      // Storage policy gates writes to `<auth.uid()>/...`. The path
      // is fixed (no extension) so a second upload always replaces
      // the first via upsert; if we kept the original extension a
      // user switching from avatar.jpg to avatar.png would leak the
      // old file. The Content-Type header carries the real format
      // for the browser, so the extension on disk is unnecessary.
      const objectPath = `${this.peerId}/avatar`;
      const { error } = await this.supabase.storage.from('avatars').upload(objectPath, file, {
        contentType: file.type || 'image/png',
        upsert: true,
      });
      if (error) throw error;
      const { data } = this.supabase.storage.from('avatars').getPublicUrl(objectPath);
      // Cache-bust so freshly-uploaded avatars don't show the old image.
      return `${data.publicUrl}?t=${Date.now()}`;
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
    // We can't probe existence with `select * from teams where id=X`:
    // teams_read_member RLS only lets members + creator see the row, so
    // a non-member trying to join an existing team would see "missing"
    // and the subsequent insert would crash on the PK conflict.
    // Instead, optimistically try the insert. If it succeeds, the
    // team_after_insert trigger added us as a member. If it conflicts
    // on the PK (23505), the team already exists — we just need to
    // upsert ourselves into team_members. Don't chain .select() on the
    // insert: at RETURNING time the AFTER trigger hasn't run yet, so
    // is_team_member(id) would reject the row.
    const { error: insertErr } = await sb.from('teams').insert({
      id, name: id, created_by: user.id,
    });
    if (insertErr && insertErr.code !== '23505') throw insertErr;
    // Either we just created the team (trigger added the membership
    // row) or it already existed and we still need to join. Upsert is
    // a no-op in the first case and the actual join in the second.
    await sb.from('team_members').upsert({ team_id: id, user_id: user.id });
    return { id, name: id };
  }

  async function startHuddle(team) {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    const profile = (await sb.from('profiles').select('*').eq('user_id', session.user.id).single()).data;
    const client = new HuddleClient({ supabase: sb, session, profile, team });
    // NOTE: callers must attach event listeners on `client` before
    // calling `client.start()`. start() dispatches `welcome` (with the
    // initial channels + peers payload) synchronously at the end of
    // its handshake; if listeners aren't attached yet, the event fires
    // into the void and the sidebar never renders.
    return client;
  }

  async function signOut() {
    const sb = await getSupabase();
    await sb.auth.signOut();
  }

  // --- Per-user integration settings (Jira host/email/token, Giphy key, …) -
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
