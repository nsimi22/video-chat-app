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
  // Auth: email step
  login: $('#login'),
  authEmailStep: $('#auth-email-step'),
  authOtpStep: $('#auth-otp-step'),
  authEmail: $('#auth-email'),
  authSendOtp: $('#auth-send-otp'),
  authOtp: $('#auth-otp'),
  authVerify: $('#auth-verify'),
  authBack: $('#auth-back'),
  // Profile + team picker
  profileStep: $('#profile-step'),
  profileName: $('#profile-name'),
  profileSave: $('#profile-save'),
  teamStep: $('#team-step'),
  teamMine: $('#team-mine'),
  teamCreate: $('#team-create'),
  teamGo: $('#team-go'),
  loginError: $('#login-error'),
  signOutBtn: $('#sign-out'),
  meSignout: $('#me-signout'),
  workspaceName: $('.workspace-name'),
  reconnectBanner: $('#reconnect-banner'),
  searchBtn: $('#search-btn'),
  whiteboardBtn: $('#whiteboard-btn'),
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
  btnStartCall: $('#btn-start-call'),
  btnJoinCall: $('#btn-join-call'),
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
  gifBtn: $('#gif-btn'),
  gifPicker: $('#gif-picker'),
  gifSearch: $('#gif-search'),
  gifGrid: $('#gif-grid'),
  gifClose: $('#gif-close'),
  gifAttribution: $('#gif-attribution'),
  // source picker
  sourcePicker: $('#source-picker'),
  sourceGrid: $('#source-grid'),
  sourceCancel: $('#source-cancel'),
  // Settings
  openSettings: $('#open-settings'),
  settingsModal: $('#settings-modal'),
  setJiraHost: $('#set-jira-host'),
  setJiraEmail: $('#set-jira-email'),
  setJiraToken: $('#set-jira-token'),
  setAiProvider: $('#set-ai-provider'),
  setAnthropicKey: $('#set-anthropic-key'),
  setAnthropicModel: $('#set-anthropic-model'),
  setOpenrouterKey: $('#set-openrouter-key'),
  setOpenrouterModel: $('#set-openrouter-model'),
  setGithubToken: $('#set-github-token'),
  setGiphyKey: $('#set-giphy-key'),
  settingsStatus: $('#settings-status'),
  settingsCancel: $('#settings-cancel'),
  settingsSave: $('#settings-save'),
  // Ticket
  btnJira: $('#btn-jira'),
  ticketModal: $('#ticket-modal'),
  ticketConfigNeeded: $('#ticket-config-needed'),
  ticketGoSettings: $('#ticket-go-settings'),
  ticketForm: $('#ticket-form'),
  ticketProject: $('#ticket-project'),
  ticketIssuetype: $('#ticket-issuetype'),
  ticketSummary: $('#ticket-summary'),
  ticketDescription: $('#ticket-description'),
  ticketPostToChannel: $('#ticket-post-to-channel'),
  ticketStatus: $('#ticket-status'),
  ticketCancel: $('#ticket-cancel'),
  ticketCreate: $('#ticket-create'),
};

const state = {
  huddle: null,           // HuddleClient — alive while signed into a team
  mesh: null,             // MeshClient — alive only while in a call
  inCallChannelId: null,  // channel.id of the active call, if any
  lurkingChannelId: null, // channel.id we're watching call-presence on
  chat: null,
  myName: '',
  tilesByKey: new Map(),
  drawLayers: new Map(),
  channelMeta: new Map(),
  activeAnnotation: null,
  pendingStreams: new Map(),
  unread: new Map(), // channelId -> { count, mentions } both ints
  _email: null,
  settings: {},      // user_integrations.settings; loaded post-auth
  jira: null,        // JiraClient — rebuilt whenever settings change
  ai: null,          // AiClient — rebuilt whenever settings change
  github: null,      // GitHubClient — rebuilt whenever settings change
  whiteboardSessions: new Map(), // whiteboardId -> WhiteboardSession
};

// Whether the OS window is currently focused. Used to gate desktop
// notifications + auto-clearing of unread on focus.
let windowFocused = document.hasFocus();
window.addEventListener('focus', () => { windowFocused = true; clearUnreadIfActive(); });
window.addEventListener('blur', () => { windowFocused = false; });

const STREAM_DECISION_MS = 1500;

// ---------------------------------------------------------------------------
// Boot — auth state machine: email -> OTP -> profile -> team picker -> joined
// ---------------------------------------------------------------------------

