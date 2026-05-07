// Top-level orchestrator: wires login -> mesh -> tiles/chat/drawing.
//
// Tiles map (tilesByKey):
//   - "self-cam"           -> the local camera tile
//   - `peer:${peerId}`     -> remote camera/audio tile
//   - `screen:${streamId}` -> a shared screen tile (local OR remote)
// Each screen tile carries a DrawingLayer keyed by streamId so strokes can be
// targeted at the right surface across the network.

const $ = (sel) => document.querySelector(sel);

const els = {
  login: $('#login'),
  loginName: $('#login-name'),
  loginTeam: $('#login-team'),
  loginPassword: $('#login-password'),
  loginServer: $('#login-server'),
  loginError: $('#login-error'),
  loginGo: $('#login-go'),
  workspaceName: $('.workspace-name'),
  reconnectBanner: $('#reconnect-banner'),
  searchBtn: $('#search-btn'),
  searchModal: $('#search-modal'),
  searchInput: $('#search-input'),
  searchScopeCurrent: $('#search-scope-current'),
  searchResults: $('#search-results'),
  searchCancel: $('#search-cancel'),
  attachBtn: $('#attach-btn'),
  fileInput: $('#file-input'),
  attachmentChips: $('#attachment-chips'),
  app: $('#app'),
  channels: $('#channels'),
  dms: $('#dms'),
  addChannel: $('#add-channel'),
  addDm: $('#add-dm'),
  ccModal: $('#create-channel-modal'),
  ccName: $('#cc-name'),
  ccTopic: $('#cc-topic'),
  ccPrivate: $('#cc-private'),
  ccMembersWrap: $('#cc-members-wrap'),
  ccMembers: $('#cc-members'),
  ccCreate: $('#cc-create'),
  ccCancel: $('#cc-cancel'),
  dmPicker: $('#dm-picker'),
  dmPeople: $('#dm-people'),
  dmCancel: $('#dm-cancel'),
  people: $('#people'),
  channelName: $('#channel-name'),
  channelTopic: $('#channel-topic'),
  me: $('#me'),
  tiles: $('#tiles'),
  btnMic: $('#btn-mic'),
  btnCam: $('#btn-cam'),
  btnShare: $('#btn-share'),
  btnLeave: $('#btn-leave'),
  drawToolbar: $('#draw-toolbar'),
  drawTargetName: $('#draw-target-name'),
  drawColor: $('#draw-color'),
  drawSize: $('#draw-size'),
  drawClear: $('#draw-clear'),
  drawClose: $('#draw-close'),
  // chat
  chatChannelName: $('#chat-channel-name'),
  threadBack: $('#chat-thread-back'),
  messages: $('#messages'),
  typing: $('#typing-indicator'),
  composer: $('#composer-input'),
  send: $('#send-btn'),
  emojiBtn: $('#emoji-btn'),
  emojiPicker: $('#emoji-picker'),
  // source picker
  sourcePicker: $('#source-picker'),
  sourceGrid: $('#source-grid'),
  sourceCancel: $('#source-cancel'),
};

const state = {
  mesh: null,
  chat: null,
  myName: '',
  tilesByKey: new Map(),
  drawLayers: new Map(),
  channelMeta: new Map(),
  activeAnnotation: null,
  pendingStreams: new Map(),
  pendingNewChannelId: null,
  unread: new Map(), // channelId -> { count, mentions } both ints
};

// Whether the OS window is currently focused. Used to gate desktop
// notifications + auto-clearing of unread on focus.
let windowFocused = document.hasFocus();
window.addEventListener('focus', () => { windowFocused = true; clearUnreadIfActive(); });
window.addEventListener('blur', () => { windowFocused = false; });

const STREAM_DECISION_MS = 1500;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  const port = await window.huddle.getSignalingPort();
  els.loginServer.value = `ws://localhost:${port}`;
  els.loginGo.addEventListener('click', join);
  for (const el of [els.loginName, els.loginTeam, els.loginPassword, els.loginServer]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  }
  els.loginName.focus();
})();

