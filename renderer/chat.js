// Slack-style chat view.
//
// Responsibilities:
//   - Channel + thread view modes, paginated history loading
//   - Message rendering with markdown, mentions, reactions, edit/delete
//   - Composer with shortcode emoji replacement, file attachments (pasted,
//     drag-dropped, or picked), and a typing indicator
//
// Per-channel state lives on `byChannel` (messages) and `paginationByChannel`
// (`{hasMore, oldestTs}`). View-only state (`nodeById`, `_currentLabel`) is
// reset on channel/thread switches.

// Composer auto-resize cap. Values larger than this scroll
// internally instead of growing the textarea, so the message list
// stays mostly visible while you draft a long message.
const MAX_COMPOSER_HEIGHT = 160;

// Voice + structure are tuned to read like a senior PM authored the
// ticket — context, problem statement, testable acceptance criteria,
// non-goals when applicable. A user-supplied "project context" string
// (from Settings → AI ticket context) is appended at runtime so the
// model knows what product/team it's writing for.
const TICKET_SYSTEM_PROMPT = `You are a senior product manager. Turn the user's freeform input into a Jira ticket as a thoughtful senior PM would write it.

Output ONLY a single JSON object — no preamble, no markdown fences, no commentary outside the JSON. Shape:
{
  "summary": "concise imperative title (clear and complete)",
  "description": "rich markdown body with the structure below",
  "issueType": "Task" | "Bug" | "Story"
}

A senior-PM description includes the sections below. Omit any that don't apply to the input — don't pad. Use these literal H2 headings.

## Background
One to three sentences of context: why this matters now, what triggered it, who is affected.

## Problem
For bugs: precise statement of what's broken, where, and the user-visible impact.
For net-new work: write "## Goal" instead and state the outcome we want.

## Acceptance criteria
Bulleted, individually testable, written as observable behaviors. Use the "- [ ] " checkbox prefix.

## Out of scope
Optional. List anything that is intentionally not part of this ticket.

## Notes
Optional. Constraints, dependencies, related tickets, open questions.

Pick "Bug" only when the input is clearly about something broken. Default to "Task". Use "Story" for net-new feature work or larger scope.

Do not artificially shorten the description. Be thorough where the input warrants it, terse where it doesn't. Cut filler, keep clarity.

Output the JSON object and nothing else.`;

// Compose the system prompt with optional user-supplied project context
// and (when GitHub tools are wired) a hint nudging the model to use them.
// Stable context goes at the top so the model treats it as background
// rather than instructions; the per-ticket prompt arrives as the user
// message, untouched.
function buildTicketSystemPrompt(projectContext, { repoSlug } = {}) {
  const parts = [];
  const ctx = (projectContext || '').trim();
  if (ctx) parts.push(`## Project context (always applies)\n${ctx}`);
  if (repoSlug) {
    parts.push(`## Repository tools available
You have read-only access to the GitHub repo \`${repoSlug}\` via tools (search_code, read_file, list_recent_commits, search_issues). Before drafting the ticket, take 1-3 tool calls to ground yourself in the actual code: search for the most distinctive nouns in the user's input, then read the matching file(s). Skip the lookup only when the input is purely product-shaped and has no codebase referent. Cite specific file paths in the description when relevant.`);
  }
  parts.push(TICKET_SYSTEM_PROMPT);
  return parts.join('\n\n---\n\n');
}

// Tool definitions for the /ai-ticket loop. Built only when both a
// GitHubClient and a configured repo slug are available; otherwise the
// AI call stays a single-shot prompt with no tool surface. Each tool
// caps its own output (limits, snippet/body slicing, line caps in
// readFile) so the iteration budget translates to a bounded token cost.
function buildGithubTicketTools(github, repoSlug) {
  return [
    {
      name: 'search_code',
      description: 'Search code in the configured GitHub repo by keyword or phrase. Returns up to 8 file matches with the path and a short snippet. Use this to find files relevant to the ticket BEFORE calling read_file. The query is a raw GitHub code-search expression — quote phrases for literal matches.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Code search query, e.g. "channel_members upsert" or "function buildTicketSystemPrompt".' },
        },
        required: ['query'],
      },
      run: async ({ query }) => github.searchCode(repoSlug, query, { limit: 8 }),
    },
    {
      name: 'read_file',
      description: 'Read a file from the configured GitHub repo. Returns up to 200 lines (or the requested line range). Pair with search_code: search first to find the right path, then read.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repo root, e.g. "renderer/chat.js".' },
          line_start: { type: 'integer', description: 'Optional 1-based line to start reading from.' },
          line_end: { type: 'integer', description: 'Optional 1-based last line to include. Capped at line_start + 199 regardless.' },
        },
        required: ['path'],
      },
      run: async ({ path, line_start, line_end }) =>
        github.readFile(repoSlug, path, { lineStart: line_start, lineEnd: line_end }),
    },
    {
      name: 'search_issues',
      description: 'Search issues and pull requests in the configured GitHub repo. Useful for spotting duplicate or related tickets before drafting a new one. Returns up to 8 results with title, state, and a body snippet.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Issue/PR search query, e.g. "RLS dm policy" or "is:open author:nsimi22".' },
        },
        required: ['query'],
      },
      run: async ({ query }) => github.searchIssues(repoSlug, query, { limit: 8 }),
    },
    {
      name: 'list_recent_commits',
      description: 'List recent commit titles for the configured GitHub repo. Useful to see what has changed lately or to scope by a specific path.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many commits to return (default 10, max 25).' },
          path: { type: 'string', description: 'Optional repo-relative path filter, e.g. "renderer/chat.js".' },
        },
      },
      run: async ({ limit, path }) => github.listRecentCommits(repoSlug, { limit, path }),
    },
  ];
}

// Tolerant JSON extractor: tries plain JSON.parse, then looks for
// the first {...} block (in case the AI wrapped the JSON in
// commentary or fenced code despite the instructions). Throws on
// total failure so the caller can surface a clean error.
function parseTicketJson(raw) {
  if (!raw) throw new Error('empty AI response');
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  throw new Error('response was not valid JSON');
}

// Single source of truth for both the composer's autocomplete
// popup AND the Settings → Slash commands explainer (rendered from
// this list by app.js). When adding a new command, add ONE entry
// here and both surfaces pick it up.
//
//   name      — canonical command (no leading slash). What the popup
//                shows and what _fillSlashSuggest types into the
//                composer.
//   usage     — short usage hint shown in the popup. Should fit on
//                one line.
//   desc      — sentence-length description for both the popup and
//                Settings. Aliases mentioned here are documentation
//                only; the actual dispatch lives in _maybeRunSlash.
//   aliases   — optional list of equivalent commands (just for the
//                Settings explainer; popup renders one row per
//                canonical name to keep it tight).
//   extras    — optional list of {usage, desc} variants to show in
//                Settings only (e.g., /jira create vs /jira <KEY>).
const SLASH_COMMANDS = [
  { name: 'ai',         usage: '/ai <question>',           desc: 'Ask the configured AI provider; the answer is posted as a teammate-visible message. When Jira is configured, the AI can read tickets, post comments, update fields, and trigger transitions on its own.' },
  { name: 'ai-ticket',  usage: '/ai-ticket <description>', desc: 'AI structures the description into a Jira ticket and creates it in your default project.', aliases: ['ait'] },
  { name: 'summarize',  usage: '/summarize',               desc: 'Summarize the last few messages in this channel.', aliases: ['summary'] },
  { name: 'jira',       usage: '/jira',                    desc: 'Open the Jira create-ticket modal.', extras: [
      { usage: '/jira create <summary>', desc: 'Open the create-ticket modal pre-filled with a summary.' },
      { usage: '/jira <KEY>',            desc: 'Post the issue URL — auto-unfurls into a status card for everyone.' },
  ] },
  { name: 'gh',         usage: '/gh <owner/repo#N>',       desc: 'Post a GitHub issue or PR URL — auto-unfurls into a status card.', aliases: ['github'] },
];
window.SLASH_COMMANDS = SLASH_COMMANDS;

