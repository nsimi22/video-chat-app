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
  bootStep: $('#boot-step'),
  authEmailStep: $('#auth-email-step'),
  authOtpStep: $('#auth-otp-step'),
  authEmail: $('#auth-email'),
  authSendOtp: $('#auth-send-otp'),
  authShowPassword: $('#auth-show-password'),
  authPasswordBlock: $('#auth-password-block'),
  authPassword: $('#auth-password'),
  authPasswordSignin: $('#auth-password-signin'),
  authPasswordSignup: $('#auth-password-signup'),
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
  teamJoinLink: $('#team-join-link'),
  teamJoinLinkGo: $('#team-join-link-go'),
  copyTeamLink: $('#copy-team-link'),
  copyCallLink: $('#copy-call-link'),
  toasts: $('#toasts'),
  loginError: $('#login-error'),
  signOutBtn: $('#sign-out'),
  meSignout: $('#me-signout'),
  workspaceName: $('.workspace-name'),
  reconnectBanner: $('#reconnect-banner'),
  searchBtn: $('#search-btn'),
  whiteboardBtn: $('#whiteboard-btn'),
  muteChannelBtn: $('#mute-channel-btn'),
  notifyAllBtn: $('#notify-all-btn'),
  searchModal: $('#search-modal'),
  shortcutsModal: $('#shortcuts-modal'),
  shortcutsClose: $('#shortcuts-close'),
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
  markAllRead: $('#mark-all-read'),
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
  dmPickerTitle: $('#dm-picker-title'),
  dmPickerHint: $('#dm-picker-hint'),
  dmPeople: $('#dm-people'),
  dmStart: $('#dm-start'),
  dmCancel: $('#dm-cancel'),
  people: $('#people'),
  channelName: $('#channel-name'),
  channelTopic: $('#channel-topic'),
  me: $('#me'),
  tiles: $('#tiles'),
  sidebarToggle: $('#sidebar-toggle'),
  btnStartCall: $('#btn-start-call'),
  btnJoinCall: $('#btn-join-call'),
  btnMic: $('#btn-mic'),
  btnCam: $('#btn-cam'),
  btnShare: $('#btn-share'),
  btnLeave: $('#btn-leave'),
  btnPopoutCall: $('#btn-popout-call'),
  btnHand: $('#btn-hand'),
  btnReact: $('#btn-react'),
  reactPopover: $('#react-popover'),
  pinnedBtn: $('#pinned-btn'),
  pinnedCount: $('#pinned-count'),
  pinnedDrawer: $('#pinned-drawer'),
  pinnedList: $('#pinned-list'),
  pinnedClose: $('#pinned-close'),
  imageLightbox: $('#image-lightbox'),
  imageLightboxImg: $('#image-lightbox-img'),
  openSaved: $('#open-saved'),
  savedCount: $('#saved-count'),
  savedDrawer: $('#saved-drawer'),
  savedClose: $('#saved-close'),
  savedLabels: $('#saved-labels'),
  savedList: $('#saved-list'),
  savePopover: $('#save-popover'),
  savePopoverLabels: $('#save-popover-labels'),
  savePopoverNew: $('#save-popover-new'),
  savePopoverAdd: $('#save-popover-add'),
  savePopoverUnsave: $('#save-popover-unsave'),
  savePopoverDone: $('#save-popover-done'),
  btnCc: $('#btn-cc'),
  captions: $('#captions'),
  captionsList: $('#captions-list'),
  captionsClose: $('#captions-close'),
  drawToolbar: $('#draw-toolbar'),
  drawTargetName: $('#draw-target-name'),
  drawColor: $('#draw-color'),
  drawSize: $('#draw-size'),
  drawClear: $('#draw-clear'),
  drawClose: $('#draw-close'),
  drawAddNote: $('#draw-add-note'),
  drawZoomIn: $('#draw-zoom-in'),
  drawZoomOut: $('#draw-zoom-out'),
  drawZoomReset: $('#draw-zoom-reset'),
  // chat
  // Canonical channel-name label is now in the stage header. The old
  // #chat-channel-name was removed when stage and chat merged into a
  // single column; ChatView.setChannel still writes to chatChannelName,
  // so we alias it to the same DOM node.
  chatChannelName: $('#channel-name'),
  threadBack: $('#chat-thread-back'),
  messages: $('#messages'),
  typing: $('#typing-indicator'),
  composer: $('#composer-input'),
  slashSuggest: $('#slash-suggest'),
  mentionSuggest: $('#mention-suggest'),
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
  setJiraProject: $('#set-jira-project'),
  setAiProvider: $('#set-ai-provider'),
  setAnthropicKey: $('#set-anthropic-key'),
  setAnthropicModel: $('#set-anthropic-model'),
  setOpenrouterKey: $('#set-openrouter-key'),
  setOpenrouterModel: $('#set-openrouter-model'),
  setAiTicketContext: $('#set-ai-ticket-context'),
  setAiTicketRepo: $('#set-ai-ticket-repo'),
  setGithubToken: $('#set-github-token'),
  setGiphyKey: $('#set-giphy-key'),
  settingsStatus: $('#settings-status'),
  settingsCancel: $('#settings-cancel'),
  settingsSave: $('#settings-save'),
  settingsProfileAnchor: $('#settings-profile-anchor'),
  setNewPassword: $('#set-new-password'),
  setNewPasswordConfirm: $('#set-new-password-confirm'),
  setPasswordStatus: $('#set-password-status'),
  setPasswordUpdate: $('#set-password-update'),
  setProfileName: $('#set-profile-name'),
  setProfileBio: $('#set-profile-bio'),
  setAvatarFile: $('#set-avatar-file'),
  setAvatarPreview: $('#set-avatar-preview'),
  setAvatarFallback: $('#set-avatar-fallback'),
  setAvatarClear: $('#set-avatar-clear'),
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
  callStarting: false,    // re-entrancy guard for startCall()
  lurkingChannelId: null, // channel.id we're watching call-presence on
  callCounts: new Map(),  // channel.id -> last known call-participant count (for "call started" detection)
  chat: null,
  myName: '',
  tilesByKey: new Map(),
  drawLayers: new Map(),
  channelMeta: new Map(),
  activeAnnotation: null,
  spotlightKey: null,
  // Active speaker = the peerId whose audio level is highest right now,
  // sampled by an interval poll. null when no one is audibly speaking.
  speakingPeer: null,
  speakerPollTimer: null,
  // Outstanding setTimeout ids for floating reactions, keyed by tile so
  // back-to-back reactions on the same tile can clear the prior timer
  // and not leak stale DOM.
  reactionTimers: new Map(),
  // Local hand-raised state (mirrored from huddle.raisedHands when remote
  // peers toggle, written here when the local user toggles).
  raisedHands: new Set(),
  // Teardown for the React popover's document-level listeners. Cleared on
  // teardownTeam so re-joining a team doesn't accumulate handlers.
  reactPopoverCleanup: null,
  // Same pattern for the Escape-to-close handler shared by the pinned
  // drawer + image lightbox; wireControls re-runs across team switches.
  overlayKeyCleanup: null,
  // Cleanup for the save popover's outside-click handler, captured
  // from wireControls — torn down on teardownTeam.
  savePopoverDocCleanup: null,
  // Personal saved-messages cache: messageId -> save row. Populated on
  // welcome and kept in sync by the saved-message-* realtime events
  // dispatched from HuddleClient. Drives the bookmark indicator on
  // message rows and the count badge on the sidebar Saved entry.
  savedById: new Map(),
  // Currently-active label chip in the saved drawer, or null for "All".
  savedActiveLabel: null,
  // Active save-popover target (messageId being edited) — used by the
  // popover input handlers to know which row to mutate.
  savePopoverTarget: null,
  pendingStreams: new Map(),
  unread: new Map(), // channelId -> { count, mentions } both ints
  _email: null,
  settings: {},      // user_integrations.settings; loaded post-auth
  jira: null,        // JiraClient — rebuilt whenever settings change
  ai: null,          // AiClient — rebuilt whenever settings change
  github: null,      // GitHubClient — rebuilt whenever settings change
  whiteboardSessions: new Map(), // whiteboardId -> WhiteboardSession
  // Invite-link redemption hop. When stepJoinViaLink redeems a link
  // that includes a channel/call, we stash the target here; onWelcome
  // (which fires after the team subscription is up) consumes it.
  pendingInviteHop: null,
  // huddle:// URL received before the workspace UI was reachable
  // (e.g. cold-start click while signed-out). Drained when
  // showStep('team') runs, OR when joinTeamAndStart completes.
  pendingProtocolUrl: null,
  // Channel ids whose call has been moved to a popout window and
  // is currently owned by that popout. While a channel is in
  // here, renderCallHeader hides Join/Start so the user can't
  // rejoin in the main window and become a duplicate participant.
  // Cleared when the corresponding popout-closed event arrives.
  poppedOutCalls: new Set(),
  // Live captions / post-call summary. cc.manager wraps Web Speech;
  // cc.lines is the rolling buffer of every final segment we've
  // captured locally OR received from another peer for the current
  // call, used both to render the panel and to feed the post-call
  // AI summary. cc.unsub disposes the mesh transcript-line listener
  // when captions are switched off or the call ends.
  cc: {
    manager: null,
    on: false,
    lines: [],            // [{ from, fromName, text, ts }]
    unsub: null,
    lastInterim: '',      // local interim, redrawn over the panel tail
    forChannelId: null,   // channel the buffer belongs to (for summary post)
    _finalizing: false,   // guards finalizeCallTranscript against re-entry
  },
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
  // Detect popout mode FIRST. A popout child window loads the same
  // index.html with `?popout=<target>&team=<id>&channel=<id>` so the
  // renderer can short-circuit the login + workspace UI and render
  // a focused view (whiteboard or call). The session is reused via
  // Supabase's persisted-session storage; the popout doesn't ask
  // for credentials again.
  const popoutCfg = parsePopoutQuery(location.search);
  if (popoutCfg) {
    document.body.classList.add('popout');
    bootPopout(popoutCfg).catch((err) => {
      console.error('popout boot failed', err);
      alert('Popout failed to load: ' + (err?.message || err));
    });
    return;
  }

  // Main-window-only: listen for popout-closed events so the call
  // header re-renders when a popped-out call ends (popout window
  // closed via Leave or the system × button). Without this, the
  // channel stays in state.poppedOutCalls forever and the user
  // can't Start call again from main.
  window.huddle.onPopoutEvent?.((msg) => {
    if (msg?.event !== 'popout-closed') return;
    const target = String(msg.target || '');
    if (!target.startsWith('call:')) return;
    const channelId = target.slice('call:'.length);
    if (state.poppedOutCalls.delete(channelId)) renderCallHeader();
  });

  // huddle:// protocol URLs. The OS hands us deep links when the
  // user clicks an invite-link in chat / browser / email; main.js
  // forwards them via IPC. Route through the existing invite-
  // redeem path. Buffer until the workspace UI is reachable so a
  // cold-start link sent before sign-in still completes after
  // the user authenticates.
  window.huddle.onProtocolUrl?.((url) => handleProtocolUrl(url));

  // Global keyboard shortcuts. Cmd/Ctrl + / toggles the cheat
  // sheet; Esc closes it (for parity with the other modals'
  // dismiss conventions). Skipped while the workspace UI is
  // hidden so the shortcut doesn't fire over the login / team
  // picker screens.
  document.addEventListener('keydown', (e) => {
    if (els.app.classList.contains('hidden')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      els.shortcutsModal.classList.toggle('hidden');
      return;
    }
    // Cmd/Ctrl + Z while a whiteboard is the active annotation
    // surface pops the user's most-recent stroke. Skipped when
    // focus is in a textarea / input so the platform's normal
    // text-undo still works in the composer.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return;
      const session = state.whiteboardSessions?.get(state.activeAnnotation);
      if (session) {
        e.preventDefault();
        session.undo().catch((err) => console.warn('whiteboard undo failed', err));
        return;
      }
    }
    if (e.key === 'Escape' && !els.shortcutsModal.classList.contains('hidden')) {
      els.shortcutsModal.classList.add('hidden');
    }
  });
  els.shortcutsClose.onclick = () => els.shortcutsModal.classList.add('hidden');

  // Render the static Settings → Slash commands explainer from
  // chat.js's SLASH_COMMANDS catalog so the composer autocomplete
  // and this list stay in lockstep. Runs once at boot — settings is
  // hidden initially, so building it now is free.
  renderSlashList();

  // Wire auth UI before checking session, so events bind even on cold start.
  els.authSendOtp.addEventListener('click', stepSendOtp);
  els.authVerify.addEventListener('click', stepVerifyOtp);
  els.authBack.addEventListener('click', () => showStep('email'));
  els.authEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepSendOtp(); });
  els.authOtp.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepVerifyOtp(); });
  // Password sign-in: hidden behind a toggle so the emailed-code path
  // stays the default. The Enter key in the password field signs in.
  els.authShowPassword.addEventListener('click', () => {
    els.authPasswordBlock.classList.remove('hidden');
    els.authShowPassword.classList.add('hidden');
    els.authPassword.focus();
  });
  els.authPasswordSignin.addEventListener('click', stepPasswordSignIn);
  els.authPasswordSignup.addEventListener('click', stepPasswordSignUp);
  els.authPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepPasswordSignIn(); });
  els.profileSave.addEventListener('click', stepSaveProfile);
  els.profileName.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepSaveProfile(); });
  els.teamGo.addEventListener('click', stepJoinTeam);
  els.teamCreate.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepJoinTeam(); });
  els.teamJoinLinkGo.addEventListener('click', stepJoinViaLink);
  els.teamJoinLink.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepJoinViaLink(); });
  els.signOutBtn?.addEventListener('click', signOutFully);
  els.meSignout?.addEventListener('click', signOutFully);

  // Resume the previous session if we have one. Boot priority:
  //   no session                  -> email step
  //   session, no profile yet     -> profile step (first-time sign-up)
  //   session + profile, 0 teams  -> team picker
  //   session + profile + teams   -> auto-rejoin the last team (or the
  //                                  only team if just one), no clicks
  //
  // getActiveSession can throw on a cold-start network blip or a
  // misconfigured Supabase URL. Without a try/catch the boot
  // loader (default-visible step) sticks forever — the user sees a
  // spinning circle with no way out. Fall through to the email
  // step on any failure; sign-in still works once the network
  // recovers.
  let session = null;
  try {
    session = await window.huddleApi.getActiveSession();
  } catch (err) {
    console.warn('boot: getActiveSession failed', err);
  }
  if (!session?.user?.email) {
    showStep('email');
    return;
  }
  state._email = session.user.email;
  await routePostAuth(session.user.id);
})();

// Shared post-authentication routing. Used by the boot resume path
// AND by the OTP / password sign-in handlers — without this, returning
// users were sent through the profile step every login even though
// their name was already saved. Sign-up still routes to the profile
// step directly since a brand-new account has no profile row.
async function routePostAuth(userId) {
  let prof = null;
  try {
    const sb = await window.huddleApi.getSupabase();
    const { data } = await sb.from('profiles').select('name, color').eq('user_id', userId).maybeSingle();
    prof = data;
  } catch (err) {
    // Network / supabase blip: don't strand the user on a blank screen.
    // Fall through to the profile step; ensureProfile is an upsert so a
    // re-entry of the existing name is harmless.
    console.warn('routePostAuth: profile fetch failed', err);
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
}

// --- Step navigation -----------------------------------------------------
function showStep(step) {
  els.loginError.classList.add('hidden');
  els.bootStep.classList.toggle('hidden', step !== 'boot');
  els.authEmailStep.classList.toggle('hidden', step !== 'email');
  els.authOtpStep.classList.toggle('hidden', step !== 'otp');
  els.profileStep.classList.toggle('hidden', step !== 'profile');
  els.teamStep.classList.toggle('hidden', step !== 'team');
  if (step === 'email') els.authEmail.focus();
  if (step === 'otp') els.authOtp.focus();
  if (step === 'profile') els.profileName.focus();
  if (step === 'team') {
    els.teamCreate.focus();
    // Drain any buffered huddle:// URL — cold-start clicks land
    // here once the user has signed in but doesn't have a default
    // team. Auto-fills the join-link input + submits.
    if (state.pendingProtocolUrl) {
      const url = state.pendingProtocolUrl;
      state.pendingProtocolUrl = null;
      els.teamJoinLink.value = url;
      stepJoinViaLink();
    }
  }
}
function showError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.remove('hidden');
}

// Surface in-app failures (call start, media access) where the
// renderer is already past the auth/login screen — the loginError
// element isn't visible there. Use alert for now: it's intrusive but
// guaranteed to be seen, which is the right tradeoff for "your call
// didn't start" or "the OS denied camera access". Replace with a
// proper toast/banner later if it becomes annoying.
function showCallError(msg) {
  alert(msg);
}

// ---------------------------------------------------------------------------
// Per-channel mute. Muted channels skip desktop notifications and
// don't bump the loud unread title — they still bump the muted
// (gray) sidebar badge so the user can see something happened
// without being interrupted. Persisted in localStorage so the
// preference survives reloads; team-scoped key prevents bleed
// across workspaces (same shape as the draft key).
// ---------------------------------------------------------------------------
function muteKey(channelId) {
  const teamId = state.huddle?.team?.id || 'unknown';
  return `huddle.muted.${teamId}.${channelId}`;
}
function isChannelMuted(channelId) {
  if (!channelId) return false;
  try { return localStorage.getItem(muteKey(channelId)) === '1'; }
  catch { return false; }
}
function setChannelMuted(channelId, muted) {
  if (!channelId) return;
  try {
    if (muted) localStorage.setItem(muteKey(channelId), '1');
    else localStorage.removeItem(muteKey(channelId));
  } catch {}
}
function toggleCurrentChannelMute() {
  const channelId = state.chat?.currentChannel;
  if (!channelId) return;
  const next = !isChannelMuted(channelId);
  setChannelMuted(channelId, next);
  // "Notify on nothing" and "notify on everything" can't both be on —
  // muting wins, so clear the notify-all flag here.
  if (next) setChannelNotifyAll(channelId, false);
  refreshMuteButton();
  refreshNotifyAllButton();
  // Re-render the sidebar row so the muted indicator updates.
  const sel = `[data-id="${cssEscape(channelId)}"]`;
  const li = els.channels.querySelector(sel) || els.dms.querySelector(sel);
  if (li) {
    li.classList.toggle('muted', next);
    if (next) li.classList.remove('notify-all');
  }
  // Existing unread for a now-muted channel stays — we just stop
  // bumping the loud title when fresh activity arrives.
  updateUnreadBadge(channelId);
  updateUnreadTitle();
  showToast(next ? 'Channel muted' : 'Channel unmuted');
}
function refreshMuteButton() {
  const channelId = state.chat?.currentChannel;
  // Hide the button entirely until a channel is focused — clicking
  // it without a channel is a no-op (toggleCurrentChannelMute
  // early-returns) and a functional-looking-but-dead button reads
  // as broken UX.
  els.muteChannelBtn.classList.toggle('hidden', !channelId);
  if (!channelId) return;
  const muted = isChannelMuted(channelId);
  els.muteChannelBtn.classList.toggle('muted', muted);
  els.muteChannelBtn.title = muted
    ? 'Unmute notifications for this channel'
    : 'Mute notifications for this channel';
}