async function join() {
  const name = els.loginName.value.trim() || 'guest';
  state.myName = name;
  const url = els.loginServer.value.trim();
  const team = els.loginTeam.value.trim();
  const password = els.loginPassword.value;
  const color = `hsl(${Math.floor(Math.random() * 360)} 70% 55%)`;
  const mesh = new MeshClient({ url, name, color, team, password });
  els.loginError.classList.add('hidden');

  mesh.addEventListener('welcome', (e) => onWelcome(e.detail));
  mesh.addEventListener('peer-joined', (e) => addPersonToSidebar(e.detail));
  mesh.addEventListener('peer-left', (e) => onPeerLeft(e.detail));
  mesh.addEventListener('track', (e) => onTrack(e.detail));
  mesh.addEventListener('screen-announce', (e) => onScreenAnnounce(e.detail));
  mesh.addEventListener('screen-stop', (e) => onScreenStop(e.detail));
  mesh.addEventListener('remote-stream-ended', (e) => onScreenStop(e.detail));
  mesh.addEventListener('draw', (e) => onRemoteDraw(e.detail));
  mesh.addEventListener('chat-channel-added', (e) => onChannelAdded(e.detail.channel));
  mesh.addEventListener('chat-channel-removed', (e) => onChannelRemoved(e.detail.channelId));
  mesh.addEventListener('chat-channel-focus', (e) => focusChannel(e.detail.channelId));
  mesh.addEventListener('chat-search-results', (e) => renderSearchResults(e.detail));
  mesh.addEventListener('reconnecting', (e) => {
    els.reconnectBanner.textContent = `Connection lost — retrying (attempt ${e.detail.attempt})…`;
    els.reconnectBanner.classList.remove('hidden');
  });
  mesh.addEventListener('connected', (e) => {
    if (!e.detail.isFirst) {
      els.reconnectBanner.textContent = 'Reconnected.';
      setTimeout(() => els.reconnectBanner.classList.add('hidden'), 1500);
    }
  });
  mesh.addEventListener('auth-failed', () => {
    els.loginError.textContent = "That team password didn't match. Ask a teammate.";
    els.loginError.classList.remove('hidden');
  });

  try { await mesh.connect(); }
  catch (err) {
    if (mesh._authFailed) {
      // login-error is already populated by the auth-failed listener
    } else {
      els.loginError.textContent = 'Could not connect to ' + url;
      els.loginError.classList.remove('hidden');
    }
    return;
  }
  state.mesh = mesh;

  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.me.textContent = name;
  if (mesh.teamMeta?.name) els.workspaceName.textContent = mesh.teamMeta.name;

  try {
    const cam = await mesh.setCamera({ video: true, audio: true });
    addLocalCameraTile(cam, name);
  } catch (err) { console.warn('No camera/mic available', err); }

  state.chat = new ChatView({
    mesh, els,
    hooks: { onMessage: (m) => onChatMessage(m) },
  });
  wireControls();
  els.btnLeave.classList.remove('hidden');
  // Ask for desktop notification permission once on join.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function leave() {
  if (!state.mesh) return;
  state.mesh.disconnect();
  state.mesh = null;
  state.chat = null;
  state.channelMeta.clear();
  state.unread.clear();
  els.channels.replaceChildren();
  els.dms.replaceChildren();
  els.people.replaceChildren();
  els.reconnectBanner.classList.add('hidden');
  for (const tile of state.tilesByKey.values()) tile.remove();
  state.tilesByKey.clear();
  state.drawLayers.clear();
  for (const p of state.pendingStreams.values()) clearTimeout(p.timer);
  state.pendingStreams.clear();
  closeAnnotate();
  els.app.classList.add('hidden');
  els.btnLeave.classList.add('hidden');
  els.login.classList.remove('hidden');
  els.loginName.focus();
}

// ---------------------------------------------------------------------------
// Channels & DMs
// ---------------------------------------------------------------------------

