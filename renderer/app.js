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
  loginServer: $('#login-server'),
  loginGo: $('#login-go'),
  app: $('#app'),
  channels: $('#channels'),
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
  tilesByKey: new Map(),
  drawLayers: new Map(), // streamId -> DrawingLayer
  channelMeta: new Map(),
  activeAnnotation: null, // streamId currently being annotated
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  const port = await window.huddle.getSignalingPort();
  els.loginServer.value = `ws://localhost:${port}`;
  els.loginGo.addEventListener('click', join);
  els.loginName.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  els.loginName.focus();
})();

async function join() {
  const name = els.loginName.value.trim() || 'guest';
  const url = els.loginServer.value.trim();
  const color = `hsl(${Math.floor(Math.random() * 360)} 70% 55%)`;
  const mesh = new MeshClient({ url, name, color });

  mesh.addEventListener('welcome', (e) => onWelcome(e.detail));
  mesh.addEventListener('peer-joined', (e) => addPersonToSidebar(e.detail));
  mesh.addEventListener('peer-left', (e) => onPeerLeft(e.detail));
  mesh.addEventListener('track', (e) => onTrack(e.detail));
  mesh.addEventListener('screen-announce', (e) => onScreenAnnounce(e.detail));
  mesh.addEventListener('screen-stop', (e) => onScreenStop(e.detail));
  mesh.addEventListener('remote-stream-ended', (e) => onScreenStop(e.detail));
  mesh.addEventListener('draw', (e) => onRemoteDraw(e.detail));
  mesh.addEventListener('disconnected', () => alert('Disconnected from server.'));

  try {
    await mesh.connect();
  } catch (err) {
    alert('Could not connect to ' + url);
    return;
  }
  state.mesh = mesh;

  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.me.textContent = `${name}`;

  // Get camera+mic and add to mesh.
  try {
    const cam = await mesh.setCamera({ video: true, audio: true });
    addLocalCameraTile(cam, name);
  } catch (err) {
    console.warn('No camera/mic available', err);
  }

  state.chat = new ChatView({ mesh, els });
  wireControls();
}

function onWelcome({ peers, channels }) {
  for (const c of channels) state.channelMeta.set(c.id, c);
  renderChannels(channels);
  els.people.innerHTML = '';
  for (const p of peers) addPersonToSidebar(p);
  state.chat?.setChannel('general', state.channelMeta.get('general')?.topic);
}

function renderChannels(channels) {
  els.channels.innerHTML = '';
  for (const c of channels) {
    const li = document.createElement('li');
    li.textContent = '# ' + c.name;
    li.dataset.id = c.id;
    if (c.id === 'general') li.classList.add('active');
    li.onclick = () => {
      [...els.channels.children].forEach((x) => x.classList.remove('active'));
      li.classList.add('active');
      state.chat.setChannel(c.id, c.topic);
    };
    els.channels.appendChild(li);
  }
}

function addPersonToSidebar(peer) {
  const existing = els.people.querySelector(`[data-id="${peer.id}"]`);
  if (existing) return;
  const li = document.createElement('li');
  li.dataset.id = peer.id;
  const dot = document.createElement('span');
  dot.className = 'dot online';
  dot.style.background = peer.color || '';
  li.append(dot, document.createTextNode(peer.name));
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
    if (kind === 'screen') tile.dataset.kind = 'screen';
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
  // Tile actions: stop sharing button.
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '⏹ Stop';
  stopBtn.onclick = () => state.mesh.removeScreen(stream.id);
  tile.querySelector('.tile-actions').appendChild(stopBtn);
}

function onTrack({ stream, track, fromId }) {
  // Heuristic: a stream that was announced as a screen lives in remoteScreenLabels.
  const screen = state.mesh.remoteScreenLabels.get(stream.id);
  if (screen) {
    const key = `screen:${stream.id}`;
    if (!state.tilesByKey.has(key)) {
      const tile = makeTile({ key, label: `${screen.label} — ${screen.fromName}`, kind: 'screen' });
      tile.dataset.streamId = stream.id;
      tile.querySelector('video').srcObject = stream;
      attachDrawingLayer(tile, stream.id, /*owner*/ false);
    }
    return;
  }
  // Otherwise treat as the camera+mic stream from this peer.
  const key = `peer:${fromId}`;
  const peer = state.mesh.peerInfo.get(fromId);
  const tile = makeTile({ key, label: peer ? peer.name : 'guest', kind: 'remote' });
  tile.querySelector('video').srcObject = stream;
}

function onScreenAnnounce(detail) {
  // Tile may already exist if the track arrived first; relabel either way.
  const key = `screen:${detail.streamId}`;
  const tile = state.tilesByKey.get(key);
  if (tile) {
    tile.querySelector('.tile-label').textContent = `${detail.label} — ${detail.fromName}`;
  }
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
  if (state.activeAnnotation === streamId) {
    closeAnnotate();
    return;
  }
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
  if (!state.activeAnnotation) {
    els.drawToolbar.classList.add('hidden');
    return;
  }
  const layer = state.drawLayers.get(state.activeAnnotation);
  if (layer) layer.setActive(false);
  state.activeAnnotation = null;
  els.drawToolbar.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Controls (mic/cam/share + drawing toolbar + source picker)
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
  els.sourceCancel.onclick = () => els.sourcePicker.classList.add('hidden');

  // Drawing toolbar
  els.drawToolbar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => {
      els.drawToolbar.querySelectorAll('[data-tool]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const layer = state.drawLayers.get(state.activeAnnotation);
      if (layer) layer.setTool(b.dataset.tool);
    };
  });
  els.drawColor.oninput = () => {
    const layer = state.drawLayers.get(state.activeAnnotation);
    if (layer) layer.setColor(els.drawColor.value);
  };
  els.drawSize.oninput = () => {
    const layer = state.drawLayers.get(state.activeAnnotation);
    if (layer) layer.setSize(parseInt(els.drawSize.value, 10));
  };
  els.drawClear.onclick = () => {
    const layer = state.drawLayers.get(state.activeAnnotation);
    if (layer) layer.clearAll(true);
  };
  els.drawClose.onclick = closeAnnotate;
}

async function openSourcePicker() {
  const sources = await window.huddle.getScreenSources();
  els.sourceGrid.innerHTML = '';
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
      } catch (err) {
        alert('Failed to share screen: ' + err.message);
      }
    };
    els.sourceGrid.appendChild(card);
  }
  els.sourcePicker.classList.remove('hidden');
}