// Per-channel "notify on every message" — the opposite end of the mute
// toggle. Same team-scoped localStorage shape; mutually exclusive with
// mute (each toggle clears the other when turned on).
function notifyAllKey(channelId) {
  const teamId = state.huddle?.team?.id || 'unknown';
  return `huddle.notifyall.${teamId}.${channelId}`;
}
function isChannelNotifyAll(channelId) {
  if (!channelId) return false;
  try { return localStorage.getItem(notifyAllKey(channelId)) === '1'; }
  catch { return false; }
}
function setChannelNotifyAll(channelId, on) {
  if (!channelId) return;
  try {
    if (on) localStorage.setItem(notifyAllKey(channelId), '1');
    else localStorage.removeItem(notifyAllKey(channelId));
  } catch {}
}
function toggleCurrentChannelNotifyAll() {
  const channelId = state.chat?.currentChannel;
  if (!channelId) return;
  const next = !isChannelNotifyAll(channelId);
  setChannelNotifyAll(channelId, next);
  if (next) setChannelMuted(channelId, false);
  refreshNotifyAllButton();
  refreshMuteButton();
  const sel = `[data-id="${cssEscape(channelId)}"]`;
  const li = els.channels.querySelector(sel) || els.dms.querySelector(sel);
  if (li) {
    li.classList.toggle('notify-all', next);
    if (next) li.classList.remove('muted');
  }
  // If it was muted, un-muting it via this path changes the badge styling.
  if (next) { updateUnreadBadge(channelId); updateUnreadTitle(); }
  showToast(next ? 'Notifying on every message here' : 'Back to @mentions only');
}
function refreshNotifyAllButton() {
  if (!els.notifyAllBtn) return;
  const channelId = state.chat?.currentChannel;
  els.notifyAllBtn.classList.toggle('hidden', !channelId);
  if (!channelId) return;
  const on = isChannelNotifyAll(channelId);
  els.notifyAllBtn.classList.toggle('active', on);
  els.notifyAllBtn.title = on
    ? 'Notifying on every message — click for @mentions only'
    : 'Notify on every message in this channel';
}

// ---------------------------------------------------------------------------
// Toasts (transient bottom-center confirmations).
// ---------------------------------------------------------------------------
function showToast(message, { kind = 'info', duration = 2400 } = {}) {
  if (!els.toasts) return;
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.textContent = message;
  els.toasts.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, duration);
}

// Populate Settings → Slash commands from window.SLASH_COMMANDS
// (chat.js). Rendered as <li><code>usage</code><span>desc</span></li>;
// aliases are appended as a sub-line, and any `extras` (e.g. /jira
// variants) become sibling rows so the explainer covers all the
// command shapes the user might want to type.
function renderSlashList() {
  const ul = $('#slash-list');
  if (!ul || !window.SLASH_COMMANDS) return;
  ul.replaceChildren();
  for (const cmd of window.SLASH_COMMANDS) {
    ul.appendChild(buildSlashRow(cmd.usage, cmd.desc, cmd.aliases));
    for (const extra of (cmd.extras || [])) {
      ul.appendChild(buildSlashRow(extra.usage, extra.desc));
    }
  }
}

function buildSlashRow(usage, desc, aliases) {
  const li = document.createElement('li');
  const code = document.createElement('code');
  code.textContent = usage;
  const span = document.createElement('span');
  if (aliases?.length) {
    const aliasNote = aliases.map((a) => `/${a}`).join(', ');
    span.textContent = `(alias ${aliasNote}) ${desc}`;
  } else {
    span.textContent = desc;
  }
  li.append(code, span);
  return li;
}

// ---------------------------------------------------------------------------
// Popout windows. The Electron main process spawns a child
// BrowserWindow that loads the same index.html with a query string
// like `?popout=whiteboard:<id>&team=<id>&channel=<id>`. The
// renderer detects the query at boot, short-circuits the login flow
// (Supabase persists the session across renderer processes), and
// renders only the focused view. Move-the-call is on the roadmap;
// this PR ships the whiteboard popout only.
// ---------------------------------------------------------------------------

function parsePopoutQuery(search) {
  if (!search || search.length < 2) return null;
  const params = new URLSearchParams(search);
  const target = params.get('popout');
  if (!target) return null;
  const colon = target.indexOf(':');
  if (colon < 0) return null;
  return {
    kind: target.slice(0, colon),
    id: target.slice(colon + 1),
    target,
    teamId: params.get('team') || '',
    channelId: params.get('channel') || '',
    whiteboardId: params.get('whiteboard') || '',
    title: params.get('title') || '',
  };
}

async function bootPopout(cfg) {
  // Reuse the persisted Supabase session — the popout was spawned
  // from a signed-in main window. If for some reason the session is
  // missing (cookie wiped between processes, user signed out in the
  // brief window before popout opened), we can't recover here:
  // surface an error in place of the workspace.
  const session = await window.huddleApi.getActiveSession();
  if (!session?.user?.email) {
    document.body.innerHTML =
      '<div style="padding:32px;color:#fff;font:14px system-ui">'
      + 'No active session. Sign in from the main window first, then re-open the popout.'
      + '</div>';
    return;
  }
  state._email = session.user.email;
  if (cfg.kind === 'whiteboard') {
    document.body.classList.add('popout-whiteboard');
    await bootWhiteboardPopout(cfg);
    return;
  }
  if (cfg.kind === 'call') {
    document.body.classList.add('popout-call');
    await bootCallPopout(cfg);
    return;
  }
  document.body.innerHTML =
    `<div style="padding:32px;color:#fff;font:14px system-ui">`
    + `Unknown popout target: ${cfg.target}`
    + `</div>`;
}

async function bootWhiteboardPopout(cfg) {
  if (!cfg.teamId || !cfg.channelId || !cfg.whiteboardId) {
    document.body.innerHTML =
      '<div style="padding:32px;color:#fff;font:14px system-ui">'
      + 'Popout missing context (team/channel/whiteboard). Close + reopen from the main window.'
      + '</div>';
    return;
  }
  // Construct a HuddleClient but DON'T call .start(). start() would
  // subscribe to the team realtime channel and track presence under
  // the same auth.uid() key as the main window — Supabase presence
  // dedupes by key, so the popout's track would overwrite the main
  // window's metadata, and when the popout closes the main window
  // would briefly show as "offline" to other peers. The whiteboard
  // session only needs a bare client (supabase + peerId) for its
  // ensureWhiteboardChannel + persist methods, so the lighter
  // construction is both correct and cheaper.
  const huddle = await window.huddleApi.startHuddle({ id: cfg.teamId, name: cfg.teamId });
  state.huddle = huddle;
  state.myName = huddle.name;

  // Build a popout-only stage: a single tile that fills the window
  // hosting the WhiteboardSession.
  const stage = document.getElementById('popout-stage') || document.body;
  stage.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'popout-whiteboard';
  stage.appendChild(wrap);

  const tile = document.createElement('div');
  tile.className = 'tile screen whiteboard popout-tile';
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = cfg.title || 'Whiteboard';
  tile.appendChild(label);
  wrap.appendChild(tile);

  // Whiteboard meta: the popout was given the whiteboard id; the
  // session only needs `{id}` to subscribe + persist.
  const session = new window.WhiteboardSession({
    huddle,
    channelId: cfg.channelId,
    whiteboard: { id: cfg.whiteboardId },
    tile,
  });
  await session.start();
  document.title = cfg.title || 'Whiteboard — Huddle';
}

// Pop the active call out into a child window. Implements
// "move-the-call" semantics: the main window leaves the call once
// the popout is ready, then the popout joins. Avoids duplicate
// participant + duplicate presence under the same auth.uid() key,
// at the cost of a brief mid-handoff gap where neither window is
// in the call. The popout can be closed manually; closing it does
// NOT auto-rejoin the main window.
async function popOutCurrentCall() {
  const channelId = state.inCallChannelId;
  if (!channelId || !state.huddle) return;
  // Two listeners with mutual-exclusion via `handoffDone`:
  //   - call-popout-ready: the happy path. Leave the call, tell
  //     the popout to take over, mark this call as popped-out so
  //     renderCallHeader can hide the Join button (otherwise the
  //     user can rejoin in main and become a duplicate
  //     participant alongside the popout).
  //   - popout-closed: fallback for when the popout's renderer
  //     crashed or the user closed the window before the handoff
  //     completed. Abort the handoff so we don't leaveCall on a
  //     ghost popout.
  let handoffDone = false;
  const unsubReady = window.huddle.onPopoutEvent(async (msg) => {
    if (msg?.event !== 'call-popout-ready') return;
    if (msg.channelId !== channelId) return;
    if (handoffDone) return;
    handoffDone = true;
    unsubReady();
    unsubClosed();
    try {
      await leaveCall();
    } finally {
      // Even if leaveCall threw, signal the popout — otherwise it
      // sits forever waiting for the handoff and the user has to
      // close + reopen.
      window.huddle.sendPopoutEvent({ event: 'main-call-left', channelId });
    }
    state.poppedOutCalls.add(channelId);
    renderCallHeader();
  });
  const unsubClosed = window.huddle.onPopoutEvent((msg) => {
    if (msg?.event !== 'popout-closed') return;
    if (msg.target !== `call:${channelId}`) return;
    if (handoffDone) return;
    handoffDone = true;
    unsubReady();
    unsubClosed();
    showToast('Popout closed before the handoff finished; staying in the call here.', { kind: 'error' });
  });
  try {
    await window.huddle.openPopout({
      target: `call:${channelId}`,
      teamId: state.huddle.team.id,
      channelId,
      title: `Call — ${state.huddle.team.name || state.huddle.team.id}`,
    });
    showToast('Call moved to a new window');
  } catch (err) {
    unsubReady();
    unsubClosed();
    console.warn('call popout failed', err);
    showCallError('Could not open call popout: ' + (err?.message || err));
  }
}

// Boot the popout window into call mode. Builds a focused tile
// grid + control bar in #popout-stage, redirects els.btn* + els.tiles
// to those popout-local DOM nodes so the existing call handlers
// (onCallPeerJoined, onTrack, addLocalCameraTile, etc.) continue
// to work unmodified, then waits for `main-call-left` before
// joining. The HuddleClient is constructed bare (no .start()) so
// the popout doesn't subscribe to the team channel — only the
// call:<team>:<channel> presence + signaling subscription matters
// for the call tile grid.
async function bootCallPopout(cfg) {
  if (!cfg.teamId || !cfg.channelId) {
    document.body.innerHTML =
      '<div style="padding:32px;color:#fff;font:14px system-ui">'
      + 'Popout missing context (team/channel). Close + reopen from the main window.'
      + '</div>';
    return;
  }
  const huddle = await window.huddleApi.startHuddle({ id: cfg.teamId, name: cfg.teamId });
  state.huddle = huddle;
  state.myName = huddle.name;
  document.title = cfg.title || 'Call — Huddle';

  const stage = document.getElementById('popout-stage') || document.body;
  stage.replaceChildren();
  // The tile grid and the control bar both need to coexist: tiles
  // fill the upper area, controls pin to the bottom. Use a flex
  // column so resizing the window stretches the tiles.
  const wrap = document.createElement('div');
  wrap.className = 'popout-call';
  const tiles = document.createElement('section');
  tiles.id = 'popout-call-tiles';
  tiles.className = 'tiles popout-tiles';
  wrap.appendChild(tiles);
  const bar = document.createElement('div');
  bar.className = 'popout-call-bar';
  const mkIconBtn = (id, iconName, title, cls = 'ctrl icon-only') => {
    const b = document.createElement('button');
    b.id = id; b.className = cls;
    b.title = title; b.setAttribute('aria-label', title);
    b.innerHTML = window.HuddleIcons[iconName];
    return b;
  };
  // Mic / Cam start disabled — startPopoutCall enables them once
  // the MeshClient is wired and joinCall has resolved. Without
  // this, clicking either button during the brief handoff gap
  // (state.mesh still null) silently no-ops and the user thinks
  // the popout is broken.
  const btnMic = mkIconBtn('popout-btn-mic', 'mic', 'Toggle microphone');
  btnMic.disabled = true;
  const btnCam = mkIconBtn('popout-btn-cam', 'cam', 'Toggle camera');
  btnCam.disabled = true;
  const btnShare = mkIconBtn('popout-btn-share', 'screen', 'Share a screen');
  btnShare.disabled = true;
  const btnHand = mkIconBtn('popout-btn-hand', 'hand', 'Raise hand');
  btnHand.disabled = true;
  const btnReact = mkIconBtn('popout-btn-react', 'smile', 'Send a reaction');
  btnReact.disabled = true;
  const reactPopover = document.createElement('div');
  reactPopover.id = 'popout-react-popover';
  reactPopover.className = 'react-popover hidden';
  reactPopover.setAttribute('role', 'menu');
  reactPopover.setAttribute('aria-label', 'Quick reactions');
  // Children are populated by wireReactPopover from the REACTION_EMOJI constant.
  const btnLeave = document.createElement('button');
  btnLeave.id = 'popout-btn-leave';
  btnLeave.className = 'ctrl danger';
  btnLeave.title = 'Leave call';
  btnLeave.innerHTML = `${window.HuddleIcons.phoneDown}<span>Leave</span>`;
  bar.append(btnMic, btnCam, btnShare, btnHand, btnReact, btnLeave);
  wrap.appendChild(bar);
  wrap.appendChild(reactPopover);
  stage.appendChild(wrap);

  // Move the draw-toolbar (which lives inside #app, hidden by
  // body.popout) into the popout-stage so the Annotate flow on a
  // shared-screen tile can show + use it. The toolbar wires its
  // own data-tool buttons in setupListeners, so the move just
  // reparents an already-bound DOM node.
  if (els.drawToolbar && els.drawToolbar.parentElement !== stage) {
    stage.appendChild(els.drawToolbar);
  }

  // Redirect els refs so the existing helpers (makeTile, syncTilesVisibility,
  // renderCallHeader, etc.) operate on the popout's DOM. We supply
  // dummy nodes for els the popout doesn't render so toggles are
  // safe no-ops.
  els.tiles = tiles;
  els.btnMic = btnMic;
  els.btnCam = btnCam;
  els.btnShare = btnShare;
  els.btnHand = btnHand;
  els.btnReact = btnReact;
  els.reactPopover = reactPopover;
  els.btnLeave = btnLeave;
  // Anything not visible in the popout: replace with a detached node
  // so toggleClass(...) / textContent assignments don't throw.
  const stub = () => document.createElement('div');
  els.btnStartCall = stub();
  els.btnJoinCall = stub();
  els.btnJira = stub();
  els.btnPopoutCall = stub();
  els.channelName = stub();
  els.channelTopic = stub();
  els.callPresenceCount = stub();

  // Wire popout-local controls. Mic/Cam toggle methods on MeshClient
  // exist already; Leave closes the call AND the popout window.
  btnMic.onclick = () => {
    if (!state.mesh) return;
    const on = state.mesh.toggleMic();
    btnMic.classList.toggle('muted', !on);
    // Mirror the main-window behaviour: the self-cam tile gets a
    // .muted class so the CSS strike-through overlay tracks the
    // actual mic state.
    const tile = state.tilesByKey.get('self-cam');
    if (tile) tile.classList.toggle('muted', !on);
  };
  btnCam.onclick = () => {
    if (!state.mesh) return;
    const on = state.mesh.toggleCam();
    btnCam.classList.toggle('muted', !on);
    setPeerCamOn(state.huddle.peerId, on);
  };
  btnShare.onclick = () => { if (state.mesh) openSourcePicker(); };
  state.reactPopoverCleanup?.();
  state.reactPopoverCleanup = wireReactPopover(btnReact, reactPopover);
  btnHand.onclick = toggleSelfHand;
  btnLeave.onclick = async () => {
    try { await leaveCall(); }
    finally { window.close(); }
  };
  // setupListeners() runs only on the main window; wire the bits the
  // popout reuses (source picker cancel, draw-toolbar tool buttons)
  // here so screen-share + annotate work end-to-end.
  if (els.sourceCancel) {
    els.sourceCancel.onclick = () => els.sourcePicker.classList.add('hidden');
  }
  wireDrawToolbar();

  // Wait for the main window to have left the call before joining,
  // so the call channel doesn't carry duplicate presence under the
  // same peer key.
  const unsub = window.huddle.onPopoutEvent((msg) => {
    if (msg?.event !== 'main-call-left') return;
    if (msg.channelId !== cfg.channelId) return;
    unsub();
    startPopoutCall(cfg.channelId).catch((err) => {
      console.warn('startPopoutCall failed', err);
      showCallError('Could not start the call: ' + (err?.message || err));
    });
  });
  // Tell the main window we're ready to take over.
  window.huddle.sendPopoutEvent({ event: 'call-popout-ready', channelId: cfg.channelId });
}