(async function boot() {
  // Wire auth UI before checking session, so events bind even on cold start.
  els.authSendOtp.addEventListener('click', stepSendOtp);
  els.authVerify.addEventListener('click', stepVerifyOtp);
  els.authBack.addEventListener('click', () => showStep('email'));
  els.authEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepSendOtp(); });
  els.authOtp.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepVerifyOtp(); });
  els.profileSave.addEventListener('click', stepSaveProfile);
  els.profileName.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepSaveProfile(); });
  els.teamGo.addEventListener('click', stepJoinTeam);
  els.teamCreate.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepJoinTeam(); });
  els.signOutBtn?.addEventListener('click', signOutFully);
  els.meSignout?.addEventListener('click', signOutFully);

  // Resume the previous session if we have one. Boot priority:
  //   no session                  -> email step
  //   session, no profile yet     -> profile step (first-time sign-up)
  //   session + profile, 0 teams  -> team picker
  //   session + profile + teams   -> auto-rejoin the last team (or the
  //                                  only team if just one), no clicks
  const session = await window.huddleApi.getActiveSession();
  if (!session?.user?.email) {
    showStep('email');
    return;
  }
  state._email = session.user.email;
  let prof = null;
  try {
    const sb = await window.huddleApi.getSupabase();
    const { data } = await sb.from('profiles').select('name, color').eq('user_id', session.user.id).maybeSingle();
    prof = data;
  } catch (err) {
    // Network / supabase blip: don't strand the user on a blank screen.
    // Fall through to the profile step; ensureProfile is an upsert so a
    // re-entry of the existing name is harmless.
    console.warn('boot: profile fetch failed', err);
  }
  if (!prof?.name) {
    showStep('profile');
    await prefillProfile();
    return;
  }
  state.myName = prof.name;
  let teams = [];
  try { teams = await window.huddleApi.listMyTeams(); } catch {}
  if (!teams.length) {
    showStep('team');
    await renderMyTeams();
    return;
  }
  const lastId = (() => { try { return localStorage.getItem('huddle.lastTeamId'); } catch { return null; } })();
  const target = teams.find((t) => t.id === lastId) || (teams.length === 1 ? teams[0] : null);
  if (target) {
    await joinTeamAndStart(target.id);
  } else {
    showStep('team');
    await renderMyTeams();
  }
})();

// --- Step navigation -----------------------------------------------------
function showStep(step) {
  els.loginError.classList.add('hidden');
  els.authEmailStep.classList.toggle('hidden', step !== 'email');
  els.authOtpStep.classList.toggle('hidden', step !== 'otp');
  els.profileStep.classList.toggle('hidden', step !== 'profile');
  els.teamStep.classList.toggle('hidden', step !== 'team');
  if (step === 'email') els.authEmail.focus();
  if (step === 'otp') els.authOtp.focus();
  if (step === 'profile') els.profileName.focus();
  if (step === 'team') els.teamCreate.focus();
}
function showError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.remove('hidden');
}

async function stepSendOtp() {
  els.loginError.classList.add('hidden');
  const email = els.authEmail.value.trim();
  if (!email) return;
  els.authSendOtp.disabled = true;
  try {
    await window.huddleApi.sendOtp(email);
    state._email = email;
    showStep('otp');
  } catch (err) {
    showError(err.message || 'Could not send code.');
  } finally { els.authSendOtp.disabled = false; }
}

async function stepVerifyOtp() {
  els.loginError.classList.add('hidden');
  const token = els.authOtp.value.trim();
  if (!token || !state._email) return;
  els.authVerify.disabled = true;
  try {
    await window.huddleApi.verifyOtp(state._email, token);
    showStep('profile');
    await prefillProfile();
  } catch (err) {
    showError("That code didn't match. Try again or send a new one.");
  } finally { els.authVerify.disabled = false; }
}

async function prefillProfile() {
  // Suggest the email's local-part as the display name on first sign-up.
  const sb = await window.huddleApi.getSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { data: prof } = await sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  els.profileName.value = prof?.name || (state._email || '').split('@')[0] || '';
}

async function stepSaveProfile() {
  els.loginError.classList.add('hidden');
  const name = els.profileName.value.trim();
  if (!name) return;
  state.myName = name;
  try {
    const color = `hsl(${Math.floor(Math.random() * 360)} 70% 55%)`;
    await window.huddleApi.ensureProfile(name, color);
    showStep('team');
    await renderMyTeams();
  } catch (err) {
    showError(err.message || 'Could not save profile.');
  }
}