class ChatView {
  constructor({ huddle, els, hooks }) {
    // ChatView used to take a MeshClient (`mesh`); the MeshClient was
    // a passthrough to HuddleClient for chat ops + an event forwarder
    // for chat-* events. Now that calls are on-demand and Mesh isn't
    // always alive, ChatView talks to HuddleClient directly. The
    // accessor name `this.mesh` is kept on the instance for backwards
    // compatibility with internal call sites; both names point at the
    // same HuddleClient.
    this.huddle = huddle;
    this.mesh = huddle;
    this.els = els;
    this.hooks = hooks || {};
    this.currentChannel = 'general';
    this.threadParentId = null;
    this.byChannel = new Map();
    this.paginationByChannel = new Map();
    this.nodeById = new Map();
    this.typingUsers = new Map();
    this.editingMessageId = null;
    this.composerAttachments = []; // [{file, status, info?}] where info = {url, name, contentType, size}
    // Session cache for Jira lookups: key -> { issue | null, error?, host? }.
    // null = lookup failed but completed (don't retry within session).
    this._jiraCache = new Map();
    this._jiraInflight = new Map();
    // GIF picker state: monotonic sequence to drop stale Giphy responses.
    this._gifFetchSeq = 0;
    this._gifSearchTimer = null;
    this._giphyKey = null;
    // In-flight AI requests — tracked as a counter so overlapping commands
    // don't prematurely hide the "thinking" indicator.
    this._aiThinkingCount = 0;
    // Single AbortController so destroy() can yank every DOM and mesh
    // listener this view installed in one go. ChatView is rebuilt on each
    // join/leave cycle, so without this the host elements (composer,
    // document, etc.) accumulate stale handlers.
    this._listenerCtrl = new AbortController();

    // Slash-command autocomplete state. Initialized here so any code
    // path that touches it (the keydown handler in particular) can't
    // observe an undefined _slashFiltered before the first refresh.
    this._slashOpen = false;
    this._slashFiltered = [];
    this._slashIndex = 0;
    this._slashBlurTimer = null;
    // Debounced draft persistence — see _scheduleDraftSave.
    this._draftSaveTimer = null;
    this._pendingDraft = null;

    this.typingClock = setInterval(() => this._refreshTyping(), 800);
    this._wireDom();
    this._wireMesh();
    this._initEmojiPicker();
    this._initGifPicker();
  }

  // --- Public API ---------------------------------------------------------

  setChannel(channelId, topic, displayLabel) {
    // Save the previous channel's draft before swapping in the new
    // one. Flush any pending debounced save first, then capture
    // the current composer value synchronously — the input event
    // for the very last keystroke might not have reached the
    // 150ms debounce yet.
    if (this.currentChannel && this.currentChannel !== channelId) {
      this._flushDraftSave();
      this._saveDraft(this.currentChannel, this.els.composer.value);
    }
    this.currentChannel = channelId;
    this.threadParentId = null;
    this.editingMessageId = null;
    this.composerAttachments = [];
    this._renderAttachmentChips();
    const label = displayLabel || ('#' + channelId);
    this._currentLabel = label;
    this.els.chatChannelName.textContent = label;
    this.els.channelName.textContent = label;
    this.els.channelTopic.textContent = topic || '';
    this.els.composer.placeholder = `Message ${label}`;
    this.els.threadBack.classList.add('hidden');
    // Restore the new channel's draft (if any). Null/empty leaves
    // the composer blank.
    this.els.composer.value = this._loadDraft(channelId) || '';
    this._autoResizeComposer();
    this._render();
    this._fetchHistory(channelId);
  }

  async _fetchHistory(channelId, before) {
    try {
      const { messages, hasMore } = await this.mesh.loadHistory(channelId, { before, limit: 50 });
      this._ingestHistory(channelId, messages, hasMore);
    } catch (err) { console.warn('history failed', err); }
  }

  _ingestHistory(channelId, incoming, hasMore) {
    const existing = this.byChannel.get(channelId) || [];
    const ids = new Set(existing.map((m) => m.id));
    const merged = existing.slice();
    for (const m of incoming) if (!ids.has(m.id)) merged.unshift(m);
    merged.sort((a, b) => a.ts - b.ts);
    this.byChannel.set(channelId, merged);
    const oldest = merged.length ? merged[0].ts : null;
    this.paginationByChannel.set(channelId, { hasMore, oldestTs: oldest });
    if (channelId === this.currentChannel) this._render();
  }

  openThread(messageId) {
    this.threadParentId = messageId;
    this.els.threadBack.classList.remove('hidden');
    this.els.chatChannelName.textContent = 'Thread';
    const parent = this._messages().find((m) => m.id === messageId);
    this.els.composer.placeholder = parent ? `Reply to ${parent.authorName}` : 'Reply';
    this._render();
  }

  closeThread() {
    this.threadParentId = null;
    this.els.threadBack.classList.add('hidden');
    const label = this._currentLabel || ('#' + this.currentChannel);
    this.els.chatChannelName.textContent = label;
    this.els.composer.placeholder = `Message ${label}`;
    this._render();
  }

  // --- Wiring -------------------------------------------------------------

  // Bind a DOM/event-target listener that auto-removes when destroy() is
  // called. Using AbortController.signal is supported by every modern
  // EventTarget (DOM nodes and our mesh client which extends EventTarget).
  _on(target, event, handler) {
    target.addEventListener(event, handler, { signal: this._listenerCtrl.signal });
  }