// Popout-local equivalent of startCall(). Same MeshClient setup +
// joinCall + setCamera, but skips the start/join button toggles
// and the in-flight guard (popout has its own UI).
async function startPopoutCall(channelId) {
  const huddle = state.huddle;
  if (!huddle || state.mesh) return;
  const mesh = new MeshClient(huddle);
  mesh.addEventListener('peer-joined', (e) => onCallPeerJoined(e.detail));
  mesh.addEventListener('peer-left', (e) => onCallPeerLeft(e.detail));
  mesh.addEventListener('track', (e) => onTrack(e.detail));
  mesh.addEventListener('screen-announce', (e) => onScreenAnnounce(e.detail));
  mesh.addEventListener('screen-stop', (e) => onScreenStop(e.detail));
  mesh.addEventListener('remote-stream-ended', (e) => onScreenStop(e.detail));
  mesh.addEventListener('draw', (e) => onRemoteDraw(e.detail));
  mesh.addEventListener('raise-hand', (e) => onRemoteRaiseHand(e.detail));
  mesh.addEventListener('reaction', (e) => onRemoteReaction(e.detail));
  mesh.addEventListener('mute-state', (e) => onRemoteMuteState(e.detail));
  try {
    await huddle.joinCall(channelId);
  } catch (err) {
    showCallError('Could not join the call: ' + (err?.message || err));
    mesh.disconnect();
    return;
  }
  state.mesh = mesh;
  state.inCallChannelId = channelId;
  startSpeakerPolling();
  // The mic/cam/share controls were disabled in bootCallPopout; flip
  // them on now that mesh.toggle{Mic,Cam}/addScreen have something to act on.
  els.btnMic.disabled = false;
  els.btnCam.disabled = false;
  if (els.btnShare) els.btnShare.disabled = false;
  if (els.btnHand) els.btnHand.disabled = false;
  if (els.btnReact) els.btnReact.disabled = false;
  mesh.bootstrapExistingPeers();
  try {
    const cam = await mesh.setCamera({ video: true, audio: true });
    addLocalCameraTile(cam, huddle.name);
  } catch (err) {
    showCallError('Could not access camera/microphone: ' + (err?.message || err));
  }
}

// ---------------------------------------------------------------------------
// Invite links: shareable URLs that open Huddle and join a team or
// call. Shape: `huddle://team/<team_id>` for plain team invites,
// `huddle://team/<team_id>/channel/<channel_id>?call=1` for join-a-
// call links. Uses the `huddle://` custom scheme so the link is
// unambiguous; until the Electron protocol handler is registered
// (separate PR), recipients paste the link into the team picker's
// "Join via link" input.
// ---------------------------------------------------------------------------
function buildTeamInviteLink(teamId) {
  return `huddle://team/${encodeURIComponent(teamId)}`;
}

function buildCallInviteLink(teamId, channelId) {
  return `huddle://team/${encodeURIComponent(teamId)}/channel/${encodeURIComponent(channelId)}?call=1`;
}

// Parse a `huddle://...` URL into { teamId, channelId, joinCall }
// or null. Lenient about whitespace and accepts URLs that the user
// might have copied with a trailing newline.
function parseInviteLink(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  let url;
  try { url = new URL(cleaned); } catch { return null; }
  if (url.protocol !== 'huddle:') return null;
  // Custom-scheme parsing: WHATWG puts the host part of `huddle://X`
  // into `pathname` because the scheme isn't on the special list.
  // Treat `host + pathname` together and split on '/'.
  const path = (url.host + url.pathname).replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'team' || !parts[1]) return null;
  const teamId = decodeURIComponent(parts[1]);
  let channelId = null, joinCall = false, messageId = null;
  if (parts[2] === 'channel' && parts[3]) {
    channelId = decodeURIComponent(parts[3]);
    joinCall = url.searchParams.get('call') === '1';
    messageId = url.searchParams.get('msg');
  }
  return { teamId, channelId, joinCall, messageId };
}

async function copyToClipboard(text) {
  // Electron renderer + modern browsers expose navigator.clipboard;
  // fall back to a hidden textarea + execCommand for older webviews.
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { /* fall through to legacy */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    // readOnly suppresses the on-screen keyboard on mobile webviews;
    // focus() before select() is required for execCommand('copy') to
    // succeed on a couple of environments that don't honour an
    // unfocused selection.
    ta.readOnly = true;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch { return false; }
}

async function copyAndToast(text, label) {
  const ok = await copyToClipboard(text);
  if (ok) showToast(`${label} copied to clipboard`);
  else showToast(`Couldn't copy ${label.toLowerCase()}`, { kind: 'error' });
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
    const session = await window.huddleApi.getActiveSession();
    if (!session?.user) throw new Error('sign-in did not establish a session');
    await routePostAuth(session.user.id);
  } catch (err) {
    showError("That code didn't match. Try again or send a new one.");
  } finally { els.authVerify.disabled = false; }
}

async function stepPasswordSignIn() {
  els.loginError.classList.add('hidden');
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (!email) { showError('Enter your email first.'); return; }
  if (!password) { showError('Enter your password.'); return; }
  els.authPasswordSignin.disabled = true;
  els.authPasswordSignup.disabled = true;
  try {
    await window.huddleApi.signInWithPassword(email, password);
    state._email = email;
    const session = await window.huddleApi.getActiveSession();
    if (!session?.user) throw new Error('sign-in did not establish a session');
    await routePostAuth(session.user.id);
  } catch (err) {
    // Supabase returns "Invalid login credentials" (HTTP 400) for both a
    // wrong password and an unknown email — surface one generic hint for
    // that case. Anything else (offline, 5xx) is reported as-is so the
    // user isn't told to "check your password" when the server is at fault.
    const msg = String(err?.message || err);
    if (err?.status === 400 || /invalid login credentials/i.test(msg)) {
      showError("Couldn't sign in with that email + password. Check both, or use an emailed code / create an account.");
    } else {
      showError('Could not sign in: ' + msg);
    }
  } finally {
    els.authPasswordSignin.disabled = false;
    els.authPasswordSignup.disabled = false;
  }
}

async function stepPasswordSignUp() {
  els.loginError.classList.add('hidden');
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (!email) { showError('Enter your email first.'); return; }
  if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }
  els.authPasswordSignin.disabled = true;
  els.authPasswordSignup.disabled = true;
  try {
    const session = await window.huddleApi.signUpWithPassword(email, password);
    if (!session) {
      // "Confirm email" is enabled on the project, so the account exists
      // but isn't usable until confirmed — and our email delivery is the
      // thing we're routing around. Tell the user plainly.
      showError('Account created, but it needs email confirmation before you can sign in. Ask an admin to disable email confirmation in the Supabase Auth settings, then try "Sign in".');
      return;
    }
    state._email = email;
    showStep('profile');
    await prefillProfile();
  } catch (err) {
    const msg = String(err?.message || err);
    showError(/registered|already/i.test(msg)
      ? 'That email already has an account — use "Sign in" instead (or an emailed code).'
      : ('Could not create the account: ' + msg));
  } finally {
    els.authPasswordSignin.disabled = false;
    els.authPasswordSignup.disabled = false;
  }
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

// Paste-to-redeem path for invite links. Same end state as
// stepJoinTeam (joinOrCreateTeam + joinTeamAndStart) plus an
// optional pending channel/call hop that runs after the workspace
// boots — see state.pendingInviteHop / consumePendingInviteHop.
async function stepJoinViaLink() {
  els.loginError.classList.add('hidden');
  const raw = els.teamJoinLink.value.trim();
  const parsed = parseInviteLink(raw);
  if (!parsed) {
    showError('That doesn’t look like a Huddle invite link.');
    return;
  }
  try {
    const t = await window.huddleApi.joinOrCreateTeam(parsed.teamId);
    if (parsed.channelId) {
      state.pendingInviteHop = { channelId: parsed.channelId, joinCall: parsed.joinCall };
    }
    await joinTeamAndStart(t.id);
  } catch (err) {
    showError(err.message || 'Could not redeem invite.');
  }
}

// OS-delivered huddle:// URL handler. The renderer routes the
// link through whichever path the current UI state allows:
//   - Already in the linked team → focus channel + optionally
//     start the call. Cheapest, most common case.
//   - Signed in but in a different team → confirm + switch.
//   - On the team picker → prefill the join-link input + click.
//   - On any earlier step (login / OTP / boot) → buffer until the
//     team picker is reachable; the showStep('team') drain or the
//     post-auth boot landing on a workspace will pick it up.
async function handleProtocolUrl(url) {
  const parsed = parseInviteLink(url);
  if (!parsed) {
    console.warn('handleProtocolUrl: unparseable', url);
    return;
  }
  // Re-entrancy guard. handleProtocolUrl awaits teardownTeam +
  // joinTeamAndStart on the different-team path; a second URL
  // arriving mid-await would race the first. Buffer concurrent
  // calls and let them drain after the in-flight one settles.
  if (state._handlingProtocolUrl) {
    state.pendingProtocolUrl = url;
    return;
  }
  state._handlingProtocolUrl = true;
  try {
    await _routeProtocolUrl(parsed, url);
  } finally {
    state._handlingProtocolUrl = false;
    // Drain a buffered URL queued during the await. Defer one tick
    // so the in-flight workflow's onWelcome / showStep callbacks
    // have a chance to run before we kick off the next.
    if (state.pendingProtocolUrl) {
      setTimeout(() => drainPendingProtocolUrl(), 0);
    }
  }
}

async function _routeProtocolUrl(parsed, url) {
  // Bring the window forward — the OS may have launched us in the
  // background.
  try { window.focus(); } catch {}

  if (state.huddle && state.huddle.team?.id === parsed.teamId) {
    // Same team — just hop. focusChannel is a no-op if the channel
    // isn't visible (private channel the user isn't in); the
    // pendingInviteHop fallback below handles those.
    if (parsed.channelId && state.channelMeta.has(parsed.channelId)) {
      focusChannel(parsed.channelId);
      if (parsed.joinCall) setTimeout(() => startCall(parsed.channelId), 0);
      // setChannel + loadHistory render messages asynchronously, so the
      // target node usually doesn't exist yet. scrollToMessage polls
      // for it with a short backoff (giving up after ~3s) so we don't
      // race a fixed setTimeout against the history fetch.
      if (parsed.messageId) state.chat?.scrollToMessage(parsed.messageId);
    } else if (parsed.channelId) {
      showCallError(`Channel #${parsed.channelId} isn't available on this team.`);
    }
    return;
  }

  if (state.huddle) {
    // Different team — confirm before tearing down the active
    // session, since the user has chat / drafts / call state in
    // play.
    const ok = confirm(`Switch to team "${parsed.teamId}"?`);
    if (!ok) return;
    try {
      await teardownTeam();
      const t = await window.huddleApi.joinOrCreateTeam(parsed.teamId);
      if (parsed.channelId) {
        state.pendingInviteHop = { channelId: parsed.channelId, joinCall: parsed.joinCall };
      }
      await joinTeamAndStart(t.id);
    } catch (err) {
      showCallError('Could not switch teams: ' + (err?.message || err));
    }
    return;
  }

  // Not signed into a workspace. If the team picker is showing,
  // route through the existing input → join flow. Otherwise
  // buffer for showStep('team') / boot resume to drain.
  if (els.teamStep && !els.teamStep.classList.contains('hidden')) {
    els.teamJoinLink.value = url;
    stepJoinViaLink();
    return;
  }
  // Buffer for showStep('team') drain or onWelcome drain to pick up
  // once the user is past login.
  state.pendingProtocolUrl = url;
}

// Spin up the HuddleClient (chat + team presence) and reveal the app.
// Calls are now started on demand via startCall() — joining a team no
// longer auto-grabs camera/mic or constructs MeshClient.
async function joinTeamAndStart(teamId) {
  els.loginError.classList.add('hidden');
  // startHuddle returns an *un-started* HuddleClient so we can attach
  // listeners before its `start()` synchronously dispatches `welcome`.
  // Without that ordering, welcome fires into the void and onWelcome
  // never runs — channels render in the DB but never make it to the
  // sidebar (the symptom that hid created channels between sessions).
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
  huddle.addEventListener('member-online', (e) => onMemberOnline(e.detail));
  huddle.addEventListener('member-offline', (e) => onMemberOffline(e.detail));
  huddle.addEventListener('chat-channel-added', (e) => onChannelAdded(e.detail.channel));
  huddle.addEventListener('chat-channel-removed', (e) => onChannelRemoved(e.detail.channelId));
  huddle.addEventListener('chat-channel-updated', (e) => onChannelUpdated(e.detail));
  huddle.addEventListener('call-presence', (e) => onCallPresence(e.detail));
  huddle.addEventListener('saved-message-added', (e) => onSavedMessageChange('add', e.detail.save));
  huddle.addEventListener('saved-message-updated', (e) => onSavedMessageChange('update', e.detail.save));
  huddle.addEventListener('saved-message-removed', (e) => onSavedMessageChange('remove', { messageId: e.detail.messageId }));

  // Construct ChatView + assign state BEFORE huddle.start(), because
  // start() dispatches `welcome` synchronously at the end of its
  // handshake. onWelcome auto-focuses #general via focusChannel, which
  // calls state.chat.setChannel() — that throws silently if state.chat
  // isn't constructed yet, and the auto-focus is lost. (Channels still
  // render in the sidebar, but the chat panel never binds to one.)
  state.huddle = huddle;
  state.mesh = null;
  state.myName = huddle.name;
  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.me.textContent = huddle.name;
  if (huddle.team?.name) els.workspaceName.textContent = huddle.team.name;

  state.profileCard = new window.ProfileCard({
    huddle,
    onMessage: (profile) => openDmWith(profile.user_id, profile.name),
    onEditProfile: () => openSettingsToProfile(),
  });

  state.chat = new ChatView({
    huddle, els,
    hooks: {
      onMessage: (m) => onChatMessage(m),
      getGiphyKey,
      getJira: () => state.jira,
      getDefaultJiraProject: () => state.settings?.jira?.defaultProject || '',
      getAiTicketContext: () => state.settings?.aiTicket?.context || '',
      getAiTicketRepo: () => state.settings?.aiTicket?.githubRepo || '',
      openTicketModal: (preset) => openTicketModal(preset),
      getAi: () => state.ai,
      getGitHub: () => state.github,
      attachProfileTrigger: (el, userId) => attachProfileTrigger(el, userId),
      openImageLightbox: (url, name) => openImageLightbox(url, name),
      toast: (msg) => showToast(msg),
      renderPinnedDrawer: (msgs, onPick) => renderPinnedDrawer(msgs, onPick),
      closePinnedDrawer: () => closePinnedDrawer(),
      onPinChanged: () => refreshPinnedCount(),
      isMessageSaved: (id) => state.savedById.has(id),
      openSavePopover: (args) => openSavePopover(args),
    },
  });
  wireControls();
  // Default to the pre-call header (Start call). startCall flips it.
  renderCallHeader();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  // Now kick off the realtime handshake. welcome will fire inside
  // start() and flow into onWelcome — which can safely auto-focus
  // #general now that state.chat is wired up.
  try { await huddle.start(); }
  catch (err) { showError(err.message || 'Could not start huddle.'); return; }
}

// User clicked "Start call" or "Join call". Construct MeshClient first
// (so its peer-joined listener is attached before huddle.joinCall fires
// presence-sync events for everyone already in the call), then join.
async function startCall(channelId) {
  if (!state.huddle || state.mesh) return; // already in a call or no team
  if (state.callStarting) return;          // double-click / re-entrancy guard
  state.callStarting = true;
  els.btnStartCall.disabled = true;
  els.btnJoinCall.disabled = true;
  // Each call starts with mic/cam enabled (fresh getUserMedia). Clear
  // any leftover .muted styling from a previous call we left while
  // muted; otherwise the UI can lie about the live track state.
  els.btnMic.classList.remove('muted');
  els.btnCam.classList.remove('muted');
  // Wire MeshClient before joinCall — joinCall's await resolves AFTER
  // the realtime channel's initial presence sync, so peer-joined
  // events for existing participants would otherwise fire into the
  // void (no MeshClient listener yet) and we'd never form WebRTC
  // connections to them.
  const mesh = new MeshClient(state.huddle);
  mesh.addEventListener('peer-joined', (e) => onCallPeerJoined(e.detail));
  mesh.addEventListener('peer-left', (e) => onCallPeerLeft(e.detail));
  mesh.addEventListener('track', (e) => onTrack(e.detail));
  mesh.addEventListener('screen-announce', (e) => onScreenAnnounce(e.detail));
  mesh.addEventListener('screen-stop', (e) => onScreenStop(e.detail));
  mesh.addEventListener('remote-stream-ended', (e) => onScreenStop(e.detail));
  mesh.addEventListener('draw', (e) => onRemoteDraw(e.detail));
  mesh.addEventListener('raise-hand', (e) => onRemoteRaiseHand(e.detail));
  mesh.addEventListener('reaction', (e) => onRemoteReaction(e.detail));
  mesh.addEventListener('mute-state', (e) => onRemoteMuteState(e.detail));
  try {
    await state.huddle.joinCall(channelId);
  } catch (err) {
    console.warn('joinCall failed', err);
    // Surface the failure to the user (see showCallError) instead
    // of swallowing into console.warn — otherwise they see the
    // button greyed out and nothing else (the regression that
    // "Start call doesn't start a call" reported on v0.2.5).
    showCallError('Could not start the call: ' + (err?.message || err));
    mesh.disconnect();
    state.callStarting = false;
    els.btnStartCall.disabled = false;
    els.btnJoinCall.disabled = false;
    return;
  }
  state.mesh = mesh;
  state.inCallChannelId = channelId;
  startSpeakerPolling();
  // Belt + suspenders: also bootstrap from the snapshot HuddleClient
  // already has, in case the presence-sync handler fired before our
  // listener attached during the joinCall handshake. _ensurePeer is
  // memoised so the duplicate path is a no-op when peer-joined races us.
  mesh.bootstrapExistingPeers();
  try {
    const cam = await mesh.setCamera({ video: true, audio: true });
    addLocalCameraTile(cam, state.huddle.name);
  } catch (err) {
    console.warn('No camera/mic available', err);
    // The call itself is still alive (signaling + presence work) so
    // we don't tear it down — just tell the user their tile isn't
    // sharing video. Common cause on macOS: the OS-level mic/camera
    // permission was previously denied for Electron / Huddle, and
    // the OS won't reprompt automatically.
    showCallError('Could not access camera/microphone: ' + (err?.message || err) + '. Check System Settings → Privacy & Security → Camera/Microphone.');
  }
  state.callStarting = false;
  els.btnStartCall.disabled = false;
  els.btnJoinCall.disabled = false;
  renderCallHeader();
}