function onWelcome({ peers, channels }) {
  els.channels.replaceChildren();
  els.dms.replaceChildren();
  state.channelMeta.clear();
  for (const c of channels) appendChannelToSidebar(c, false);
  els.people.replaceChildren();
  for (const p of peers) addPersonToSidebar(p);
  // Activate the general channel by default.
  const generalLi = els.channels.querySelector('[data-id="general"]');
  if (generalLi) generalLi.click();
  else if (state.channelMeta.size > 0) {
    // Fallback: pick the first available.
    const first = [...state.channelMeta.keys()][0];
    focusChannel(first);
  }
}

function appendChannelToSidebar(channel, makeActive) {
  state.channelMeta.set(channel.id, channel);
  const isDm = channel.type === 'dm';
  const list = isDm ? els.dms : els.channels;
  if (list.querySelector(`[data-id="${cssEscape(channel.id)}"]`)) return;

  const li = document.createElement('li');
  li.dataset.id = channel.id;

  const label = document.createElement('span');
  label.className = 'ch-name';
  label.textContent = displayLabelFor(channel);
  li.appendChild(label);

  // Unread badge slot — populated by updateUnreadBadge().
  const badge = document.createElement('span');
  badge.className = 'ch-badge';
  badge.style.display = 'none';
  li.appendChild(badge);

  if (canDelete(channel)) {
    const del = document.createElement('button');
    del.className = 'ch-delete';
    del.title = isDm ? 'Close DM' : 'Delete channel';
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      const verb = isDm ? 'Close' : 'Delete';
      const target = isDm ? `your DM with ${displayLabelFor(channel).replace(/^@\s*/, '')}` : `#${channel.name}`;
      if (!confirm(`${verb} ${target}? This is permanent.`)) return;
      state.mesh.send({ type: 'chat-delete-channel', channelId: channel.id });
    };
    li.appendChild(del);
  }

  if (makeActive) li.classList.add('active');
  li.onclick = () => focusChannel(channel.id);
  list.appendChild(li);
}

function focusChannel(channelId) {
  const channel = state.channelMeta.get(channelId);
  if (!channel) return;
  for (const x of els.channels.children) x.classList.remove('active');
  for (const x of els.dms.children) x.classList.remove('active');
  const list = channel.type === 'dm' ? els.dms : els.channels;
  const li = list.querySelector(`[data-id="${cssEscape(channel.id)}"]`);
  if (li) li.classList.add('active');
  state.chat.setChannel(channel.id, channel.topic, displayLabelFor(channel));
  // Visiting a channel clears its unread.
  state.unread.delete(channelId);
  updateUnreadBadge(channelId);
}

// On window focus, clear unread for the channel we're already viewing.
function clearUnreadIfActive() {
  if (!state.chat || !state.mesh) return;
  const id = state.chat.currentChannel;
  if (state.unread.has(id)) {
    state.unread.delete(id);
    updateUnreadBadge(id);
  }
}

// Bump unread for a channel when an incoming message lands there but isn't
// already visible. Mentions count separately so the badge can highlight them.
function bumpUnread(channelId, mentionsMe) {
  const cur = state.unread.get(channelId) || { count: 0, mentions: 0 };
  cur.count += 1;
  if (mentionsMe) cur.mentions += 1;
  state.unread.set(channelId, cur);
  updateUnreadBadge(channelId);
}

function updateUnreadBadge(channelId) {
  const sel = `[data-id="${cssEscape(channelId)}"]`;
  const li = els.channels.querySelector(sel) || els.dms.querySelector(sel);
  if (!li) return;
  const badge = li.querySelector('.ch-badge');
  if (!badge) return;
  const u = state.unread.get(channelId);
  if (!u || u.count === 0) {
    badge.style.display = 'none';
    badge.textContent = '';
    badge.classList.remove('muted');
    return;
  }
  badge.style.display = 'inline-block';
  badge.textContent = String(u.count);
  // Mentions / DMs render as the loud red badge; plain channel chatter is muted.
  const channel = state.channelMeta.get(channelId);
  const loud = u.mentions > 0 || channel?.type === 'dm';
  badge.classList.toggle('muted', !loud);
}

