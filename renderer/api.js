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
  //
  // Returns the entries to store in messages.mentions:
  //   - resolved user display names (from `names`, case-insensitive match) —
  //     stored as-typed in the directory, e.g. 'Alice'
  //   - broadcast sentinels '@here' / '@channel' — the leading '@' makes them
  //     unambiguous against a hypothetical user literally named "here" or
  //     "channel" (no other entry in the array carries an '@' prefix)
  function extractMentions(text, names) {
    if (!text) return [];
    const set = new Set();
    const lookup = new Map((names || []).map((n) => [n.toLowerCase(), n]));
    const re = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,31})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const token = m[2].toLowerCase();
      if (token === 'here' || token === 'channel') {
        set.add('@' + token);
        continue;
      }
      const hit = lookup.get(token);
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
      // Full team roster, populated on start() and read by the
      // sidebar + DM picker + member picker so offline teammates
      // are visible. Keyed by user_id, value: { id, name, color,
      // avatar_url }.
      this.roster = new Map();
      this.remoteScreenLabels = new Map();
      this.activeScreens = new Map(); // streamId -> { from, label, owner: bool }
      // Peer ids whose hand is currently raised. Cleared when the peer
      // lowers their hand or leaves the call.
      this.raisedHands = new Set();
      this.url = _config.url;
      this._teamChannel = null;
      this._screenChannels = new Map();     // streamId -> RealtimeChannel
      this._whiteboardChannels = new Map(); // whiteboardId -> RealtimeChannel
      this._dbChannel = null;               // postgres_changes subscription
      this._myChannelIds = new Set();       // channel ids we have a membership row in (private + dm)
      this._memberRefreshTimers = new Map(); // channelId -> debounce timer, coalescing realtime member-change events
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
      await this._loadRoster();
      this._dispatchWelcome();
    }

    // Pull the full team roster (including offline members). Presence
    // only carries currently-online users, which is fine for the
    // call/typing UX but useless for the DM picker and "people"
    // list — you can't DM someone who isn't sitting in the app right
    // now if those surfaces only iterate presence. Stash the roster
    // in a Map keyed by user_id; sidebar + pickers render from this
    // and overlay online status from peerInfo.
    async _loadRoster() {
      this.roster = new Map();
      // Two queries instead of `select('user_id, profiles!inner(...)')`:
      // there's no direct FK between team_members and profiles
      // (both reference auth.users), so PostgREST can't infer the
      // embed reliably. Fetch user_ids first, then resolve them
      // against profiles in one round-trip — same shape that
      // _loadInitialChannels already uses.
      const { data: members, error: memErr } = await this.supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', this.team.id);
      if (memErr) throw memErr;
      const ids = (members || []).map((m) => m.user_id);
      if (!ids.length) return;
      const { data: profs, error: profErr } = await this.supabase
        .from('profiles')
        .select('user_id, name, color, avatar_url')
        .in('user_id', ids);
      if (profErr) throw profErr;
      for (const p of (profs || [])) {
        this.roster.set(p.user_id, {
          id: p.user_id,
          name: p.name,
          color: p.color,
          avatar_url: p.avatar_url || null,
        });
      }
    }

    async stop() {
      // Channel maps store readiness promises — resolve them and await
      // the unsubscribes before clearing the maps so the page isn't
      // unloaded mid-handshake (which leaks subscriptions server-side).
      const direct = [this._teamChannel, this._dbChannel, this._callChannel];
      // Screen + whiteboard maps still store raw promise<RealtimeChannel>;
      // _lurkers values are now {channel, ready} pairs.
      const indirectPromises = [...this._screenChannels.values(), ...this._whiteboardChannels.values()];
      const lurkerChannels = [...this._lurkers.values()].map((l) => l.channel);
      const work = direct
        .map((ch) => ch ? Promise.resolve().then(() => ch.unsubscribe()).catch(() => {}) : null)
        .filter(Boolean)
        .concat(indirectPromises.map((p) => Promise.resolve(p).then((ch) => ch.unsubscribe()).catch(() => {})))
        .concat(lurkerChannels.map((ch) => Promise.resolve().then(() => ch.unsubscribe()).catch(() => {})));
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
      for (const t of this._memberRefreshTimers.values()) clearTimeout(t);
      this._memberRefreshTimers.clear();
      this._myChannelIds.clear();
      this.roster.clear();
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
      const hadLurker = this._lurkers.has(channelId);
      await this._dropLurker(channelId);
      try {
        await this._joinCallInner(channelId);
      } catch (err) {
        // joinCall failed after we dropped the lurker. The user is
        // still viewing this channel via the chat header, so
        // re-subscribe a lurker on a best-effort basis — without
        // it the "Join call · N" count would freeze at its
        // pre-attempt value until something else triggered a
        // refocus.
        if (hadLurker) this.watchCallPresence(channelId).catch(() => {});
        throw err;
      }
    }

    async _joinCallInner(channelId) {
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
            this.raisedHands.delete(id);
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
      ch.on('broadcast', { event: 'raise-hand' }, ({ payload }) => {
        if (payload.raised) this.raisedHands.add(payload.from);
        else this.raisedHands.delete(payload.from);
        this.dispatchEvent(new CustomEvent('raise-hand', { detail: payload }));
      });
      // Reactions are ephemeral; receivers render a floating emoji on
      // the sender's tile and let it auto-clear locally — no DB row.
      ch.on('broadcast', { event: 'reaction' }, ({ payload }) => {
        this.dispatchEvent(new CustomEvent('reaction', { detail: payload }));
      });

      // Live call captions: transcript lines are ephemeral broadcasts
      // (no DB row) so they don't pollute message history. Each peer
      // who has captions on locally broadcasts their own final SR
      // segments here; receivers render them in the in-call captions
      // panel and accumulate them for the post-call AI summary.
      ch.on('broadcast', { event: 'transcript-line' }, ({ payload }) => {
        this.dispatchEvent(new CustomEvent('transcript-line', { detail: payload }));
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
      this.raisedHands.clear();
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
        try { await cached.ready; } catch {}
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
      // Store BOTH the synchronously-available channel handle and
      // the readiness promise. _dropLurker calls .unsubscribe()
      // on the channel directly instead of awaiting `ready` —
      // otherwise a lurker whose subscribe handshake is hanging
      // would block joinCall forever (no timeout in subscribe()
      // for the lurker path).
      this._lurkers.set(channelId, { channel: ch, ready });
      ready.catch(() => this._lurkers.delete(channelId));
      await ready;
      return this._lurkerCounts.get(channelId) || 0;
    }

    // Fire-and-forget version of _dropLurker. Public callers (the
    // chat header swap when focusing a different channel) don't
    // need to await the unsubscribe — supabase-js will tear it
    // down in the background. _dropLurker swallows its own errors,
    // so no .catch() needed here.
    unwatchCallPresence(channelId) {
      this._dropLurker(channelId);
    }

    // Tear down the lurker subscription on a channel. joinCall
    // needs the unsubscribe to complete before it asks
    // supabase.channel(topic) for a fresh instance — supabase.js
    // caches channels by topic, so a still-subscribed lurker
    // would hand back its already-SUBSCRIBED instance and
    // ch.on('presence', ...) would throw "cannot add presence
    // callbacks after subscribe()".
    //
    // We unsubscribe via the channel handle directly (not by
    // awaiting `ready`) so a lurker whose subscribe handshake is
    // still pending can still be dropped immediately. The
    // handshake's resolution is swallowed so its error doesn't
    // leak after we've moved on.
    async _dropLurker(channelId) {
      const cached = this._lurkers.get(channelId);
      if (!cached) return;
      this._lurkers.delete(channelId);
      this._lurkerCounts.delete(channelId);
      cached.ready.catch(() => {});
      try { await cached.channel.unsubscribe(); } catch {}
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
        (p) => { this._myChannelIds.delete(p.old.id); this.dispatchEvent(new CustomEvent('chat-channel-removed', { detail: { channelId: p.old.id } })); });
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channel_members', filter: teamFilter },
        async (p) => {
          if (p.new.user_id === this.peerId) {
            // We were added to a private channel or (group) DM — fetch the
            // channel meta + members and announce it so it appears in the
            // sidebar (we couldn't have read it before this).
            const { data } = await this.supabase
              .from('channels').select('*').eq('team_id', p.new.team_id).eq('id', p.new.channel_id).maybeSingle();
            if (!data) return;
            const meta = this._marshalChannel(data);
            if (meta.type !== 'public') {
              const { memberIds, members } = await this._fetchChannelMembers(p.new.channel_id);
              meta.memberIds = memberIds;
              meta.members = members;
              this._myChannelIds.add(p.new.channel_id);
            }
            this.dispatchEvent(new CustomEvent('chat-channel-added', { detail: { channel: meta } }));
            return;
          }
          // Someone else joined a channel we're in (e.g. a group DM grew) —
          // refresh its member list so labels stay current. Debounced so a
          // bulk add (several rows in quick succession) is one refetch.
          this._scheduleMemberRefresh(p.new.channel_id);
        });
      ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'channel_members', filter: teamFilter },
        async (p) => {
          // Our own removal is handled synchronously by leaveDmChannel(); a
          // realtime echo of it is harmless (onChannelRemoved is idempotent).
          if (p.old.user_id === this.peerId) {
            this._myChannelIds.delete(p.old.channel_id);
            this.dispatchEvent(new CustomEvent('chat-channel-removed', { detail: { channelId: p.old.channel_id } }));
            return;
          }
          // Someone else left a channel we're in — refresh its member list
          // (debounced, same as the join path).
          this._scheduleMemberRefresh(p.old.channel_id);
        });
      // Saved-messages mutations. RLS on saved_messages restricts the
      // payload to the caller's own rows so we don't need an auth-side
      // filter here. The renderer keeps a local copy of the user's
      // saves and reconciles via these events.
      const saveFilter = `user_id=eq.${this.peerId}`;
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'saved_messages', filter: saveFilter },
        (p) => this.dispatchEvent(new CustomEvent('saved-message-added', { detail: { save: this._marshalSavedRow(p.new) } })));
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'saved_messages', filter: saveFilter },
        (p) => this.dispatchEvent(new CustomEvent('saved-message-updated', { detail: { save: this._marshalSavedRow(p.new) } })));
      ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'saved_messages', filter: saveFilter },
        (p) => this.dispatchEvent(new CustomEvent('saved-message-removed', { detail: { messageId: p.old.message_id } })));
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
          const ids = memberIdsByChannel.get(c.id);
          c.memberIds = ids;
          c.members = ids.map((id) => nameById.get(id) || '');
          this._myChannelIds.add(c.id);
        }
      }
    }

    // Coalesce a burst of channel_members changes for one channel (e.g. several
    // people added at once each emit their own realtime row) into a single
    // member-list refetch + 'chat-channel-updated'.
    _scheduleMemberRefresh(channelId) {
      if (!this._myChannelIds.has(channelId)) return;
      clearTimeout(this._memberRefreshTimers.get(channelId));
      this._memberRefreshTimers.set(channelId, setTimeout(async () => {
        this._memberRefreshTimers.delete(channelId);
        if (!this._myChannelIds.has(channelId)) return;
        try {
          const { memberIds, members } = await this._fetchChannelMembers(channelId);
          this.dispatchEvent(new CustomEvent('chat-channel-updated', { detail: { channelId, memberIds, members } }));
        } catch { /* a transient read failure self-heals on the next change */ }
      }, 200));
    }

    // Member ids + display names for one channel, in a stable order.
    async _fetchChannelMembers(channelId) {
      const { data: rows } = await this.supabase
        .from('channel_members').select('user_id').eq('team_id', this.team.id).eq('channel_id', channelId);
      const memberIds = (rows || []).map((r) => r.user_id);
      let members = memberIds.map(() => '');
      if (memberIds.length) {
        const { data: profs } = await this.supabase
          .from('profiles').select('user_id,name').in('user_id', memberIds);
        const nameById = new Map((profs || []).map((p) => [p.user_id, p.name]));
        members = memberIds.map((id) => nameById.get(id) || '');
      }
      return { memberIds, members };
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
    sendRaiseHand(raised) {
      if (raised) this.raisedHands.add(this.peerId);
      else this.raisedHands.delete(this.peerId);
      this._callChannel?.send({ type: 'broadcast', event: 'raise-hand', payload: { from: this.peerId, raised: !!raised } });
    }
    sendReaction(emoji) {
      this._callChannel?.send({ type: 'broadcast', event: 'reaction', payload: { from: this.peerId, emoji } });
      // Call channel is { broadcast: { self: false } }; mirror locally so
      // the sender sees their own reaction without a round-trip.
      this.dispatchEvent(new CustomEvent('reaction', { detail: { from: this.peerId, emoji } }));
    }
    sendTranscriptLine(text, ts) {
      // Broadcast a final SR segment to other call participants. Skipped
      // when no call is active — captions are call-scoped, so there's
      // no team-channel fallback. ts lets receivers stitch together
      // out-of-order arrivals at summary time.
      this._callChannel?.send({
        type: 'broadcast', event: 'transcript-line',
        payload: { from: this.peerId, fromName: this.name, text, ts: ts || Date.now() },
      });
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
      // Throw on failure so callers (notably /ai-ticket) can surface the
      // problem to the user — silently warning here meant a successful
      // Jira ticket would never appear in chat with no visible error.
      if (error) throw error;
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

    // Pin / unpin a message. Routed through a security-definer RPC so any
    // channel member can pin (the messages_update_own RLS policy only
    // permits the author to mutate their own row otherwise). The existing
    // realtime UPDATE subscription on messages broadcasts the change to
    // everyone — chat.js re-renders the row's pin badge from chat-update.
    async pinMessage(messageId, pin) {
      const { error } = await this.supabase.rpc('set_message_pin', {
        p_message_id: messageId,
        p_pin: !!pin,
      });
      if (error) { console.warn('pinMessage failed', error); throw error; }
    }

    async loadPinnedMessages(channelId) {
      const { data, error } = await this.supabase
        .from('messages').select('*')
        .eq('team_id', this.team.id).eq('channel_id', channelId)
        .not('pinned_at', 'is', null)
        .order('pinned_at', { ascending: false })
        .limit(50);
      if (error) { console.warn('loadPinnedMessages failed', error); return []; }
      return (data || []).map((m) => this._marshalMessage(m));
    }

    // Count-only query for the channel-header pin chip. Avoids round-
    // tripping (and marshalling) up to 50 full message rows just to
    // surface a number, and stays accurate past the 50-row cap that
    // loadPinnedMessages applies for drawer rendering.
    async pinnedMessageCount(channelId) {
      const { count, error } = await this.supabase
        .from('messages').select('id', { count: 'exact', head: true })
        .eq('team_id', this.team.id).eq('channel_id', channelId)
        .not('pinned_at', 'is', null);
      if (error) { console.warn('pinnedMessageCount failed', error); return 0; }
      return count || 0;
    }

    // --- Saved messages -----------------------------------------------------
    //
    // Per-user bookmarks with arbitrary user-defined labels. The save row
    // carries the team/channel/message ids needed to render the saved-
    // panel without re-joining to the message author each time, plus the
    // labels array the user has tagged this save with. RLS restricts
    // every read/write to the saver, so we don't need to gate further
    // here — wire the user's id into the row and trust the policy.

    _marshalSavedRow(row) {
      return {
        userId: row.user_id,
        teamId: row.team_id,
        channelId: row.channel_id,
        messageId: row.message_id,
        labels: Array.isArray(row.labels) ? row.labels : [],
        savedAt: row.saved_at ? new Date(row.saved_at).getTime() : Date.now(),
      };
    }

    // Save a message for the current user. Idempotent: re-saving an
    // already-saved message replaces its labels (this is the editing
    // path called by the labels popover). ON CONFLICT DO UPDATE works
    // here because the saved_messages_update policy permits self-
    // updates — unlike channel_members where there is no UPDATE policy.
    async saveMessage({ teamId, channelId, messageId, labels = [] }) {
      const cleanLabels = (labels || []).map((s) => String(s).trim()).filter(Boolean);
      const { error } = await this.supabase.from('saved_messages').upsert(
        {
          user_id: this.peerId,
          team_id: teamId || this.team.id,
          channel_id: channelId,
          message_id: messageId,
          labels: cleanLabels,
          // saved_at default keeps the original save timestamp on
          // re-save; updating labels via this path bumps `saved_at`
          // so the item resurfaces at the top of the panel — that
          // matches Slack's "I just refiled this" mental model.
          saved_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,message_id' },
      );
      if (error) { console.warn('saveMessage failed', error); throw error; }
    }

    async unsaveMessage(messageId) {
      const { error } = await this.supabase.from('saved_messages')
        .delete().eq('user_id', this.peerId).eq('message_id', messageId);
      if (error) { console.warn('unsaveMessage failed', error); throw error; }
    }

    // Load the caller's saved rows joined to the underlying messages,
    // newest first. Optional label filter narrows to rows whose labels
    // array contains the given label. Limit kept generous because the
    // panel loads incrementally and pinning the cap server-side avoids
    // a runaway query when a user has thousands of saves.
    async loadSavedMessages({ label, limit = 200 } = {}) {
      let q = this.supabase
        .from('saved_messages')
        .select('user_id, team_id, channel_id, message_id, labels, saved_at, messages!inner(*)')
        .eq('user_id', this.peerId)
        .order('saved_at', { ascending: false })
        .limit(limit);
      if (label) q = q.contains('labels', [label]);
      const { data, error } = await q;
      if (error) { console.warn('loadSavedMessages failed', error); return []; }
      return (data || []).map((row) => ({
        save: this._marshalSavedRow(row),
        // PostgREST embed: messages!inner returns the joined row inline.
        // RLS on messages still applies — a save pointing at a row the
        // user can no longer see (e.g. they were removed from a private
        // channel) just won't include the embedded message.
        message: row.messages ? this._marshalMessage(row.messages) : null,
      })).filter((x) => x.message);
    }

    // (No loadSavedLabels here — the renderer derives the distinct
    // label set from its in-memory savedById cache, which is seeded
    // from loadSavedMessages and kept current by the realtime fan-in.
    // That avoids a second round-trip just to compute a Set on data
    // we already loaded.)

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
      // Idempotent channel upsert: ignoreDuplicates keeps a
      // pre-existing row from tripping channels_pkey, and we don't
      // chain .select() because on the fresh-insert path the
      // on_channel_after_insert trigger that adds the creator to
      // channel_members hasn't fired yet at RETURNING time —
      // channels_read RLS gates type='dm' on membership and would
      // throw "row violates row-level security policy".
      const { error } = await this.supabase.from('channels').upsert({
        team_id: this.team.id, id, name: displayName, topic: '',
        type: 'dm', protected: false, created_by: this.peerId,
      }, { onConflict: 'team_id,id', ignoreDuplicates: true });
      // Belt + braces: ignoreDuplicates should turn the conflict into a
      // no-op via Prefer: resolution=ignore-duplicates, but the 23505
      // has been seen in the wild on bundles where that header is
      // dropped. Treat unique-violation on the channels pkey as a
      // success so the membership repair below still runs and the user
      // gets their DM.
      if (error && error.code !== '23505') throw error;
      // Add OUR membership unconditionally. channel_members'
      // insert_self policy permits inserting your own row, so this
      // works whether the channel was just created (no-op against
      // the trigger-added row) or pre-existed with us missing
      // (the legacy bad state we're repairing). On the no-op path
      // the upsert returns success.
      //
      // ignoreDuplicates is critical: supabase-js's default upsert
      // sends ON CONFLICT DO UPDATE, but channel_members has no
      // UPDATE policy (there's nothing legitimately updatable on a
      // membership row), so the conflict path fails RLS with
      // "USING expression for table channel_members". DO NOTHING
      // sidesteps the UPDATE branch entirely.
      const { error: meErr } = await this.supabase.from('channel_members').upsert(
        { team_id: this.team.id, channel_id: id, user_id: a },
        { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true },
      );
      if (meErr) throw meErr;
      // Re-fetch through RLS now that we're a member. Gives us
      // the persisted created_by value — needed below.
      const { data: ch, error: selErr } = await this.supabase
        .from('channels').select('*')
        .eq('team_id', this.team.id).eq('id', id).single();
      if (selErr) throw selErr;
      // Counterparty: only upsert when WE created the channel
      // (the only path where channel_members' insert_self policy
      // lets us insert another user's row, via the
      // `channels.created_by = auth.uid()` branch). If somebody
      // else created it, B was added by the trigger when they
      // did, so a no-op here is fine; trying anyway would fail
      // RLS and break this whole flow.
      if (ch.created_by === a) {
        // Same DO-NOTHING dance as the self-upsert above — see comment there.
        const { error: peerErr } = await this.supabase.from('channel_members').upsert(
          { team_id: this.team.id, channel_id: id, user_id: b },
          { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true },
        );
        if (peerErr) throw peerErr;
      }
      this._myChannelIds.add(id);
      const meta = this._marshalChannel(ch);
      meta.memberIds = [a, b];
      meta.members = [this.name, displayName];
      return meta;
    }

    // --- Group DMs ----------------------------------------------------------

    // Resolve uuids -> current display names, preferring live presence over a
    // profiles round-trip. Always includes ourselves.
    async _resolveNames(userIds) {
      const out = new Map([[this.peerId, this.name]]);
      const missing = [];
      for (const uid of userIds) {
        if (out.has(uid)) continue;
        const live = this.peerInfo.get(uid)?.name;
        if (live) out.set(uid, live); else missing.push(uid);
      }
      if (missing.length) {
        const { data: profs } = await this.supabase.from('profiles').select('user_id,name').in('user_id', missing);
        for (const p of (profs || [])) out.set(p.user_id, p.name);
      }
      return out;
    }

    async _assertTeamMembers(userIds) {
      if (!userIds.length) return;
      const { data, error } = await this.supabase
        .from('team_members').select('user_id').eq('team_id', this.team.id).in('user_id', userIds);
      if (error) throw error;
      const have = new Set((data || []).map((r) => r.user_id));
      if (userIds.some((id) => !have.has(id))) throw new Error('not all of those users are in this team');
    }

    // Open or create a group DM with `otherUserIds` (plus us). If a DM channel
    // with exactly this membership already exists, reuse it (re-adding us to
    // channel_members if we'd previously left). Group DMs use a random
    // `gdm:<uuid>` id so members can change over time without the id going
    // stale; dedup is enforced server-side by a partial unique index on
    // (team_id, member_sig) added in 20260514120000.
    async createGroupDm(otherUserIds, _names) {
      const ids = [...new Set((otherUserIds || []).filter(Boolean))].filter((id) => id !== this.peerId);
      if (ids.length < 2) throw new Error('a group DM needs at least two other people');
      await this._assertTeamMembers(ids);
      // Canonical member-set signature: sorted UUIDs joined by commas. Must
      // match the format the migration's backfill uses (string_agg user_id::text
      // order by user_id::text) or existing rows won't be found.
      const memberSig = [this.peerId, ...ids].sort().join(',');

      // First try server-side dedup. join_dm_by_member_sig is SECURITY
      // DEFINER: it checks auth.uid() is in the sig, looks up the matching
      // gdm, and adds us to channel_members in one atomic step. Returns the
      // channel id (or null on miss). Folding the lookup and the membership
      // write together is what lets us tighten channel_members_insert_self
      // (20260515000000) — the RLS no longer allows self-insert into a gdm
      // we aren't a creator/member of, so we have to rejoin through this
      // function instead of doing it client-side.
      const { data: existingId, error: lookupErr } = await this.supabase
        .rpc('join_dm_by_member_sig', { t: this.team.id, sig: memberSig });
      if (lookupErr) throw lookupErr;
      if (existingId) return await this._openExistingDm(existingId, ids);

      const nameById = await this._resolveNames(ids);
      const label = ids.map((id) => nameById.get(id) || 'someone').sort((x, y) => x.localeCompare(y)).join(', ');
      const id = 'gdm:' + ((typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      // Don't chain .select() — same RLS-with-RETURNING gotcha as createDm:
      // channels_read gates type='dm' on membership, which the
      // on_channel_after_insert trigger only grants after RETURNING runs.
      const { error: chErr } = await this.supabase.from('channels').insert({
        team_id: this.team.id, id, name: label.slice(0, 200) || 'Group', topic: '',
        type: 'dm', protected: false, created_by: this.peerId, member_sig: memberSig,
      });
      if (chErr) {
        // 23505 = the (team_id, member_sig) partial unique index fired. We
        // raced another tab/click that beat us to the insert; recover by
        // opening the winner instead of surfacing an opaque error.
        if (chErr.code === '23505') {
          const { data: conflictId } = await this.supabase
            .rpc('join_dm_by_member_sig', { t: this.team.id, sig: memberSig });
          if (conflictId) return await this._openExistingDm(conflictId, ids);
        }
        throw chErr;
      }
      // The trigger added us; add the rest. We're the creator, so the existing
      // channel_members insert_self policy (created_by branch) permits this.
      // .insert() is atomic — a single failed row aborts the batch and leaves
      // the channel half-populated, so don't mask any error (incl. 23505,
      // which shouldn't happen at all for a freshly-minted gdm:<uuid>).
      const rows = ids.map((uid) => ({ team_id: this.team.id, channel_id: id, user_id: uid }));
      const { error: memErr } = await this.supabase.from('channel_members').insert(rows);
      if (memErr) throw memErr;
      this._myChannelIds.add(id);
      const allIds = [this.peerId, ...ids];
      return {
        id, name: label || 'Group', topic: '', type: 'dm', protected: false, createdBy: this.peerId,
        memberIds: allIds, members: allIds.map((uid) => nameById.get(uid) || ''),
      };
    }

    // Open an existing DM by id, re-adding any intended participants who
    // had previously left. Used by createGroupDm when join_dm_by_member_sig
    // hits — that RPC already added the caller to channel_members, so we
    // only need to handle the *other* intended members here. Branch 3 of
    // channel_members_insert_self (is_channel_member + type='dm') authorizes
    // them: we're now a member of the gdm via the RPC, and they're being
    // pulled in by an existing member.
    //
    // .upsert(ignoreDuplicates) is used for the batch because .insert() is
    // atomic: one 23505 (already a member) would otherwise abort the whole
    // batch and leave the rest of the intended members unadded.
    async _openExistingDm(channelId, otherUserIds = []) {
      this._myChannelIds.add(channelId);
      const others = (otherUserIds || []).filter((uid) => uid && uid !== this.peerId);
      if (others.length) {
        const rows = others.map((uid) => ({ team_id: this.team.id, channel_id: channelId, user_id: uid }));
        const { error: othersErr } = await this.supabase
          .from('channel_members')
          .upsert(rows, { onConflict: 'team_id,channel_id,user_id', ignoreDuplicates: true });
        if (othersErr) throw othersErr;
      }
      const { data: chRow, error: chErr } = await this.supabase
        .from('channels').select('*').eq('team_id', this.team.id).eq('id', channelId).maybeSingle();
      if (chErr) throw chErr;
      if (!chRow) throw new Error('dm vanished between lookup and join');
      const { memberIds, members } = await this._fetchChannelMembers(channelId);
      const meta = this._marshalChannel(chRow);
      meta.memberIds = memberIds;
      meta.members = members;
      return meta;
    }

    // Add more people to an existing DM channel (turns a 1:1 into a group, or
    // grows a group). Requires the group-DM RLS migration so non-creators can
    // do this. Peers see the change via the channel_members realtime stream.
    async addDmMembers(channelId, userIds) {
      const ids = [...new Set((userIds || []).filter(Boolean))].filter((id) => id !== this.peerId);
      if (!ids.length) return null;
      await this._assertTeamMembers(ids);
      const rows = ids.map((uid) => ({ team_id: this.team.id, channel_id: channelId, user_id: uid }));
      const { error } = await this.supabase.from('channel_members').insert(rows);
      if (error && error.code !== '23505') throw error;
      const { memberIds, members } = await this._fetchChannelMembers(channelId);
      this.dispatchEvent(new CustomEvent('chat-channel-updated', { detail: { channelId, memberIds, members } }));
      return { memberIds, members };
    }

    // Leave a DM/group channel: just drop our own membership row. (RLS:
    // channel_members_delete_self allows deleting where user_id = auth.uid().)
    async leaveDmChannel(channelId) {
      const { error } = await this.supabase.from('channel_members')
        .delete().eq('team_id', this.team.id).eq('channel_id', channelId).eq('user_id', this.peerId);
      if (error) throw error;
      this._myChannelIds.delete(channelId);
      this.dispatchEvent(new CustomEvent('chat-channel-removed', { detail: { channelId } }));
    }

    async deleteChannel(channelId) {
      // Throw on failure so the renderer can surface the error
      // instead of leaving the user staring at an unchanged sidebar.
      // RLS may legitimately deny (non-owner trying to delete a
      // public/private channel; protected #general; etc.) so the
      // caller is responsible for catching + showing a useful
      // message.
      const { error } = await this.supabase.from('channels').delete().eq('team_id', this.team.id).eq('id', channelId);
      if (error) throw error;
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

    // Per-stroke undo: locate the row by its client-generated uuid
    // (stored in data.uuid as text) and delete it. The strokes_delete
    // RLS policy gates by `can_see_channel` via the EXISTS join —
    // anyone in the channel can undo any stroke, matching the
    // collaborative model used elsewhere on the board.
    async deleteWhiteboardStrokeByUuid(whiteboardId, uuid) {
      if (!uuid) return;
      const { error } = await this.supabase
        .from('whiteboard_strokes')
        .delete()
        .eq('whiteboard_id', whiteboardId)
        .eq('data->>uuid', uuid);
      if (error) throw error;
    }

    async clearWhiteboard(whiteboardId) {
      // Live viewers get a "clear" stroke via broadcast; persistent state is
      // wiped by deleting every stroke row. New viewers fetch zero rows on
      // open and start blank. Notes are wiped alongside strokes — Clear
      // is a "reset to blank canvas" gesture.
      await this.supabase.from('whiteboard_strokes').delete().eq('whiteboard_id', whiteboardId);
      await this.supabase.from('whiteboard_notes').delete().eq('whiteboard_id', whiteboardId);
    }

    // --- Whiteboard sticky notes ---------------------------------------

    async fetchWhiteboardNotes(whiteboardId) {
      const { data, error } = await this.supabase
        .from('whiteboard_notes')
        .select('id, x, y, w, h, text, color, author_id, updated_at')
        .eq('whiteboard_id', whiteboardId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    async createWhiteboardNote(whiteboardId, note) {
      // team_id / channel_id used to be on this insert but they were
      // redundant with the whiteboards FK and let a malicious client
      // diverge them from the parent. RLS now uses an EXISTS join on
      // whiteboards (mirroring the strokes_* policies after PR-#5
      // review), so we only send the FK-anchored fields.
      const row = {
        id: note.id,
        whiteboard_id: whiteboardId,
        author_id: this.peerId,
        x: note.x, y: note.y,
        w: note.w, h: note.h,
        text: note.text || '',
        color: note.color || '#ffd866',
      };
      const { error } = await this.supabase.from('whiteboard_notes').insert(row);
      if (error) throw error;
    }

    async updateWhiteboardNote(noteId, patch) {
      const next = { ...patch, updated_at: new Date().toISOString() };
      const { error } = await this.supabase.from('whiteboard_notes').update(next).eq('id', noteId);
      if (error) throw error;
    }

    async deleteWhiteboardNote(noteId) {
      const { error } = await this.supabase.from('whiteboard_notes').delete().eq('id', noteId);
      if (error) throw error;
    }

    // Live note edit broadcasts. Same channel as strokes so a single
    // subscribe covers both. The ensureWhiteboardChannel handler now
    // dispatches `stroke` and `note` payloads through the same callback
    // — see below for the WhiteboardSession wiring.
    sendWhiteboardNote(whiteboardId, payload) {
      const cached = this._whiteboardChannels.get(whiteboardId);
      if (!cached) return;
      Promise.resolve(cached).then((ch) =>
        ch.send({ type: 'broadcast', event: 'note', payload: { from: this.peerId, ...payload } })
      ).catch((err) => console.warn('[whiteboard] note send before subscribe', err));
    }

    // Subscribe to live strokes on a whiteboard. Idempotent — repeated calls
    // for the same whiteboardId await the cached subscription. The latest
    // onStroke replaces the previous handler. Topic is `team:<id>:wb:<uuid>`
    // so the realtime broadcast policy can gate by team membership instead
    // of relying on the UUID being secret.
    async ensureWhiteboardChannel(whiteboardId, onStroke, onNote) {
      const cached = this._whiteboardChannels.get(whiteboardId);
      if (cached) {
        const ch = await Promise.resolve(cached);
        ch._onStroke = onStroke;
        ch._onNote = onNote;
        return ch;
      }
      const topic = `team:${this.team.id}:wb:${whiteboardId}`;
      const ch = this.supabase.channel(topic, { config: { broadcast: { self: false }, private: true } });
      ch._onStroke = onStroke;
      ch._onNote = onNote;
      ch.on('broadcast', { event: 'stroke' }, ({ payload }) => ch._onStroke?.(payload));
      ch.on('broadcast', { event: 'note' }, ({ payload }) => ch._onNote?.(payload));
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
        pinnedAt: row.pinned_at ? new Date(row.pinned_at).getTime() : null,
        pinnedBy: row.pinned_by || null,
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

  // Password sign-in for users who have one set. Errors with "Invalid
  // login credentials" for a wrong password OR an unknown email — we
  // surface a single generic message rather than leaking which.
  async function signInWithPassword(email, password) {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  // Account creation with a password. Returns the active session when the
  // project has "Confirm email" disabled; otherwise `data.session` is null
  // and the user must confirm via email before the account is usable —
  // the caller surfaces that distinction.
  async function signUpWithPassword(email, password) {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    return data.session; // null when email confirmation is still required
  }

  // Set or change the signed-in user's password. The active session is the
  // proof of identity, so no current-password / email round-trip is needed.
  // Works for OTP-only users too — this is how they pick up a password the
  // first time.
  async function updatePassword(newPassword) {
    const sb = await getSupabase();
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
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
    if (!user) throw new Error('not authenticated');
    // Single-team rule (enforced by team_members_one_team_per_user):
    // leave any other team first, otherwise the team_after_insert
    // trigger trips the unique (user_id) constraint and the create
    // path rolls back. Surface delete errors so they don't masquerade
    // as the subsequent unique-violation.
    const { error: delErr } = await sb.from('team_members')
      .delete().eq('user_id', user.id).neq('team_id', id);
    if (delErr) throw delErr;
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
    sendOtp, verifyOtp, signInWithPassword, signUpWithPassword, updatePassword, ensureProfile,
    listMyTeams, joinOrCreateTeam, startHuddle,
    signOut, getActiveSession,
    loadSettings, saveSettings,
    HuddleClient,
  };
})();