// Drop the call (media + WebRTC peers + tile grid) but stay signed
// into the team. The HuddleClient keeps chat realtime running.
async function leaveCall() {
  if (!state.mesh) return;
  // Snapshot + clear the captions buffer synchronously, then
  // dispatch the AI summary as a background task. We don't await
  // because the AI round-trip can take several seconds; blocking
  // here would keep the WebRTC mesh up + the UI frozen until the
  // recap returns. finalizeCallTranscript handles the team-channel
  // outliving leaveCall (mesh.disconnect doesn't close it).
  finalizeCallTranscript();
  // stop() is async (flushes pending note-save timers); await all
  // sessions in parallel so a slow DB write doesn't block the rest.
  await Promise.allSettled([...state.whiteboardSessions.values()].map((s) => s.stop()));
  state.whiteboardSessions.clear();
  state.mesh.disconnect();
  state.mesh = null;
  state.inCallChannelId = null;
  resetCallEphemera();
  try { await state.huddle?.leaveCall(); } catch {}
  // joinCall dropped the lurker for this channel when we became a
  // full participant. After leaveCall, the user is still viewing the
  // same chat — re-watch it so the header can show "Join call · N"
  // if other participants stayed behind.
  const ch = state.chat?.currentChannel;
  if (ch && state.huddle) {
    state.lurkingChannelId = ch;
    // Forget the cached count — while we were a participant the lurker
    // was off, so it's stale. Dropping it makes the first post-leave
    // presence sync read as an initial sync, not a 0→N "call started".
    state.callCounts.delete(ch);
    try { await state.huddle.watchCallPresence(ch); } catch {}
  }
  renderCallHeader();
}

// ---------------------------------------------------------------------------
// Live call captions (Web Speech API) + post-call AI summary
// ---------------------------------------------------------------------------
//
// startCaptions() flips local SR on, broadcasts each final segment to
// other call participants, and shows the captions panel. Remote
// transcript-line events feed the same buffer so every peer's panel
// shows the unified call transcript. stopCaptions() (called from the
// CC toggle, leaveCall, or popout-handoff) tears down the SR + the
// mesh listener but keeps the buffer around long enough for
// finalizeCallTranscript() to summarise it.
function startCaptions() {
  if (state.cc.on) return;
  if (!window.HuddleTranscript?.TranscriptManager?.isSupported()) {
    showCallError("This build's runtime doesn't expose the Web Speech API; live captions aren't available.");
    return;
  }
  if (!state.mesh || !state.huddle) return;
  state.cc.on = true;
  state.cc.forChannelId = state.inCallChannelId;
  els.btnCc?.classList.add('active');
  showCaptionsPanel();

  // Receive lines from peers (and from this peer's local SR via the
  // self: false call channel — those go straight into the buffer
  // without the network round-trip).
  state.cc.unsub = bindTranscriptLines();

  const mgr = new window.HuddleTranscript.TranscriptManager();
  state.cc.manager = mgr;
  mgr.onFinal((text) => {
    // SR fires asynchronously, so teardownTeam may have nulled
    // state.huddle between the time we started capturing and this
    // callback resolving. Bail rather than crash the renderer
    // dereferencing peerId / name on null.
    const huddle = state.huddle;
    if (!huddle) return;
    const line = {
      from: huddle.peerId, fromName: huddle.name,
      text, ts: Date.now(),
    };
    appendCaptionLine(line);
    state.cc.lastInterim = '';
    renderInterim();
    try { huddle.sendTranscriptLine(text, line.ts); } catch {}
  });
  mgr.onInterim((text) => {
    state.cc.lastInterim = text;
    renderInterim();
  });
  mgr.start();
}

function stopCaptions({ keepBuffer = false } = {}) {
  state.cc.on = false;
  els.btnCc?.classList.remove('active');
  state.cc.manager?.stop();
  state.cc.manager = null;
  state.cc.unsub?.();
  state.cc.unsub = null;
  state.cc.lastInterim = '';
  if (!keepBuffer) {
    state.cc.lines = [];
    state.cc.forChannelId = null;
    // Full reset — also clear the in-flight lock so a previous
    // recap that's mid-await on AI doesn't keep the next team's
    // leaveCall from spawning its own finalize. The IIFE's
    // .finally would clear this eventually, but the gap can swallow
    // the next call's recap if leaveCall fires during it.
    state.cc._finalizing = false;
    if (els.captionsList) els.captionsList.replaceChildren();
    hideCaptionsPanel();
  } else {
    // Buffer persists for the post-call summary; panel hides anyway
    // since the call is over.
    hideCaptionsPanel();
  }
}

function bindTranscriptLines() {
  if (!state.huddle) return () => {};
  const handler = (e) => {
    const d = e.detail || {};
    if (!d.text) return;
    appendCaptionLine({ from: d.from, fromName: d.fromName, text: d.text, ts: d.ts || Date.now() });
  };
  state.huddle.addEventListener('transcript-line', handler);
  return () => state.huddle?.removeEventListener('transcript-line', handler);
}

function appendCaptionLine(line) {
  state.cc.lines.push(line);
  if (!els.captionsList) return;
  const row = document.createElement('div');
  row.className = 'caption-line' + (line.from === state.huddle?.peerId ? ' caption-self' : '');
  const who = document.createElement('span');
  who.className = 'caption-from';
  who.textContent = line.fromName || 'someone';
  const what = document.createElement('span');
  what.className = 'caption-text';
  what.textContent = line.text;
  row.append(who, what);
  // Strip a trailing interim node before appending so finals always
  // sit below interim flicker.
  const interim = els.captionsList.querySelector('.caption-interim');
  if (interim) interim.remove();
  els.captionsList.appendChild(row);
  if (state.cc.lastInterim) renderInterim();
  els.captionsList.scrollTop = els.captionsList.scrollHeight;
}

function renderInterim() {
  if (!els.captionsList) return;
  let row = els.captionsList.querySelector('.caption-interim');
  if (!state.cc.lastInterim) { row?.remove(); return; }
  if (!row) {
    row = document.createElement('div');
    row.className = 'caption-line caption-self caption-interim';
    const who = document.createElement('span');
    who.className = 'caption-from';
    who.textContent = state.huddle?.name || 'you';
    const what = document.createElement('span');
    what.className = 'caption-text';
    row.append(who, what);
    els.captionsList.appendChild(row);
  }
  row.querySelector('.caption-text').textContent = state.cc.lastInterim;
  els.captionsList.scrollTop = els.captionsList.scrollHeight;
}

function showCaptionsPanel() { els.captions?.classList.remove('hidden'); }
function hideCaptionsPanel() { els.captions?.classList.add('hidden'); }

// Called from leaveCall: if the local user had captions on,
// summarise the buffer via the configured AI provider and post
// the recap as an AI message in the channel. The synchronous
// part of this function snapshots the buffer + clears the
// shared state immediately; the AI round-trip runs in the
// background so leaveCall can disconnect the mesh + return
// without blocking the UI for several seconds.
function finalizeCallTranscript() {
  // Re-entrancy + cross-call safety. Without _finalizing, double-
  // clicking Leave (or leaveCall→startCall on a new channel before
  // the AI returns) would spawn parallel recaps and would also
  // clear cc.lines AFTER the await — wiping the next call's
  // freshly-accumulating buffer.
  if (state.cc._finalizing) return;
  if (!state.cc.on && state.cc.lines.length === 0) return;
  state.cc._finalizing = true;

  // Snapshot + reset shared state synchronously so a follow-up
  // call accumulates into a fresh buffer with no chance of being
  // cleared by an in-flight summary belonging to the previous one.
  const lines = state.cc.lines.slice();
  const channelId = state.cc.forChannelId;
  state.cc.lines = [];
  state.cc.forChannelId = null;
  stopCaptions({ keepBuffer: true });

  if (!channelId || lines.length === 0) {
    state.cc._finalizing = false;
    return;
  }
  const ai = state.ai;
  if (!ai || !ai.isConfigured()) {
    state.cc._finalizing = false;
    return;
  }

  // Background path: don't block the leaveCall teardown on the AI
  // round-trip. The team realtime channel survives mesh.disconnect
  // (only the per-call channel closes), so sendAiMessage still
  // works after the await. If teardownTeam has run by the time
  // the chat resolves, state.huddle?.sendAiMessage no-ops cleanly.
  (async () => {
    lines.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const transcript = lines.map((l) => `${l.fromName || 'someone'}: ${l.text}`).join('\n');
    const system = "You are summarising a live call transcript captured via the browser's speech-to-text. Produce a concise recap (under 200 words) in markdown: 2-3 bullets of the main points discussed, then a 'Decisions' section if any were made, then 'Action items' (with owners if you can infer them). The transcript is rough — fix obvious recognition errors silently and don't quote raw lines.";
    let result;
    try {
      result = await ai.chat({ system, messages: [{ role: 'user', content: transcript }] });
    } catch (err) {
      console.warn('call summary failed', err);
      return;
    }
    const body = `**📞 Call recap**\n\n${result.text || '(no recap produced)'}`;
    try {
      await state.huddle?.sendAiMessage({
        channelId, parentId: null, text: body, model: result.model,
      });
    } catch (err) {
      console.warn('failed to post call recap', err);
    }
  })().finally(() => { state.cc._finalizing = false; });
}

async function teardownTeam() {
  if (state.mesh) {
    // Captions ride the team realtime channel for the post-call
    // recap; tear them down (without trying to summarise — the
    // huddle is about to be stop()-ed below) before the channel
    // goes away so the SR session doesn't keep firing into a
    // null mesh.
    stopCaptions();
    await Promise.allSettled([...state.whiteboardSessions.values()].map((s) => s.stop()));
    state.whiteboardSessions.clear();
    state.mesh.disconnect();
    state.mesh = null;
  }
  // Detach the chat view's interval + every listener it installed before
  // dropping the reference, otherwise rejoining accumulates handlers.
  state.chat?.destroy();
  // Await the huddle teardown so unsubscribes complete before the page
  // can navigate / reload — otherwise channels can leak server-side.
  try { await state.huddle?.stop(); } catch {}
  state.huddle = null;
  state.chat = null;
  // Drop the profile-card popover and its document-level mousedown
  // / keydown listeners. Without destroy() the old instance lingers
  // across team rejoins and stacks N copies of the dismissal logic
  // per mousedown.
  state.profileCard?.destroy();
  state.profileCard = null;
  // Drop a redemption hop that never finished (e.g. user signed out
  // mid-load). Otherwise the next sign-in's onWelcome would jump
  // somebody else's session into a stale channel.
  state.pendingInviteHop = null;
  // Same reasoning for buffered protocol URLs: a deep link that was
  // waiting on an active session is stale once we've torn the team
  // down (e.g. user explicitly switched teams via the picker).
  state.pendingProtocolUrl = null;
  state.channelMeta.clear();
  state.unread.clear();
  updateUnreadTitle();
  state.inCallChannelId = null;
  state.lurkingChannelId = null;
  state.callStarting = false;
  // Drop any popout-call markers — they're channel ids from the
  // outgoing team and would otherwise hide Start/Join on rejoin.
  state.poppedOutCalls.clear();
  els.channels.replaceChildren();
  els.dms.replaceChildren();
  els.people.replaceChildren();
  // Clear any leftover toasts so they don't bleed into the login
  // screen of the next session.
  els.toasts?.replaceChildren();
  els.reconnectBanner?.classList.add('hidden');
  resetCallEphemera();
  // The React-popover document listeners are re-registered every time
  // wireControls runs; tear them down here so a different team's
  // wireControls call doesn't pile up handlers on the same document.
  state.reactPopoverCleanup?.();
  state.reactPopoverCleanup = null;
  state.overlayKeyCleanup?.();
  state.overlayKeyCleanup = null;
  state.savePopoverDocCleanup?.();
  state.savePopoverDocCleanup = null;
  // Close any team-scoped overlays so they don't bleed into the next
  // team's session.
  closePinnedDrawer();
  closeImageLightbox();
  closeSavedDrawer();
  closeSavePopover();
  if (state._savedDrawerRefreshTimer) {
    clearTimeout(state._savedDrawerRefreshTimer);
    state._savedDrawerRefreshTimer = null;
  }
  state.savedById.clear();
  refreshSavedSidebarCount();
  if (els.pinnedBtn) els.pinnedBtn.classList.add('hidden');
  els.app.classList.add('hidden');
}

// Toggle the tile-grid visibility based on whether anything lives in
// it. Called from startCall (camera tile), leaveCall (calls drop),
// openWhiteboard (whiteboard tile), removeTile (anything closing),
// and teardownTeam (full reset). Whiteboards are tiles that should
// be visible even when no call is active, which the original PR #14
// hidden-by-default rule accidentally suppressed.
function syncTilesVisibility() {
  const hasContent = state.tilesByKey.size > 0;
  els.tiles.classList.toggle('hidden', !hasContent);
}

// "Leave team" — drop everything, go back to the team picker (still signed in).
async function leave() {
  await teardownTeam();
  els.login.classList.remove('hidden');
  showStep('team');
  await renderMyTeams();
}

// Full sign-out: leave the team, drop the Supabase session, reset to email step.
async function signOutFully() {
  await teardownTeam();
  try { await window.huddleApi.signOut(); } catch {}
  // Clear remembered team so the next signed-in user starts at the
  // team picker (and doesn't auto-resume into someone else's team).
  try { localStorage.removeItem('huddle.lastTeamId'); } catch {}
  state._email = null;
  if (els.authEmail) els.authEmail.value = '';
  if (els.authOtp) els.authOtp.value = '';
  if (els.authPassword) els.authPassword.value = '';
  // Re-collapse the password sub-form so the next sign-in starts on the
  // emailed-code path (and the password field isn't lingering visible).
  if (els.authPasswordBlock) els.authPasswordBlock.classList.add('hidden');
  if (els.authShowPassword) els.authShowPassword.classList.remove('hidden');
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
  // Channels whose call this user popped out are owned by the
  // popout window — hide both Start/Join here so a click in main
  // doesn't rejoin and become a duplicate participant.
  const ownedByPopout = !!channelId && state.poppedOutCalls.has(channelId);
  const lurkerCount = (channelId && state.huddle && !inCallHere)
    ? state.huddle.getCallParticipantCount(channelId) : 0;
  const others = inCallHere ? null : (lurkerCount > 0);
  els.btnStartCall.classList.toggle('hidden', !!inCallHere || !!others || ownedByPopout);
  els.btnJoinCall.classList.toggle('hidden', !!inCallHere || !others || ownedByPopout);
  if (others) {
    // Update the text span inside the button (which sits next to the
    // SVG icon) instead of replacing innerHTML, so we keep the icon.
    const span = els.btnJoinCall.querySelector('span:not(.count)');
    if (span) span.textContent = `Join call`;
    let count = els.btnJoinCall.querySelector('.count');
    if (!count) {
      count = document.createElement('span');
      count.className = 'count';
      els.btnJoinCall.appendChild(count);
    }
    count.textContent = String(lurkerCount);
  }
  els.btnMic.classList.toggle('hidden', !inCallHere);
  els.btnCam.classList.toggle('hidden', !inCallHere);
  els.btnShare.classList.toggle('hidden', !inCallHere);
  els.btnHand?.classList.toggle('hidden', !inCallHere);
  els.btnReact?.classList.toggle('hidden', !inCallHere);
  if (!inCallHere) els.reactPopover?.classList.add('hidden');
  els.btnJira.classList.toggle('hidden', !inCallHere);
  // CC visible only when in a call AND the runtime exposes Web Speech.
  // We hide outside calls so the post-call summary doesn't show the
  // toggle while there's nothing to caption.
  const ccSupported = !!window.HuddleTranscript?.TranscriptManager?.isSupported();
  els.btnCc?.classList.toggle('hidden', !inCallHere || !ccSupported);
  els.btnPopoutCall.classList.toggle('hidden', !inCallHere);
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
  state.raisedHands.delete(peerId);
  if (state.speakingPeer === peerId) setSpeakingPeer(null);
  // Drop any screen tiles owned by this peer too.
  for (const [key, tile] of state.tilesByKey.entries()) {
    if (key.startsWith('screen:') && tile.dataset.fromId === peerId) {
      removeTile(key);
    }
  }
}

function onMemberOffline(peerId) {
  // Don't remove the row — offline teammates have to stay visible
  // so they can be DMed. Re-render so the now-offline member sinks
  // to the bottom of the sorted list with a grey dot.
  renderRoster();
}

function onCallPresence({ channelId, count }) {
  // Track the previous count so we can spot a call going from nobody to
  // somebody. The first event we see for a channel is its initial
  // presence sync (or a post-leaveCall re-sync) — not a transition — so
  // never treat that one as "a call started".
  const known = state.callCounts.has(channelId);
  const prev = state.callCounts.get(channelId) || 0;
  state.callCounts.set(channelId, count);
  if (state.chat?.currentChannel === channelId) renderCallHeader();
  const justStarted = known && prev === 0 && count > 0;
  const active = state.chat?.currentChannel === channelId && windowFocused;
  if (justStarted
      && channelId !== state.inCallChannelId
      && !state.poppedOutCalls.has(channelId)
      && !isChannelMuted(channelId)
      && !active) {
    notifyCallStarted(channelId);
  }
}