// Called by ChatView via the onMessage hook for every inbound chat message
// (including our own echo). Decides whether to bump unread and notify.
function onChatMessage(m) {
  if (!state.mesh) return;
  if (m.authorName === state.myName) return; // ignore our own messages
  const channel = state.channelMeta.get(m.channelId);
  const mentionsMe = Array.isArray(m.mentions) && m.mentions.includes(state.myName);
  const isDm = channel?.type === 'dm';
  const isActive = state.chat?.currentChannel === m.channelId && windowFocused;
  if (!isActive) bumpUnread(m.channelId, mentionsMe);
  // Notification triggers: mentions, DMs, or a reply in a thread you're in.
  const shouldNotify = !isActive && (mentionsMe || isDm);
  if (shouldNotify) sendDesktopNotification(m, channel);
}

function sendDesktopNotification(m, channel) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const where = channel?.type === 'dm' ? `DM from ${m.authorName}`
    : `${m.authorName} in #${channel?.name || m.channelId}`;
  try {
    const n = new Notification(where, {
      body: (m.text || '').slice(0, 200),
      tag: m.channelId, // collapse repeated alerts per channel
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      focusChannel(m.channelId);
      n.close();
    };
  } catch (err) { console.warn('notification failed', err); }
}

function onChannelAdded(channel) {
  const wasNew = !state.channelMeta.has(channel.id);
  appendChannelToSidebar(channel, false);
  // If this client just created a regular channel, switch into it.
  if (wasNew && state.pendingNewChannelId === channel.id) {
    state.pendingNewChannelId = null;
    focusChannel(channel.id);
  }
}

function onChannelRemoved(channelId) {
  state.channelMeta.delete(channelId);
  const sel = `[data-id="${cssEscape(channelId)}"]`;
  const li = els.channels.querySelector(sel) || els.dms.querySelector(sel);
  if (li) li.remove();
  // If we were viewing it, fall back to general.
  if (state.chat && state.chat.currentChannel === channelId) {
    state.chat.byChannel.delete(channelId);
    const general = els.channels.querySelector('[data-id="general"]');
    if (general) general.click();
  }
}

function displayLabelFor(channel) {
  if (channel.type === 'dm') {
    const other = (channel.members || []).find((m) => m !== state.myName) || channel.name;
    return `@ ${other}`;
  }
  if (channel.type === 'private') return `🔒 ${channel.name}`;
  return `# ${channel.name}`;
}

function canDelete(channel) {
  if (channel.protected) return false;
  if (channel.type === 'dm') return (channel.members || []).includes(state.myName);
  return channel.createdBy === state.myName;
}

// CSS.escape isn't available everywhere; tiny shim for our id alphabet.
function cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c); }

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function addPersonToSidebar(peer) {
  if (els.people.querySelector(`[data-id="${peer.id}"]`)) return;
  const li = document.createElement('li');
  li.dataset.id = peer.id;
  li.dataset.name = peer.name;
  const dot = document.createElement('span');
  dot.className = 'dot online';
  dot.style.background = peer.color || '';
  li.append(dot, document.createTextNode(peer.name));
  // Click to open a DM with them.
  li.onclick = () => {
    if (peer.name === state.myName) return;
    state.mesh.send({ type: 'chat-create-dm', with: peer.name });
  };
  li.title = peer.name === state.myName ? 'You' : `Direct message ${peer.name}`;
  els.people.appendChild(li);
}

