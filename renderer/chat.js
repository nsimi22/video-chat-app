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

// How long to swallow a re-click of the *same* GIF in the picker. Long
// enough to cover the post's realtime echo round-trip (so "didn't see it,
// clicked again" doesn't double-post); short enough that an intentional
// repeat isn't blocked for long.
const GIF_RECLICK_DEBOUNCE_MS = 5000;

// An `@<partial>` mention token sitting at the end of a string: `@`
// preceded by start-of-text or a non-name char (the same boundary
// extractMentions uses, so `foo@bar` doesn't count), then a run of
// name chars with no whitespace. Capture group 1 is the partial. No
// `g` flag — reused statelessly by the composer's mention popup.
const MENTION_TOKEN_RE = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_.-]*)$/;

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

## User story
Required for "Story". Strongly preferred for "Task" / "Bug" when there's a real user persona to point at. Single line in the form: "As a <persona>, I want <capability>, so that <benefit>." Skip only when the work is purely internal (e.g., a build-system fix nobody outside engineering experiences).

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

// System prompts for the /ai command (the general-purpose assistant, as
// opposed to the Jira-specific /ai-ticket). /ai must answer anything —
// jokes, explanations, code, brainstorming — and never deflect a request
// just because it isn't about Jira (free OpenRouter models were
// over-indexing on the old Jira-heavy prompt and refusing). When Jira
// tools are wired up we use the *_WITH_JIRA variant, which notes the tools
// exist but keeps Jira one optional capability rather than the AI's purpose.
const AI_SYSTEM_PROMPT = 'You are a helpful, general-purpose AI assistant inside a team chat app. Answer whatever the user asks. Be concise.';
const AI_SYSTEM_PROMPT_WITH_JIRA = 'You are a helpful, general-purpose AI assistant inside a team chat app. Answer whatever the user asks — questions, jokes, explanations, brainstorming, code, anything — like any capable chat assistant would; never refuse or redirect a request just because it is not about Jira. You also have Jira tools available: when the user names a Jira ticket key (e.g. "FOO-123") or asks to read / comment on / update / transition a ticket, call those tools to fetch context first and then act. Be concise — bullet points for summaries, and for any ticket changes give a single-line confirmation stating the ticket key plus a one-line summary of what you did.';
// Appended when the team-roadmap tools are wired (any connected team):
// lets "/ai put the billing revamp on the roadmap for late July" work.
// Built per-call so it can carry today's date for resolving relative dates.
function aiRoadmapPromptAddendum() {
  return `You can also read and add to the team roadmap (the shared timeline of deliverables on the board) via the roadmap_* tools: use roadmap_add_item when the user asks to put something on the roadmap — resolve relative dates like "end of July" to YYYY-MM-DD knowing that today is ${new Date().toISOString().slice(0, 10)}, and omit dates the user didn't imply — and roadmap_list_items to answer questions about what's planned. Confirm additions with the item title and date in one line.`;
}