function notifyCallStarted(channelId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const channel = state.channelMeta.get(channelId);
  // displayLabelFor gives "# general" / "🔒 secret" / "@ Alice" — the
  // same labels the sidebar uses, so DM calls name the person.
  const where = channel ? displayLabelFor(channel) : `#${channelId}`;
  try {
    const n = new Notification(`Call started in ${where}`, {
      body: 'Click to join.',
      tag: `call:${channelId}`, // collapse repeat alerts for the same call
      silent: false,
    });
    n.onclick = () => { window.focus(); focusChannel(channelId); n.close(); };
  } catch (err) { console.warn('call notification failed', err); }
}

// ---------------------------------------------------------------------------
// Channels & DMs
// ---------------------------------------------------------------------------

function onWelcome({ peers, channels }) {
  els.channels.replaceChildren();
  els.dms.replaceChildren();
  state.channelMeta.clear();
  for (const c of channels) appendChannelToSidebar(c, false);
  // Roster was loaded synchronously inside huddle.start before the
  // welcome dispatched, so render the full list here. Online status
  // is overlaid from peerInfo (which `peers` is the snapshot of).
  renderRoster();
  // Seed the saved-message cache once we know the team is up. The
  // sidebar count + bookmark indicators read from this; realtime keeps
  // it current after the first load.
  refreshSavedCache().catch((err) => console.warn('saved cache seed failed', err));
  // If we just redeemed an invite link with a channel/call hop,
  // jump straight there instead of landing on #general. Falls back
  // to the normal default-channel logic if the target isn't visible
  // (e.g. the link pointed at a private channel the user wasn't
  // explicitly invited to).
  if (consumePendingInviteHop()) {
    // Drain any buffered protocol URL too — cold-start where the
    // session auto-resumed into a previous team can leave a
    // huddle:// URL pointing at a *different* team waiting.
    drainPendingProtocolUrl();
    return;
  }
  // Activate the general channel by default.
  const generalLi = els.channels.querySelector('[data-id="general"]');
  if (generalLi) generalLi.click();
  else if (state.channelMeta.size > 0) {
    const first = [...state.channelMeta.keys()][0];
    focusChannel(first);
  }
  drainPendingProtocolUrl();
}

function drainPendingProtocolUrl() {
  if (!state.pendingProtocolUrl) return;
  const url = state.pendingProtocolUrl;
  state.pendingProtocolUrl = null;
  // Defer to a microtask so the channel-focus / startCall above
  // settles before the protocol path potentially prompts to
  // switch teams.
  setTimeout(() => handleProtocolUrl(url), 0);
}

function consumePendingInviteHop() {
  const hop = state.pendingInviteHop;
  if (!hop) return false;
  state.pendingInviteHop = null;
  const target = state.channelMeta.get(hop.channelId);
  if (!target) {
    showToast(`Channel #${hop.channelId} isn’t available on this team.`, { kind: 'error' });
    return false;
  }
  focusChannel(hop.channelId);
  if (hop.joinCall) {
    // startCall depends on huddle being constructed AND
    // currentChannel being set — focusChannel did the latter.
    // Defer to a microtask so the call header has rendered before
    // we blow it away with the in-call layout.
    setTimeout(() => startCall(hop.channelId), 0);
  }
  return true;
}

function appendChannelToSidebar(channel, makeActive) {
  // Preserve membership info we may already have: a realtime `channels` INSERT
  // echo doesn't carry memberIds/members, so blindly overwriting would clobber
  // the richer meta we just got back from createDm/createGroupDm.
  const prev = state.channelMeta.get(channel.id);
  if (prev && !channel.memberIds && prev.memberIds) {
    channel = { ...channel, memberIds: prev.memberIds, members: prev.members };
  }
  state.channelMeta.set(channel.id, channel);
  const isDm = channel.type === 'dm';
  const list = isDm ? els.dms : els.channels;
  if (list.querySelector(`[data-id="${cssEscape(channel.id)}"]`)) return;
  // First time we're rendering this channel: start a call-presence
  // lurker for it (idempotent — cached per topic) so a call starting
  // anywhere can pop a desktop notification, not just in the channel
  // you happen to be viewing. joinCall() drops the lurker for the
  // channel you actually join; leaveCall() puts it back.
  state.huddle?.watchCallPresence(channel.id).catch(() => {});

  const li = document.createElement('li');
  li.dataset.id = channel.id;
  // Sidebar muted-channel styling: dimmer text + a small bell-slash
  // suffix in CSS. The class is toggled by toggleCurrentChannelMute
  // when the user flips the per-channel toggle.
  if (isChannelMuted(channel.id)) li.classList.add('muted');
  else if (isChannelNotifyAll(channel.id)) li.classList.add('notify-all');

  const label = document.createElement('span');
  label.className = 'ch-name';
  label.textContent = displayLabelFor(channel);
  li.appendChild(label);

  // Unread badge slot — populated by updateUnreadBadge().
  const badge = document.createElement('span');
  badge.className = 'ch-badge';
  badge.style.display = 'none';
  li.appendChild(badge);

  if (isGroupDm(channel)) {
    // Group DMs get "add people" + "leave" rather than a delete-for-everyone.
    const add = document.createElement('button');
    add.className = 'ch-delete';
    add.title = 'Add people';
    add.setAttribute('aria-label', 'Add people');
    add.textContent = '+';
    add.onclick = (e) => {
      e.stopPropagation();
      openDmPicker({ mode: 'add', channel: state.channelMeta.get(channel.id) || channel });
    };
    li.appendChild(add);
    const leave = document.createElement('button');
    leave.className = 'ch-delete';
    leave.title = 'Leave group';
    leave.setAttribute('aria-label', 'Leave group');
    leave.innerHTML = window.HuddleIcons.x;
    leave.onclick = async (e) => {
      e.stopPropagation();
      const label = dmLabelFor(state.channelMeta.get(channel.id) || channel);
      if (!confirm(`Leave "${label}"? You won't get new messages unless someone adds you back.`)) return;
      try {
        await state.huddle.leaveDmChannel(channel.id);
      } catch (err) {
        console.warn('leaveDmChannel failed', err);
        showCallError(`Could not leave the group: ${err?.message || err}`);
      }
    };
    li.appendChild(leave);
  } else if (canDelete(channel)) {
    const del = document.createElement('button');
    del.className = 'ch-delete';
    del.title = isDm ? 'Close DM' : 'Delete channel';
    del.setAttribute('aria-label', del.title);
    del.innerHTML = window.HuddleIcons.x;
    del.onclick = async (e) => {
      e.stopPropagation();
      const verb = isDm ? 'Close' : 'Delete';
      const target = isDm ? `your DM with ${displayLabelFor(channel).replace(/^[@👥]\s*/, '')}` : `#${channel.name}`;
      if (!confirm(`${verb} ${target}? This is permanent.`)) return;
      try {
        await state.huddle.deleteChannel(channel.id);
      } catch (err) {
        console.warn('deleteChannel failed', err);
        showCallError(`Could not ${verb.toLowerCase()} ${target}: ${err?.message || err}`);
      }
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
  refreshPinnedCount();
  closePinnedDrawer();
  // Make sure this channel's call presence is being watched (it always
  // should be — appendChannelToSidebar starts a lurker for every channel
  // so call-started notifications work everywhere — but a freshly added
  // channel or a post-leaveCall re-watch could be racing, and the call
  // is idempotent). The active call (if any) keeps its own non-lurker
  // subscription instead.
  if (state.huddle && channelId !== state.inCallChannelId) {
    state.lurkingChannelId = channelId;
    state.huddle.watchCallPresence(channelId).catch(() => {});
  } else {
    state.lurkingChannelId = null;
  }
  renderCallHeader();
  refreshMuteButton();
  refreshNotifyAllButton();
  // Visiting a channel clears its unread.
  state.unread.delete(channelId);
  updateUnreadBadge(channelId);
  updateUnreadTitle();
}

// On window focus, clear unread for the channel we're already viewing.
function clearUnreadIfActive() {
  if (!state.chat || !state.huddle) return;
  const id = state.chat.currentChannel;
  if (state.unread.has(id)) {
    state.unread.delete(id);
    updateUnreadBadge(id);
    updateUnreadTitle();
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
  updateUnreadTitle();
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
  // Mentions / DMs render as the loud red badge; plain channel
  // chatter is muted. Per-channel mute also forces the muted
  // styling regardless of mention status — the user explicitly
  // asked for this channel to stop being loud.
  const channel = state.channelMeta.get(channelId);
  const channelMuted = isChannelMuted(channelId);
  const loud = !channelMuted && (u.mentions > 0 || channel?.type === 'dm');
  badge.classList.toggle('muted', !loud);
  updateUnreadTitle();
}

// Sum the "loud" unreads (mentions + DMs) across every channel and
// prefix the window title with the count. The OS dock / taskbar
// shows the prefix in any window-list view, so the user sees
// attention-required at a glance even when Huddle isn't focused.
// Plain-channel chatter is intentionally excluded so the title
// doesn't scream every time anyone posts anywhere.
function updateUnreadTitle() {
  // Popout windows have their own title (the call / whiteboard
  // they're showing) — skip the unread prefix for them.
  if (document.body.classList.contains('popout')) return;
  const base = state.huddle?.team?.name
    ? `Huddle — ${state.huddle.team.name}`
    : 'Huddle';
  let loudCount = 0;
  for (const [channelId, u] of state.unread) {
    if (isChannelMuted(channelId)) continue;
    const channel = state.channelMeta.get(channelId);
    // DMs count every unread message (the whole conversation is
    // for you). Channels only count direct @mentions — getting
    // the full chatter count would scream every time a busy
    // channel sees one mention buried in fifty messages.
    if (channel?.type === 'dm') loudCount += u.count;
    else if (u.mentions > 0) loudCount += u.mentions;
  }
  document.title = loudCount > 0 ? `(${loudCount}) ${base}` : base;
}

// Called by ChatView via the onMessage hook for every inbound chat message
// (including our own echo). Decides whether to bump unread and notify.
function onChatMessage(m) {
  if (!state.huddle) return;
  if (m.authorName === state.myName) return; // ignore our own messages
  const channel = state.channelMeta.get(m.channelId);
  const isDm = channel?.type === 'dm';
  // A message "mentions me" if my name is in `m.mentions`, or — in a
  // public/private channel — it carries a broadcast sentinel (@here /
  // @channel). Broadcast in DMs is redundant since `isDm` already fans the
  // notification out to every member, so we don't double-count it there.
  const mentionsMe = Array.isArray(m.mentions) && (
    m.mentions.includes(state.myName)
    || (!isDm && (m.mentions.includes('@here') || m.mentions.includes('@channel')))
  );
  const isActive = state.chat?.currentChannel === m.channelId && windowFocused;
  const muted = isChannelMuted(m.channelId);
  if (!isActive) bumpUnread(m.channelId, mentionsMe);
  // Muted channels never produce a desktop notification — that's
  // the whole point of the toggle. They still bump the sidebar
  // badge (with muted styling via updateUnreadBadge) so the user
  // can see something happened.
  if (muted) return;
  const shouldNotify = !isActive && (mentionsMe || isDm || isChannelNotifyAll(m.channelId));
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

// Membership of a channel we're in changed (e.g. a group DM grew/shrank).
// Refresh the cached meta and the visible label(s).
function onChannelUpdated({ channelId, memberIds, members } = {}) {
  const ch = state.channelMeta.get(channelId);
  if (!ch) return;
  if (memberIds) ch.memberIds = memberIds;
  if (members) ch.members = members;
  const sel = `[data-id="${cssEscape(channelId)}"]`;
  const li = els.dms.querySelector(sel) || els.channels.querySelector(sel);
  const lbl = li?.querySelector('.ch-name');
  if (lbl) lbl.textContent = displayLabelFor(ch);
  state.chat?.setLabel(channelId, displayLabelFor(ch));
}

// A "group DM" is a type='dm' channel with a `gdm:<uuid>` id (or, defensively,
// one that has grown past two members). 1:1 DMs keep their `dm:<a>::<b>` id.
function isGroupDm(channel) {
  return channel.type === 'dm'
    && (String(channel.id).startsWith('gdm:') || (channel.memberIds?.length || 0) > 2);
}

function displayLabelFor(channel) {
  if (channel.type === 'dm') return `${isGroupDm(channel) ? '👥' : '@'} ${dmLabelFor(channel)}`;
  if (channel.type === 'private') return `🔒 ${channel.name}`;
  return `# ${channel.name}`;
}

// Human label for a DM (1:1 or group). Prefer each member's CURRENT name from
// live presence over the snapshot in channel.members (which is taken at
// creation/load and goes stale after Edit-profile renames). channel.members is
// index-aligned with channel.memberIds. For a 1:1 DM whose member list hasn't
// loaded yet, fall back to parsing the `dm:<a>::<b>` id; channel.name (the
// counterpart's / the group's name at creation) is the last resort.
function dmLabelFor(channel) {
  const me = state.huddle?.peerId;
  const ids = channel.memberIds || [];
  if (ids.length === 1 && ids[0] === me) return 'just you'; // everyone else left a group
  if (ids.length > 1) {
    const names = ids
      .map((id, i) => ({ id, snap: channel.members?.[i] || '' }))
      .filter((x) => x.id !== me)
      .map((x) => state.huddle?.peerInfo.get(x.id)?.name || x.snap || 'someone')
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 1) return names[0];
    if (names.length) return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  }
  const m = /^dm:([0-9a-f-]+)::([0-9a-f-]+)$/.exec(channel.id);
  if (m && me) {
    const otherId = m[1] === me ? m[2] : (m[2] === me ? m[1] : null);
    if (otherId) {
      const live = state.huddle.peerInfo.get(otherId)?.name;
      if (live) return live;
    }
  }
  return channel.name || 'unknown';
}

function canDelete(channel) {
  if (channel.protected) return false;
  // A DM/group channel is only ever in your sidebar because you're a member
  // (RLS on `channels` requires it), so the close/leave control is always
  // available. (Group DMs use a separate "Leave" action — see the sidebar.)
  if (channel.type === 'dm') return true;
  // createdBy is a user uuid; compare against the authenticated user's id,
  // not the display name.
  return channel.createdBy && channel.createdBy === state.huddle?.peerId;
}

// CSS.escape isn't available everywhere; tiny shim for our id alphabet.
function cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c); }

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// Open or focus the DM with another team member. Used by the
// "Direct messages +" picker (intent-driven: clicking a row IS the
// pick, no profile-card detour) and by the profile card's Message
// button. Failures used to log to console.warn only — that's the
// "card → Message does nothing" bug. Surface them as alerts so the
// user knows why nothing happened.
async function openDmWith(userId, name) {
  if (!userId) {
    showCallError('Could not open DM: no user id.');
    return;
  }
  try {
    const channel = await state.huddle.createDm(userId, name);
    onChannelAdded(channel);
    focusChannel(channel.id);
  } catch (err) {
    console.warn('createDm failed', err);
    showCallError('Could not open DM: ' + (err?.message || err));
  }
}

// Wire any element to open the profile card for `userId` on click.
// Used by every UI surface that shows a user's identity (chat author
// rows, sidebar people list, call-tile labels, DM/member pickers) so
// the click semantics are uniform: card pops up, "Message" button on
// the card kicks off the DM. Cursor + hover styling come from the
// `.profile-clickable` class.
function attachProfileTrigger(el, userId) {
  if (!el || !userId) return;
  el.classList.add('profile-clickable');
  el.dataset.profileFor = userId;
  el.addEventListener('click', (e) => {
    // Stop click bubbling so containers (e.g. member-picker rows that
    // toggle a checkbox on row click) don't fire their own handler.
    e.stopPropagation();
    state.profileCard?.show(el, userId);
  });
}

// Roster sort: online first, alphabetical within each group. Self
// always sorts as online — peerInfo deliberately excludes the
// signed-in user, but the user is by definition online with
// respect to themselves.
function sortRosterMembers(members) {
  const me = state.huddle?.peerId;
  return members.sort((a, b) => {
    const aOn = (a.id === me || state.huddle.peerInfo.has(a.id)) ? 0 : 1;
    const bOn = (b.id === me || state.huddle.peerInfo.has(b.id)) ? 0 : 1;
    if (aOn !== bOn) return aOn - bOn;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// Resolve a member's display attributes for rendering. Live presence
// (peerInfo) is preferred over the roster snapshot — it carries the
// most recent name/color the member has broadcast — and offline
// members fall through to the roster row. Self is special-cased:
// peerInfo excludes the signed-in user, so without this branch
// "you" would render as grey + dim.
function resolveMemberDisplay(member) {
  const isSelf = member.id === state.huddle?.peerId;
  if (isSelf) {
    return {
      online: true,
      name: state.huddle.name || member.name,
      color: state.huddle.color || member.color || '',
    };
  }
  const online = state.huddle.peerInfo.has(member.id);
  const live = state.huddle.peerInfo.get(member.id);
  return {
    online,
    name: live?.name || member.name,
    color: online ? (live?.color || member.color || '') : '',
  };
}

// Render the People sidebar from the full team roster. Online
// teammates get a coloured dot, offline ones get a grey dot + dimmed
// text but stay visible so they remain DMable.
function renderRoster() {
  els.people.replaceChildren();
  const members = sortRosterMembers([...state.huddle.roster.values()]);
  for (const m of members) renderRosterRow(m);
}

function renderRosterRow(member) {
  const { online, name, color } = resolveMemberDisplay(member);
  const li = document.createElement('li');
  li.dataset.id = member.id;
  li.dataset.name = name;
  const dot = document.createElement('span');
  dot.className = online ? 'dot online' : 'dot';
  dot.style.background = color;
  li.append(dot, document.createTextNode(name));
  attachProfileTrigger(li, member.id);
  li.title = member.id === state.huddle.peerId
    ? 'You'
    : `View ${name}'s profile${online ? '' : ' (offline)'}`;
  if (!online) li.classList.add('offline');
  els.people.appendChild(li);
}

// Member-online: ensure the row exists in the roster (somebody who
// just joined the team mid-session won't be in our snapshot), then
// re-render the whole list so online users bubble back to the top.
function onMemberOnline(peer) {
  if (!state.huddle.roster.has(peer.id)) {
    state.huddle.roster.set(peer.id, {
      id: peer.id, name: peer.name, color: peer.color, avatar_url: null,
    });
  } else {
    // Update the cached name/color in case they changed since
    // start() loaded the roster.
    const r = state.huddle.roster.get(peer.id);
    r.name = peer.name || r.name;
    r.color = peer.color || r.color;
  }
  renderRoster();
}

// (onMemberOffline + onCallPeerLeft above replace the old onPeerLeft —
// team presence and call presence are now distinct event sources.)

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function makeTile({ key, label, kind, userId }) {
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
  if (userId) attachProfileTrigger(lbl, userId);
  tile.appendChild(lbl);
  if (kind === 'screen' || kind === 'whiteboard') {
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    if (kind === 'screen') {
      const annotate = document.createElement('button');
      annotate.className = 'tile-action-annotate';
      annotate.innerHTML = `${window.HuddleIcons.edit}<span>Annotate</span>`;
      annotate.onclick = () => toggleAnnotate(tile.dataset.streamId);
      actions.appendChild(annotate);
    }
    const spotlight = document.createElement('button');
    spotlight.className = 'tile-action-spotlight';
    spotlight.innerHTML = `${window.HuddleIcons.spotlight}<span>Spotlight</span>`;
    spotlight.onclick = () => toggleSpotlight(key);
    actions.appendChild(spotlight);
    tile.appendChild(actions);
  }
  els.tiles.appendChild(tile);
  state.tilesByKey.set(key, tile);
  // Reveal the tile grid as soon as anything lives in it. This covers
  // local cam (startCall), remote cam (commitStreamAsCamera), screen
  // shares (renderRemoteScreen / addLocalScreenTile), and whiteboards.
  syncTilesVisibility();
  return tile;
}

function removeTile(key) {
  const tile = state.tilesByKey.get(key);
  if (tile) tile.remove();
  state.tilesByKey.delete(key);
  if (state.spotlightKey === key) clearSpotlight();
  syncTilesVisibility();
}

// Spotlight: stage one screen/whiteboard tile in the main column with the
// rest stacked in a side rail. Local UI state only — no broadcast, since
// each viewer chooses their own focus.
function toggleSpotlight(key) {
  if (state.spotlightKey === key) { clearSpotlight(); return; }
  if (state.spotlightKey) {
    const prev = state.tilesByKey.get(state.spotlightKey);
    if (prev) prev.classList.remove('spotlighted');
  }
  const tile = state.tilesByKey.get(key);
  if (!tile) return;
  tile.classList.add('spotlighted');
  els.tiles.classList.add('has-spotlight');
  state.spotlightKey = key;
}

function clearSpotlight() {
  if (!state.spotlightKey) return;
  const tile = state.tilesByKey.get(state.spotlightKey);
  if (tile) tile.classList.remove('spotlighted');
  els.tiles.classList.remove('has-spotlight');
  state.spotlightKey = null;
}

// ---------------------------------------------------------------------------
// In-call presence: active speaker, raise hand, reactions
// ---------------------------------------------------------------------------

// Resolve a peerId to its camera tile. The local user shows up as
// `self-cam` rather than `peer:<id>`, so callers don't have to special-case.
function tileForPeer(peerId) {
  if (peerId === state.huddle?.peerId) return state.tilesByKey.get('self-cam');
  return state.tilesByKey.get(`peer:${peerId}`);
}

const SPEAKER_POLL_MS = 750;
// audioLevel is reported in [0, 1]. Empirically anything below ~0.05 is
// room noise / breath; staying above the threshold is what we treat as
// "talking" rather than picking the nominal max regardless.
const SPEAKER_LEVEL_THRESHOLD = 0.05;

// Walk every peer connection's inbound audio receiver, plus the local
// audio sender's media-source, and surface the loudest peer. Cheap
// (one stats fetch per pc per tick) and entirely local — no signaling.
function startSpeakerPolling() {
  stopSpeakerPolling();
  state.speakerPollTimer = setInterval(pollActiveSpeaker, SPEAKER_POLL_MS);
}

function stopSpeakerPolling() {
  if (state.speakerPollTimer) clearInterval(state.speakerPollTimer);
  state.speakerPollTimer = null;
  setSpeakingPeer(null);
}

async function pollActiveSpeaker() {
  if (!state.mesh) return;
  // Re-entrancy guard: a slow getStats() round (large mesh, busy machine)
  // can take longer than the poll interval. Two overlapping passes would
  // race to call setSpeakingPeer with stale snapshots and produce flicker.
  if (state._speakerPollInFlight) return;
  state._speakerPollInFlight = true;
  try { await collectSpeakerSamples(); }
  finally { state._speakerPollInFlight = false; }
}

async function collectSpeakerSamples() {
  const samples = []; // [peerId, level]
  // Local mic level via any peer connection's outbound audio media-source.
  const someConn = state.mesh.peers.values().next().value;
  if (someConn) {
    try {
      const stats = await someConn.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
          samples.push([state.huddle.peerId, r.audioLevel]);
        }
      });
    } catch (err) { console.warn('[speaker-poll] local stats failed', err); }
  }
  // Remote peers via each pc's inbound audio.
  for (const [peerId, conn] of state.mesh.peers) {
    try {
      const stats = await conn.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
          samples.push([peerId, r.audioLevel]);
        }
      });
    } catch (err) { console.warn('[speaker-poll] peer stats failed', err); }
  }
  if (samples.length === 0) { setSpeakingPeer(null); return; }
  samples.sort((a, b) => b[1] - a[1]);
  const [peerId, level] = samples[0];
  setSpeakingPeer(level >= SPEAKER_LEVEL_THRESHOLD ? peerId : null);
}