function onPeerLeft(peerId) {
  const li = els.people.querySelector(`[data-id="${peerId}"]`);
  if (li) li.remove();
  removeTile(`peer:${peerId}`);
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function makeTile({ key, label, kind }) {
  let tile = state.tilesByKey.get(key);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.className = 'tile' + (kind === 'screen' ? ' screen' : '');
  tile.dataset.key = key;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (kind === 'self') video.muted = true;
  tile.appendChild(video);
  const lbl = document.createElement('div');
  lbl.className = 'tile-label';
  lbl.textContent = label;
  tile.appendChild(lbl);
  if (kind === 'screen') {
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    const annotate = document.createElement('button');
    annotate.textContent = '✏️ Annotate';
    annotate.onclick = () => toggleAnnotate(tile.dataset.streamId);
    actions.appendChild(annotate);
    tile.dataset.kind = 'screen';
    tile.appendChild(actions);
  }
  els.tiles.appendChild(tile);
  state.tilesByKey.set(key, tile);
  return tile;
}

function removeTile(key) {
  const tile = state.tilesByKey.get(key);
  if (tile) tile.remove();
  state.tilesByKey.delete(key);
}

function addLocalCameraTile(stream, name) {
  const tile = makeTile({ key: 'self-cam', label: `${name} (you)`, kind: 'self' });
  tile.querySelector('video').srcObject = stream;
}

function addLocalScreenTile(stream, label) {
  const key = `screen:${stream.id}`;
  const tile = makeTile({ key, label: `${label} — you`, kind: 'screen' });
  tile.dataset.streamId = stream.id;
  tile.querySelector('video').srcObject = stream;
  attachDrawingLayer(tile, stream.id, /*owner*/ true);
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '⏹ Stop';
  stopBtn.onclick = () => state.mesh.removeScreen(stream.id);
  tile.querySelector('.tile-actions').appendChild(stopBtn);
}

function onTrack({ stream, track, fromId }) {
  const screen = state.mesh.remoteScreenLabels.get(stream.id);
  if (screen) { renderRemoteScreen(stream, screen); return; }
  if (state.pendingStreams.has(stream.id)) return;
  const timer = setTimeout(() => commitStreamAsCamera(stream.id), STREAM_DECISION_MS);
  state.pendingStreams.set(stream.id, { stream, fromId, timer });
}

function commitStreamAsCamera(streamId) {
  const pending = state.pendingStreams.get(streamId);
  if (!pending) return;
  state.pendingStreams.delete(streamId);
  clearTimeout(pending.timer);
  const key = `peer:${pending.fromId}`;
  const peer = state.mesh.peerInfo.get(pending.fromId);
  const tile = makeTile({ key, label: peer ? peer.name : 'guest', kind: 'remote' });
  tile.querySelector('video').srcObject = pending.stream;
}

function renderRemoteScreen(stream, screen) {
  const key = `screen:${stream.id}`;
  if (state.tilesByKey.has(key)) {
    state.tilesByKey.get(key).querySelector('.tile-label').textContent =
      `${screen.label} — ${screen.fromName}`;
    return;
  }
  const tile = makeTile({ key, label: `${screen.label} — ${screen.fromName}`, kind: 'screen' });
  tile.dataset.streamId = stream.id;
  tile.querySelector('video').srcObject = stream;
  attachDrawingLayer(tile, stream.id, /*owner*/ false);
}

function onScreenAnnounce(detail) {
  const pending = state.pendingStreams.get(detail.streamId);
  if (pending) {
    clearTimeout(pending.timer);
    state.pendingStreams.delete(detail.streamId);
    renderRemoteScreen(pending.stream, { label: detail.label, fromName: detail.fromName });
    return;
  }
  const tile = state.tilesByKey.get(`screen:${detail.streamId}`);
  if (tile) tile.querySelector('.tile-label').textContent = `${detail.label} — ${detail.fromName}`;
}

function onScreenStop({ streamId }) {
  removeTile(`screen:${streamId}`);
  state.drawLayers.delete(streamId);
  if (state.activeAnnotation === streamId) closeAnnotate();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function attachDrawingLayer(tile, streamId, isOwner) {
  const layer = new DrawingLayer({
    streamId,
    isOwner,
    send: (stroke) => state.mesh.send({ type: 'draw', streamId, stroke }),
  });
  layer.attach(tile);
  state.drawLayers.set(streamId, layer);
}

function onRemoteDraw({ streamId, stroke }) {
  const layer = state.drawLayers.get(streamId);
  if (layer) layer.applyRemote(stroke);
}

function toggleAnnotate(streamId) {
  if (state.activeAnnotation === streamId) { closeAnnotate(); return; }
  if (state.activeAnnotation) closeAnnotate();
  const layer = state.drawLayers.get(streamId);
  if (!layer) return;
  layer.setActive(true);
  state.activeAnnotation = streamId;
  const tile = state.tilesByKey.get(`screen:${streamId}`);
  els.drawToolbar.classList.remove('hidden');
  els.drawTargetName.textContent = tile?.querySelector('.tile-label')?.textContent || 'screen';
}

function closeAnnotate() {
  if (!state.activeAnnotation) { els.drawToolbar.classList.add('hidden'); return; }
  const layer = state.drawLayers.get(state.activeAnnotation);
  if (layer) layer.setActive(false);
  state.activeAnnotation = null;
  els.drawToolbar.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Controls (mic/cam/share + drawing toolbar + create channel + DM picker)
// ---------------------------------------------------------------------------

function wireControls() {
  els.btnMic.onclick = () => {
    const on = state.mesh.toggleMic();
    els.btnMic.textContent = on ? '🎤' : '🔇';
    const tile = state.tilesByKey.get('self-cam');
    if (tile) tile.classList.toggle('muted', !on);
  };
  els.btnCam.onclick = () => {
    const on = state.mesh.toggleCam();
    els.btnCam.textContent = on ? '📷' : '📵';
  };
  els.btnShare.onclick = openSourcePicker;
  els.btnLeave.onclick = leave;
  els.sourceCancel.onclick = () => els.sourcePicker.classList.add('hidden');

  // Search
  els.searchBtn.onclick = openSearchModal;
  els.searchCancel.onclick = () => els.searchModal.classList.add('hidden');
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
    if (e.key === 'Escape') els.searchModal.classList.add('hidden');
  });

  // Create-channel modal
  els.addChannel.onclick = openCreateChannelModal;
  els.ccCancel.onclick = () => els.ccModal.classList.add('hidden');
  els.ccPrivate.onchange = () => {
    els.ccMembersWrap.classList.toggle('hidden', !els.ccPrivate.checked);
    if (els.ccPrivate.checked) renderMemberPicker(els.ccMembers);
  };
  els.ccCreate.onclick = submitCreateChannel;
  els.ccName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !els.ccPrivate.checked) submitCreateChannel(); });

  // DM picker
  els.addDm.onclick = openDmPicker;
  els.dmCancel.onclick = () => els.dmPicker.classList.add('hidden');

  // Drawing toolbar
  els.drawToolbar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => {
      els.drawToolbar.querySelectorAll('[data-tool]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const layer = state.drawLayers.get(state.activeAnnotation);
      if (layer) layer.setTool(b.dataset.tool);
    };
  });
  els.drawColor.oninput = () => state.drawLayers.get(state.activeAnnotation)?.setColor(els.drawColor.value);
  els.drawSize.oninput = () => state.drawLayers.get(state.activeAnnotation)?.setSize(parseInt(els.drawSize.value, 10));
  els.drawClear.onclick = () => state.drawLayers.get(state.activeAnnotation)?.clearAll(true);
  els.drawClose.onclick = closeAnnotate;
}