async function renderMyTeams() {
  els.teamMine.replaceChildren();
  let teams;
  try { teams = await window.huddleApi.listMyTeams(); }
  catch (err) { showError('Could not load teams.'); return; }
  if (!teams.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = "You're not in any teams yet — type a name below to create one.";
    els.teamMine.appendChild(p);
    return;
  }
  for (const t of teams) {
    const li = document.createElement('button');
    li.className = 'team-pick';
    li.textContent = '# ' + t.name;
    li.onclick = () => joinTeamAndStart(t.id);
    els.teamMine.appendChild(li);
  }
}

async function stepJoinTeam() {
  els.loginError.classList.add('hidden');
  const name = els.teamCreate.value.trim();
  if (!name) return;
  try {
    const t = await window.huddleApi.joinOrCreateTeam(name);
    await joinTeamAndStart(t.id);
  } catch (err) {
    showError(err.message || 'Could not join team.');
  }
}

// Spin up the HuddleClient (chat + team presence) and reveal the app.
// Calls are now started on demand via startCall() — joining a team no
// longer auto-grabs camera/mic or constructs MeshClient.
async function joinTeamAndStart(teamId) {
  els.loginError.classList.add('hidden');
  let huddle;
  try { huddle = await window.huddleApi.startHuddle({ id: teamId, name: teamId }); }
  catch (err) { showError(err.message || 'Could not start huddle.'); return; }
  // Remember this team so the next launch resumes straight here.
  try { localStorage.setItem('huddle.lastTeamId', teamId); } catch {}

  // Per-user integration settings — drives the Jira client + Giphy key.
  // Reload after the user saves new ones in the Settings modal.
  await refreshSettings();

  // Welcome + sidebar wiring listens to HuddleClient directly. Team
  // presence drives the People sidebar's online dot via member-online/
  // -offline; WebRTC peer events come from the call channel and only
  // when the user has explicitly joined a call.
  huddle.addEventListener('welcome', (e) => onWelcome(e.detail));
  huddle.addEventListener('member-online', (e) => addPersonToSidebar(e.detail));
  huddle.addEventListener('member-offline', (e) => onMemberOffline(e.detail));
  huddle.addEventListener('chat-channel-added', (e) => onChannelAdded(e.detail.channel));
  huddle.addEventListener('chat-channel-removed', (e) => onChannelRemoved(e.detail.channelId));
  huddle.addEventListener('call-presence', (e) => onCallPresence(e.detail));

  state.huddle = huddle;
  state.mesh = null;
  state.myName = huddle.name;
  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.me.textContent = huddle.name;
  if (huddle.team?.name) els.workspaceName.textContent = huddle.team.name;

  state.chat = new ChatView({
    huddle, els,
    hooks: {
      onMessage: (m) => onChatMessage(m),
      getGiphyKey,
      getJira: () => state.jira,
      openTicketModal: (preset) => openTicketModal(preset),
      getAi: () => state.ai,
      getGitHub: () => state.github,
    },
  });
  wireControls();
  // Default to the pre-call header (Start call). startCall flips it.
  renderCallHeader();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// User clicked "Start call" or "Join call". Subscribe the call topic,
// construct MeshClient, prompt cam/mic, show the tile grid.
async function startCall(channelId) {
  if (!state.huddle || state.mesh) return; // already in a call or no team
  try {
    await state.huddle.joinCall(channelId);
  } catch (err) {
    console.warn('joinCall failed', err);
    return;
  }
  const mesh = new MeshClient(state.huddle);
  mesh.addEventListener('peer-joined', (e) => onCallPeerJoined(e.detail));
  mesh.addEventListener('peer-left', (e) => onCallPeerLeft(e.detail));
  mesh.addEventListener('track', (e) => onTrack(e.detail));
  mesh.addEventListener('screen-announce', (e) => onScreenAnnounce(e.detail));
  mesh.addEventListener('screen-stop', (e) => onScreenStop(e.detail));
  mesh.addEventListener('remote-stream-ended', (e) => onScreenStop(e.detail));
  mesh.addEventListener('draw', (e) => onRemoteDraw(e.detail));
  state.mesh = mesh;
  state.inCallChannelId = channelId;
  els.tiles.classList.remove('hidden');
  try {
    const cam = await mesh.setCamera({ video: true, audio: true });
    addLocalCameraTile(cam, state.huddle.name);
  } catch (err) {
    console.warn('No camera/mic available', err);
  }
  renderCallHeader();
}

// Drop the call (media + WebRTC peers + tile grid) but stay signed
// into the team. The HuddleClient keeps chat realtime running.
async function leaveCall() {
  if (!state.mesh) return;
  for (const session of state.whiteboardSessions.values()) session.stop();
  state.whiteboardSessions.clear();
  state.mesh.disconnect();
  state.mesh = null;
  state.inCallChannelId = null;
  for (const tile of state.tilesByKey.values()) tile.remove();
  state.tilesByKey.clear();
  state.drawLayers.clear();
  for (const p of state.pendingStreams.values()) clearTimeout(p.timer);
  state.pendingStreams.clear();
  closeAnnotate();
  els.tiles.classList.add('hidden');
  try { await state.huddle?.leaveCall(); } catch {}
  renderCallHeader();
}

function teardownTeam() {
  if (state.mesh) {
    for (const session of state.whiteboardSessions.values()) session.stop();
    state.whiteboardSessions.clear();
    state.mesh.disconnect();
    state.mesh = null;
  }
  // Detach the chat view's interval + every listener it installed before
  // dropping the reference, otherwise rejoining accumulates handlers.
  state.chat?.destroy();
  state.huddle?.stop();
  state.huddle = null;
  state.chat = null;
  state.channelMeta.clear();
  state.unread.clear();
  state.inCallChannelId = null;
  els.channels.replaceChildren();
  els.dms.replaceChildren();
  els.people.replaceChildren();
  els.reconnectBanner?.classList.add('hidden');
  for (const tile of state.tilesByKey.values()) tile.remove();
  state.tilesByKey.clear();
  state.drawLayers.clear();
  for (const p of state.pendingStreams.values()) clearTimeout(p.timer);
  state.pendingStreams.clear();
  closeAnnotate();
  els.tiles.classList.add('hidden');
  els.app.classList.add('hidden');
}

// "Leave team" — drop everything, go back to the team picker (still signed in).
async function leave() {
  teardownTeam();
  els.login.classList.remove('hidden');
  showStep('team');
  await renderMyTeams();
}

// Full sign-out: leave the team, drop the Supabase session, reset to email step.
async function signOutFully() {
  teardownTeam();
  try { await window.huddleApi.signOut(); } catch {}
  // Clear remembered team so the next signed-in user starts at the
  // team picker (and doesn't auto-resume into someone else's team).
  try { localStorage.removeItem('huddle.lastTeamId'); } catch {}
  state._email = null;
  if (els.authEmail) els.authEmail.value = '';
  if (els.authOtp) els.authOtp.value = '';
  els.login.classList.remove('hidden');
  showStep('email');
}

// Re-render the call-controls header for the active channel + mesh
// state. Three modes:
//   not in call, no one's in call here  -> Start call
//   not in call, others are in call     -> Join call · N
//   in call here                        -> Mic / Cam / Share / ... / Leave
function renderCallHeader() {
  const channelId = state.chat?.currentChannel;
  const inCallHere = state.mesh && state.inCallChannelId === channelId;
  const lurkerCount = (channelId && state.huddle && !inCallHere)
    ? (state.huddle._lurkerCounts.get(channelId) || 0) : 0;
  const others = inCallHere ? null : (lurkerCount > 0);
  els.btnStartCall.classList.toggle('hidden', !!inCallHere || !!others);
  els.btnJoinCall.classList.toggle('hidden', !!inCallHere || !others);
  if (others) {
    els.btnJoinCall.innerHTML = `📞 Join call <span class="count">${lurkerCount}</span>`;
  }
  els.btnMic.classList.toggle('hidden', !inCallHere);
  els.btnCam.classList.toggle('hidden', !inCallHere);
  els.btnShare.classList.toggle('hidden', !inCallHere);
  els.btnJira.classList.toggle('hidden', !inCallHere);
  els.btnLeave.classList.toggle('hidden', !inCallHere);
}

function onCallPeerJoined(peer) {
  // Per-call peer joined; MeshClient already opened the WebRTC
  // connection — we just need to render an empty tile they can stream
  // into. Track callbacks fill in the actual stream once it arrives.
  // (For now, MeshClient's track event creates the tile imperatively;
  // this is a no-op hook left for future "show participant before
  // their first frame" UX.)
}

function onCallPeerLeft(peerId) {
  removePersonFromCall(peerId);
}

function removePersonFromCall(peerId) {
  removeTile(`peer:${peerId}`);
  // Drop any screen tiles owned by this peer too.
  for (const [key, tile] of state.tilesByKey.entries()) {
    if (key.startsWith('screen:') && tile.dataset.fromId === peerId) {
      removeTile(key);
    }
  }
}

function onMemberOffline(peerId) {
  // Sidebar dot only — call grid is driven by call presence.
  const li = els.people.querySelector(`[data-id="${cssEscape(peerId)}"]`);
  if (li) li.remove();
}

function onCallPresence({ channelId, count }) {
  if (state.chat?.currentChannel === channelId) renderCallHeader();
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
      state.huddle.deleteChannel(channel.id);
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
  // Swap call-presence lurker subscriptions so the header reflects
  // whether someone's already in this channel's call. We unsubscribe
  // the previously-watched channel to avoid an unbounded fan-out; the
  // active call (if any) keeps its own non-lurker subscription.
  const prev = state.lurkingChannelId;
  if (prev && prev !== channelId && prev !== state.inCallChannelId) {
    state.huddle?.unwatchCallPresence(prev);
  }
  if (state.huddle && channelId !== state.inCallChannelId) {
    state.lurkingChannelId = channelId;
    state.huddle.watchCallPresence(channelId).catch(() => {});
  } else {
    state.lurkingChannelId = null;
  }
  renderCallHeader();
  // Visiting a channel clears its unread.
  state.unread.delete(channelId);
  updateUnreadBadge(channelId);
}

// On window focus, clear unread for the channel we're already viewing.
function clearUnreadIfActive() {
  if (!state.chat || !state.huddle) return;
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
  if (!state.huddle) return;
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
  appendChannelToSidebar(channel, false);
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
  // createdBy is a user uuid; compare against the authenticated user's id,
  // not the display name.
  return channel.createdBy && channel.createdBy === state.huddle?.peerId;
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
  li.onclick = async () => {
    if (peer.name === state.myName) return;
    try {
      const channel = await state.huddle.createDm(peer.name);
      onChannelAdded(channel);
      focusChannel(channel.id);
    } catch (err) { console.warn('createDm failed', err); }
  };
  li.title = peer.name === state.myName ? 'You' : `Direct message ${peer.name}`;
  els.people.appendChild(li);
}

// (onMemberOffline + onCallPeerLeft above replace the old onPeerLeft —
// team presence and call presence are now distinct event sources.)

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function makeTile({ key, label, kind }) {
  let tile = state.tilesByKey.get(key);
  if (tile) return tile;
  tile = document.createElement('div');
  // 'screen' tiles span two grid columns. Whiteboards reuse the same
  // generous footprint without the screen-specific overlay logic.
  const sizeClass = (kind === 'screen' || kind === 'whiteboard') ? ' screen' : '';
  tile.className = `tile${sizeClass}` + (kind === 'whiteboard' ? ' whiteboard' : '');
  tile.dataset.key = key;
  tile.dataset.kind = kind || '';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (kind === 'self') video.muted = true;
  tile.appendChild(video);
  const lbl = document.createElement('div');
  lbl.className = 'tile-label';
  lbl.textContent = label;
  tile.appendChild(lbl);
  if (kind === 'screen' || kind === 'whiteboard') {
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    if (kind === 'screen') {
      const annotate = document.createElement('button');
      annotate.textContent = '✏️ Annotate';
      annotate.onclick = () => toggleAnnotate(tile.dataset.streamId);
      actions.appendChild(annotate);
    }
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
  const peer = state.huddle.peerInfo.get(pending.fromId);
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
    send: (stroke) => state.huddle.sendDraw(streamId, stroke),
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
  // Drawable surfaces live under either `screen:<id>` (shared screens) or
  // `whiteboard:<id>` (collaborative canvases) — look both up.
  const tile = state.tilesByKey.get(`screen:${streamId}`)
    || state.tilesByKey.get(`whiteboard:${streamId}`);
  els.drawToolbar.classList.remove('hidden');
  els.drawTargetName.textContent = tile?.querySelector('.tile-label')?.textContent || 'screen';
}

// Make the toolbar/active-annotation state target `streamId`, but never
// toggle off if it's already focused. Used by openWhiteboard so a re-click
// on 🎨 doesn't deactivate an already-open whiteboard.
function focusAnnotation(streamId) {
  if (state.activeAnnotation === streamId) return;
  toggleAnnotate(streamId);
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
  // Pre-call entry: starts (or joins) a call in the active channel.
  els.btnStartCall.onclick = () => {
    const ch = state.chat?.currentChannel;
    if (ch) startCall(ch);
  };
  els.btnJoinCall.onclick = () => {
    const ch = state.chat?.currentChannel;
    if (ch) startCall(ch);
  };
  els.btnMic.onclick = () => {
    if (!state.mesh) return;
    const on = state.mesh.toggleMic();
    els.btnMic.textContent = on ? '🎤' : '🔇';
    const tile = state.tilesByKey.get('self-cam');
    if (tile) tile.classList.toggle('muted', !on);
  };
  els.btnCam.onclick = () => {
    if (!state.mesh) return;
    const on = state.mesh.toggleCam();
    els.btnCam.textContent = on ? '📷' : '📵';
  };
  els.btnShare.onclick = openSourcePicker;
  // Leave the call (drop media + tile grid, keep chat). Held-down "Leave
  // team" is in the sidebar's sign-out menu.
  els.btnLeave.onclick = leaveCall;
  els.sourceCancel.onclick = () => els.sourcePicker.classList.add('hidden');

  // Settings
  els.openSettings.onclick = openSettings;
  els.settingsCancel.onclick = () => els.settingsModal.classList.add('hidden');
  els.settingsSave.onclick = saveSettings;

  // Jira create-ticket modal
  els.btnJira.onclick = () => openTicketModal();
  els.ticketCancel.onclick = () => els.ticketModal.classList.add('hidden');
  els.ticketCreate.onclick = submitTicket;
  els.ticketGoSettings.onclick = (e) => {
    e.preventDefault();
    els.ticketModal.classList.add('hidden');
    openSettings();
  };

  // Whiteboard (🎨)
  els.whiteboardBtn.onclick = openWhiteboard;

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
  els.drawClear.onclick = () => {
    // Whiteboards have a separate clear path that also wipes persistent
    // strokes; screen annotations only clear the local overlay + broadcast.
    const session = state.whiteboardSessions.get(state.activeAnnotation);
    if (session) {
      if (confirm('Clear the whiteboard for everyone? This cannot be undone.')) session.clear();
      return;
    }
    state.drawLayers.get(state.activeAnnotation)?.clearAll(true);
  };
  els.drawClose.onclick = () => {
    if (state.whiteboardSessions.has(state.activeAnnotation)) {
      closeWhiteboard(state.activeAnnotation);
    } else {
      closeAnnotate();
    }
  };
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

async function submitCreateChannel() {
  const name = els.ccName.value.trim();
  if (!name) return;
  const isPrivate = els.ccPrivate.checked;
  const memberNames = isPrivate
    ? [...els.ccMembers.querySelectorAll('.row.selected')].map((r) => r.dataset.name)
    : undefined;
  els.ccModal.classList.add('hidden');
  try {
    const channel = await state.huddle.createChannel({ name, topic: els.ccTopic.value, isPrivate, memberNames });
    onChannelAdded(channel);
    focusChannel(channel.id);
  } catch (err) {
    alert('Could not create channel: ' + (err.message || err));
  }
}

// Render a multi-select list of online peers (excluding self) for member invitation.
function renderMemberPicker(container) {
  container.replaceChildren();
  const peers = [...state.huddle.peerInfo.values()].filter((p) => p.name !== state.myName);
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
  const peers = [...state.huddle.peerInfo.values()].filter((p) => p.name !== state.myName);
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
      row.onclick = async () => {
        els.dmPicker.classList.add('hidden');
        try {
          const channel = await state.huddle.createDm(p.name);
          onChannelAdded(channel);
          focusChannel(channel.id);
        } catch (err) { console.warn('createDm failed', err); }
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

async function runSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;
  const channelId = els.searchScopeCurrent.checked ? state.chat.currentChannel : undefined;
  els.searchResults.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty';
  loading.textContent = 'Searching…';
  els.searchResults.appendChild(loading);
  try {
    const results = await state.huddle.searchMessages(q, channelId);
    renderSearchResults({ query: q, results });
  } catch (err) {
    renderSearchResults({ query: q, results: [] });
  }
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

// ---------------------------------------------------------------------------
// Whiteboard (one collaborative canvas per channel, persisted to Postgres)
// ---------------------------------------------------------------------------

async function openWhiteboard() {
  if (!state.huddle || !state.chat) return;
  const channelId = state.chat.currentChannel;
  const channel = state.channelMeta.get(channelId);
  let wb;
  try { wb = await state.huddle.getOrCreateWhiteboard(channelId); }
  catch (err) { alert('Could not open whiteboard: ' + (err.message || err)); return; }

  // If already open as a tile, just refocus it (don't toggle off).
  const key = `whiteboard:${wb.id}`;
  if (state.tilesByKey.has(key)) {
    focusAnnotation(wb.id);
    return;
  }

  const tile = makeTile({
    key,
    label: `Whiteboard — ${channel ? displayLabelFor(channel) : '#' + channelId}`,
    kind: 'whiteboard',
  });
  tile.dataset.streamId = wb.id;

  const session = new window.WhiteboardSession({
    huddle: state.huddle, channelId, whiteboard: wb, tile,
  });
  state.whiteboardSessions.set(wb.id, session);
  try { await session.start(); }
  catch (err) {
    console.warn('whiteboard start failed', err);
    closeWhiteboard(wb.id);
    return;
  }
  // Register the layer so the existing draw toolbar (color, size, tool)
  // controls the whiteboard the same way it controls a screen annotation.
  state.drawLayers.set(wb.id, session.layer);

  // Tile actions: just close (the toolbar's Clear button covers clearing).
  const actions = tile.querySelector('.tile-actions');
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close';
  closeBtn.onclick = () => closeWhiteboard(wb.id);
  actions.appendChild(closeBtn);

  // Drawing is always active on a whiteboard; reuse the screen-annotation
  // toolbar so pen/arrow/eraser/color/size all work.
  toggleAnnotate(wb.id);
}

function closeWhiteboard(whiteboardId) {
  const session = state.whiteboardSessions.get(whiteboardId);
  if (session) session.stop();
  state.whiteboardSessions.delete(whiteboardId);
  state.drawLayers.delete(whiteboardId);
  state.tilesByKey.delete(`whiteboard:${whiteboardId}`);
  if (state.activeAnnotation === whiteboardId) {
    state.activeAnnotation = null;
    els.drawToolbar.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Settings (per-user integration credentials)
// ---------------------------------------------------------------------------

async function refreshSettings() {
  try { state.settings = await window.huddleApi.loadSettings(); }
  catch (err) { console.warn('settings load failed', err); state.settings = {}; }
  rebuildJiraClient();
  rebuildAiClient();
  rebuildGitHubClient();
}

function rebuildJiraClient() {
  const j = state.settings?.jira || {};
  state.jira = new window.JiraClient(j);
  const enabled = state.jira.isConfigured();
  els.btnJira?.classList.toggle('disabled', !enabled);
}

function rebuildAiClient() {
  const a = state.settings?.ai || {};
  const provider = a.provider || 'anthropic';
  const defaultModel = provider === 'anthropic' ? (a.anthropicModel || '') : (a.openrouterModel || '');
  state.ai = new window.AiClient({
    provider,
    anthropicKey: a.anthropicKey || '',
    openrouterKey: a.openrouterKey || '',
    defaultModel,
  });
}

function rebuildGitHubClient() {
  const g = state.settings?.github || {};
  state.github = new window.GitHubClient({ token: g.token || '' });
}

function openSettings() {
  const s = state.settings || {};
  els.setJiraHost.value = s.jira?.host || '';
  els.setJiraEmail.value = s.jira?.email || '';
  els.setJiraToken.value = s.jira?.token || '';
  els.setAiProvider.value = s.ai?.provider || 'anthropic';
  els.setAnthropicKey.value = s.ai?.anthropicKey || '';
  els.setAnthropicModel.value = s.ai?.anthropicModel || '';
  els.setOpenrouterKey.value = s.ai?.openrouterKey || '';
  els.setOpenrouterModel.value = s.ai?.openrouterModel || '';
  els.setGithubToken.value = s.github?.token || '';
  els.setGiphyKey.value = s.giphy?.key || '';
  els.settingsStatus.classList.add('hidden');
  els.settingsModal.classList.remove('hidden');
  els.setJiraHost.focus();
}

async function saveSettings() {
  const next = {
    ...state.settings,
    jira: {
      host: els.setJiraHost.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      email: els.setJiraEmail.value.trim(),
      token: els.setJiraToken.value,
    },
    ai: {
      provider: els.setAiProvider.value,
      anthropicKey: els.setAnthropicKey.value,
      anthropicModel: els.setAnthropicModel.value.trim(),
      openrouterKey: els.setOpenrouterKey.value,
      openrouterModel: els.setOpenrouterModel.value.trim(),
    },
    github: { token: els.setGithubToken.value },
    giphy: { key: els.setGiphyKey.value.trim() },
  };
  try {
    await window.huddleApi.saveSettings(next);
    state.settings = next;
    rebuildJiraClient();
    rebuildAiClient();
    rebuildGitHubClient();
    els.settingsStatus.textContent = 'Saved.';
    els.settingsStatus.className = 'settings-status success';
    setTimeout(() => els.settingsModal.classList.add('hidden'), 600);
  } catch (err) {
    els.settingsStatus.textContent = 'Could not save: ' + (err.message || err);
    els.settingsStatus.className = 'settings-status error';
  }
}

// Giphy key resolver — sourced exclusively from per-user Settings.
async function getGiphyKey() {
  return state.settings?.giphy?.key || '';
}

// ---------------------------------------------------------------------------
// Jira: create-ticket modal
// ---------------------------------------------------------------------------

async function openTicketModal({ summary = '', description = '' } = {}) {
  els.ticketStatus.classList.add('hidden');
  if (!state.jira?.isConfigured()) {
    els.ticketConfigNeeded.classList.remove('hidden');
    els.ticketForm.classList.add('hidden');
    els.ticketCreate.disabled = true;
    els.ticketModal.classList.remove('hidden');
    return;
  }
  els.ticketConfigNeeded.classList.add('hidden');
  els.ticketForm.classList.remove('hidden');
  els.ticketCreate.disabled = false;

  const channel = state.channelMeta.get(state.chat?.currentChannel);
  els.ticketSummary.value = summary;
  els.ticketDescription.value = description
    || (channel ? `From a discussion in #${channel.name}.\n\n` : '');
  els.ticketModal.classList.remove('hidden');
  els.ticketSummary.focus();

  // Lazy-load projects + issue types.
  els.ticketProject.replaceChildren(new Option('Loading…', ''));
  els.ticketIssuetype.replaceChildren(new Option('Loading…', ''));
  try {
    const projects = await state.jira.listProjects();
    els.ticketProject.replaceChildren();
    for (const p of projects) {
      const opt = new Option(`${p.key} — ${p.name}`, p.key);
      els.ticketProject.add(opt);
    }
    els.ticketProject.onchange = () => loadIssueTypes(els.ticketProject.value);
    if (projects.length) await loadIssueTypes(projects[0].key);
  } catch (err) {
    showTicketStatus('Could not load projects: ' + err.message, 'error');
    els.ticketCreate.disabled = true;
  }
}

async function loadIssueTypes(projectKey) {
  if (!projectKey) return;
  els.ticketIssuetype.replaceChildren(new Option('Loading…', ''));
  try {
    const types = await state.jira.listIssueTypes(projectKey);
    const usable = types.filter((t) => !t.subtask);
    els.ticketIssuetype.replaceChildren();
    for (const t of usable) els.ticketIssuetype.add(new Option(t.name, t.name));
    // Default to "Task" if present.
    const defaultType = [...els.ticketIssuetype.options].find((o) => o.value === 'Task');
    if (defaultType) els.ticketIssuetype.value = 'Task';
  } catch (err) {
    showTicketStatus('Could not load issue types: ' + err.message, 'error');
  }
}

async function submitTicket() {
  const projectKey = els.ticketProject.value;
  const issueType = els.ticketIssuetype.value;
  const summary = els.ticketSummary.value.trim();
  const description = els.ticketDescription.value.trim();
  if (!projectKey || !summary) {
    showTicketStatus('Project and summary are required.', 'error');
    return;
  }
  els.ticketCreate.disabled = true;
  showTicketStatus('Creating…', 'success');
  try {
    const issue = await state.jira.createIssue({ projectKey, summary, description, issueType });
    const url = state.jira.issueUrl(issue.key);
    showTicketStatus(`Created ${issue.key}.`, 'success');
    if (els.ticketPostToChannel.checked && state.chat) {
      // Posting the URL triggers the auto-unfurl on every viewer.
      state.huddle.sendMessage({
        channelId: state.chat.currentChannel,
        parentId: state.chat.threadParentId,
        text: `Created Jira ticket: ${url}`,
        attachments: [],
      });
    }
    setTimeout(() => els.ticketModal.classList.add('hidden'), 700);
  } catch (err) {
    showTicketStatus('Failed: ' + (err.message || err), 'error');
  } finally {
    els.ticketCreate.disabled = false;
  }
}

function showTicketStatus(msg, kind) {
  els.ticketStatus.textContent = msg;
  els.ticketStatus.className = 'settings-status ' + kind;
  els.ticketStatus.classList.remove('hidden');
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