function setSpeakingPeer(peerId) {
  if (state.speakingPeer === peerId) return;
  if (state.speakingPeer) {
    const prev = tileForPeer(state.speakingPeer);
    if (prev) prev.classList.remove('speaking');
  }
  state.speakingPeer = peerId;
  if (peerId) {
    const tile = tileForPeer(peerId);
    if (tile) tile.classList.add('speaking');
  }
}

// Raise hand: maintained as a Set of peerIds locally. Self toggles via the
// control-bar button; remote peers emit raise-hand broadcasts that flow in
// here. The DOM badge attaches to the peer's camera tile (or self-cam).
function setHandRaised(peerId, raised) {
  if (raised) state.raisedHands.add(peerId);
  else state.raisedHands.delete(peerId);
  const tile = tileForPeer(peerId);
  if (!tile) return;
  let badge = tile.querySelector('.tile-hand');
  if (raised && !badge) {
    badge = document.createElement('div');
    badge.className = 'tile-hand';
    badge.textContent = '✋';
    tile.appendChild(badge);
  } else if (!raised && badge) {
    badge.remove();
  }
}

function toggleSelfHand() {
  if (!state.mesh) return;
  const peerId = state.huddle.peerId;
  const next = !state.raisedHands.has(peerId);
  setHandRaised(peerId, next);
  state.mesh.sendRaiseHand(next);
  els.btnHand.classList.toggle('active', next);
}

function onRemoteRaiseHand({ from, raised }) {
  setHandRaised(from, !!raised);
}

// Mic / cam state for remote peers (and the local self-cam tile, called
// from the toggle handlers). Driven by the call channel's `mute-state`
// broadcast — `track.enabled = false` doesn't show up on the receiver
// side, so this is the only signal the renderer has for muted / camera-
// off remote peers.
function setPeerMicOn(peerId, micOn) {
  const tile = tileForPeer(peerId);
  if (!tile) return;
  tile.classList.toggle('muted', !micOn);
}

function setPeerCamOn(peerId, camOn) {
  const tile = tileForPeer(peerId);
  if (!tile) return;
  tile.classList.toggle('cam-off', !camOn);
  if (!camOn) ensureCamOffOverlay(tile, peerId);
}

// The overlay is what users see in place of the (black) video when a
// peer turns their camera off — a colored avatar circle with their
// initial and their name underneath. Built lazily on first cam-off and
// kept in the DOM so re-enabling the cam (CSS hides the overlay via the
// .cam-off class) is a single class flip with no rebuild.
function ensureCamOffOverlay(tile, peerId) {
  if (tile.querySelector('.tile-cam-off')) return;
  const isSelf = peerId === state.huddle?.peerId;
  const peer = isSelf
    ? { name: state.huddle.name, color: state.huddle.color }
    : state.huddle?.peerInfo.get(peerId) || state.huddle?.callPeerInfo?.get(peerId) || {};
  const name = peer.name || 'guest';
  const color = peer.color || '#666';
  const overlay = document.createElement('div');
  overlay.className = 'tile-cam-off';
  const avatar = document.createElement('div');
  avatar.className = 'tile-cam-off-avatar';
  avatar.style.background = color;
  avatar.textContent = (name || '?').slice(0, 1).toUpperCase();
  const label = document.createElement('div');
  label.className = 'tile-cam-off-name';
  label.textContent = isSelf ? `${name} (you)` : name;
  overlay.append(avatar, label);
  tile.appendChild(overlay);
}

function onRemoteMuteState({ from, micOn, camOn }) {
  setPeerMicOn(from, !!micOn);
  setPeerCamOn(from, !!camOn);
}

// Reactions: ephemeral floating emoji over the sender's tile. Each reaction
// has its own independent timer (rapid follow-ups intentionally coexist —
// the CSS jitter offsets them so they don't perfectly stack). The Map keeps
// the active timer ids so leaveCall can bulk-cancel them.
const REACTION_TTL_MS = 2400;
// Single source of truth for the quick-reaction emoji set; both the main-
// window popover (built in wireReactPopover) and the popout-window popover
// (built in bootCallPopout) iterate this list. Keep the order — that's the
// order they render in the chip.
const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉'];

function showReaction(peerId, emoji) {
  const tile = tileForPeer(peerId);
  if (!tile) return;
  const node = document.createElement('div');
  node.className = 'tile-reaction';
  node.textContent = emoji;
  // Slight horizontal jitter so back-to-back reactions don't perfectly overlap.
  node.style.setProperty('--rx-offset', `${Math.floor(Math.random() * 40 - 20)}px`);
  tile.appendChild(node);
  state.reactionTimers.set(node, setTimeout(() => {
    node.remove();
    state.reactionTimers.delete(node);
  }, REACTION_TTL_MS));
}

function onRemoteReaction({ from, emoji }) {
  showReaction(from, emoji);
}

function clearAllReactions() {
  for (const t of state.reactionTimers.values()) clearTimeout(t);
  state.reactionTimers.clear();
  for (const node of els.tiles.querySelectorAll('.tile-reaction')) node.remove();
}

// ---------------------------------------------------------------------------
// Pinned drawer + image lightbox
// ---------------------------------------------------------------------------

function openImageLightbox(url, alt) {
  if (!els.imageLightbox || !els.imageLightboxImg) return;
  els.imageLightboxImg.src = url;
  els.imageLightboxImg.alt = alt || '';
  els.imageLightbox.classList.remove('hidden');
  els.imageLightbox.setAttribute('aria-hidden', 'false');
}

function closeImageLightbox() {
  if (!els.imageLightbox) return;
  els.imageLightbox.classList.add('hidden');
  els.imageLightbox.setAttribute('aria-hidden', 'true');
  // Drop the src so a closed lightbox doesn't keep a large image in
  // memory. Setting to '' triggers a load error in some browsers; use
  // the 1×1 transparent PNG instead.
  els.imageLightboxImg.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
}

// Render the pinned-messages drawer. Each row reuses the markdown
// renderer for body content but stays read-only — clicking a row
// scrolls the main pane to the original message and flashes it.
function renderPinnedDrawer(messages, onPick) {
  if (!els.pinnedDrawer || !els.pinnedList) return;
  els.pinnedList.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pinned-empty';
    empty.textContent = 'No pinned messages in this channel yet.';
    els.pinnedList.appendChild(empty);
  }
  for (const m of messages) {
    const row = document.createElement('button');
    row.className = 'pinned-item';
    row.type = 'button';
    const head = document.createElement('div');
    head.className = 'pinned-item-head';
    head.textContent = `${m.authorName} · ${new Date(m.ts).toLocaleString()}`;
    const body = document.createElement('div');
    body.className = 'pinned-item-body';
    // renderMarkdown sanitizes HTML, so prefer it. If the dependency
    // ever loaded out of order, fall back to textContent — never raw
    // innerHTML — so a malformed message body can't ship an XSS payload.
    if (window.renderMarkdown) body.innerHTML = window.renderMarkdown(m.text || '');
    else body.textContent = m.text || '';
    row.append(head, body);
    row.onclick = () => onPick?.(m.id);
    els.pinnedList.appendChild(row);
  }
  els.pinnedDrawer.classList.remove('hidden');
  els.pinnedDrawer.setAttribute('aria-hidden', 'false');
}

function closePinnedDrawer() {
  if (!els.pinnedDrawer) return;
  els.pinnedDrawer.classList.add('hidden');
  els.pinnedDrawer.setAttribute('aria-hidden', 'true');
}

// Update the channel-header pin chip with the current pinned count.
// Cheap count-only query (indexed partial scan) — fired from focusChannel
// + on chat-update so pin/unpin keeps the badge accurate without
// fetching full message rows.
async function refreshPinnedCount() {
  if (!els.pinnedBtn || !state.chat?.currentChannel || !state.huddle) return;
  const n = await state.huddle.pinnedMessageCount(state.chat.currentChannel);
  els.pinnedBtn.classList.toggle('hidden', n === 0);
  els.pinnedCount.textContent = String(n);
}

// ---------------------------------------------------------------------------
// Saved messages: per-user bookmarks with arbitrary labels
// ---------------------------------------------------------------------------

// Seed the local cache + sidebar count from the DB on welcome. Realtime
// keeps it current after that.
async function refreshSavedCache() {
  if (!state.huddle) return;
  state.savedById.clear();
  const rows = await state.huddle.loadSavedMessages({ limit: 500 });
  for (const r of rows) state.savedById.set(r.save.messageId, r.save);
  refreshSavedSidebarCount();
  // Re-render any visible message rows so their bookmark indicators
  // catch up to the now-populated cache.
  if (state.chat) state.chat.refreshAllMessages?.();
}

function refreshSavedSidebarCount() {
  if (!els.savedCount) return;
  const n = state.savedById.size;
  els.savedCount.textContent = String(n);
}

// Realtime fan-in. The HuddleClient dispatches one of three events per
// row mutation; mirror them into state.savedById and refresh the
// surfaces that read from it. Keeping the local cache + DOM in lockstep
// here means the renderer never has to await a roundtrip when toggling
// a save from the popover.
function onSavedMessageChange(kind, payload) {
  if (kind === 'add' || kind === 'update') {
    state.savedById.set(payload.messageId, payload);
  } else if (kind === 'remove') {
    state.savedById.delete(payload.messageId);
  }
  refreshSavedSidebarCount();
  // The bookmark in the message hover-actions is read from
  // hooks.isMessageSaved at render time, so refresh the affected row(s).
  if (state.chat) state.chat.refreshMessageById?.(payload.messageId);
  // Coalesce drawer re-renders. Bursty events (bulk unsave, label
  // refile across many rows) would otherwise trigger one re-fetch per
  // row; a single trailing render after the burst is sufficient.
  if (els.savedDrawer && !els.savedDrawer.classList.contains('hidden')) {
    if (state._savedDrawerRefreshTimer) clearTimeout(state._savedDrawerRefreshTimer);
    state._savedDrawerRefreshTimer = setTimeout(() => {
      state._savedDrawerRefreshTimer = null;
      renderSavedDrawer();
    }, 100);
  }
  if (state.savePopoverTarget === payload.messageId) {
    renderSavePopoverLabels();
  }
}

async function openSavedDrawer() {
  state.savedActiveLabel = null;
  await renderSavedDrawer();
  els.savedDrawer.classList.remove('hidden');
  els.savedDrawer.setAttribute('aria-hidden', 'false');
}

function closeSavedDrawer() {
  if (!els.savedDrawer) return;
  els.savedDrawer.classList.add('hidden');
  els.savedDrawer.setAttribute('aria-hidden', 'true');
}

// Render the chip rail (label filters) and the list of saved rows.
// Re-fetches from the DB so labels removed elsewhere disappear from
// the rail; the row list comes back filtered by state.savedActiveLabel
// when one is selected.
// Distinct label set across the cached saves. Replaces the round-trip
// loadSavedLabels query — we already keep the full save corpus in
// state.savedById (seeded with limit:500 on welcome and kept current
// by realtime), so a Set computed locally is faster and zero-network.
function distinctSavedLabels() {
  const set = new Set();
  for (const save of state.savedById.values()) {
    for (const l of save.labels || []) set.add(l);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function renderSavedDrawer() {
  if (!state.huddle) return;
  const labels = distinctSavedLabels();
  els.savedLabels.replaceChildren();
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'saved-label-chip' + (state.savedActiveLabel == null ? ' active' : '');
  all.textContent = `All (${state.savedById.size})`;
  all.onclick = () => { state.savedActiveLabel = null; renderSavedDrawer(); };
  els.savedLabels.appendChild(all);
  for (const label of labels) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'saved-label-chip' + (state.savedActiveLabel === label ? ' active' : '');
    chip.textContent = label;
    chip.onclick = () => { state.savedActiveLabel = label; renderSavedDrawer(); };
    els.savedLabels.appendChild(chip);
  }
  const rows = await state.huddle.loadSavedMessages({ label: state.savedActiveLabel || undefined, limit: 200 });
  els.savedList.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pinned-empty';
    empty.textContent = state.savedActiveLabel
      ? `No saves under "${state.savedActiveLabel}".`
      : 'No saved messages yet. Hover a message and click the bookmark to save it.';
    els.savedList.appendChild(empty);
    return;
  }
  for (const { save, message } of rows) {
    // The row itself is the click target (role=button + tabindex). The
    // body holds rendered markdown which can include block-level
    // elements (<p>, <pre>, etc.); putting that inside a real <button>
    // would violate HTML's phrasing-content rule, so the row stays a
    // <div> with explicit accessibility attrs.
    const row = document.createElement('div');
    row.className = 'saved-item';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    const goToMessage = () => {
      closeSavedDrawer();
      focusChannel(save.channelId);
      state.chat?.scrollToMessage(message.id);
    };
    row.onclick = (ev) => {
      // Don't navigate when the user clicked one of the inline action
      // buttons (Labels / Unsave) — those bubble through to the row.
      if (ev.target.closest('.saved-item-edit, .saved-item-unsave')) return;
      goToMessage();
    };
    row.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goToMessage(); }
    };
    const head = document.createElement('div');
    head.className = 'saved-item-head';
    const channelLabel = state.channelMeta.get(save.channelId);
    const channelText = channelLabel ? displayLabelFor(channelLabel) : `#${save.channelId}`;
    head.textContent = `${message.authorName} · ${channelText} · ${new Date(message.ts).toLocaleString()}`;
    const body = document.createElement('div');
    body.className = 'saved-item-body';
    if (window.renderMarkdown) body.innerHTML = window.renderMarkdown(message.text || '');
    else body.textContent = message.text || '';
    const meta = document.createElement('div');
    meta.className = 'saved-item-meta';
    for (const label of save.labels || []) {
      const chip = document.createElement('span');
      chip.className = 'saved-item-label';
      chip.textContent = label;
      meta.appendChild(chip);
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost saved-item-edit';
    edit.title = 'Edit labels';
    edit.innerHTML = `${window.HuddleIcons.tag}<span>Labels</span>`;
    edit.onclick = (ev) => openSavePopover({
      messageId: message.id,
      teamId: save.teamId,
      channelId: save.channelId,
      anchor: ev.currentTarget,
    });
    const unsave = document.createElement('button');
    unsave.type = 'button';
    unsave.className = 'ghost saved-item-unsave';
    unsave.title = 'Unsave';
    unsave.innerHTML = window.HuddleIcons.bookmark;
    unsave.onclick = async () => {
      try { await state.huddle.unsaveMessage(message.id); }
      catch (err) { showCallError('Could not unsave: ' + (err?.message || err)); }
    };
    meta.appendChild(edit);
    meta.appendChild(unsave);
    row.append(head, body, meta);
    els.savedList.appendChild(row);
  }
}