function openCreateChannelModal() {
  els.ccName.value = '';
  els.ccTopic.value = '';
  els.ccPrivate.checked = false;
  els.ccMembersWrap.classList.add('hidden');
  els.ccMembers.replaceChildren();
  els.ccModal.classList.remove('hidden');
  els.ccName.focus();
}

function submitCreateChannel() {
  const name = els.ccName.value.trim();
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length < 2) { alert('Channel name must be at least 2 characters.'); return; }
  state.pendingNewChannelId = slug;
  const isPrivate = els.ccPrivate.checked;
  const members = isPrivate
    ? [...els.ccMembers.querySelectorAll('.row.selected')].map((r) => r.dataset.name)
    : undefined;
  state.mesh.send({
    type: 'chat-create-channel',
    name,
    topic: els.ccTopic.value,
    private: isPrivate,
    members,
  });
  els.ccModal.classList.add('hidden');
}

// Render a multi-select list of online peers (excluding self) for member invitation.
function renderMemberPicker(container) {
  container.replaceChildren();
  const peers = [...state.mesh.peerInfo.values()].filter((p) => p.name !== state.myName);
  if (peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No other people are online right now.';
    container.appendChild(empty);
    return;
  }
  for (const p of peers) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.name = p.name;
    const dot = document.createElement('span');
    dot.className = 'dot online';
    dot.style.background = p.color || '';
    const check = document.createElement('span');
    check.className = 'check';
    const lbl = document.createElement('span');
    lbl.textContent = p.name;
    row.append(dot, lbl, check);
    row.onclick = () => {
      const selected = row.classList.toggle('selected');
      check.textContent = selected ? '✓' : '';
    };
    container.appendChild(row);
  }
}