// Tool definitions for the /ai-ticket loop live in ai-tools.js
// (window.HuddleAiTools.buildGithubTicketTools) so the AI panel can reuse
// the same repo-scoped GitHub read tools. Built only when both a
// GitHubClient and a configured repo slug are available; otherwise the AI
// call stays a single-shot prompt with no tool surface.

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
    // ChatView talks to HuddleClient directly for chat ops + chat-*
    // event subscriptions; the call client is constructed on demand
    // when the user starts a call and isn't always alive. The
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
    this._savingMessageId = null; // edit-save in flight (re-entrancy guard)
    this.composerAttachments = []; // [{file, status, info?}] where info = {url, name, contentType, size}
    // Session cache for Jira lookups: key -> { issue | null, error?, host? }.
    // null = lookup failed but completed (don't retry within session).
    this._jiraCache = new Map();
    this._jiraInflight = new Map();
    // GIF picker state: monotonic sequence to drop stale Giphy responses.
    this._gifFetchSeq = 0;
    this._gifSearchTimer = null;
    this._giphyKey = null;
    // Last GIF posted (url + timestamp) — debounces the "didn't see it
    // post, clicked the same one again" double-post while the realtime
    // echo is still in flight.
    this._lastGifUrl = null;
    this._lastGifAt = 0;
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
    // @-mention autocomplete state.
    this._mentionOpen = false;
    this._mentionFiltered = [];
    this._mentionIndex = 0;
    // author key -> { name, color } for everyone who has authored a
    // loaded message. Keyed by user_id when known so a renamed user
    // doesn't show up under both their old and new display names;
    // falls back to `name:<lower>` for AI/system messages without an
    // author_id. Built incrementally (see _noteMentionAuthor) so the
    // mention popup never re-scans the whole message history per
    // keystroke.
    this._mentionDirectory = new Map();
    // Debounced draft persistence — see _scheduleDraftSave.
    this._draftSaveTimer = null;
    this._pendingDraft = null;

    this.typingClock = setInterval(() => this._refreshTyping(), 800);
    // One-shot timer that fires just after the next local midnight to
    // re-render the date dividers — without it a user sitting in a
    // channel across midnight would see yesterday's messages still
    // labelled "Today". Reschedules itself on every fire.
    this._midnightTimer = null;
    this._scheduleMidnightRefresh();
    this._wireDom();
    this._wireMesh();
    this._initEmojiPicker();
    this._initGifPicker();
    this._initPollComposer();
    this._initClipRecorder();
  }

  // --- Public API ---------------------------------------------------------

  setChannel(channelId, topic, displayLabel, channelType) {
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
    this._currentChannelType = channelType || null;
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
    // Header lock for private channels — sidebar drops the 🔒 prefix
    // in favour of the Lock SVG icon on the row, and this restores the
    // same visual cue when the user is actually inside the channel.
    this._applyHeaderPrefix();
    // Restore the new channel's draft (if any). Null/empty leaves
    // the composer blank. The restored value is set programmatically,
    // so the `input`-driven popups won't re-evaluate — close any that
    // were open against the old channel's text.
    this.els.composer.value = this._loadDraft(channelId) || '';
    this._hideSlashSuggest();
    this._hideMentionSuggest();
    this._autoResizeComposer();
    this._render();
    this._fetchHistory(channelId);
  }

  // Relabel the current channel in-place (e.g. a group DM's membership
  // changed) without reloading history or touching the composer draft.
  setLabel(channelId, displayLabel, channelType) {
    if (channelId !== this.currentChannel || !displayLabel) return;
    this._currentLabel = displayLabel;
    if (channelType) this._currentChannelType = channelType;
    if (this.threadParentId) return; // thread view shows "Thread", not the channel label
    this.els.chatChannelName.textContent = displayLabel;
    this.els.channelName.textContent = displayLabel;
    this.els.composer.placeholder = `Message ${displayLabel}`;
    this._applyHeaderPrefix();
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
    for (const m of incoming) this._noteMentionAuthor(m.authorName, m.authorColor, m.authorId);
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
    // Header reads "Thread", not the channel name — drop the lock
    // prefix so it doesn't read "🔒 Thread".
    if (this.els.chatChannelPrefix) this.els.chatChannelPrefix.replaceChildren();
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
    // Restore the lock prefix for private channels.
    this._applyHeaderPrefix();
    this._render();
  }

  // Mirror the sidebar's lock-icon decoration in the chat header for
  // private channels. Empty `<span>` for everything else; CSS `:empty`
  // collapses it so there's no stray margin.
  _applyHeaderPrefix() {
    const el = this.els.chatChannelPrefix;
    if (!el) return;
    if (this._currentChannelType === 'private' && window.HuddleIcons) {
      el.innerHTML = window.HuddleIcons.lock;
    } else {
      el.replaceChildren();
    }
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
      // Both autocomplete popups claim arrow keys, Tab, and Escape while
      // visible (they're mutually exclusive — a /command needs to be at
      // the start of the value, an @mention can't be). Enter still
      // submits when neither popup consumed it.
      if (this._slashOpen && this._handleSlashKeydown(e)) return;
      if (this._mentionOpen && this._handleMentionKeydown(e)) return;
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
      this._refreshMentionSuggest();
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
        this._hideMentionSuggest();
      }, 80);
    });
    this._on(this.els.composer, 'paste', (e) => this._onPaste(e));
    this._on(this.els.emojiBtn, 'click', (e) => {
      e.stopPropagation();
      this._resetEmojiPickerAnchor();
      const willShow = this.els.emojiPicker.classList.contains('hidden');
      this.els.emojiPicker.classList.toggle('hidden');
      this._emojiPickerMode = 'compose';
      if (willShow) this._refreshEmojiPicker();
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
      const arr = this.byChannel.get(m.channelId);
      // Postgres realtime can re-deliver a row we already have (our own
      // insert racing the local fetch, a re-subscribe, …). Bail on the
      // dupe BEFORE _appendIncremental — that helper unconditionally
      // appends a fresh DOM node, so calling it for an id we've already
      // rendered leaves two copies of the message on screen (and fires
      // onMessage twice).
      if (arr) {
        if (arr.some((x) => x.id === m.id)) return;
        arr.push(m);
      } else {
        this.byChannel.set(m.channelId, [m]);
      }
      this._noteMentionAuthor(m.authorName, m.authorColor, m.authorId);
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
    if (this._midnightTimer) clearTimeout(this._midnightTimer);
    this._midnightTimer = null;
    if (this._gifSearchTimer) clearTimeout(this._gifSearchTimer);
    this._gifSearchTimer = null;
    if (this._slashBlurTimer) clearTimeout(this._slashBlurTimer);
    this._slashBlurTimer = null;
    // Flush any pending debounced draft save so a sign-out / team
    // switch never strands the user's last keystrokes in a
    // never-fired timer.
    this._flushDraftSave();
    // Release any live camera/screen capture the clip recorder is holding
    // (e.g. the modal was left open when the team switched). Force-close so
    // teardown happens without a "Discard your recording?" prompt — there's
    // nobody to answer it during a programmatic destroy, and a blocked dialog
    // would strand the camera/screen tracks on.
    try { this._clipRecorder?.close(true); } catch {}
    this._clipRecorder = null;
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
    root.appendChild(this._buildSuggestHint());
    root.classList.remove('hidden');
  }

  // Footer row reminding users of the keyboard affordances. aria-hidden
  // so screen readers — which already announce the listbox items via
  // role="option" — don't read it as another choice.
  _buildSuggestHint() {
    const hint = document.createElement('div');
    hint.className = 'slash-suggest-hint';
    hint.setAttribute('role', 'presentation');
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = '<kbd>↑↓</kbd> navigate <span class="sep">·</span> <kbd>Tab</kbd>/<kbd>Enter</kbd> insert <span class="sep">·</span> <kbd>Esc</kbd> dismiss';
    return hint;
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

  // Drop `text` into the composer and focus it, caret at the end. Used by
  // the action-items "Create ticket → GitHub issue" path to seed a
  // `/gh issue …` command the user reviews and sends (which runs the
  // existing _runSlashGh flow — no create logic is duplicated). Mirrors
  // _fillSlashSuggest's manual auto-resize since a programmatic value
  // assignment doesn't fire the composer's `input` listener.
  _prefillComposer(text) {
    if (!this.els?.composer) return;
    this.els.composer.value = text || '';
    this._autoResizeComposer();
    // A programmatic `.value =` doesn't fire the composer's `input`
    // listener, so the per-channel draft is never persisted — switch
    // channels and the seeded text (e.g. a `/gh issue …` command) is
    // silently lost. Mirror what the input handler does and schedule
    // the same debounced draft save so the prefill survives a switch.
    if (this.currentChannel) this._scheduleDraftSave(this.currentChannel, this.els.composer.value);
    this.els.composer.focus();
    try {
      const end = this.els.composer.value.length;
      this.els.composer.setSelectionRange(end, end);
    } catch {}
  }

  // --- @-mention autocomplete ---------------------------------------------

  // Record a message author in the mention directory. Keyed by
  // authorId when present so a renamed user collapses to one entry;
  // latest write wins so the directory reflects the most recent name
  // we've seen for that user. Falls back to `name:<lower>` for
  // AI/system messages without an author_id.
  _noteMentionAuthor(name, color, authorId) {
    const n = (name || '').trim();
    if (!n) return;
    const k = authorId || ('name:' + n.toLowerCase());
    this._mentionDirectory.set(k, { name: n, color: color || '#8a8f98' });
  }

  // Resolve a user id to a display name by walking the same sources
  // we use for @mentions — live roster first (current canonical name),
  // then in-call presence, then the historical-author cache (covers
  // former members who reacted to old messages). Returns null when
  // nothing matches so callers can decide how to render the gap.
  _nameForUserId(uid) {
    if (!uid) return null;
    const roster = this.mesh.roster?.get?.(uid);
    if (roster?.name) return roster.name;
    const presence = this.mesh.peerInfo?.get?.(uid);
    if (presence?.name) return presence.name;
    const cached = this._mentionDirectory?.get?.(uid);
    if (cached?.name) return cached.name;
    return null;
  }

  // Build the native-tooltip string shown on hover of a reaction pill.
  // "you" sorts first when present; everyone else is by lookup order.
  // Caps at REACTION_TOOLTIP_MAX_NAMES so a popular announcement with
  // 50 thumbs-up doesn't produce a tooltip the browser truncates
  // mid-name.
  _reactionTooltip(emoji, peers) {
    return `${this._namesPhrase(peers)} reacted with ${emoji}`;
  }

  // Shared "you, Alice and 2 others" phrase builder for reaction pills
  // and poll-option tooltips.
  _namesPhrase(peers) {
    const myId = this.mesh.peerId;
    const names = [];
    let unknown = 0;
    // Self goes first so the user can confirm at a glance which
    // reactions/votes they themselves contributed to.
    if (peers.includes(myId)) names.push('you');
    for (const uid of peers) {
      if (uid === myId) continue;
      const n = this._nameForUserId(uid);
      if (n) names.push(n);
      else unknown++;
    }
    if (unknown > 0) names.push(unknown === 1 ? 'someone' : `${unknown} others`);
    // Trim overlong lists. Keep the first MAX_NAMES entries (which
    // includes 'you' at the front when present) and collapse the rest
    // into a single "and N more" slot.
    const MAX_NAMES = 4;
    let overflow = 0;
    if (names.length > MAX_NAMES) {
      overflow = names.length - MAX_NAMES;
      names.length = MAX_NAMES;
      names.push(`${overflow} more`);
    }
    if (names.length === 0) return 'no one';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // Teammates that can be @-mentioned: the live team roster (current
  // profile names by user_id) plus presence peers plus self, then any
  // historical message authors not in the roster (e.g. former
  // members). Deduped by user_id so a rename doesn't double-list the
  // user under old + new names.
  _mentionCandidates() {
    const byKey = new Map();
    const set = (key, name, color) => {
      const n = (name || '').trim();
      if (!n || !key) return;
      if (!byKey.has(key)) byKey.set(key, { name: n, color: color || '#8a8f98' });
    };
    set(this.mesh.peerId, this.mesh.name, this.mesh.color);
    for (const p of this.mesh.roster?.values?.() || []) set(p.id, p.name, p.color);
    for (const p of this.mesh.peerInfo.values()) set(p.id, p.name, p.color);
    for (const [k, v] of this._mentionDirectory) {
      if (!byKey.has(k)) byKey.set(k, v);
    }
    // Broadcast keywords. Tagged with kind='broadcast' so the row renderer
    // shows the leading '@' and the "notify the channel" subtitle, making
    // them visually distinct from teammates.
    const out = [...byKey.values()];
    out.push({ name: 'here', color: 'var(--warn)', kind: 'broadcast', subtitle: 'Notify the channel' });
    out.push({ name: 'channel', color: 'var(--warn)', kind: 'broadcast', subtitle: 'Notify the channel' });
    return out;
  }

  // Re-evaluate the @-mention popup against the caret. Shows it when the
  // caret sits at the end of an `@<partial>` token (see MENTION_TOKEN_RE)
  // and at least one teammate matches the partial.
  _refreshMentionSuggest() {
    // The slash popup wins if it's up — a value that's a /command can't
    // also be on an @mention token, but bail defensively anyway.
    if (this._slashOpen) { this._hideMentionSuggest(); return; }
    const el = this.els.composer;
    const caret = el.selectionStart ?? el.value.length;
    const m = MENTION_TOKEN_RE.exec(el.value.slice(0, caret));
    if (!m) { this._hideMentionSuggest(); return; }
    const q = m[1].toLowerCase();
    const matches = this._mentionCandidates()
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      // Prefix matches first, then alphabetical — so `@al` floats "Alex"
      // above "Pascal".
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q), bp = b.name.toLowerCase().startsWith(q);
        if (ap !== bp) return ap ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    if (!matches.length) { this._hideMentionSuggest(); return; }
    this._mentionFiltered = matches;
    this._mentionIndex = 0;
    this._mentionOpen = true;
    this._renderMentionSuggest();
  }

  _renderMentionSuggest() {
    const root = this.els.mentionSuggest;
    root.replaceChildren();
    for (let i = 0; i < this._mentionFiltered.length; i++) {
      const cand = this._mentionFiltered[i];
      const row = document.createElement('div');
      row.className = 'slash-suggest-item' + (i === this._mentionIndex ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === this._mentionIndex ? 'true' : 'false');
      const dot = document.createElement('span');
      dot.className = 'mention-dot';
      dot.style.background = cand.color;
      const name = document.createElement('span');
      name.className = 'mention-name';
      // Broadcast rows show the literal '@here' / '@channel' so they're
      // visibly different from a teammate row. Insertion still uses
      // cand.name; the '@' prefix gets added by _fillMentionSuggest.
      name.textContent = cand.kind === 'broadcast' ? '@' + cand.name : cand.name;
      row.append(dot, name);
      if (cand.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'mention-subtitle';
        sub.textContent = cand.subtitle;
        row.appendChild(sub);
      }
      // mousedown so the textarea-blur teardown doesn't beat the click.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this._fillMentionSuggest(i); });
      root.appendChild(row);
    }
    root.appendChild(this._buildSuggestHint());
    root.classList.remove('hidden');
  }

  _hideMentionSuggest() {
    this._mentionOpen = false;
    this._mentionFiltered = [];
    this._mentionIndex = 0;
    this.els.mentionSuggest.classList.add('hidden');
  }

  // Returns true iff the keypress was handled (caller bails out).
  _handleMentionKeydown(e) {
    if (!this._mentionOpen) return false;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._mentionIndex = (this._mentionIndex + 1) % this._mentionFiltered.length;
        this._renderMentionSuggest();
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this._mentionIndex = (this._mentionIndex - 1 + this._mentionFiltered.length) % this._mentionFiltered.length;
        this._renderMentionSuggest();
        return true;
      case 'Tab':
      case 'Enter':
        e.preventDefault();
        this._fillMentionSuggest(this._mentionIndex);
        return true;
      case 'Escape':
        e.preventDefault();
        this._hideMentionSuggest();
        return true;
      default:
        return false;
    }
  }

  _fillMentionSuggest(index) {
    const cand = this._mentionFiltered[index];
    if (!cand) return;
    const el = this.els.composer;
    const caret = el.selectionStart ?? el.value.length;
    // Re-derive the token at the *current* caret rather than trusting a
    // value captured when the popup opened: the caret can move (Left/Right
    // arrow) without firing `input`, so a stale offset would splice into
    // the wrong place. If the caret has moved off the token, just close.
    const m = MENTION_TOKEN_RE.exec(el.value.slice(0, caret));
    if (!m) { this._hideMentionSuggest(); return; }
    const atIdx = caret - m[1].length - 1; // index of the `@`
    const head = el.value.slice(0, atIdx);
    const tail = el.value.slice(caret);
    const insert = `@${cand.name} `;
    el.value = head + insert + tail;
    const pos = head.length + insert.length;
    el.setSelectionRange(pos, pos);
    // Programmatic value set doesn't fire `input`; mirror what that
    // handler would have done so the textarea sizing and per-channel
    // draft stay in sync with the new value.
    this._autoResizeComposer();
    if (this.currentChannel) this._scheduleDraftSave(this.currentChannel, el.value);
    el.focus();
    this._hideMentionSuggest();
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

    // Clear the composer up front — before the (sometimes laggy) send
    // round-trip — so a second Enter while it's in flight can't re-fire
    // and double-post. If the send actually throws, put the text +
    // attachments back so nothing is lost. Snapshot the destination
    // channel/thread so a mid-flight channel switch doesn't (a) send to
    // the wrong place or (b) dump the failed text into another channel's
    // composer on the restore path.
    const channelId = this.currentChannel;
    const parentId = this.threadParentId;
    const restoreAttachments = this.composerAttachments;
    this._clearDraft(channelId);
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this.composerAttachments = [];
    this._renderAttachmentChips();
    try {
      // Strict variant — the lenient sendMessage swallows failures,
      // which would make this whole catch (restore text + alert) dead
      // code and silently eat messages sent while offline.
      await this.mesh.sendMessageStrict({
        channelId,
        parentId,
        text: window.replaceShortcodes(text),
        attachments,
      });
    } catch (err) {
      // Re-stash the text as that channel's draft either way; only put it
      // back in the live composer if we're still looking at that channel.
      this._saveDraft(channelId, text);
      if (this.currentChannel === channelId) {
        this.els.composer.value = text;
        this._autoResizeComposer();
        this.composerAttachments = restoreAttachments;
        this._renderAttachmentChips();
      }
      alert("Couldn't send your message: " + (err?.message || err));
    }
  }

  _beginEdit(messageId) {
    this.editingMessageId = messageId;
    this._replaceNodeById(messageId);
  }

  async _saveEdit(messageId, newText) {
    // Re-entrancy guard: the Save button stays clickable while the
    // update is in flight (the row only re-renders on chat-update), so
    // a double-click would fire duplicate concurrent requests.
    if (this._savingMessageId === messageId) return;
    this._savingMessageId = messageId;
    this.editingMessageId = null;
    try {
      await this.mesh.editMessage(messageId, newText);
      // Realtime postgres_changes will fire chat-update; render happens then.
    } catch (err) {
      // Put the row back into edit mode — the textarea (with the user's
      // text) is still in the DOM since we only re-render on chat-update,
      // so they can retry Save or copy their changes out.
      this.editingMessageId = messageId;
      alert("Couldn't save your edit: " + (err?.message || err));
    } finally {
      if (this._savingMessageId === messageId) this._savingMessageId = null;
    }
  }

  _cancelEdit() {
    const id = this.editingMessageId;
    this.editingMessageId = null;
    if (id) this._replaceNodeById(id);
  }

  async _delete(messageId) {
    if (!confirm('Delete this message? It will be removed for everyone.')) return;
    // Optimistic local removal. Without this, the UI waits for
    // Supabase Realtime's DELETE event to fire — which it sometimes
    // doesn't carry through reliably (REPLICA IDENTITY on `messages`
    // is the default-FK form, so OLD.* columns can come back partial
    // for ai_generated rows). The handler below is idempotent so a
    // late DELETE event reaching us after the optimistic prune is a
    // safe no-op.
    let removedArr = null, removedIdx = -1, removed = null;
    for (const arr of this.byChannel.values()) {
      const idx = arr.findIndex((x) => x.id === messageId);
      if (idx >= 0) { removedArr = arr; removedIdx = idx; removed = arr[idx]; arr.splice(idx, 1); break; }
    }
    const node = this.nodeById.get(messageId);
    if (node) { node.remove(); this.nodeById.delete(messageId); }
    this._render();
    try { await this.mesh.deleteMessage(messageId); }
    catch (err) {
      // Roll back the optimistic removal — the row still exists
      // server-side (and for everyone else), so leaving it hidden
      // locally just desyncs this client until the next reload.
      if (removedArr && removed) {
        removedArr.splice(Math.min(removedIdx, removedArr.length), 0, removed);
        this._render();
      }
      alert("Couldn't delete the message: " + (err?.message || err));
    }
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
    if (await window.writeClipboard(url)) this.hooks.toast?.('Message link copied');
    else this.hooks.toast?.('Could not copy link');
  }

  async _copyText(text) {
    if (await window.writeClipboard(text)) this.hooks.toast?.('Copied to clipboard');
    else this.hooks.toast?.('Could not copy');
  }

  async _addMessageToRoadmap(m) {
    const where = this.hooks.getChannelName?.(this.currentChannel);
    try {
      await this.hooks.addRoadmapItem({
        title: (m.text || '').slice(0, 200),
        notes: `From a message in ${where ? '#' + where : 'a channel'}.`,
      });
      this.hooks.toast?.("Added to the roadmap — see the board's Timeline or Feed.");
    } catch (err) {
      this.hooks.toast?.(`Couldn't add to the roadmap: ${err?.message || err}`.slice(0, 140));
    }
  }

  // Right-click context-menu items for a message. Mirrors the hover action
  // bar (same handlers) plus copy-text and create-from-message; the global
  // dispatcher in app.js calls this and feeds it to HuddleContextMenu. `ev`
  // is the contextmenu event, passed through so the reaction picker can
  // anchor at the cursor.
  contextMenuItems(messageId, ev) {
    const m = this._messages().find((x) => x.id === messageId);
    if (!m) return [];
    const isMine = m.authorId ? m.authorId === this.mesh.peerId : m.authorName === this.mesh.name;
    const inThread = this.threadParentId !== null;
    const jiraOk = !!this.hooks.getJira?.()?.isConfigured?.();
    const roadmapOk = !!this.hooks.addRoadmapItem;
    const items = [];
    items.push({ label: 'Add reaction', icon: 'smile', onClick: () => this._openReactionPicker(ev, m.id) });
    if (!m.parentId && !inThread) items.push({ label: 'Reply in thread', icon: 'reply', onClick: () => this.openThread(m.id) });
    items.push({ type: 'divider' });
    if (m.text) items.push({ label: 'Copy text', icon: 'text', onClick: () => this._copyText(m.text) });
    items.push({ label: 'Copy link to message', icon: 'link', onClick: () => this._copyMessageLink(m.id) });
    items.push({ type: 'divider' });
    items.push({ label: m.pinnedAt ? 'Unpin message' : 'Pin message', icon: 'pin', onClick: () => this._togglePin(m.id, !m.pinnedAt) });
    items.push({
      label: this.hooks.isMessageSaved?.(m.id) ? 'Edit saved labels' : 'Save message', icon: 'bookmark',
      onClick: () => this.hooks.openSavePopover?.({ messageId: m.id, teamId: this.mesh.teamMeta?.id, channelId: this.currentChannel, anchor: this.nodeById.get(m.id) }),
    });
    if (m.text && (jiraOk || roadmapOk)) {
      items.push({ type: 'divider' });
      if (jiraOk) items.push({ label: 'Create Jira ticket', icon: 'ticket', onClick: () => this.hooks.openTicketModal?.({ summary: (m.text || '').split('\n')[0].slice(0, 120) }) });
      if (roadmapOk) items.push({ label: 'Add to roadmap', icon: 'calendar', onClick: () => this._addMessageToRoadmap(m) });
    }
    if (isMine) {
      items.push({ type: 'divider' });
      if (!m.meta?.poll) items.push({ label: 'Edit message', icon: 'pen', onClick: () => this._beginEdit(m.id) });
      items.push({ label: 'Delete message', icon: 'trash', danger: true, onClick: () => this._delete(m.id) });
    }
    return items;
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
    // Compute the @mention name set once per render — _knownNames
    // iterates the roster + cached messages + presence peers + author
    // directory, and the result is identical for every message in the
    // same render pass. Pre-fix this was an O(N²) hot path on the
    // initial render of a large channel.
    const mentionNames = this._knownNames();
    for (const m of visible) {
      // Drop a date banner before the first visible message and at
      // every local-day boundary so the user can tell at a glance
      // which day a message belongs to.
      if (!prev || !this._isSameLocalDay(prev.ts, m.ts)) {
        container.appendChild(this._buildDateDivider(m.ts));
      }
      const node = this._renderMessage(m, all, prev, mentionNames);
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

  // Local-day equality. Date getters already operate in the user's
  // local timezone, so a per-component compare gives the right answer
  // for two messages that span local midnight — without paying the
  // locale-formatting cost of toLocaleDateString on the render hot
  // path (called once per visible message + once per incoming message).
  _isSameLocalDay(tsA, tsB) {
    const a = new Date(tsA);
    const b = new Date(tsB);
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  // "Today" / "Yesterday" / "Tuesday, May 26" — collapses recent days
  // into friendly labels so the banner doesn't read like a log.
  _formatDateDivider(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (this._isSameLocalDay(d.getTime(), today.getTime())) return 'Today';
    if (this._isSameLocalDay(d.getTime(), yesterday.getTime())) return 'Yesterday';
    // Year omitted for the current calendar year; included otherwise so
    // scrolling back into last year's archive isn't ambiguous.
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  }

  // Prefix the time with the day a message was sent so each line carries
  // its own day inline — not just via the scroll-position date divider.
  // Today is the exception: it gets no prefix, because the message sits
  // under a "Today" divider that already says so and repeating it on
  // every line is noise in the common case. "Yesterday" and weekday
  // names cover the recent past; past a week the weekday names start
  // repeating and read ambiguously, so we escalate to a numeric date
  // (year appended only when it differs from now), mirroring the
  // friendly→explicit handling in _formatDateDivider above.
  _formatMessageTime(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const now = new Date();
    // _isSameLocalDay (shared with _formatDateDivider) keeps the two
    // helpers aligned and also means a message whose clock runs slightly
    // ahead of ours still reads as today, rather than a negative day
    // delta falling through to a misleading weekday name.
    if (this._isSameLocalDay(d.getTime(), now.getTime())) return time;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (this._isSameLocalDay(d.getTime(), yesterday.getTime())) return `Yesterday ${time}`;
    // Beyond yesterday: weekday name, escalating to a numeric date once
    // weekday names start repeating (>= 7 days). Math.max guards a
    // timestamp dated more than a day into the future (clock skew) from
    // being mislabeled as last week.
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const daysAgo = Math.max(0, Math.round((startToday - startMsg) / 86400000));
    if (daysAgo >= 7) {
      const sameYear = d.getFullYear() === now.getFullYear();
      const date = d.toLocaleDateString([], {
        month: 'numeric', day: 'numeric',
        ...(sameYear ? {} : { year: '2-digit' }),
      });
      return `${date} ${time}`;
    }
    return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  }

  _buildDateDivider(ts) {
    const wrap = document.createElement('div');
    wrap.className = 'date-divider';
    const label = document.createElement('span');
    label.className = 'date-divider-label';
    label.textContent = this._formatDateDivider(ts);
    wrap.appendChild(label);
    return wrap;
  }

  // Re-render the current channel just after the next local midnight
  // so the "Today" / "Yesterday" dividers refresh to reflect the new
  // day. The 1-second buffer past midnight makes sure new Date()
  // inside _formatDateDivider lands cleanly on the new day even
  // accounting for setTimeout drift on a busy machine.
  _scheduleMidnightRefresh() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    const ms = Math.max(1000, nextMidnight.getTime() - now.getTime());
    this._midnightTimer = setTimeout(() => {
      this._midnightTimer = null;
      // Only re-render when there's actually a channel mounted — on
      // sign-out the timer has already been cleared by destroy().
      if (this.currentChannel) this._render();
      this._scheduleMidnightRefresh();
    }, ms);
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
      // Drop a date banner when an incoming message lands on a different
      // local day than the last one we rendered (or when this is the
      // first message in an empty view). Without this branch the banner
      // only appeared on full re-renders, so a user sitting in a channel
      // across midnight would see today's messages with no `Today`
      // marker until they switched channels and back.
      if (!this._lastRendered || !this._isSameLocalDay(this._lastRendered.ts, m.ts)) {
        this.els.messages.appendChild(this._buildDateDivider(m.ts));
      }
      // Single message — one _knownNames call is fine, default fallthrough.
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

  // Public refresh hooks, wired from app.js when state outside the
  // chat (saved-message cache, profile renames, etc.) changes shape
  // without producing a chat-update event we'd otherwise listen for.
  refreshMessageById(id) {
    if (id && this.nodeById.has(id)) this._replaceNodeById(id);
  }
  refreshAllMessages() {
    // Profile renames / save-cache updates rebuild every visible row.
    // Same O(N²) trap as the initial render; pre-compute once and pass
    // the cached mention names through.
    const mentionNames = this._knownNames();
    for (const id of [...this.nodeById.keys()]) this._replaceNodeById(id, mentionNames);
  }

  _replaceNodeById(id, mentionNames) {
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
    const fresh = this._renderMessage(target, all, prev, mentionNames);
    this.nodeById.set(id, fresh);
    old.replaceWith(fresh);
  }

  // Names eligible for the `<span class="mention">` highlight pass in
  // renderMarkdown(). Previously this only pulled from self +
  // live-presence peers + cached message authors, which meant a
  // teammate who is offline AND has never authored a message in any
  // cached channel never got highlighted — even though the @-mention
  // autocomplete popup happily offered them (see _mentionCandidates,
  // which already iterates this.mesh.roster). The asymmetry showed
  // up in the wild as: "@Rachid @Leigh ..." rendered with only the
  // first name as a styled pill, because Leigh was rosterable but
  // not yet a known author. Pulling the roster + _mentionDirectory
  // in here makes the renderer a superset of the autocomplete: every
  // name we suggest is also a name we highlight.
  _knownNames() {
    const set = new Set();
    if (this.mesh.name) set.add(this.mesh.name);
    for (const p of this.mesh.roster?.values?.() || []) set.add(p.name);
    for (const p of this.mesh.peerInfo.values()) set.add(p.name);
    for (const v of this._mentionDirectory.values()) set.add(v.name);
    for (const arr of this.byChannel.values()) for (const m of arr) set.add(m.authorName);
    set.delete('');
    return [...set];
  }

  _renderMessage(m, all, prev, mentionNames) {
    // Meeting-thread anchors (meta.meeting_root) render as a compact
    // system-style tile, not as a user-authored chat row. No hover
    // toolbar (react / reply / edit / delete) — these are auto-posted
    // system messages, not user content. Recap reply (if any) is
    // surfaced inline via _renderMeetingRoot.
    if (m.meta?.meeting_root) {
      return this._renderMeetingRoot(m, all);
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.dataset.messageId = m.id;
    const myName = this.mesh.name;
    // Ownership drives Edit/Delete. Match on author_id (set by the
    // messages_set_author trigger, and what RLS gates on) rather than
    // display name — two teammates can share a name, in which case a
    // name match would show Edit/Delete on each other's messages and
    // the Delete would no-op against RLS with no error surfaced. Fall
    // back to name only for legacy rows that predate the trigger.
    const isMine = m.authorId ? m.authorId === this.mesh.peerId : m.authorName === myName;
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
      timeHover.textContent = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
      // Presence dot on the author's avatar. data-uid lets the host's
      // refreshMessagePresence() repaint dots in place when presence
      // flips — rows are built once, so a render-time-only status
      // would go stale.
      avatar.dataset.uid = m.authorId;
      const presence = document.createElement('span');
      const status = this.hooks.presenceStatusFor?.(m.authorId);
      presence.className = 'av-presence' + (status ? ` on status-${status}` : '');
      avatar.appendChild(presence);
    }

    const right = document.createElement('div');
    if (m.aiGenerated) wrap.classList.add('msg-ai');
    const head = document.createElement('div');
    head.className = 'msg-head';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = m.aiGenerated ? 'Huddle AI' : m.authorName;
    if (!m.aiGenerated) this.hooks.attachProfileTrigger?.(author, m.authorId);
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = this._formatMessageTime(m.ts);
    head.append(author);
    // AI messages get an "ASSISTANT" mono badge between the name and
    // the time, per design. The model name moves out of the head and
    // into a card footer below the body — see msg-ai-footer below.
    if (m.aiGenerated) {
      const badge = document.createElement('span');
      badge.className = 'msg-ai-badge mono';
      badge.textContent = 'ASSISTANT';
      head.append(badge);
    }
    head.append(time);
    if (m.editedTs) {
      const edited = document.createElement('span');
      edited.className = 'msg-edited';
      edited.textContent = '(edited)';
      head.append(edited);
    }

    // Body: poll card, edit-mode textarea, or rendered markdown.
    let body;
    // Action items: AI recaps (/summarize, post-call recap) embed a fenced
    // ```action-items block of structured items. Parse it out of AI-message
    // text so (a) the displayed markdown shows only the human-readable part
    // and (b) we can render a "Create ticket" row per item below the body.
    // Non-AI messages never carry the block, so we skip the parse for them.
    let actionItems = [];
    let displayText = m.text || '';
    if (m.aiGenerated && window.HuddleActionItems) {
      const parsed = window.HuddleActionItems.parseActionItems(m.text || '');
      actionItems = parsed.items;
      displayText = parsed.cleanText;
    }
    if (m.meta?.poll) {
      // Polls render as an interactive card in place of the body. The
      // body text ("📊 Poll: …") still exists on the row for mobile,
      // notifications, and search — just not rendered here. Polls are
      // not editable (edit would desync body from meta.poll), so the
      // editingMessageId branch can't apply.
      body = this._renderPollCard(m, isMine);
    } else if (this.editingMessageId === m.id) {
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
      // displayText == m.text for normal messages; for AI recaps it's the
      // text with the machine-readable action-items block stripped out.
      body.innerHTML = window.renderMarkdown(displayText, {
        // The hot-loop callers (_render, refreshAllMessages) pre-compute
        // this once per pass and pass it through. Single-shot callers
        // (_appendIncremental, refreshMessageById → _replaceNodeById)
        // pass undefined and we fall back to one fresh call here.
        mentionNames: mentionNames || this._knownNames(),
        myName,
      });
    }

    // Attachments — inline image previews; everything else as a download chip.
    let attachmentsEl = null;
    if (Array.isArray(m.attachments) && m.attachments.length) {
      attachmentsEl = document.createElement('div');
      attachmentsEl.className = 'msg-attachments';
      for (const a of m.attachments) {
        const ct = a.contentType || '';
        const isImage = ct.startsWith('image/');
        // Huddle Clips (and any other video upload) render as an inline
        // player. We key off the MIME type so plain video uploads work too,
        // not just clips recorded in-app (which also carry kind === 'clip').
        const isVideo = ct.startsWith('video/') || a.kind === 'clip' || a.kind === 'video';
        if (isVideo) {
          const video = document.createElement('video');
          video.src = a.url;
          video.controls = true;
          video.preload = 'metadata';
          video.playsInline = true;
          video.className = 'msg-video';
          if (a.poster) video.poster = a.poster;
          attachmentsEl.appendChild(video);
        } else if (isImage) {
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
      // Defensive: the toggle_message_reaction RPC deletes the emoji
      // key when the last reactor un-reacts, so an empty array here
      // shouldn't happen — but if a malformed payload ever did slip
      // through, a "0" pill with "no one reacted" tooltip would be
      // worse than just skipping the row.
      if (!Array.isArray(peers) || peers.length === 0) continue;
      const pill = document.createElement('span');
      pill.className = 'reaction' + (peers.includes(this.mesh.peerId) ? ' mine' : '');
      // Emoji in its own span with the colour-emoji font so the "mine"
      // accent colour can't tint it monochrome/blue; count stays themed.
      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'reaction-emoji';
      emojiSpan.textContent = emoji;
      const countSpan = document.createElement('span');
      countSpan.className = 'reaction-count';
      countSpan.textContent = String(peers.length);
      pill.append(emojiSpan, countSpan);
      // Native title tooltip lists everyone who reacted with this emoji
      // so the user can tell *who* reacted without us building a custom
      // popover. Slack-style phrasing — "you, Alice and 2 others
      // reacted with 👍".
      pill.title = this._reactionTooltip(emoji, peers);
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
    // Save: per-user bookmark with optional labels. Click toggles a
    // popover; saved state lives in the renderer's `state.savedById`
    // map and the bookmark stays filled while the message has a row
    // in saved_messages. Distinct from pin (which is channel-public).
    const isSaved = !!this.hooks.isMessageSaved?.(m.id);
    const save = document.createElement('button');
    save.className = 'msg-action' + (isSaved ? ' active' : '');
    save.innerHTML = window.HuddleIcons.bookmark;
    save.title = isSaved ? 'Edit save / labels' : 'Save message';
    save.setAttribute('aria-label', save.title);
    save.onclick = (ev) => this.hooks.openSavePopover?.({
      messageId: m.id,
      teamId: this.mesh.teamMeta?.id,
      channelId: this.currentChannel,
      anchor: ev.currentTarget,
    });
    actions.appendChild(save);
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
      // Polls can't be edited (body and meta.poll would desync); the
      // author still gets delete.
      if (!m.meta?.poll) {
        const edit = document.createElement('button');
        edit.className = 'msg-action';
        edit.innerHTML = window.HuddleIcons.edit;
        edit.title = 'Edit message';
        edit.setAttribute('aria-label', 'Edit message');
        edit.onclick = () => this._beginEdit(m.id);
        actions.append(edit);
      }
      const del = document.createElement('button');
      del.className = 'msg-action danger';
      del.innerHTML = window.HuddleIcons.trash;
      del.title = 'Delete message';
      del.setAttribute('aria-label', 'Delete message');
      del.onclick = () => this._delete(m.id);
      actions.append(del);
    }

    // Jira + GitHub unfurls: scan the message text and render a card per
    // match. Each card resolves async via its respective cached lookup.
    const jiraEls = this._renderJiraUnfurls(m.text || '');
    const ghEls = this._renderGitHubUnfurls(m.text || '');

    const children = [head, body];
    if (attachmentsEl) children.push(attachmentsEl);
    // Action-items widget: one "Create ticket" row per parsed item, sitting
    // directly under the recap text. Each row's button reuses the existing
    // Jira create modal / `/gh issue` flow pre-filled — see action-items.js.
    if (actionItems.length && window.HuddleActionItems) {
      const widget = window.HuddleActionItems.renderActionItems(actionItems, {
        // Provenance label for the ticket body — the recap is rendered in
        // the channel it belongs to, so the current channel name is right.
        channelName: this.hooks.getChannelName?.(this.currentChannel) || '',
        getJira: () => this.hooks.getJira?.(),
        getGitHub: () => this.hooks.getGitHub?.(),
        getAiTicketRepo: () => this.hooks.getAiTicketRepo?.() || '',
        openTicketModal: (preset) => this.hooks.openTicketModal?.(preset),
        // Pre-fill the composer with the `/gh issue …` command so the
        // existing slash flow creates the issue on send (no dup logic).
        prefillComposer: (text) => this._prefillComposer(text),
        // Third target: drop the item onto the team roadmap (the board's
        // Timeline/Feed views) as an undated team_roadmap_items row.
        addRoadmapItem: (item) => this.hooks.addRoadmapItem?.(item),
        toast: (msg) => this.hooks.toast?.(msg),
      });
      if (widget) children.push(widget);
    }
    if (jiraEls.length) children.push(...jiraEls);
    if (ghEls.length) children.push(...ghEls);
    // AI message footer: "via @<asker> · <model>" sits below the
    // body inside the card. The asker handle is the human user who
    // ran /ai — m.authorName already holds that for AI replies (the
    // user is the message author even though the content is from
    // the assistant). Skips entirely for non-AI messages.
    if (m.aiGenerated) {
      const footer = document.createElement('div');
      footer.className = 'msg-ai-footer';
      const via = document.createElement('span');
      via.className = 'msg-ai-footer-via';
      via.textContent = `via @${m.authorName || 'someone'}`;
      footer.appendChild(via);
      const sep = document.createElement('span');
      sep.className = 'msg-ai-footer-sep';
      sep.textContent = '·';
      footer.appendChild(sep);
      const model = document.createElement('span');
      model.className = 'msg-ai-footer-model mono';
      model.textContent = m.aiModel || 'unknown model';
      footer.appendChild(model);
      children.push(footer);
    }
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

  // Compact "call started" tile rendered in the channel feed. No
  // avatar / hover toolbar — this is a system-style row. Surfaces:
  //   • a phone glyph + "Call started — <local time>"
  //   • the reply count, when there are notes / a recap reply
  //   • an inline preview of the most recent AI-generated reply
  //     (the post-call recap) so non-thread viewers can see the
  //     summary without opening the thread
  //   • a single "Open notes →" action
  _renderMeetingRoot(m, all) {
    const wrap = document.createElement('div');
    wrap.className = 'msg meeting-root-msg';
    wrap.dataset.messageId = m.id;

    const tile = document.createElement('div');
    tile.className = 'meeting-root-tile';

    const head = document.createElement('div');
    head.className = 'meeting-root-head';
    const icon = document.createElement('span');
    icon.className = 'meeting-root-icon';
    icon.textContent = '📞';
    const title = document.createElement('span');
    title.className = 'meeting-root-title';
    const startedAt = m.meta?.started_at ? new Date(m.meta.started_at) : new Date(m.ts);
    const timeStr = startedAt.toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
    title.textContent = `Call started · ${timeStr}`;
    const author = document.createElement('span');
    author.className = 'meeting-root-author';
    author.textContent = `by ${m.authorName || 'someone'}`;
    head.append(icon, title, author);
    tile.appendChild(head);

    // Replies = the meeting thread's contents. Walk `all` once for
    // count + recap surface. (`all` is the full marshaled message
    // list passed by the caller; cheap O(N) is fine for chat-feed
    // rendering scale.)
    const replies = (all || []).filter((x) => x.parentId === m.id);
    const recap = [...replies].reverse().find((x) => x.aiGenerated);
    if (recap) {
      const recapBlock = document.createElement('div');
      recapBlock.className = 'meeting-root-recap';
      const label = document.createElement('div');
      label.className = 'meeting-root-recap-label';
      label.textContent = 'Call recap';
      const body = document.createElement('div');
      body.className = 'meeting-root-recap-body';
      if (typeof window.renderMarkdown === 'function') {
        body.innerHTML = window.renderMarkdown(recap.text || '');
      } else {
        body.textContent = recap.text || '';
      }
      recapBlock.append(label, body);
      tile.appendChild(recapBlock);
    }

    const foot = document.createElement('div');
    foot.className = 'meeting-root-foot';
    const count = document.createElement('span');
    count.className = 'meeting-root-count';
    const n = replies.length;
    count.textContent = n === 0
      ? 'No notes yet'
      : `${n} ${n === 1 ? 'note' : 'notes'}`;
    const openBtn = document.createElement('button');
    openBtn.className = 'meeting-root-open';
    openBtn.textContent = 'Open notes →';
    openBtn.onclick = () => this.openThread(m.id);
    foot.append(count, openBtn);
    tile.appendChild(foot);

    wrap.appendChild(tile);
    return wrap;
  }

  _initEmojiPicker() {
    const p = this.els.emojiPicker;
    p.innerHTML = '';
    const search = document.createElement('input');
    search.className = 'emoji-search';
    search.type = 'text';
    search.placeholder = 'Search emoji…';
    search.addEventListener('click', (e) => e.stopPropagation());
    search.addEventListener('input', () => this._renderEmojiList(search.value));
    p.appendChild(search);
    const scroll = document.createElement('div');
    scroll.className = 'emoji-scroll';
    p.appendChild(scroll);
    this._emojiSearchEl = search;
    this._emojiScrollEl = scroll;
    this._renderEmojiList('');
  }

  _pickEmoji(char) {
    this._recordRecentEmoji(char);
    if (this._emojiPickerMode === 'react' && this._emojiPickerTarget) {
      this.mesh.toggleReaction(this._emojiPickerTarget, char);
    } else {
      this.els.composer.value += char;
      this.els.composer.focus();
    }
    this.els.emojiPicker.classList.add('hidden');
    this._resetEmojiPickerAnchor();
  }

  // (Re)render the picker body: a Recently-used section (unless searching),
  // then each category, filtered by the search term (matches shortcode or
  // category name).
  _renderEmojiList(filter) {
    const scroll = this._emojiScrollEl;
    if (!scroll) return;
    scroll.innerHTML = '';
    const f = (filter || '').trim().toLowerCase();
    const makeBtn = (char) => {
      const b = document.createElement('button');
      b.textContent = char;
      b.onclick = (e) => { e.stopPropagation(); this._pickEmoji(char); };
      return b;
    };
    const section = (title, chars) => {
      if (!chars.length) return;
      const hd = document.createElement('div');
      hd.className = 'group-header';
      hd.textContent = title;
      scroll.appendChild(hd);
      for (const c of chars) scroll.appendChild(makeBtn(c));
    };
    if (!f) section('Recently used', this._getRecentEmoji());
    for (const group of window.EMOJI_GROUPS) {
      const items = group.list.filter((e) =>
        !f || e[0].toLowerCase().includes(f) || (e[2] || '').toLowerCase().includes(f) || group.name.toLowerCase().includes(f));
      section(group.name, items.map((e) => e[1]));
    }
    if (!scroll.children.length) {
      const empty = document.createElement('div');
      empty.className = 'group-header';
      empty.textContent = 'No matches';
      scroll.appendChild(empty);
    }
  }

  _refreshEmojiPicker() {
    if (this._emojiSearchEl) this._emojiSearchEl.value = '';
    this._renderEmojiList('');
  }

  _getRecentEmoji() {
    try { return JSON.parse(localStorage.getItem('huddle.emojiRecents') || '[]'); } catch { return []; }
  }
  _recordRecentEmoji(char) {
    try {
      const cur = this._getRecentEmoji().filter((c) => c !== char);
      cur.unshift(char);
      localStorage.setItem('huddle.emojiRecents', JSON.stringify(cur.slice(0, 24)));
    } catch {}
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
    this._refreshEmojiPicker();
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

  // ----- Polls -------------------------------------------------------------

  _initPollComposer() {
    if (!this.els.pollBtn) return;
    this._on(this.els.pollBtn, 'click', (e) => {
      e.stopPropagation();
      const hidden = this.els.pollComposer.classList.toggle('hidden');
      if (!hidden) this._openPollComposer();
    });
    if (this.els.pollClose) this._on(this.els.pollClose, 'click', () => this.els.pollComposer.classList.add('hidden'));
    if (this.els.pollAddOption) this._on(this.els.pollAddOption, 'click', () => this._addPollOptionInput());
    if (this.els.pollCreate) this._on(this.els.pollCreate, 'click', () => this._createPoll());
    this._on(document, 'click', (e) => {
      if (this.els.pollComposer?.classList.contains('hidden')) return;
      if (this.els.pollComposer.contains(e.target) || e.target === this.els.pollBtn) return;
      this.els.pollComposer.classList.add('hidden');
    });
  }

  // --- Huddle Clips -------------------------------------------------------

  // Wire the composer's "Record a clip" button to the ClipRecorder modal.
  // The recorder itself (camera/screen capture, MediaRecorder, preview,
  // stop/re-record/discard) lives in renderer/clip-recorder.js; we only
  // own the entry point and the "post the finished blob" hand-off.
  _initClipRecorder() {
    if (!this.els.clipBtn || !window.ClipRecorder) return;
    this._clipRecorder = new window.ClipRecorder({
      els: this.els,
      signal: this._listenerCtrl.signal,
      hooks: {
        // Reuse the app's screen source picker (promise-returning variant).
        pickScreenSource: this.hooks.pickScreenSource,
        denoiseEnabled: () => this.hooks.denoiseEnabled?.() ?? true,
        toast: (msg) => this.hooks.toast?.(msg),
        // Finished clip → upload via the normal uploadFile path, then post
        // it as a chat message with a video attachment in the *current*
        // channel/thread (snapshotted so a mid-upload channel switch posts
        // to the right place).
        onPost: (blob, meta) => this._postClip(blob, meta),
      },
    });
    this._on(this.els.clipBtn, 'click', (e) => {
      e.stopPropagation();
      this._clipRecorder.open();
    });
  }

  // Upload a recorded clip Blob and post it as a video attachment. Mirrors
  // the _beginUpload + _submit flow: the clip rides as a normal attachment
  // (same JSONB shape) so no message-schema change is needed; rendering
  // keys off the `video/*` contentType.
  async _postClip(blob, meta) {
    const channelId = this.currentChannel;
    const parentId = this.threadParentId;
    // uploadFile takes a File/Blob with a .name + .type; wrap the Blob in a
    // File so the stored object gets a sensible filename + content type.
    const file = new File([blob], meta.name, { type: meta.mimeType || blob.type });
    let info;
    try {
      info = await this.mesh.uploadFile(file);
    } catch (err) {
      console.warn('clip upload failed', err);
      this.hooks.toast?.('Clip upload failed — try again.');
      // Re-throw so the recorder's _post() learns the hand-off failed and
      // keeps the recording (re-enabling Post) instead of closing + discarding
      // a clip that never actually made it to the channel.
      throw err;
    }
    // Tag the attachment as a clip so the renderer can treat it specially
    // (inline <video controls>) and so future features (transcripts) have a
    // hook. `kind` is additive metadata; existing image/file attachments
    // simply don't have it.
    info.kind = 'clip';
    if (meta.durationSecs) info.durationSecs = meta.durationSecs;
    try {
      // Strict variant — lenient sendMessage never throws, which would
      // leave this catch dead and discard the take on a failed post.
      await this.mesh.sendMessageStrict({
        channelId,
        parentId,
        text: '',
        attachments: [info],
      });
    } catch (err) {
      console.warn('clip post failed', err);
      this.hooks.toast?.('Couldn’t post the clip.');
      // Re-throw for the same reason as the upload path: the recorder needs
      // to know the post didn't land so it can keep the take for a retry.
      throw err;
    }
  }

  _openPollComposer() {
    this.els.pollQuestion.value = '';
    this.els.pollMulti.checked = false;
    this.els.pollOptions.replaceChildren();
    this._addPollOptionInput();
    this._addPollOptionInput();
    this.els.pollQuestion.focus();
  }

  _addPollOptionInput() {
    const POLL_MAX_OPTIONS = 10;
    const n = this.els.pollOptions.children.length;
    if (n >= POLL_MAX_OPTIONS) return null;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'poll-option-input';
    input.placeholder = `Option ${n + 1}`;
    input.maxLength = 150;
    // Enter walks to the next option (adding one on the last row).
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = input.nextElementSibling || (input.value.trim() ? this._addPollOptionInput() : null);
      next?.focus();
    });
    this.els.pollOptions.appendChild(input);
    return input;
  }

  async _createPoll() {
    const question = this.els.pollQuestion.value.trim();
    const options = [...this.els.pollOptions.querySelectorAll('input')]
      .map((i) => i.value.trim()).filter(Boolean);
    if (!question) { this.els.pollQuestion.focus(); return; }
    if (options.length < 2) { this.els.pollOptions.querySelector('input')?.focus(); return; }
    this.els.pollCreate.disabled = true;
    try {
      await this.mesh.sendPollMessage({
        channelId: this.currentChannel,
        // A poll created while a thread is open belongs to that thread,
        // matching where the composer's normal sends go (_send).
        parentId: this.threadParentId || null,
        question,
        options,
        multi: this.els.pollMulti.checked,
      });
      this.els.pollComposer.classList.add('hidden');
    } finally {
      this.els.pollCreate.disabled = false;
    }
  }

  // Interactive poll card rendered in place of the message body.
  // Clicking an option toggles the user's vote through the
  // toggle_poll_vote RPC; the resulting messages UPDATE re-renders
  // this card on every viewer's screen with fresh tallies.
  _renderPollCard(m, isMine) {
    const poll = m.meta.poll;
    const card = document.createElement('div');
    card.className = 'msg-body poll-card';
    const q = document.createElement('div');
    q.className = 'poll-question';
    q.textContent = poll.question || '';
    card.appendChild(q);

    const votes = poll.votes || {};
    const closed = !!poll.closed_at;
    const myId = this.mesh.peerId;
    // Percentages are share-of-voters: in a multi-answer poll each bar
    // reads "X% of voters picked this" (bars can sum past 100%), which
    // keeps the bars consistent with the distinct-voter count in the
    // footer. For single-choice the two denominators are identical.
    const voterCount = new Set(Object.values(votes).flat()).size;

    for (const opt of poll.options || []) {
      const voters = Array.isArray(votes[opt.id]) ? votes[opt.id] : [];
      const row = document.createElement('button');
      row.className = 'poll-option' + (voters.includes(myId) ? ' mine' : '');
      row.disabled = closed;
      const pct = voterCount ? Math.round((voters.length / voterCount) * 100) : 0;
      const bar = document.createElement('span');
      bar.className = 'poll-bar';
      bar.style.width = `${pct}%`;
      const label = document.createElement('span');
      label.className = 'poll-option-label';
      label.textContent = opt.text;
      const count = document.createElement('span');
      count.className = 'poll-count';
      count.textContent = voters.length ? `${voters.length} · ${pct}%` : '';
      row.append(bar, label, count);
      if (voters.length) row.title = `${this._namesPhrase(voters)} voted`;
      row.onclick = () => this.mesh.togglePollVote(m.id, opt.id);
      card.appendChild(row);
    }

    const foot = document.createElement('div');
    foot.className = 'poll-foot';
    const info = document.createElement('span');
    const votesLabel = `${voterCount} ${voterCount === 1 ? 'vote' : 'votes'}`;
    info.textContent = closed
      ? `Final results · ${votesLabel}`
      : votesLabel + (poll.multi ? ' · multiple answers' : '');
    foot.appendChild(info);
    if (!closed && isMine) {
      const close = document.createElement('button');
      close.className = 'poll-close-btn';
      close.textContent = 'Close poll';
      close.onclick = () => {
        if (confirm('Close this poll? Voting will be locked and final results shown.')) this.mesh.closePoll(m.id);
      };
      foot.appendChild(close);
    }
    card.appendChild(foot);
    return card;
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
      this._renderGifEmpty('Add a Giphy API key in Settings to enable the GIF picker. Get one at https://developers.giphy.com/');
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
      const preview = images.fixed_width?.url
        || images.fixed_height_small?.url
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
        alert('Jira is not configured. Open Settings to add your Atlassian credentials.');
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
      alert('No AI provider is configured. Open Settings to add an Anthropic or OpenRouter API key.');
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
    // /ai is the general-purpose assistant — it answers anything. We
    // additionally wire any configured integrations as tools so it *can*
    // read/act on Jira tickets when asked; the prompt (see AI_SYSTEM_PROMPT*
    // near the top of this file) keeps Jira an optional capability.
    const jira = this.hooks.getJira?.();
    const jiraTools = window.HuddleAiTools ? window.HuddleAiTools.buildJiraTools(jira) : [];
    const roadmapTools = window.HuddleAiTools?.buildRoadmapTools
      ? window.HuddleAiTools.buildRoadmapTools(this.hooks.getRoadmap?.()) : [];
    const tools = [...jiraTools, ...roadmapTools];
    let system = jiraTools.length ? AI_SYSTEM_PROMPT_WITH_JIRA : AI_SYSTEM_PROMPT;
    if (roadmapTools.length) system += ' ' + aiRoadmapPromptAddendum();
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
        const arg = tu.input?.key || tu.input?.jql || tu.input?.title || '';
        return arg ? `${tu.name}(${arg})` : tu.name;
      }).join(', ');
      body += `\n\n_via ${summary}_`;
    }
    try {
      await this.mesh.sendAiMessage({
        channelId: this.currentChannel,
        parentId: this.threadParentId,
        text: body,
        model: result.model,
      });
    } catch (err) {
      alert('AI answered but could not post to chat: ' + (err?.message || err));
    }
    return true;
  }

  // Tool-use progress: surface the most recent tool name in the
  // "AI is thinking…" indicator so users can see when a slow Jira
  // call is in flight (otherwise the indicator looks stuck).
  _noteAiToolUse(name) {
    this._aiThinkingNote = name;
    this._refreshTyping();
  }

  // /ai-ticket <description> — slash entry. Wipes the composer and
  // delegates to the public runAiTicket().
  async _runSlashAiTicket(prompt) {
    if (!prompt) {
      alert('Usage: /ai-ticket <description>');
      return true;
    }
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    await this.runAiTicket(prompt);
    return true;
  }

  // Public AI-ticket entry. Lets the AI structure a freeform prompt
  // into {summary, description, issueType} and creates the Jira
  // ticket. Posts the resulting issue URL into chat where the /jira
  // unfurl renders the status card. Called from:
  //   • _runSlashAiTicket (the /ai-ticket slash command)
  //   • app.js's in-call ticket button (via state.chat.runAiTicket)
  //
  // opts:
  //   channelId — override the destination channel for the URL post.
  //               Defaults to this.currentChannel. The in-call button
  //               passes state.inCallChannelId so the ticket URL lands
  //               in the channel the call belongs to even when the
  //               user has scrolled to another channel.
  async runAiTicket(prompt, opts = {}) {
    const ai = this.hooks.getAi?.();
    const jira = this.hooks.getJira?.();
    if (!ai?.isConfigured()) {
      alert('No AI provider configured. Open Settings → AI assistant.');
      return false;
    }
    if (!jira?.isConfigured()) {
      alert('Jira is not configured. Open Settings → Jira.');
      return false;
    }
    const projectKey = (this.hooks.getDefaultJiraProject?.() || '').toUpperCase();
    if (!projectKey) {
      alert('No default Jira project set. Open Settings → Jira → Default project.');
      return false;
    }
    if (!prompt || !prompt.trim()) {
      alert('Empty prompt — describe what the ticket should cover.');
      return false;
    }
    const channelId = opts.channelId || this.currentChannel;
    this._beginAiThinking();
    // Attach GitHub tools only when both a repo slug AND a working
    // GitHub client are configured. Either missing falls through to a
    // tool-less single-shot prompt — the model still drafts a ticket,
    // it just can't ground in the codebase.
    const repoSlug = (this.hooks.getAiTicketRepo?.() || '').trim();
    const github = this.hooks.getGitHub?.();
    const useTools = !!(repoSlug && github?.isConfigured());
    const tools = useTools && window.HuddleAiTools
      ? window.HuddleAiTools.buildGithubTicketTools(github, repoSlug)
      : null;
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
      return false;
    }
    this._endAiThinking();
    let parsed;
    try { parsed = parseTicketJson(aiResult.text); }
    catch (err) {
      alert('AI returned an unparseable response: ' + err.message);
      return false;
    }
    if (!parsed.summary) {
      alert('AI did not produce a ticket summary. Try rephrasing the description.');
      return false;
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
      return false;
    }
    const url = jira.issueUrl(issue.key);
    // Post the bare URL so the existing Jira unfurl renders the same
    // status card the user gets from `/jira <KEY>`. The AI badge on the
    // message (sendAiMessage sets ai_generated) is the "this was
    // auto-created" signal — a duplicate prefix line just clutters the
    // card. parentId is intentionally omitted when an alternate
    // channelId is supplied — the in-call button doesn't have a thread
    // context.
    try {
      const postChannelId = channelId;
      const parentId = postChannelId === this.currentChannel ? this.threadParentId : null;
      await this.mesh.sendAiMessage({
        channelId: postChannelId,
        parentId,
        text: url,
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
      alert('No AI provider is configured. Open Settings to add an Anthropic or OpenRouter API key.');
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
    try {
      await this.mesh.sendAiMessage({
        channelId: this.currentChannel,
        parentId: this.threadParentId,
        text: body,
        model: result.model,
      });
    } catch (err) {
      alert('Summary failed to post to chat: ' + (err?.message || err));
    }
    return true;
  }

  async _runSlashGh(arg) {
    const gh = this.hooks.getGitHub?.();
    if (!gh || !gh.isConfigured()) {
      alert('GitHub is not configured. Open Settings to add a Personal Access Token.');
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

  async _postGif(url, result) {
    // The same GIF URL re-clicked within a few seconds is a "didn't see
    // it post, clicked again" double-post (the realtime echo hasn't
    // landed yet), not intent to post it twice — swallow it.
    const now = Date.now();
    if (url === this._lastGifUrl && now - this._lastGifAt < GIF_RECLICK_DEBOUNCE_MS) {
      this.els.gifPicker.classList.add('hidden');
      return;
    }
    this._lastGifUrl = url;
    this._lastGifAt = now;
    const images = result?.images || {};
    const size = parseInt(images.original?.size, 10) || 0;
    this.els.gifPicker.classList.add('hidden');
    try {
      await this.mesh.sendMessageStrict({
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
    } catch (err) {
      // Reset the re-click debounce so an immediate retry of the same
      // GIF isn't swallowed as a double-post.
      this._lastGifUrl = null;
      this._lastGifAt = 0;
      alert("Couldn't post the GIF: " + (err?.message || err));
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

window.ChatView = ChatView;