// Save popover: anchored to the bookmark button in a message's
// hover-actions strip, OR to the Edit-labels chip in the saved drawer.
// Uses the same UI for both because the operation is the same: replace
// this message's saved row with a new label set (or remove it).
function openSavePopover({ messageId, teamId, channelId, anchor }) {
  if (!els.savePopover) return;
  state.savePopoverTarget = messageId;
  state.savePopoverTeamId = teamId || state.huddle?.team?.id;
  state.savePopoverChannelId = channelId;
  // Position the popover near the anchor, clamped to the viewport so a
  // hover-action button at the top of the stage doesn't push it off-
  // screen. Width is fixed-ish (260px) — the height grows with labels.
  const r = anchor?.getBoundingClientRect?.();
  if (r) {
    const top = Math.min(window.innerHeight - 320, Math.max(8, r.bottom + 6));
    const left = Math.min(window.innerWidth - 280, Math.max(8, r.left - 200));
    els.savePopover.style.top = `${top}px`;
    els.savePopover.style.left = `${left}px`;
  }
  renderSavePopoverLabels();
  els.savePopover.classList.remove('hidden');
  els.savePopoverNew.value = '';
  els.savePopoverNew.focus();
}

function closeSavePopover() {
  if (!els.savePopover) return;
  els.savePopover.classList.add('hidden');
  state.savePopoverTarget = null;
}

// Render the labels list inside the popover. Each existing label has a
// remove (×) chip; the user's full label corpus gets rendered as
// togglable chips below so they can stack many tags without typing.
function renderSavePopoverLabels() {
  if (!state.savePopoverTarget || !state.huddle) return;
  const messageId = state.savePopoverTarget;
  const current = new Set(state.savedById.get(messageId)?.labels || []);
  // Suggestion corpus comes from the local cache, same as the drawer's
  // chip rail. Avoids a round-trip per popover open.
  const corpus = new Set(distinctSavedLabels());
  els.savePopoverLabels.replaceChildren();
  // Currently-applied labels, with × to remove. These render as filled
  // chips so the "applied" state is visually distinct from the corpus.
  for (const label of current) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'saved-popover-chip applied';
    chip.innerHTML = `<span></span><span aria-hidden="true">×</span>`;
    chip.querySelector('span').textContent = label;
    chip.onclick = () => applyLabelChange(messageId, label, false);
    els.savePopoverLabels.appendChild(chip);
  }
  // Suggested labels from the user's corpus that aren't currently
  // applied. Click to add. Skipped entirely when the user has none yet.
  const suggestable = [...corpus].filter((l) => !current.has(l)).sort();
  if (suggestable.length) {
    const sep = document.createElement('div');
    sep.className = 'saved-popover-sep';
    sep.textContent = 'Suggestions';
    els.savePopoverLabels.appendChild(sep);
    for (const label of suggestable) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'saved-popover-chip';
      chip.textContent = label;
      chip.onclick = () => applyLabelChange(messageId, label, true);
      els.savePopoverLabels.appendChild(chip);
    }
  }
}

async function applyLabelChange(messageId, label, add) {
  const cur = state.savedById.get(messageId);
  const next = new Set(cur?.labels || []);
  if (add) next.add(label); else next.delete(label);
  try {
    await state.huddle.saveMessage({
      teamId: state.savePopoverTeamId,
      channelId: state.savePopoverChannelId,
      messageId,
      labels: [...next],
    });
  } catch (err) {
    // A foreign-key violation here means the saved_messages.message_id
    // target was deleted between rendering it and this save. Nothing to
    // retry; close the popover rather than leave a raw constraint error
    // on screen.
    const PG_FOREIGN_KEY_VIOLATION = '23503';
    if (err?.code === PG_FOREIGN_KEY_VIOLATION) {
      showCallError('That message no longer exists — it may have just been deleted.');
      closeSavePopover();
    } else {
      showCallError('Could not update labels: ' + (err?.message || err));
    }
  }
}

async function addNewLabelFromPopover() {
  const raw = (els.savePopoverNew.value || '').trim();
  if (!raw) return;
  els.savePopoverNew.value = '';
  await applyLabelChange(state.savePopoverTarget, raw, true);
}

async function unsaveFromPopover() {
  const messageId = state.savePopoverTarget;
  if (!messageId) return;
  try {
    await state.huddle.unsaveMessage(messageId);
  } catch (err) {
    showCallError('Could not unsave: ' + (err?.message || err));
  }
  closeSavePopover();
}

// Drop everything that lives only for the duration of an active call:
// the tile grid and all of its overlays/state. Shared between leaveCall
// (call ends, team stays) and teardownTeam (whole team session torn
// down) so both surfaces tear down identically.
function resetCallEphemera() {
  for (const tile of state.tilesByKey.values()) tile.remove();
  state.tilesByKey.clear();
  state.drawLayers.clear();
  for (const p of state.pendingStreams.values()) clearTimeout(p.timer);
  state.pendingStreams.clear();
  closeAnnotate();
  clearSpotlight();
  stopSpeakerPolling();
  state.raisedHands.clear();
  if (els.btnHand) els.btnHand.classList.remove('active');
  clearAllReactions();
  syncTilesVisibility();
}

// Tiny popover anchored to the React button. Click outside or press
// Escape to dismiss; selecting an emoji sends + closes. Returns a
// teardown function that removes the document-level listeners — joining
// a different team re-runs wireControls, so without this the listeners
// would accumulate across team switches.
function wireReactPopover(btn, popover) {
  // Build (or rebuild) the emoji buttons from the single source-of-truth
  // list so the main window and popout always render the same set.
  popover.replaceChildren();
  for (const emoji of REACTION_EMOJI) {
    const e = document.createElement('button');
    e.className = 'react-emoji';
    e.dataset.emoji = emoji;
    e.setAttribute('aria-label', emoji);
    e.textContent = emoji;
    popover.appendChild(e);
  }
  const close = () => popover.classList.add('hidden');
  btn.onclick = (e) => {
    e.stopPropagation();
    popover.classList.toggle('hidden');
  };
  popover.onclick = (e) => {
    const tgt = e.target.closest('[data-emoji]');
    if (!tgt) return;
    if (state.mesh) state.mesh.sendReaction(tgt.dataset.emoji);
    close();
  };
  const onDocClick = (e) => {
    if (popover.classList.contains('hidden')) return;
    if (popover.contains(e.target) || btn.contains(e.target)) return;
    close();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };
}

function addLocalCameraTile(stream, name) {
  const tile = makeTile({ key: 'self-cam', label: `${name} (you)`, kind: 'self', userId: state.huddle.peerId });
  tile.querySelector('video').srcObject = stream;
}

function addLocalScreenTile(stream, label) {
  const key = `screen:${stream.id}`;
  const tile = makeTile({ key, label: `${label} — you`, kind: 'screen' });
  tile.dataset.streamId = stream.id;
  tile.querySelector('video').srcObject = stream;
  attachDrawingLayer(tile, stream.id, /*owner*/ true);
  const stopBtn = document.createElement('button');
  stopBtn.className = 'tile-action-stop';
  stopBtn.title = 'Stop sharing'; stopBtn.setAttribute('aria-label', 'Stop sharing');
  stopBtn.innerHTML = `${window.HuddleIcons.stop}<span>Stop</span>`;
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
  const tile = makeTile({ key, label: peer ? peer.name : 'guest', kind: 'remote', userId: pending.fromId });
  tile.querySelector('video').srcObject = pending.stream;
  // Catch up on hand-raised state in case the broadcast arrived before the tile.
  if (state.raisedHands.has(pending.fromId)) setHandRaised(pending.fromId, true);
  // Catch up on mute / cam state too — same race: the mute-state
  // broadcast can land before the WebRTC track does, and the tile we'd
  // have toggled didn't exist yet.
  const media = state.huddle?.peerMediaState.get(pending.fromId);
  if (media) {
    setPeerMicOn(pending.fromId, media.micOn);
    setPeerCamOn(pending.fromId, media.camOn);
  }
}

function renderRemoteScreen(stream, screen) {
  const key = `screen:${stream.id}`;
  if (state.tilesByKey.has(key)) {
    state.tilesByKey.get(key).querySelector('.tile-label').textContent =
      `${screen.label} — ${screen.fromName}`;
    return;
  }
  const tile = makeTile({ key, label: `${screen.label} — ${screen.fromName}`, kind: 'screen', userId: screen.from });
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
  // The 📝 Note button only applies to whiteboards (notes are
  // persisted per-whiteboard); screen-share annotations don't have
  // a place to store them. Toggle visibility per-surface.
  const isWhiteboard = state.whiteboardSessions.has(streamId);
  els.drawAddNote.classList.toggle('hidden', !isWhiteboard);
  // Zoom controls also only apply to whiteboards (the screen
  // annotation overlay is locked to the underlying video frame).
  els.drawZoomIn.classList.toggle('hidden', !isWhiteboard);
  els.drawZoomOut.classList.toggle('hidden', !isWhiteboard);
  els.drawZoomReset.classList.toggle('hidden', !isWhiteboard);
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
  // Sidebar collapse — persisted across launches so the user's choice
  // sticks. The CSS handles the column-grid swap; we just toggle the
  // attribute on `.app`.
  const initialCollapsed = (() => { try { return localStorage.getItem('huddle.sidebarCollapsed') === '1'; } catch { return false; } })();
  els.app.dataset.sidebarCollapsed = initialCollapsed ? 'true' : 'false';
  els.sidebarToggle.onclick = () => {
    const next = els.app.dataset.sidebarCollapsed !== 'true';
    els.app.dataset.sidebarCollapsed = next ? 'true' : 'false';
    try { localStorage.setItem('huddle.sidebarCollapsed', next ? '1' : '0'); } catch {}
  };

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
    // The SVG icon stays the same; we add a `.muted` class so CSS can
    // overlay a strikethrough and dim the button color, no need to
    // swap DOM content.
    els.btnMic.classList.toggle('muted', !on);
    const tile = state.tilesByKey.get('self-cam');
    if (tile) tile.classList.toggle('muted', !on);
  };
  els.btnCam.onclick = () => {
    if (!state.mesh) return;
    const on = state.mesh.toggleCam();
    els.btnCam.classList.toggle('muted', !on);
    setPeerCamOn(state.huddle.peerId, on);
  };
  els.btnShare.onclick = openSourcePicker;
  // CC button + the panel's X both toggle captions off so the panel
  // visibility and the capture state stay in sync — otherwise you'd
  // get the awkward "X hid the panel but my mic is still being
  // transcribed and broadcast" mode.
  const toggleCaptions = () => (state.cc.on ? stopCaptions() : startCaptions());
  els.btnCc && (els.btnCc.onclick = toggleCaptions);
  els.captionsClose && (els.captionsClose.onclick = () => stopCaptions());
  // Leave the call (drop media + tile grid, keep chat). Held-down "Leave
  // team" is in the sidebar's sign-out menu.
  els.btnLeave.onclick = leaveCall;
  els.btnPopoutCall.onclick = popOutCurrentCall;
  if (els.btnHand) els.btnHand.onclick = toggleSelfHand;
  if (els.pinnedBtn) els.pinnedBtn.onclick = () => state.chat?.openPinnedDrawer();
  if (els.pinnedClose) els.pinnedClose.onclick = closePinnedDrawer;
  if (els.openSaved) els.openSaved.onclick = openSavedDrawer;
  if (els.savedClose) els.savedClose.onclick = closeSavedDrawer;
  if (els.savePopoverAdd) els.savePopoverAdd.onclick = addNewLabelFromPopover;
  if (els.savePopoverNew) els.savePopoverNew.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addNewLabelFromPopover(); } };
  if (els.savePopoverDone) els.savePopoverDone.onclick = closeSavePopover;
  if (els.savePopoverUnsave) els.savePopoverUnsave.onclick = unsaveFromPopover;
  // Click outside the popover closes it. Captured in state so
  // teardownTeam can detach it on team-switch instead of accumulating
  // (same shape as state.reactPopoverCleanup / state.overlayKeyCleanup).
  state.savePopoverDocCleanup?.();
  const onDocClickForSave = (e) => {
    if (!els.savePopover || els.savePopover.classList.contains('hidden')) return;
    if (els.savePopover.contains(e.target)) return;
    // The bookmark / labels-edit buttons toggle the popover via their
    // own onclick; let those open the popover without this outside-
    // click handler racing the open and immediately closing it.
    if (e.target.closest('.msg-action')) return;
    if (e.target.closest('.saved-item-edit')) return;
    closeSavePopover();
  };
  document.addEventListener('click', onDocClickForSave);
  state.savePopoverDocCleanup = () => document.removeEventListener('click', onDocClickForSave);
  if (els.imageLightbox) {
    els.imageLightbox.onclick = (e) => {
      // Click on the backdrop (not the image itself) closes; the image
      // gets pointer-events:auto via CSS and stops propagation when clicked.
      if (e.target === els.imageLightbox) closeImageLightbox();
    };
  }
  // Drop a previous registration first so wireControls re-running on a
  // team switch can't pile up handlers on the document.
  state.overlayKeyCleanup?.();
  const onOverlayKey = (e) => {
    if (e.key !== 'Escape') return;
    if (els.imageLightbox && !els.imageLightbox.classList.contains('hidden')) closeImageLightbox();
    else if (els.savePopover && !els.savePopover.classList.contains('hidden')) closeSavePopover();
    else if (els.savedDrawer && !els.savedDrawer.classList.contains('hidden')) closeSavedDrawer();
    else if (els.pinnedDrawer && !els.pinnedDrawer.classList.contains('hidden')) closePinnedDrawer();
  };
  document.addEventListener('keydown', onOverlayKey);
  state.overlayKeyCleanup = () => document.removeEventListener('keydown', onOverlayKey);
  if (els.btnReact && els.reactPopover) {
    state.reactPopoverCleanup?.();
    state.reactPopoverCleanup = wireReactPopover(els.btnReact, els.reactPopover);
  }
  els.sourceCancel.onclick = () => els.sourcePicker.classList.add('hidden');

  // Invite links — workspace header (team) + channel header (call).
  els.copyTeamLink.onclick = () => {
    const teamId = state.huddle?.team?.id;
    if (!teamId) return;
    copyAndToast(buildTeamInviteLink(teamId), 'Team invite link');
  };
  els.copyCallLink.onclick = () => {
    const teamId = state.huddle?.team?.id;
    const channelId = state.chat?.currentChannel;
    if (!teamId || !channelId) return;
    copyAndToast(buildCallInviteLink(teamId, channelId), 'Call link');
  };

  // Settings
  els.openSettings.onclick = openSettings;
  els.settingsCancel.onclick = closeSettingsAndDiscardPending;
  els.settingsSave.onclick = saveSettings;
  els.setPasswordUpdate.onclick = updatePasswordFromSettings;

  // Avatar picker. The actual upload is deferred to saveSettings so
  // hitting Cancel after picking a file doesn't leave a half-saved
  // avatar lying around in storage.
  // Plain assignment, not addEventListener — wireControls re-runs on every
  // team (re)join, and addEventListener would stack a duplicate handler
  // each time (so the Nth join fires this N times for one file pick).
  els.setAvatarFile.onchange = () => {
    const file = els.setAvatarFile.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showCallError('Avatar is too big (max 2 MB).');
      els.setAvatarFile.value = '';
      return;
    }
    state._pendingAvatarFile = file;
    const reader = new FileReader();
    reader.onload = () => renderAvatarPreview(reader.result, state.huddle?.color, state.huddle?.name);
    reader.readAsDataURL(file);
  };
  els.setAvatarClear.onclick = () => {
    state._pendingAvatarFile = null;
    state._editingAvatarUrl = null;
    els.setAvatarFile.value = '';
    renderAvatarPreview(null, state.huddle?.color, state.huddle?.name);
  };

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
  els.muteChannelBtn.onclick = toggleCurrentChannelMute;
  els.notifyAllBtn.onclick = toggleCurrentChannelNotifyAll;

  // Search
  els.searchBtn.onclick = openSearchModal;
  els.searchCancel.onclick = () => els.searchModal.classList.add('hidden');
  els.searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') runSearch();
    if (e.key === 'Escape') els.searchModal.classList.add('hidden');
  };

  // Mark every channel + DM as read in one go. Iterates the unread
  // map and clears each entry; updateUnreadBadge handles the
  // per-row badge, updateUnreadTitle clears the OS title prefix.
  els.markAllRead.onclick = () => {
    if (state.unread.size === 0) return;
    for (const channelId of [...state.unread.keys()]) {
      state.unread.delete(channelId);
      updateUnreadBadge(channelId);
    }
    updateUnreadTitle();
    showToast('All channels marked read');
  };

  // Create-channel modal
  els.addChannel.onclick = openCreateChannelModal;
  els.ccCancel.onclick = () => els.ccModal.classList.add('hidden');
  els.ccPrivate.onchange = () => {
    els.ccMembersWrap.classList.toggle('hidden', !els.ccPrivate.checked);
    if (els.ccPrivate.checked) renderMemberPicker(els.ccMembers);
  };
  els.ccCreate.onclick = submitCreateChannel;
  els.ccName.onkeydown = (e) => { if (e.key === 'Enter' && !els.ccPrivate.checked) submitCreateChannel(); };

  // DM picker
  els.addDm.onclick = () => openDmPicker();
  els.dmStart.onclick = submitDmPicker;
  els.dmCancel.onclick = () => els.dmPicker.classList.add('hidden');

  wireDrawToolbar();
}