function openDmPicker() {
  els.dmPeople.replaceChildren();
  const peers = [...state.mesh.peerInfo.values()].filter((p) => p.name !== state.myName);
  if (peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No other people are online right now.';
    els.dmPeople.appendChild(empty);
  } else {
    for (const p of peers) {
      const row = document.createElement('div');
      row.className = 'row';
      const dot = document.createElement('span');
      dot.className = 'dot online';
      dot.style.background = p.color || '';
      const lbl = document.createElement('span');
      lbl.textContent = p.name;
      row.append(dot, lbl);
      row.onclick = () => {
        state.mesh.send({ type: 'chat-create-dm', with: p.name });
        els.dmPicker.classList.add('hidden');
      };
      els.dmPeople.appendChild(row);
    }
  }
  els.dmPicker.classList.remove('hidden');
}

function openSearchModal() {
  els.searchInput.value = '';
  els.searchResults.replaceChildren();
  els.searchScopeCurrent.checked = false;
  els.searchModal.classList.remove('hidden');
  els.searchInput.focus();
}

function runSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;
  const channelId = els.searchScopeCurrent.checked ? state.chat.currentChannel : undefined;
  state.mesh.send({ type: 'chat-search', query: q, channelId });
  els.searchResults.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty';
  loading.textContent = 'Searching…';
  els.searchResults.appendChild(loading);
}

function renderSearchResults({ query, results }) {
  els.searchResults.replaceChildren();
  if (!results || results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No matches for "${query}".`;
    els.searchResults.appendChild(empty);
    return;
  }
  for (const m of results) {
    const ch = state.channelMeta.get(m.channelId);
    const hit = document.createElement('div');
    hit.className = 'hit';
    const meta = document.createElement('div');
    meta.className = 'hit-meta';
    const when = new Date(m.ts).toLocaleString();
    meta.textContent = `${m.authorName} · ${ch ? displayLabelFor(ch) : '#' + m.channelId} · ${when}`;
    const text = document.createElement('div');
    text.className = 'hit-text';
    text.textContent = (m.text || '').slice(0, 240);
    hit.append(meta, text);
    hit.onclick = () => {
      els.searchModal.classList.add('hidden');
      focusChannel(m.channelId);
      // If the hit is a thread reply, open the thread on the parent.
      if (m.parentId) state.chat.openThread(m.parentId);
    };
    els.searchResults.appendChild(hit);
  }
}

async function openSourcePicker() {
  const sources = await window.huddle.getScreenSources();
  els.sourceGrid.replaceChildren();
  for (const s of sources) {
    const card = document.createElement('div');
    card.className = 'src';
    const img = document.createElement('img');
    img.src = s.thumbnail;
    const name = document.createElement('div');
    name.className = 'src-name';
    name.textContent = s.name;
    card.append(img, name);
    card.onclick = async () => {
      els.sourcePicker.classList.add('hidden');
      try {
        const stream = await state.mesh.addScreen(s.id, s.name);
        addLocalScreenTile(stream, s.name);
      } catch (err) { alert('Failed to share screen: ' + err.message); }
    };
    els.sourceGrid.appendChild(card);
  }
  els.sourcePicker.classList.remove('hidden');
}