  _wireDom() {
    const sig = { signal: this._listenerCtrl.signal };
    this._on(this.els.threadBack, 'click', () => this.closeThread());
    this._on(this.els.send, 'click', () => this._submit());
    this._on(this.els.composer, 'keydown', (e) => {
      // Slash autocomplete claims arrow keys, Tab, and Escape while
      // visible. Enter still submits (the popup just disappears as
      // the message is sent).
      if (this._slashOpen && this._handleSlashKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._submit();
      } else {
        this.mesh.sendTyping(this.currentChannel, this.threadParentId);
      }
    });
    this._on(this.els.composer, 'input', () => {
      this._autoResizeComposer();
      this._refreshSlashSuggest();
      // Persist the draft, but debounced — localStorage is a
      // synchronous, thread-blocking API and a large draft saved
      // on every keystroke can cause noticeable input lag. The
      // 150ms window is short enough that a renderer crash won't
      // lose much, and blur / channel-switch / submit each flush
      // any pending save so committed text is never stale.
      if (this.currentChannel) this._scheduleDraftSave(this.currentChannel, this.els.composer.value);
    });
    this._on(this.els.composer, 'blur', () => {
      // Flush any pending debounced draft save before yielding focus
      // — otherwise a fast blur (channel switch, etc.) could lose
      // the last keystrokes.
      this._flushDraftSave();
      // Slight delay so a click on a suggestion can fire before we
      // tear down the popup. Tracked so destroy() can clear the
      // timer — without it, a teardown within 80ms of a blur
      // (e.g. signing out while the composer was just focused)
      // fires _hideSlashSuggest on a torn-down ChatView whose
      // listener controller is already null.
      this._slashBlurTimer = setTimeout(() => {
        this._slashBlurTimer = null;
        this._hideSlashSuggest();
      }, 80);
    });
    this._on(this.els.composer, 'paste', (e) => this._onPaste(e));
    this._on(this.els.emojiBtn, 'click', (e) => {
      e.stopPropagation();
      this._resetEmojiPickerAnchor();
      this.els.emojiPicker.classList.toggle('hidden');
      this._emojiPickerMode = 'compose';
    });
    this._on(document, 'click', (e) => {
      if (!this.els.emojiPicker.contains(e.target) && e.target !== this.els.emojiBtn) {
        this.els.emojiPicker.classList.add('hidden');
        this._resetEmojiPickerAnchor();
      }
    });
    if (this.els.attachBtn) {
      this._on(this.els.attachBtn, 'click', () => this.els.fileInput?.click());
    }
    if (this.els.fileInput) {
      this._on(this.els.fileInput, 'change', (e) => {
        for (const f of e.target.files) this._beginUpload(f);
        e.target.value = '';
      });
    }
    const drop = this.els.messages.parentElement;
    if (drop) {
      this._on(drop, 'dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
      this._on(drop, 'dragleave', () => drop.classList.remove('drag-over'));
      this._on(drop, 'drop', (e) => {
        e.preventDefault();
        drop.classList.remove('drag-over');
        for (const f of e.dataTransfer.files || []) this._beginUpload(f);
      });
    }
  }

  _wireMesh() {
    const on = (event, fn) => this._on(this.mesh, event, fn);
    on('chat-message', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      // Postgres realtime can deliver our own insert before the local fetch
      // resolves; dedupe by id.
      if (!arr.some((x) => x.id === m.id)) arr.push(m);
      this.byChannel.set(m.channelId, arr);
      if (m.channelId === this.currentChannel) this._appendIncremental(m);
      this.hooks.onMessage?.(m);
    });
    on('chat-update', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      const idx = arr.findIndex((x) => x.id === m.id);
      const prev = idx >= 0 ? arr[idx] : null;
      if (idx >= 0) arr[idx] = m;
      if (m.channelId === this.currentChannel) this._replaceNode(m);
      // Pin/unpin updates flow through the standard chat-update channel
      // (the RPC writes pinned_at + pinned_by, which the realtime
      // subscription broadcasts as a row UPDATE). Surface a hook so
      // the channel-header chip refreshes its count without polling.
      if (m.channelId === this.currentChannel && (!prev || !!prev.pinnedAt !== !!m.pinnedAt)) {
        this.hooks.onPinChanged?.(m.channelId);
      }
    });
    on('chat-message-deleted', (e) => {
      const { channelId, messageId } = e.detail;
      const arr = this.byChannel.get(channelId) || [];
      const idx = arr.findIndex((x) => x.id === messageId);
      if (idx >= 0) arr.splice(idx, 1);
      if (channelId === this.currentChannel) {
        const node = this.nodeById.get(messageId);
        if (node) node.remove();
        this.nodeById.delete(messageId);
        // The deleted message's successor inherited a .msg-followup
        // state from its now-missing predecessor. Re-render the
        // whole channel so successors pick up correct prev refs.
        // Cheap: deletes are rare and bounded by the visible
        // message list.
        this._render();
      }
    });
    on('typing', (e) => {
      const { from, fromName, channelId, parentId } = e.detail;
      if (channelId !== this.currentChannel) return;
      if ((parentId || null) !== (this.threadParentId || null)) return;
      this.typingUsers.set(from, { name: fromName, until: Date.now() + 2500 });
      this._refreshTyping();
    });
  }

  // Tear down: stop the typing indicator clock and yank every DOM/mesh
  // event listener installed via `_on()`. Called from teardownMesh() so
  // listeners don't accumulate across join/leave cycles.
  destroy() {
    if (this.typingClock) clearInterval(this.typingClock);
    this.typingClock = null;
    if (this._gifSearchTimer) clearTimeout(this._gifSearchTimer);
    this._gifSearchTimer = null;
    if (this._slashBlurTimer) clearTimeout(this._slashBlurTimer);
    this._slashBlurTimer = null;
    // Flush any pending debounced draft save so a sign-out / team
    // switch never strands the user's last keystrokes in a
    // never-fired timer.
    this._flushDraftSave();
    this._listenerCtrl?.abort();
    this._listenerCtrl = null;
  }

  // --- Slash-command autocomplete -----------------------------------------

  // Re-evaluate the popup against the current composer value. Shows
  // the popup when the value is a /<partial-name> token (no spaces)
  // and at least one command matches; hides otherwise. Re-rendering
  // also resets the highlight to the first match so Tab fills the
  // top suggestion as the user types.
  _refreshSlashSuggest() {
    const value = this.els.composer.value;
    // [\w-]* matches _maybeRunSlash's dispatch regex, so anything that
    // would actually run as a slash command also surfaces in the
    // suggester (incl. hyphenated /ai-ticket and any future underscore
    // command). The asterisk lets a bare "/" open the picker.
    const m = /^\/([\w-]*)$/.exec(value);
    if (!m) { this._hideSlashSuggest(); return; }
    const partial = m[1].toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(partial));
    if (!matches.length) { this._hideSlashSuggest(); return; }
    this._slashFiltered = matches;
    this._slashIndex = 0;
    this._slashOpen = true;
    this._renderSlashSuggest();
  }

  _renderSlashSuggest() {
    const root = this.els.slashSuggest;
    root.replaceChildren();
    for (let i = 0; i < this._slashFiltered.length; i++) {
      const cmd = this._slashFiltered[i];
      const row = document.createElement('div');
      row.className = 'slash-suggest-item' + (i === this._slashIndex ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === this._slashIndex ? 'true' : 'false');
      const code = document.createElement('code');
      code.textContent = cmd.usage;
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = cmd.desc;
      row.append(code, desc);
      // mousedown (not click) so the textarea blur doesn't close the
      // popup before the click lands. preventDefault keeps focus on
      // the textarea after the fill.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._fillSlashSuggest(i);
      });
      root.appendChild(row);
    }
    root.classList.remove('hidden');
  }

  _hideSlashSuggest() {
    this._slashOpen = false;
    this._slashFiltered = [];
    this._slashIndex = 0;
    this.els.slashSuggest.classList.add('hidden');
  }

  // Returns true iff the keypress was handled here (caller bails out).
  _handleSlashKeydown(e) {
    if (!this._slashOpen) return false;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._slashIndex = (this._slashIndex + 1) % this._slashFiltered.length;
        this._renderSlashSuggest();
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this._slashIndex = (this._slashIndex - 1 + this._slashFiltered.length) % this._slashFiltered.length;
        this._renderSlashSuggest();
        return true;
      case 'Tab':
      case 'Enter':
        // Both keys commit the highlighted suggestion. Enter is the
        // most-discovered completion key (users reach for it before
        // Tab); since the slash popup intercepts before the
        // composer's own Enter-sends handler, this doesn't conflict
        // with sending. The user just hits Enter again on the
        // filled-in `/<cmd> ` to send.
        e.preventDefault();
        this._fillSlashSuggest(this._slashIndex);
        return true;
      case 'Escape':
        e.preventDefault();
        this._hideSlashSuggest();
        return true;
      default:
        return false;
    }
  }

  _fillSlashSuggest(index) {
    const cmd = this._slashFiltered[index];
    if (!cmd) return;
    // Replace the partial with `/<name> ` so the user can keep
    // typing the argument. The trailing space also closes the
    // popup (input handler matches /^\/[a-zA-Z0-9-]*$/, which fails
    // once a space is present).
    this.els.composer.value = `/${cmd.name} `;
    // Programmatic value assignments don't fire `input`, so the
    // composer's auto-resize logic — which lives in the input
    // listener — never runs and the textarea height drifts. Run
    // the same recompute via the shared helper.
    this._autoResizeComposer();
    this.els.composer.focus();
    this._hideSlashSuggest();
  }

  // --- Drafts -------------------------------------------------------------
  // Composer text is persisted per-channel in localStorage so a
  // mid-thought switch + back doesn't drop what the user was
  // writing. Storage key includes the team id so multi-team users
  // don't bleed drafts across workspaces.

  // Recompute the composer textarea's height to fit its content,
  // capped at MAX_COMPOSER_HEIGHT. Three call sites (setChannel
  // restore, input listener, _fillSlashSuggest) needed the same
  // sequence and the literal 160 was about to become a fourth.
  _autoResizeComposer() {
    this.els.composer.style.height = 'auto';
    this.els.composer.style.height = Math.min(MAX_COMPOSER_HEIGHT, this.els.composer.scrollHeight) + 'px';
  }

  _draftKey(channelId) {
    const teamId = this.huddle?.team?.id || 'unknown';
    return `huddle.draft.${teamId}.${channelId}`;
  }

  _saveDraft(channelId, value) {
    if (!channelId) return;
    try {
      const key = this._draftKey(channelId);
      if (!value) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // localStorage can be unavailable in private modes / quota'd
      // — drafts just don't survive in that case. Not worth
      // surfacing to the user.
    }
  }

  _loadDraft(channelId) {
    if (!channelId) return '';
    try { return localStorage.getItem(this._draftKey(channelId)) || ''; }
    catch { return ''; }
  }

  // Debounced draft save. localStorage is synchronous and large
  // drafts saved on every keystroke produce noticeable input lag,
  // so coalesce within a 150ms window. Always paired with
  // _flushDraftSave on blur / channel-switch / submit / destroy
  // so committed text never strands in the timer.
  _scheduleDraftSave(channelId, value) {
    this._pendingDraft = { channelId, value };
    if (this._draftSaveTimer) return;
    this._draftSaveTimer = setTimeout(() => {
      this._draftSaveTimer = null;
      this._flushDraftSave();
    }, 150);
  }

  _flushDraftSave() {
    if (this._draftSaveTimer) {
      clearTimeout(this._draftSaveTimer);
      this._draftSaveTimer = null;
    }
    if (!this._pendingDraft) return;
    const { channelId, value } = this._pendingDraft;
    this._pendingDraft = null;
    this._saveDraft(channelId, value);
  }

  _clearDraft(channelId) {
    // Drop any pending save for this channel — we're explicitly
    // clearing, so the queued value is moot. Pending saves for
    // OTHER channels (rare; only happens via fast cross-channel
    // edits) are left alone to fire on schedule.
    if (this._pendingDraft?.channelId === channelId) {
      this._pendingDraft = null;
      if (this._draftSaveTimer) {
        clearTimeout(this._draftSaveTimer);
        this._draftSaveTimer = null;
      }
    }
    this._saveDraft(channelId, '');
  }

  // --- Submit / edit ------------------------------------------------------

  async _submit() {
    if (this.editingMessageId) return; // edits use their own inline path
    // Submit dismisses the slash autocomplete unconditionally — the
    // composer either clears or has its content shipped, both of
    // which invalidate the popup.
    this._hideSlashSuggest();

    // Wait for any in-flight uploads to settle before sending.
    const pending = this.composerAttachments.filter((a) => a.status === 'uploading');
    if (pending.length) return;
    const failed = this.composerAttachments.filter((a) => a.status === 'failed');
    if (failed.length) {
      alert(`Some files failed to upload: ${failed.map((a) => a.file.name).join(', ')}`);
      return;
    }

    const text = this.els.composer.value.trim();
    const attachments = this.composerAttachments.filter((a) => a.status === 'done').map((a) => a.info);
    if (!text && attachments.length === 0) return;

    // Slash commands run client-side and either consume the input (no chat
    // message sent) or fall through to the normal path. The slow-API
    // handlers (/ai, /summarize) clear the composer themselves once they've
    // validated input, so unrecognized /commands fall back through to
    // sendMessage with the user's text intact.
    if (text.startsWith('/')) {
      const handled = await this._maybeRunSlash(text);
      if (handled) {
        this._clearDraft(this.currentChannel);
        this.els.composer.value = '';
        this.els.composer.style.height = 'auto';
        this.composerAttachments = [];
        this._renderAttachmentChips();
        return;
      }
    }

    await this.mesh.sendMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: window.replaceShortcodes(text),
      attachments,
    });
    this._clearDraft(this.currentChannel);
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this.composerAttachments = [];
    this._renderAttachmentChips();
  }

  _beginEdit(messageId) {
    this.editingMessageId = messageId;
    this._replaceNodeById(messageId);
  }

  _saveEdit(messageId, newText) {
    this.mesh.editMessage(messageId, newText);
    this.editingMessageId = null;
    // Realtime postgres_changes will fire chat-update; render happens then.
  }

  _cancelEdit() {
    const id = this.editingMessageId;
    this.editingMessageId = null;
    if (id) this._replaceNodeById(id);
  }

  _delete(messageId) {
    if (!confirm('Delete this message? It will be removed for everyone.')) return;
    this.mesh.deleteMessage(messageId);
  }

  // --- Pinning + permalinks -----------------------------------------------

  async _togglePin(messageId, pin) {
    try { await this.mesh.pinMessage(messageId, pin); }
    catch (err) { alert('Could not pin: ' + (err?.message || err)); }
  }

  // Build a huddle:// permalink for a message and shove it on the
  // clipboard. The link encodes team + channel + message id; the
  // app.js protocol handler scrolls to the row on open.
  async _copyMessageLink(messageId) {
    const teamId = this.mesh.teamMeta?.id;
    const channelId = this.currentChannel;
    if (!teamId || !channelId) return;
    const url = `huddle://team/${encodeURIComponent(teamId)}/channel/${encodeURIComponent(channelId)}?msg=${encodeURIComponent(messageId)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.hooks.toast?.('Message link copied');
    } catch (err) {
      console.warn('copy link failed', err);
      this.hooks.toast?.('Could not copy link');
    }
  }

  // Find a rendered message node in the active channel pane and scroll
  // it into view with a brief flash. Used by the protocol-URL handler
  // and by clicks in the pinned drawer.
  //
  // The protocol-URL path arrives mid-channel-switch — history is still
  // loading and the target node may not exist yet. Poll briefly with
  // backoff instead of accepting a fixed setTimeout race; give up after
  // ~3s. Returns a Promise<boolean> so callers can await/observe success.
  scrollToMessage(messageId, { timeoutMs = 3000 } = {}) {
    const flash = (node) => {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.remove('msg-flash');
      // Force reflow so the keyframe restarts even when the class was
      // already on the node from a prior scrollToMessage call.
      void node.offsetWidth;
      node.classList.add('msg-flash');
      setTimeout(() => node.classList.remove('msg-flash'), 1800);
    };
    const find = () => this.els.messages.querySelector(`.msg[data-message-id="${CSS.escape(messageId)}"]`);
    const immediate = find();
    if (immediate) { flash(immediate); return Promise.resolve(true); }
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const node = find();
        if (node) {
          clearInterval(interval);
          flash(node);
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
  }

  async openPinnedDrawer() {
    if (!this.currentChannel) return;
    const list = await this.mesh.loadPinnedMessages(this.currentChannel);
    this.hooks.renderPinnedDrawer?.(list, (id) => {
      this.hooks.closePinnedDrawer?.();
      this.scrollToMessage(id);
    });
  }

  // --- File uploads -------------------------------------------------------

  _onPaste(e) {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) this._beginUpload(f);
      }
    }
  }

  async _beginUpload(file) {
    if (!file) return;
    const slot = { file, status: 'uploading', info: null };
    this.composerAttachments.push(slot);
    this._renderAttachmentChips();
    try {
      slot.info = await this.mesh.uploadFile(file);
      slot.status = 'done';
    } catch (err) {
      console.warn('upload failed', err);
      slot.status = 'failed';
    }
    this._renderAttachmentChips();
  }

  _renderAttachmentChips() {
    if (!this.els.attachmentChips) return;
    this.els.attachmentChips.replaceChildren();
    if (this.composerAttachments.length === 0) {
      this.els.attachmentChips.classList.add('hidden');
      return;
    }
    this.els.attachmentChips.classList.remove('hidden');
    for (const a of this.composerAttachments) {
      const chip = document.createElement('span');
      chip.className = 'chip ' + a.status;
      const dot = document.createElement('span');
      dot.className = 'chip-status';
      const txt = document.createElement('span');
      txt.textContent = a.file.name + (a.status === 'uploading' ? ' …' : a.status === 'failed' ? ' (failed)' : '');
      const x = document.createElement('button');
      x.title = 'Remove'; x.setAttribute('aria-label', 'Remove');
      x.innerHTML = window.HuddleIcons.x;
      x.onclick = () => {
        this.composerAttachments = this.composerAttachments.filter((c) => c !== a);
        this._renderAttachmentChips();
      };
      chip.append(dot, txt, x);
      this.els.attachmentChips.appendChild(chip);
    }
  }

  // --- Rendering ----------------------------------------------------------

  _refreshTyping() {
    const now = Date.now();
    const live = [];
    for (const [id, info] of this.typingUsers) {
      if (info.until > now) live.push(info.name);
      else this.typingUsers.delete(id);
    }
    const text = live.length === 0 ? ''
      : live.length === 1 ? `${live[0]} is typing…`
      : `${live.slice(0, -1).join(', ')} and ${live.at(-1)} are typing…`;
    // Names go through textContent first so any HTML-ish chars are
    // escaped; we only inject our trusted AI-thinking SVG via innerHTML.
    this.els.typing.textContent = text;
    if (this._aiThinkingCount > 0) {
      const sep = text ? ' · ' : '';
      const ai = document.createElement('span');
      ai.className = 'typing-ai';
      const label = this._aiThinkingNote
        ? `AI is using ${this._aiThinkingNote}…`
        : 'AI is thinking…';
      ai.innerHTML = `${window.HuddleIcons.robot}<span></span>`;
      ai.querySelector('span').textContent = label;
      this.els.typing.append(sep, ai);
    }
  }

  // Track AI requests in flight as a counter, not a boolean — otherwise
  // overlapping `/ai` and `/summarize` would have the first one's `finally`
  // hide the indicator while the second is still running.
  _beginAiThinking() { this._aiThinkingCount = (this._aiThinkingCount || 0) + 1; this._refreshTyping(); }
  _endAiThinking() {
    this._aiThinkingCount = Math.max(0, (this._aiThinkingCount || 0) - 1);
    if (this._aiThinkingCount === 0) this._aiThinkingNote = null;
    this._refreshTyping();
  }

  _messages() { return this.byChannel.get(this.currentChannel) || []; }

  _render() {
    const all = this._messages();
    const container = this.els.messages;
    container.replaceChildren();
    this.nodeById.clear();

    const pagination = this.paginationByChannel.get(this.currentChannel);
    if (pagination?.hasMore && !this.threadParentId) {
      const more = document.createElement('button');
      more.className = 'load-more';
      more.textContent = '↑ Load older messages';
      more.onclick = () => {
        const oldest = pagination.oldestTs || Date.now();
        this._fetchHistory(this.currentChannel, oldest);
      };
      container.appendChild(more);
    }

    const visible = this._visibleList(all);
    let prev = null;
    for (const m of visible) {
      const node = this._renderMessage(m, all, prev);
      this.nodeById.set(m.id, node);
      container.appendChild(node);
      prev = m;
    }
    this._lastRendered = prev;
    // Empty state — only when this channel has no messages yet AND
    // we've finished initial history fetch (pagination entry exists
    // and has no `hasMore` flag pointing back further). Without the
    // pagination check we'd briefly flash the empty state during
    // history load.
    if (!this.threadParentId && visible.length === 0 && pagination && !pagination.hasMore) {
      container.appendChild(this._buildEmptyState());
    }
    container.scrollTop = container.scrollHeight;
  }

  _buildEmptyState() {
    const wrap = document.createElement('div');
    wrap.className = 'channel-empty';
    const icon = document.createElement('div');
    icon.className = 'channel-empty-icon';
    icon.innerHTML = window.HuddleIcons.sparkle;
    const title = document.createElement('div');
    title.className = 'channel-empty-title';
    title.textContent = `Welcome to ${this._currentLabel || 'this channel'}`;
    const hint = document.createElement('div');
    hint.className = 'channel-empty-hint';
    hint.textContent = 'Be the first to say something — drop a message, paste a link, or run a /command.';
    wrap.append(icon, title, hint);
    return wrap;
  }

  _visibleList(all) {
    if (this.threadParentId) {
      const parent = all.find((m) => m.id === this.threadParentId);
      const replies = all.filter((m) => m.parentId === this.threadParentId);
      return parent ? [parent, ...replies] : replies;
    }
    return all.filter((m) => !m.parentId);
  }

  _isInCurrentView(m) {
    if (this.threadParentId) {
      return m.id === this.threadParentId || m.parentId === this.threadParentId;
    }
    return !m.parentId;
  }

  _appendIncremental(m) {
    if (this._isInCurrentView(m)) {
      const node = this._renderMessage(m, this._messages(), this._lastRendered);
      this.nodeById.set(m.id, node);
      this.els.messages.appendChild(node);
      this._lastRendered = m;
      this.els.messages.scrollTop = this.els.messages.scrollHeight;
      return;
    }
    if (m.parentId && !this.threadParentId) this._replaceNodeById(m.parentId);
  }

  _replaceNode(m) {
    if (this._isInCurrentView(m)) this._replaceNodeById(m.id);
  }

  _replaceNodeById(id) {
    const old = this.nodeById.get(id);
    if (!old) return;
    const all = this._messages();
    const target = all.find((x) => x.id === id);
    if (!target) return;
    // Compute prev so the re-rendered row keeps its .msg-followup
    // state. Without this, an edit on a follow-up message would
    // restore the avatar + head and break the burst grouping.
    const visible = this._visibleList(all);
    const idx = visible.findIndex((x) => x.id === id);
    const prev = idx > 0 ? visible[idx - 1] : null;
    const fresh = this._renderMessage(target, all, prev);
    this.nodeById.set(id, fresh);
    old.replaceWith(fresh);
  }

  _knownNames() {
    const set = new Set();
    if (this.mesh.name) set.add(this.mesh.name);
    for (const p of this.mesh.peerInfo.values()) set.add(p.name);
    for (const arr of this.byChannel.values()) for (const m of arr) set.add(m.authorName);
    set.delete('');
    return [...set];
  }

  _renderMessage(m, all, prev) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.dataset.messageId = m.id;
    const myName = this.mesh.name;
    const isMine = m.authorName === myName;
    const mentionsMe = Array.isArray(m.mentions) && m.mentions.includes(myName);
    if (mentionsMe) wrap.classList.add('msg-mentions-me');
    if (m.pinnedAt) wrap.classList.add('msg-pinned');
    // Slack-style consecutive grouping: same author within 5 minutes
    // collapses the head + reuses the avatar slot. Threads keep the
    // full chrome on each reply (always shown in a thread pane).
    const FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;
    const isFollowup = prev
      && !this.threadParentId
      && !m.parentId && !prev.parentId
      && !!m.aiGenerated === !!prev.aiGenerated
      && m.aiModel === prev.aiModel
      && (m.authorId || m.authorName) === (prev.authorId || prev.authorName)
      && (m.ts - prev.ts) < FOLLOWUP_WINDOW_MS;
    if (isFollowup) {
      wrap.classList.add('msg-followup');
      // Slack-style: surface the time in the avatar gutter on hover
      // so users can still timestamp a line in a burst.
      const timeHover = document.createElement('span');
      timeHover.className = 'msg-time-hover';
      timeHover.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      wrap.appendChild(timeHover);
    }

    const initials = (m.authorName || '?').slice(0, 1).toUpperCase();
    const avatar = document.createElement('div');
    avatar.className = 'avatar' + (m.aiGenerated ? ' avatar-ai' : '');
    if (m.aiGenerated) {
      // Robot icon avatar; same size as the human ones so the grid stays aligned.
      avatar.style.background = '#3a3f47';
      avatar.innerHTML = window.HuddleIcons.robot;
    } else {
      avatar.style.background = m.authorColor || '#666';
      avatar.textContent = initials;
      // Author + avatar open the profile card. The card lazily
      // resolves the up-to-date avatar_url, so we don't try to
      // pre-load images into the chat row itself — the colored
      // initial is fine inline.
      this.hooks.attachProfileTrigger?.(avatar, m.authorId);
    }

    const right = document.createElement('div');
    if (m.aiGenerated) wrap.classList.add('msg-ai');
    const head = document.createElement('div');
    head.className = 'msg-head';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = m.aiGenerated ? `AI · ${m.aiModel || 'unknown model'}` : m.authorName;
    if (!m.aiGenerated) this.hooks.attachProfileTrigger?.(author, m.authorId);
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    head.append(author, time);
    if (m.aiGenerated) {
      const via = document.createElement('span');
      via.className = 'msg-edited';
      via.textContent = `via ${m.authorName}`;
      head.append(via);
    }
    if (m.editedTs) {
      const edited = document.createElement('span');
      edited.className = 'msg-edited';
      edited.textContent = '(edited)';
      head.append(edited);
    }

    // Body: edit-mode textarea or rendered markdown.
    let body;
    if (this.editingMessageId === m.id) {
      body = document.createElement('div');
      body.className = 'msg-body editing';
      const ta = document.createElement('textarea');
      ta.value = m.text;
      ta.rows = Math.max(2, m.text.split('\n').length);
      const row = document.createElement('div');
      row.className = 'edit-actions';
      const save = document.createElement('button');
      save.textContent = 'Save';
      save.className = 'primary';
      save.onclick = () => this._saveEdit(m.id, ta.value);
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this._cancelEdit();
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
        if (e.key === 'Escape') cancel.click();
      });
      row.append(save, cancel);
      body.append(ta, row);
      setTimeout(() => ta.focus(), 0);
    } else {
      body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = window.renderMarkdown(m.text || '', {
        mentionNames: this._knownNames(),
        myName,
      });
    }

    // Attachments — inline image previews; everything else as a download chip.
    let attachmentsEl = null;
    if (Array.isArray(m.attachments) && m.attachments.length) {
      attachmentsEl = document.createElement('div');
      attachmentsEl.className = 'msg-attachments';
      for (const a of m.attachments) {
        const isImage = (a.contentType || '').startsWith('image/');
        if (isImage) {
          const img = document.createElement('img');
          img.src = a.url;
          img.alt = a.name;
          img.className = 'msg-image';
          img.onclick = () => this.hooks.openImageLightbox?.(a.url, a.name);
          attachmentsEl.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.href = a.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'attachment-chip';
          const sizeLabel = a.size ? ` (${formatBytes(a.size)})` : '';
          link.innerHTML = `${window.HuddleIcons.paperclip}<span></span>`;
          link.querySelector('span').textContent = `${a.name}${sizeLabel}`;
          attachmentsEl.appendChild(link);
        }
      }
    }

    const reactions = document.createElement('div');
    reactions.className = 'reactions';
    for (const [emoji, peers] of Object.entries(m.reactions || {})) {
      const pill = document.createElement('span');
      pill.className = 'reaction' + (peers.includes(this.mesh.peerId) ? ' mine' : '');
      pill.textContent = `${emoji} ${peers.length}`;
      pill.onclick = () => this.mesh.toggleReaction(m.id, emoji);
      reactions.appendChild(pill);
    }

    // Floating action toolbar — small chips that appear on row hover.
    // Replaces the old inline-quick-reactions row (5 large emoji
    // buttons + ➕) which dominated every hover and pushed body
    // content around. Now it's an absolutely-positioned cluster
    // near the top-right with: react, thread, edit, delete.
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const react = document.createElement('button');
    react.className = 'msg-action';
    react.innerHTML = window.HuddleIcons.smile;
    react.title = 'Add reaction';
    react.setAttribute('aria-label', 'Add reaction');
    react.onclick = (ev) => this._openReactionPicker(ev, m.id);
    actions.appendChild(react);
    if (!m.parentId && this.threadParentId === null) {
      const thread = document.createElement('button');
      thread.className = 'msg-action';
      thread.innerHTML = window.HuddleIcons.thread;
      thread.title = 'Reply in thread';
      thread.setAttribute('aria-label', 'Reply in thread');
      thread.onclick = () => this.openThread(m.id);
      actions.appendChild(thread);
    }
    // Pin / unpin: any channel member can toggle. The RPC enforces
    // channel membership; the realtime UPDATE re-renders the row with
    // (or without) the pinned class on every viewer's screen.
    const pin = document.createElement('button');
    pin.className = 'msg-action' + (m.pinnedAt ? ' active' : '');
    pin.innerHTML = window.HuddleIcons.pin;
    pin.title = m.pinnedAt ? 'Unpin message' : 'Pin message';
    pin.setAttribute('aria-label', pin.title);
    pin.onclick = () => this._togglePin(m.id, !m.pinnedAt);
    actions.appendChild(pin);
    // Copy-link: share a deep link straight to this message. The
    // permalink is decoded by app.js parseInviteLink + scrollToMessage.
    const link = document.createElement('button');
    link.className = 'msg-action';
    link.innerHTML = window.HuddleIcons.link;
    link.title = 'Copy link to message';
    link.setAttribute('aria-label', 'Copy link to message');
    link.onclick = () => this._copyMessageLink(m.id);
    actions.appendChild(link);
    if (isMine) {
      const edit = document.createElement('button');
      edit.className = 'msg-action';
      edit.innerHTML = window.HuddleIcons.edit;
      edit.title = 'Edit message';
      edit.setAttribute('aria-label', 'Edit message');
      edit.onclick = () => this._beginEdit(m.id);
      const del = document.createElement('button');
      del.className = 'msg-action danger';
      del.innerHTML = window.HuddleIcons.trash;
      del.title = 'Delete message';
      del.setAttribute('aria-label', 'Delete message');
      del.onclick = () => this._delete(m.id);
      actions.append(edit, del);
    }

    // Jira + GitHub unfurls: scan the message text and render a card per
    // match. Each card resolves async via its respective cached lookup.
    const jiraEls = this._renderJiraUnfurls(m.text || '');
    const ghEls = this._renderGitHubUnfurls(m.text || '');

    const children = [head, body];
    if (attachmentsEl) children.push(attachmentsEl);
    if (jiraEls.length) children.push(...jiraEls);
    if (ghEls.length) children.push(...ghEls);
    children.push(reactions, actions);
    if (!m.parentId && this.threadParentId === null) {
      const replies = (all || []).filter((x) => x.parentId === m.id);
      // Only render the inline link when there's an actual thread to
      // jump to. The empty "Reply in thread" zero-state shipped on
      // every message and added clutter; the toolbar's 💬 button
      // covers the new-thread entry point now.
      if (replies.length > 0) {
        const link = document.createElement('div');
        link.className = 'thread-link';
        link.textContent = `↪ ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
        link.onclick = () => this.openThread(m.id);
        children.push(link);
      }
    }
    right.append(...children);
    wrap.append(avatar, right);
    return wrap;
  }

  _initEmojiPicker() {
    const p = this.els.emojiPicker;
    p.innerHTML = '';
    for (const group of window.EMOJI_GROUPS) {
      const h = document.createElement('div');
      h.className = 'group-header';
      h.textContent = group.name;
      p.appendChild(h);
      for (const [, char] of group.list) {
        const b = document.createElement('button');
        b.textContent = char;
        b.onclick = (e) => {
          e.stopPropagation();
          if (this._emojiPickerMode === 'react' && this._emojiPickerTarget) {
            this.mesh.toggleReaction(this._emojiPickerTarget, char);
          } else {
            this.els.composer.value += char;
            this.els.composer.focus();
          }
          p.classList.add('hidden');
          this._resetEmojiPickerAnchor();
        };
        p.appendChild(b);
      }
    }
  }

  _openReactionPicker(ev, messageId) {
    ev.stopPropagation();
    this._emojiPickerMode = 'react';
    this._emojiPickerTarget = messageId;
    const p = this.els.emojiPicker;
    // Position the picker next to the clicked react button instead of
    // the default composer-anchored slot. Use position: fixed (set via
    // [data-anchor=react]) and align the picker's right edge with the
    // button's right edge, opening downward by default and flipping
    // upward when there isn't room below.
    const btn = ev.currentTarget;
    const rect = btn.getBoundingClientRect();
    p.classList.remove('hidden');
    p.dataset.anchor = 'react';
    const margin = 8;
    const w = p.offsetWidth || 296;
    const h = p.offsetHeight || 340;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.min(Math.max(margin, rect.right - w), vw - w - margin);
    let top = rect.bottom + 6;
    if (top + h > vh - margin) top = Math.max(margin, rect.top - h - 6);
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
    p.style.right = 'auto';
    p.style.bottom = 'auto';
  }

  _resetEmojiPickerAnchor() {
    const p = this.els.emojiPicker;
    if (p.dataset.anchor === 'react') {
      delete p.dataset.anchor;
      p.style.left = p.style.top = p.style.right = p.style.bottom = '';
    }
  }

  // --- GIF picker (Giphy) -------------------------------------------------

  _initGifPicker() {
    if (!this.els.gifBtn) return;
    this._on(this.els.gifBtn, 'click', (e) => {
      e.stopPropagation();
      const hidden = this.els.gifPicker.classList.toggle('hidden');
      if (!hidden) this._openGifPicker();
    });
    if (this.els.gifClose) this._on(this.els.gifClose, 'click', () => this.els.gifPicker.classList.add('hidden'));
    if (this.els.gifSearch) this._on(this.els.gifSearch, 'input', () => this._scheduleGifSearch());
    this._on(document, 'click', (e) => {
      if (this.els.gifPicker?.classList.contains('hidden')) return;
      if (this.els.gifPicker.contains(e.target) || e.target === this.els.gifBtn) return;
      this.els.gifPicker.classList.add('hidden');
    });
  }

  async _openGifPicker() {
    // The orchestrator owns settings, including the Giphy key. We always
    // re-read so a freshly-saved key takes effect immediately.
    try {
      this._giphyKey = this.hooks.getGiphyKey ? await this.hooks.getGiphyKey() : '';
    } catch { this._giphyKey = ''; }
    this.els.gifSearch.value = '';
    this.els.gifSearch.focus();
    this.els.gifAttribution?.classList.toggle('hidden', !this._giphyKey);
    if (!this._giphyKey) {
      this._renderGifEmpty('Add a Giphy API key in Settings (⚙) to enable the GIF picker. Get one at https://developers.giphy.com/');
      return;
    }
    // Show trending GIFs as the default state.
    this._fetchGifs('');
  }

  _scheduleGifSearch() {
    clearTimeout(this._gifSearchTimer);
    this._gifSearchTimer = setTimeout(() => this._fetchGifs(this.els.gifSearch.value.trim()), 250);
  }

  async _fetchGifs(query) {
    if (!this._giphyKey) return;
    const seq = ++this._gifFetchSeq;
    const base = 'https://api.giphy.com/v1/gifs';
    const params = new URLSearchParams({
      api_key: this._giphyKey,
      limit: '24',
      rating: 'g',
    });
    if (query) params.set('q', query);
    const url = query ? `${base}/search?${params}` : `${base}/trending?${params}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('giphy ' + res.status);
      const json = await res.json();
      // A newer query may have superseded this one mid-flight.
      if (seq !== this._gifFetchSeq) return;
      this._renderGifResults(json.data || []);
    } catch (err) {
      if (seq !== this._gifFetchSeq) return;
      console.warn('giphy failed', err);
      this._renderGifEmpty('Could not reach Giphy. Check your key and network.');
    }
  }

  _renderGifEmpty(msg) {
    this.els.gifGrid.replaceChildren();
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = msg;
    this.els.gifGrid.appendChild(el);
  }

  _renderGifResults(results) {
    this.els.gifGrid.replaceChildren();
    if (!results.length) {
      this._renderGifEmpty('No matches.');
      return;
    }
    for (const r of results) {
      const images = r.images || {};
      const preview = images.fixed_height_small?.url
        || images.preview_gif?.url
        || images.original?.url;
      const full = images.original?.url || preview;
      if (!preview || !full) continue;
      const img = document.createElement('img');
      img.src = preview;
      img.loading = 'lazy';
      img.alt = r.title || 'gif';
      img.onclick = () => this._postGif(full, r);
      this.els.gifGrid.appendChild(img);
    }
  }

  // --- Slash commands -----------------------------------------------------
  // Returns `true` if the command was consumed (no chat message should go
  // out); `false` if the input should be sent verbatim.
  async _maybeRunSlash(text) {
    // [\w-]+ = [A-Za-z0-9_-], matching _refreshSlashSuggest's autocomplete
    // regex. `\w` alone doesn't include hyphens, so the old pattern
    // silently rejected any hyphenated command (notably /ai-ticket) and
    // the dispatch fell through to a plain message.
    const m = /^\/([\w-]+)(?:\s+([\s\S]+))?$/.exec(text);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const arg = (m[2] || '').trim();
    if (cmd === 'me') return this._runSlashMe(arg);
    if (cmd === 'shrug') return this._runSlashShrug(arg);
    if (cmd === 'ai') return this._runSlashAi(arg);
    if (cmd === 'ai-ticket' || cmd === 'ait') return this._runSlashAiTicket(arg);
    if (cmd === 'summarize' || cmd === 'summary') return this._runSlashSummarize();
    if (cmd === 'gh' || cmd === 'github') return this._runSlashGh(arg);
    if (cmd === 'jira') {
      // /jira create [summary]    -> open the create-ticket modal
      // /jira <KEY>               -> post a message containing the URL,
      //                              which auto-unfurls for everyone
      // /jira (no arg)            -> open create-ticket modal (most common)
      if (!arg || /^create\b/i.test(arg)) {
        const summary = arg.replace(/^create\s*/i, '');
        this.hooks.openTicketModal?.({ summary });
        return true;
      }
      const jira = this.hooks.getJira?.();
      if (!jira?.isConfigured()) {
        alert('Jira is not configured. Open settings (⚙) to add your Atlassian credentials.');
        return true;
      }
      // Treat the rest as an issue key.
      const key = arg.toUpperCase();
      const url = jira.issueUrl(key);
      await this.mesh.sendMessage({
        channelId: this.currentChannel,
        parentId: this.threadParentId,
        text: url,
        attachments: [],
      });
      return true;
    }
    return false;
  }

  // --- Local slash commands -----------------------------------------------

  // /me <action> — italicized third-person line ("Alice waves").
  // The author name is added on the receiver side from the row's
  // author_name (set by the messages_set_author trigger), so we just
  // post the action wrapped in markdown italics; receivers will see
  // "Alice" + the action just like any other message header + body.
  async _runSlashMe(action) {
    const text = (action || '').trim();
    if (!text) return true;
    await this.mesh.sendMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: `_${text}_`,
      attachments: [],
    });
    return true;
  }

  // /shrug [text] — appends the classic ASCII shrug to whatever the
  // user typed (or sends just the shrug if no text was given). Doubled
  // backslash because the literal contains a single backslash.
  async _runSlashShrug(text) {
    const body = (text || '').trim();
    const shrug = '¯\\_(ツ)_/¯';
    await this.mesh.sendMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: body ? `${body} ${shrug}` : shrug,
      attachments: [],
    });
    return true;
  }

  // --- AI slash commands --------------------------------------------------

  async _runSlashAi(prompt) {
    const ai = this.hooks.getAi?.();
    if (!ai || !ai.isConfigured()) {
      alert('No AI provider is configured. Open Settings (⚙) to add an Anthropic or OpenRouter API key.');
      return true;
    }
    if (!prompt) {
      alert('Usage: /ai <your question>');
      return true;
    }
    // Once validated, clear the composer + show "🤖 AI is thinking…" in
    // the typing-indicator slot so the user knows the (slow) request is
    // in flight. Only the local user sees the thinking indicator —
    // it's not broadcast.
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this._beginAiThinking();
    // Wire any configured integrations as tools so the AI can answer
    // ticket/repo questions without the user having to copy-paste
    // context. The system prompt nudges the model to call them when
    // the user names a Jira key or asks for an update; otherwise it
    // falls through to plain chat.
    const jira = this.hooks.getJira?.();
    const tools = window.HuddleAiTools ? window.HuddleAiTools.buildJiraTools(jira) : [];
    const system = tools.length
      ? 'You are a helpful assistant inside a team chat app. When the user references a Jira ticket key (e.g. "FOO-123") or asks to update / comment on / transition a ticket, use the Jira tools to fetch context first and then act. Be concise — bullet points for summaries, single-line confirmations after edits. Always state the ticket key + a one-line summary of what you did.'
      : undefined;
    let result;
    try {
      result = await ai.chat({
        system,
        messages: [{ role: 'user', content: prompt }],
        tools: tools.length ? tools : undefined,
        onToolUse: (name, input) => this._noteAiToolUse(name, input),
      });
    } catch (err) {
      alert('AI request failed: ' + (err.message || err));
      return true;
    } finally {
      this._endAiThinking();
    }
    // Wrap the response so the team has context: include the human's question
    // as a markdown blockquote at the top and the AI response below. Single
    // message, single bubble. When the AI used tools, append a small
    // footnote so the team can see what mutated — no surprise edits.
    let body = `> ${prompt.replace(/\n/g, '\n> ')}\n\n${result.text || '(no response)'}`;
    if (result.toolUses?.length) {
      const summary = result.toolUses.map((tu) => {
        const arg = tu.input?.key || tu.input?.jql || '';
        return arg ? `${tu.name}(${arg})` : tu.name;
      }).join(', ');
      body += `\n\n_via ${summary}_`;
    }
    await this.mesh.sendAiMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: body,
      model: result.model,
    });
    return true;
  }

  // Tool-use progress: surface the most recent tool name in the
  // "AI is thinking…" indicator so users can see when a slow Jira
  // call is in flight (otherwise the indicator looks stuck).
  _noteAiToolUse(name) {
    this._aiThinkingNote = name;
    this._refreshTyping();
  }

  // /ai-ticket <description> — let the AI structure a freeform
  // description into {summary, description, issueType} and create
  // the Jira ticket directly. Uses the default project from
  // Settings → Jira → Default project. Posts the resulting issue
  // URL into chat where the existing /jira unfurl handles the
  // status card.
  async _runSlashAiTicket(prompt) {
    const ai = this.hooks.getAi?.();
    const jira = this.hooks.getJira?.();
    if (!ai?.isConfigured()) {
      alert('No AI provider configured. Open Settings (⚙) → AI assistant.');
      return true;
    }
    if (!jira?.isConfigured()) {
      alert('Jira is not configured. Open Settings (⚙) → Jira.');
      return true;
    }
    const projectKey = (this.hooks.getDefaultJiraProject?.() || '').toUpperCase();
    if (!projectKey) {
      alert('No default Jira project set. Open Settings (⚙) → Jira → Default project.');
      return true;
    }
    if (!prompt) {
      alert('Usage: /ai-ticket <description>');
      return true;
    }
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this._beginAiThinking();
    // Attach GitHub tools only when both a repo slug AND a working
    // GitHub client are configured. Either missing falls through to a
    // tool-less single-shot prompt — the model still drafts a ticket,
    // it just can't ground in the codebase.
    const repoSlug = (this.hooks.getAiTicketRepo?.() || '').trim();
    const github = this.hooks.getGitHub?.();
    const useTools = !!(repoSlug && github?.isConfigured());
    const tools = useTools ? buildGithubTicketTools(github, repoSlug) : null;
    let aiResult;
    try {
      aiResult = await ai.chat({
        system: buildTicketSystemPrompt(this.hooks.getAiTicketContext?.(), {
          repoSlug: useTools ? repoSlug : null,
        }),
        messages: [{ role: 'user', content: prompt }],
        tools: tools || undefined,
        // Bound the loop so a misbehaving model can't run up the API
        // bill — typical /ai-ticket needs 1-3 tool calls then drafts.
        maxIterations: useTools ? 6 : undefined,
        onToolUse: useTools ? ((name) => this._noteAiToolUse(`github:${name}`)) : undefined,
      });
    } catch (err) {
      this._endAiThinking();
      alert('AI request failed: ' + (err?.message || err));
      return true;
    }
    this._endAiThinking();
    let parsed;
    try { parsed = parseTicketJson(aiResult.text); }
    catch (err) {
      alert('AI returned an unparseable response: ' + err.message);
      return true;
    }
    if (!parsed.summary) {
      alert('AI did not produce a ticket summary. Try rephrasing the description.');
      return true;
    }
    // Jira's summary field is hard-capped to 255 chars by the API; the
    // 250 slice is a safety net so an unusually verbose AI summary
    // still creates the ticket instead of erroring out at the Jira call.
    // slice() is a no-op when the string is already shorter, so no
    // conditional is needed. The description has effectively no length
    // limit and stays untouched.
    const summary = parsed.summary.slice(0, 250);
    let issue;
    try {
      issue = await jira.createIssue({
        projectKey,
        summary,
        description: parsed.description || '',
        issueType: parsed.issueType || 'Task',
      });
    } catch (err) {
      alert('Could not create Jira ticket: ' + (err?.message || err));
      return true;
    }
    const url = jira.issueUrl(issue.key);
    const body = `Created **${issue.key}** (${parsed.issueType || 'Task'}): ${parsed.summary}\n\n${url}`;
    try {
      await this.mesh.sendAiMessage({
        channelId: this.currentChannel,
        parentId: this.threadParentId,
        text: body,
        model: aiResult.model,
      });
    } catch (err) {
      // Ticket exists in Jira at this point; we just couldn't post
      // about it. Tell the user explicitly with the key + URL so
      // they don't think nothing happened.
      console.warn('[ai-ticket] post failed', err);
      alert(`Created ${issue.key} but couldn't post to chat: ${err?.message || err}\n\n${url}`);
    }
    return true;
  }

  async _runSlashSummarize() {
    const ai = this.hooks.getAi?.();
    if (!ai || !ai.isConfigured()) {
      alert('No AI provider is configured. Open Settings (⚙) to add an Anthropic or OpenRouter API key.');
      return true;
    }
    // Summarize the last 100 visible messages of the current channel/thread.
    // We use the in-memory cache (already paginated) rather than re-fetching.
    const all = this._messages();
    const list = (this.threadParentId
      ? all.filter((m) => m.id === this.threadParentId || m.parentId === this.threadParentId)
      : all.filter((m) => !m.parentId)
    ).slice(-100);
    if (list.length === 0) {
      alert('Nothing to summarize yet.');
      return true;
    }
    // Clear composer + flag thinking before the slow API call.
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this._beginAiThinking();
    let result;
    try { result = await ai.summarize(list); }
    catch (err) { alert('Summarize failed: ' + (err.message || err)); return true; }
    finally { this._endAiThinking(); }
    const body = `🧠 **Summary of recent messages**\n\n${result.text || '(no summary)'}`;
    await this.mesh.sendAiMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: body,
      model: result.model,
    });
    return true;
  }

  async _runSlashGh(arg) {
    const gh = this.hooks.getGitHub?.();
    if (!gh || !gh.isConfigured()) {
      alert('GitHub is not configured. Open Settings (⚙) to add a Personal Access Token.');
      return true;
    }
    if (!arg) {
      alert('Usage: /gh <owner>/<repo>#<number> | /gh issue <owner>/<repo> <title> [-- body…]');
      return true;
    }
    // /gh <owner>/<repo>#<num> — quick lookup, post URL so it auto-unfurls
    const ref = window.githubParseRef(arg);
    if (ref) {
      const url = gh.htmlUrl(ref.owner, ref.repo, ref.number);
      await this.mesh.sendMessage({
        channelId: this.currentChannel,
        parentId: this.threadParentId,
        text: url,
      });
      return true;
    }
    // /gh issue <owner>/<repo> <title> [-- body…]
    const m = /^(issue|pr)\s+([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\s+([\s\S]+)$/.exec(arg);
    if (!m) {
      alert('Usage: /gh <owner>/<repo>#<number>  OR  /gh issue <owner>/<repo> <title> [-- body…]');
      return true;
    }
    const [, kind, owner, repo, rest] = m;
    if (kind !== 'issue') {
      alert('Only /gh issue is supported for creation right now (PRs need a branch — use the GitHub UI).');
      return true;
    }
    let title = rest, body = '';
    const sep = rest.indexOf('--');
    if (sep > 0) { title = rest.slice(0, sep).trim(); body = rest.slice(sep + 2).trim(); }
    let issue;
    try { issue = await gh.createIssue(owner, repo, { title, body }); }
    catch (err) { alert('GitHub create failed: ' + (err.message || err)); return true; }
    await this.mesh.sendMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: `Created GitHub issue: ${issue.html_url}`,
    });
    return true;
  }

  // --- GitHub unfurl ------------------------------------------------------

  _renderGitHubUnfurls(text) {
    const gh = this.hooks.getGitHub?.();
    if (!gh || !gh.isConfigured()) return [];
    const refs = window.githubExtractRefs(text);
    if (!refs.length) return [];
    const out = [];
    for (const ref of refs) {
      const el = document.createElement('div');
      el.className = 'gh-unfurl';
      this._paintGhLoading(el, ref);
      out.push(el);
      this._lookupGhAndPaint(ref, el, gh);
    }
    return out;
  }

  _paintGhLoading(el, ref) {
    el.classList.remove('error');
    el.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'gh-loading';
    loading.textContent = `Loading ${ref.owner}/${ref.repo}#${ref.number}…`;
    el.appendChild(loading);
  }

  async _lookupGhAndPaint(ref, el, gh) {
    const cacheKey = `${ref.owner}/${ref.repo}#${ref.number}`;
    if (!this._ghCache) { this._ghCache = new Map(); this._ghInflight = new Map(); }
    const cached = this._ghCache.get(cacheKey);
    let issue = cached;
    if (issue === undefined) {
      let p = this._ghInflight.get(cacheKey);
      if (!p) {
        p = gh.getIssueOrPull(ref.owner, ref.repo, ref.number)
          .then((data) => { this._ghCache.set(cacheKey, data); return data; })
          .catch((err) => { this._ghCache.set(cacheKey, null); throw err; })
          .finally(() => this._ghInflight.delete(cacheKey));
        this._ghInflight.set(cacheKey, p);
      }
      try { issue = await p; }
      catch (err) {
        el.classList.add('error');
        el.replaceChildren();
        const e = document.createElement('div');
        e.className = 'gh-loading';
        e.textContent = `${cacheKey}: ${err.message || 'lookup failed'}`;
        el.appendChild(e);
        return;
      }
    }
    if (!issue) {
      el.classList.add('error');
      el.replaceChildren();
      const e = document.createElement('div');
      e.className = 'gh-loading';
      e.textContent = `${cacheKey}: not found or no access`;
      el.appendChild(e);
      return;
    }
    el.replaceChildren();
    const isPr = !!issue.pull_request;
    const top = document.createElement('div');
    top.className = 'gh-row';
    const link = document.createElement('a');
    link.href = issue.html_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'gh-key';
    link.textContent = `${isPr ? 'PR' : 'Issue'} · ${cacheKey}`;
    const stat = document.createElement('span');
    const state = (issue.state || '').toLowerCase();
    const statusKind = state === 'closed' ? (issue.merged ? 'merged' : 'closed') : 'open';
    stat.className = `gh-status ${statusKind}`;
    stat.textContent = statusKind;
    // Reload — busts the cache and re-fetches so the user can pull
    // the latest status without re-running /gh. Await the lookup so
    // the button's disabled state covers the whole refetch.
    const reload = this._buildReloadButton(async () => {
      this._ghCache.delete(cacheKey);
      this._paintGhLoading(el, ref);
      await this._lookupGhAndPaint(ref, el, gh);
    });
    top.append(link, stat, reload);
    const sumRow = document.createElement('div');
    sumRow.className = 'gh-summary';
    sumRow.textContent = issue.title || '';
    const meta = document.createElement('div');
    meta.className = 'gh-row';
    meta.style.color = 'var(--text-dim)';
    const assignee = issue.assignee?.login || (issue.assignees?.[0]?.login) || 'Unassigned';
    meta.textContent = `Author: ${issue.user?.login || '?'}  ·  Assignee: ${assignee}  ·  Comments: ${issue.comments ?? 0}`;
    el.append(top, sumRow, meta);
  }

  // --- Jira unfurl --------------------------------------------------------

  // Small ↻ button reused by both unfurl renderers. Disables itself
  // for the duration of the click handler so a double-click doesn't
  // fire two refetches.
  _buildReloadButton(onClick) {
    const btn = document.createElement('button');
    btn.className = 'unfurl-reload';
    btn.title = 'Reload latest status';
    btn.setAttribute('aria-label', 'Reload latest status');
    btn.innerHTML = window.HuddleIcons.refresh;
    btn.onclick = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try { await onClick(); } finally { btn.disabled = false; }
    };
    return btn;
  }

  // Returns an array of <div class="jira-unfurl"> elements (possibly empty)
  // for the message text. Cards start in a "loading" state; the lookup is
  // fired off async and the DOM mutated in place when it returns.
  _renderJiraUnfurls(text) {
    const jira = this.hooks.getJira?.();
    if (!jira || !jira.isConfigured()) return [];
    const matches = window.jiraExtractKeys(text, jira.host);
    if (!matches.length) return [];
    const out = [];
    for (const { key } of matches) {
      const el = document.createElement('div');
      el.className = 'jira-unfurl';
      this._paintJiraLoading(el, key);
      out.push(el);
      this._lookupAndPaint(key, el, jira);
    }
    return out;
  }

  _paintJiraLoading(el, key) {
    el.classList.remove('error');
    el.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'jira-loading';
    loading.textContent = `Loading ${key}…`;
    el.appendChild(loading);
  }

  async _lookupAndPaint(key, el, jira) {
    try {
      const issue = await this._lookupJira(key, jira);
      if (!issue) {
        el.classList.add('error');
        el.replaceChildren();
        const err = document.createElement('div');
        err.className = 'jira-loading';
        err.textContent = `${key}: not found or no access`;
        el.appendChild(err);
        return;
      }
      const fields = issue.fields || {};
      const status = fields.status?.name || '';
      const statusKind = (fields.status?.statusCategory?.key || '').toLowerCase(); // 'new'|'indeterminate'|'done'
      const statusClass = statusKind === 'done' ? 'done'
        : statusKind === 'indeterminate' ? 'inprogress' : 'todo';
      const assignee = fields.assignee?.displayName || 'Unassigned';
      const issueType = fields.issuetype?.name || '';
      const url = jira.issueUrl(issue.key);

      el.replaceChildren();
      const top = document.createElement('div');
      top.className = 'jira-row';
      const link = document.createElement('a');
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.className = 'jira-key';
      link.textContent = `${issueType ? issueType + ' · ' : ''}${issue.key}`;
      const stat = document.createElement('span');
      stat.className = `jira-status ${statusClass}`;
      stat.textContent = status;
      // Reload — busts the cache and re-fetches the latest status
      // without re-pasting the issue key into chat. Await the lookup
      // so the button stays disabled for the whole refetch.
      const reload = this._buildReloadButton(async () => {
        this._jiraCache.delete(key);
        this._paintJiraLoading(el, key);
        await this._lookupAndPaint(key, el, jira);
      });
      top.append(link, stat, reload);

      const sumRow = document.createElement('div');
      sumRow.className = 'jira-summary';
      sumRow.textContent = fields.summary || '';

      const meta = document.createElement('div');
      meta.className = 'jira-row';
      meta.style.color = 'var(--text-dim)';
      meta.textContent = `Assignee: ${assignee}`;

      el.append(top, sumRow, meta);
    } catch (err) {
      el.classList.add('error');
      el.replaceChildren();
      const errEl = document.createElement('div');
      errEl.className = 'jira-loading';
      errEl.textContent = `${key}: ${err.message || 'lookup failed'}`;
      el.appendChild(errEl);
    }
  }

  async _lookupJira(key, jira) {
    if (this._jiraCache.has(key)) return this._jiraCache.get(key);
    if (this._jiraInflight.has(key)) return this._jiraInflight.get(key);
    const p = (async () => {
      try {
        const issue = await jira.getIssue(key);
        this._jiraCache.set(key, issue);
        return issue;
      } catch (err) {
        this._jiraCache.set(key, null);
        throw err;
      } finally {
        this._jiraInflight.delete(key);
      }
    })();
    this._jiraInflight.set(key, p);
    return p;
  }

  _postGif(url, result) {
    const images = result?.images || {};
    const size = parseInt(images.original?.size, 10) || 0;
    this.mesh.sendMessage({
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: '',
      attachments: [{
        url,
        name: (result?.title || 'giphy.gif').slice(0, 80),
        contentType: 'image/gif',
        size,
      }],
    });
    this.els.gifPicker.classList.add('hidden');
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

window.ChatView = ChatView;