// Drawing toolbar wiring. Extracted out of setupListeners so the
// call popout (which doesn't run setupListeners) can call it after
// reparenting #draw-toolbar into popout-stage.
function wireDrawToolbar() {
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
  // Sticky note button — only meaningful for whiteboards (the toolbar
  // is also used for screen-share annotations, which don't support
  // notes). The button visibility toggles from toggleAnnotate based on
  // whether the active surface is a whiteboard.
  els.drawAddNote.onclick = () => {
    const session = state.whiteboardSessions.get(state.activeAnnotation);
    if (session) session.addNote();
  };
  // Zoom + reset operate on the active whiteboard session's
  // InfiniteCanvas. Buttons are hidden when no whiteboard is the
  // active annotation surface (toggleAnnotate sets visibility).
  els.drawZoomIn.onclick = () => state.whiteboardSessions.get(state.activeAnnotation)?.zoomIn();
  els.drawZoomOut.onclick = () => state.whiteboardSessions.get(state.activeAnnotation)?.zoomOut();
  els.drawZoomReset.onclick = () => state.whiteboardSessions.get(state.activeAnnotation)?.resetViewport();
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
  // Roster (all teammates), not peerInfo (online only) — channel
  // invites should reach offline teammates too.
  const members = sortRosterMembers(
    [...state.huddle.roster.values()].filter((m) => m.id !== state.huddle.peerId),
  );
  if (members.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No other teammates yet.';
    container.appendChild(empty);
    return;
  }
  for (const m of members) {
    const { online, name, color } = resolveMemberDisplay(m);
    const row = document.createElement('div');
    row.className = 'row' + (online ? '' : ' offline');
    row.dataset.name = name;
    const dot = document.createElement('span');
    dot.className = online ? 'dot online' : 'dot';
    dot.style.background = color;
    const check = document.createElement('span');
    check.className = 'check';
    const lbl = document.createElement('span');
    lbl.textContent = name;
    row.append(dot, lbl, check);
    row.onclick = () => {
      const selected = row.classList.toggle('selected');
      check.innerHTML = selected ? window.HuddleIcons.check : '';
    };
    attachProfileTrigger(lbl, m.id);
    container.appendChild(row);
  }
}

// The DM picker is multi-select: pick one teammate for a 1:1, or several for
// a group DM. Reused in "add" mode to pull more people into an existing group
// (opts = { mode: 'add', channel }).
function openDmPicker(opts = {}) {
  const mode = opts && opts.mode === 'add' ? 'add' : 'new';
  const channel = (opts && opts.channel) || null;
  state.dmPickerMode = mode;
  state.dmPickerChannel = channel;
  els.dmPickerTitle.textContent = mode === 'add' ? 'Add people' : 'Start a direct message';
  els.dmPickerHint.textContent = mode === 'add'
    ? 'Pick teammates to add to this group.'
    : 'Pick one person, or several for a group.';
  els.dmStart.textContent = mode === 'add' ? 'Add' : 'Start chat';
  els.dmStart.disabled = true;
  els.dmPeople.replaceChildren();
  // Iterate the full team roster — DMing/adding offline teammates is fine.
  const already = mode === 'add' && channel ? new Set(channel.memberIds || []) : new Set();
  const members = sortRosterMembers(
    [...state.huddle.roster.values()].filter((m) => m.id !== state.huddle.peerId && !already.has(m.id)),
  );
  if (members.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = mode === 'add' ? 'Everyone is already in this group.' : 'No other teammates yet.';
    els.dmPeople.appendChild(empty);
  } else {
    for (const m of members) {
      const { online, name, color } = resolveMemberDisplay(m);
      const row = document.createElement('div');
      row.className = 'row' + (online ? '' : ' offline');
      row.dataset.userId = m.id;
      row.dataset.name = name;
      const dot = document.createElement('span');
      dot.className = online ? 'dot online' : 'dot';
      dot.style.background = color;
      const lbl = document.createElement('span');
      lbl.textContent = name;
      const check = document.createElement('span');
      check.className = 'check';
      row.append(dot, lbl, check);
      row.addEventListener('click', () => {
        const selected = row.classList.toggle('selected');
        check.innerHTML = selected ? window.HuddleIcons.check : '';
        els.dmStart.disabled = !els.dmPeople.querySelector('.row.selected');
      });
      els.dmPeople.appendChild(row);
    }
  }
  els.dmPicker.classList.remove('hidden');
}

async function submitDmPicker() {
  const picks = [...els.dmPeople.querySelectorAll('.row.selected')]
    .map((r) => ({ id: r.dataset.userId, name: r.dataset.name }))
    .filter((p) => p.id);
  if (!picks.length) return;
  els.dmPicker.classList.add('hidden');
  if (state.dmPickerMode === 'add') {
    const channel = state.dmPickerChannel;
    if (!channel) return;
    try {
      await state.huddle.addDmMembers(channel.id, picks.map((p) => p.id));
    } catch (err) {
      console.warn('addDmMembers failed', err);
      showCallError('Could not add people: ' + (err?.message || err));
    }
    return;
  }
  if (picks.length === 1) { openDmWith(picks[0].id, picks[0].name); return; }
  try {
    const channel = await state.huddle.createGroupDm(picks.map((p) => p.id), picks.map((p) => p.name));
    onChannelAdded(channel);
    focusChannel(channel.id);
  } catch (err) {
    console.warn('createGroupDm failed', err);
    showCallError('Could not start group DM: ' + (err?.message || err));
  }
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

  // Pop-out button — sits next to the existing × Close in
  // .tile-actions. Clicking spawns a child window that subscribes
  // to the same whiteboard:<id> realtime topic so strokes/notes
  // keep syncing across both windows.
  const actions = tile.querySelector('.tile-actions');
  if (actions && window.huddle?.openPopout) {
    const popBtn = document.createElement('button');
    popBtn.textContent = '⤢ Pop out';
    popBtn.title = 'Open in a separate window';
    popBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await window.huddle.openPopout({
          target: `whiteboard:${wb.id}`,
          teamId: state.huddle.team.id,
          channelId,
          whiteboardId: wb.id,
          title: `Whiteboard — ${channel ? displayLabelFor(channel) : '#' + channelId}`,
        });
        showToast('Whiteboard opened in a new window');
      } catch (err) {
        console.warn('popout failed', err);
        showCallError('Could not open popout: ' + (err?.message || err));
      }
    };
    // Insert before the existing × Close so the layout reads:
    // [Pop out] [× Close]
    actions.insertBefore(popBtn, actions.firstChild);
  }
  try { await session.start(); }
  catch (err) {
    console.warn('whiteboard start failed', err);
    closeWhiteboard(wb.id);
    return;
  }
  // Register the canvas so the existing draw toolbar (color, size,
  // tool) controls the whiteboard the same way it controls a screen
  // annotation. Whiteboards now use InfiniteCanvas (world coords +
  // pan/zoom) instead of DrawingLayer; both expose the same setTool
  // / setColor / setSize / clearAll surface for toolbar interop.
  state.drawLayers.set(wb.id, session.canvas);

  // Tile actions: just close (the toolbar's Clear button covers
  // clearing). The pop-out button was already inserted above; this
  // appends Close after it.
  const closeBtn = document.createElement('button');
  closeBtn.title = 'Close whiteboard'; closeBtn.setAttribute('aria-label', 'Close whiteboard');
  closeBtn.innerHTML = `${window.HuddleIcons.x}<span>Close</span>`;
  closeBtn.onclick = () => closeWhiteboard(wb.id);
  actions.appendChild(closeBtn);

  // Drawing is always active on a whiteboard; reuse the screen-annotation
  // toolbar so pen/arrow/eraser/color/size all work.
  toggleAnnotate(wb.id);
}

async function closeWhiteboard(whiteboardId) {
  const session = state.whiteboardSessions.get(whiteboardId);
  // Drop the session-map entry up front so concurrent close calls
  // don't double-fire the async stop(). Awaited stop() flushes
  // pending note-save timers before the realtime channel goes away.
  state.whiteboardSessions.delete(whiteboardId);
  if (session) await session.stop();
  state.drawLayers.delete(whiteboardId);
  // removeTile yanks the DOM node + clears the tilesByKey entry +
  // re-runs syncTilesVisibility. Plain Map.delete used to leave the
  // tile DOM node orphaned in #tiles forever.
  removeTile(`whiteboard:${whiteboardId}`);
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

async function openSettings() {
  const s = state.settings || {};
  els.setJiraHost.value = s.jira?.host || '';
  els.setJiraEmail.value = s.jira?.email || '';
  els.setJiraToken.value = s.jira?.token || '';
  els.setJiraProject.value = s.jira?.defaultProject || '';
  els.setAiProvider.value = s.ai?.provider || 'anthropic';
  els.setAnthropicKey.value = s.ai?.anthropicKey || '';
  els.setAnthropicModel.value = s.ai?.anthropicModel || '';
  els.setOpenrouterKey.value = s.ai?.openrouterKey || '';
  els.setOpenrouterModel.value = s.ai?.openrouterModel || '';
  els.setAiTicketContext.value = s.aiTicket?.context || '';
  els.setAiTicketRepo.value = s.aiTicket?.githubRepo || '';
  els.setGithubToken.value = s.github?.token || '';
  els.setGiphyKey.value = s.giphy?.key || '';
  els.settingsStatus.classList.add('hidden');
  // Password fields are write-only — never prefilled, always cleared on open.
  els.setNewPassword.value = '';
  els.setNewPasswordConfirm.value = '';
  els.setPasswordStatus.classList.add('hidden');
  // Pre-fill the profile fields from the current profile.
  els.setProfileName.value = state.huddle?.name || '';
  try {
    const p = await state.huddle?.getProfile(state.huddle.peerId);
    els.setProfileBio.value = p?.bio || '';
    state._editingAvatarUrl = p?.avatar_url || null;
    renderAvatarPreview(state._editingAvatarUrl, p?.color || state.huddle?.color, p?.name || state.huddle?.name);
  } catch (err) {
    console.warn('profile prefill failed', err);
    els.setProfileBio.value = '';
    state._editingAvatarUrl = null;
    renderAvatarPreview(null, state.huddle?.color, state.huddle?.name);
  }
  els.settingsModal.classList.remove('hidden');
  els.setProfileName.focus();
}

function openSettingsToProfile() {
  openSettings().then(() => {
    // Profile is wrapped in a <details> accordion. If the user
    // collapsed it previously, force-open it before scrolling so the
    // body is actually visible.
    const section = document.getElementById('settings-profile-section');
    if (section) section.open = true;
    els.settingsProfileAnchor?.scrollIntoView({ block: 'start' });
  });
}

// Cancel button on Settings: must drop any deferred avatar selection
// so the file picked in this session doesn't ride along with a later
// Save. Without this clear, picking a file → Cancel → reopening
// → editing only the bio → Save would also upload the abandoned
// avatar, surprising the user.
function closeSettingsAndDiscardPending() {
  state._pendingAvatarFile = null;
  els.setAvatarFile.value = '';
  els.setNewPassword.value = '';
  els.setNewPasswordConfirm.value = '';
  els.settingsModal.classList.add('hidden');
}

// "Update password" button in Settings → Password. Independent of the
// main Save button: a typed-but-not-submitted password never rides along
// with an unrelated settings save, and the password fields are write-only
// (cleared on open/close). Goes straight through Supabase Auth's
// session-authenticated updateUser — no current-password prompt, no email.
async function updatePasswordFromSettings() {
  // Each terminal branch below sets `status.className` (without `hidden`),
  // which both reveals the line and applies the right colour — so there's
  // no need to un-hide it up front. Doing so would flash a stale message
  // from a prior attempt while this one runs.
  const status = els.setPasswordStatus;
  const pw = els.setNewPassword.value;
  const confirm = els.setNewPasswordConfirm.value;
  if (pw.length < 6) {
    status.textContent = 'Password must be at least 6 characters.';
    status.className = 'settings-status error';
    return;
  }
  if (pw !== confirm) {
    status.textContent = "The two passwords don't match.";
    status.className = 'settings-status error';
    return;
  }
  els.setPasswordUpdate.disabled = true;
  try {
    await window.huddleApi.updatePassword(pw);
    els.setNewPassword.value = '';
    els.setNewPasswordConfirm.value = '';
    status.textContent = 'Password updated. Use it with "Sign in" on the login screen next time.';
    status.className = 'settings-status success';
  } catch (err) {
    status.textContent = 'Could not update password: ' + (err?.message || err);
    status.className = 'settings-status error';
  } finally {
    els.setPasswordUpdate.disabled = false;
  }
}

function renderAvatarPreview(avatarUrl, color, name) {
  const img = els.setAvatarPreview;
  const fb = els.setAvatarFallback;
  if (avatarUrl) {
    img.src = avatarUrl;
    img.style.display = '';
    fb.style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    fb.style.display = '';
    fb.style.background = color || '#888';
    fb.textContent = (name || '?').slice(0, 1).toUpperCase();
  }
}

async function saveSettings() {
  const next = {
    ...state.settings,
    jira: {
      host: els.setJiraHost.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      email: els.setJiraEmail.value.trim(),
      token: els.setJiraToken.value,
      // Project keys are bare (DAP), not issue keys (DAP-123). If
      // a user pastes an issue key the leftover "-123" prevents
      // the find() in openTicketModal from matching, and the
      // pre-select silently falls back to projects[0]. Take
      // everything before the first hyphen so DAP-123 → DAP, and
      // trim AFTER the split so `PROJ - 123` (with surrounding
      // whitespace around the hyphen) doesn't leave a trailing
      // space inside the key.
      defaultProject: els.setJiraProject.value.split('-')[0].trim().toUpperCase(),
    },
    ai: {
      provider: els.setAiProvider.value,
      anthropicKey: els.setAnthropicKey.value,
      anthropicModel: els.setAnthropicModel.value.trim(),
      openrouterKey: els.setOpenrouterKey.value,
      openrouterModel: els.setOpenrouterModel.value.trim(),
    },
    aiTicket: {
      // Free-form project/team context the user wants every /ai-ticket
      // call to consider — described domain, codebase areas, terminology,
      // tone preferences. Trimmed but otherwise stored verbatim.
      context: els.setAiTicketContext.value.trim(),
      // Optional GitHub repo (`owner/name`) the AI can search/read while
      // drafting a ticket. Empty string disables the tool loop and keeps
      // /ai-ticket as a single-shot prompt call.
      githubRepo: els.setAiTicketRepo.value.trim(),
    },
    github: { token: els.setGithubToken.value },
    giphy: { key: els.setGiphyKey.value.trim() },
  };
  try {
    // Upload pending avatar first so the URL is included in the
    // profile patch. Failing the upload aborts the whole save.
    //
    // If updateProfile fails AFTER a successful upload there's a
    // brief inconsistency: storage holds the new image at the fixed
    // <uid>/avatar path, but the DB row still has the old URL
    // (with an older `?t=` cache-buster). The DB URL still resolves
    // to the new image via the storage path, so anyone fetching
    // fresh sees the new avatar; only browsers that already cached
    // the old object under the old `?t=` will keep showing the
    // previous version until their cache expires. We clear
    // _pendingAvatarFile after a successful upload so a retry
    // doesn't re-upload — Save again with the same form just
    // re-runs updateProfile against the URL we already have. Not
    // worth a backup-and-restore dance for that failure mode.
    let avatarUrl = state._editingAvatarUrl;
    if (state._pendingAvatarFile) {
      avatarUrl = await state.huddle.uploadAvatar(state._pendingAvatarFile);
      state._pendingAvatarFile = null;
      state._editingAvatarUrl = avatarUrl;
    }
    const profilePatch = {
      name: els.setProfileName.value.trim() || state.huddle.name,
      bio: els.setProfileBio.value.trim() || null,
      avatar_url: avatarUrl,
    };
    await state.huddle.updateProfile(profilePatch);
    state.myName = state.huddle.name;
    els.me.textContent = state.huddle.name;

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
    // Prefer the per-user default project (Settings → Jira →
    // "Default project"). Falls back to the first project the
    // account has access to if the configured key isn't visible
    // (revoked, mistyped, etc.).
    const preferred = (state.settings?.jira?.defaultProject || '').toUpperCase();
    const initial = (preferred && projects.find((p) => p.key.toUpperCase() === preferred))
      ? preferred
      : (projects[0]?.key || '');
    if (initial) {
      els.ticketProject.value = initial;
      await loadIssueTypes(initial);
    }
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
  if (state.mesh && state.mesh.activeScreenCount >= window.MAX_CONCURRENT_SCREENS) {
    showCallError(`Only ${window.MAX_CONCURRENT_SCREENS} screens can be shared at once. Ask someone to stop sharing first.`);
    return;
  }
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
