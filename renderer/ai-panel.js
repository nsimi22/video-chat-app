// v2 Huddle AI panel — a dedicated conversational surface that
// opens when the nav-rail "Huddle AI" item is clicked. Renders a
// chat-style transcript with the local AiClient and lets the user
// post the latest AI reply into the channel composer via a quick-
// action button. Lazy-builds its DOM on first open.
//
// Conversation is in-memory for the session; closing the panel
// keeps state so a second open resumes. Only active under
// [data-ui="v2"]; legacy renders never touch this code.
(function () {
  let root = null;
  let transcript = null;
  let composer = null;
  let sendBtn = null;
  let chipsRow = null;
  let modelBadge = null;
  let conversation = []; // [{role, content}] for AiClient.chat()
  let pending = false;

  // --- helpers -----------------------------------------------------

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Tiny markdown: **bold**, *italic*, `code`, paragraph breaks.
  // Falls back to escaped text. Avoids pulling in the full markdown.js
  // since this panel doesn't need link auto-formatting / mention pills.
  function renderText(text) {
    if (!text) return '';
    const esc = escapeHtml(text);
    return esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*]+)\*(\W|$)/g, '$1<em>$2</em>$3')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br />');
  }

  function getActiveChannelLabel() {
    const id = window.huddleApp?.getActiveChannelId?.();
    if (!id) return null;
    // Prefer the bare channel.name from app state (e.g. "general")
    // — the sidebar's .ch-name text carries displayLabelFor's
    // prefix ("# general"), and prepending another `#` in the
    // caller produced "## general" in suggestions.
    const bare = window.huddleApp?.getChannelName?.(id);
    if (bare) return bare;
    const li = document.querySelector(`#channels li[data-id="${id}"]`)
      || document.querySelector(`#channels li[data-channel-id="${id}"]`);
    const name = li?.querySelector('.ch-name')?.textContent?.trim();
    // Strip a leading `# ` / `@ ` / lock-emoji that displayLabelFor
    // may have prepended — defaultSuggestions formats the prefix.
    return (name || id).replace(/^[#@🔒]\s*/, '');
  }

  // Returns up to N suggestions tailored to whatever signals are
  // available in the current channel + app state:
  //   - call active anywhere → swap in a brief-the-call prompt
  //   - JIRA ticket key seen recently → swap in a status-on-ticket prompt
  // Falls back to the static "team decided" / "draft a ticket" lines
  // when no context-specific signal is present. Stays at 3 chips so
  // the chip row layout doesn't reflow between channels.
  function defaultSuggestions() {
    const ch = getActiveChannelLabel();
    const chPrefix = ch ? `#${ch}` : 'this channel';
    const inCall = document.body.classList.contains('huddle-in-call');
    const recentJiraKey = findRecentJiraKey();

    const summary = inCall
      ? `Brief me on the call in ${chPrefix}`
      : `Summarize today in ${chPrefix}`;
    const middle = recentJiraKey
      ? `What's the latest on ${recentJiraKey}?`
      : 'Draft a Jira ticket for the latest discussion';
    const tail = 'What did the team decide this week?';

    return [summary, middle, tail];
  }

  // Scan the last few visible messages in the current channel for a
  // JIRA ticket key like "DAP-123". Returns the first match or null.
  // Reads from the DOM rather than app state — avoids growing the
  // huddleApp surface for one feature, and DOM order already reflects
  // chat order. Capped at the last 20 messages so a huge channel
  // backscroll doesn't churn through hundreds of nodes on every chip
  // re-render.
  const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]{1,9})-(\d{1,6})\b/;
  function findRecentJiraKey() {
    const bodies = document.querySelectorAll('#messages .msg .msg-body');
    if (!bodies.length) return null;
    const start = Math.max(0, bodies.length - 20);
    for (let i = bodies.length - 1; i >= start; i--) {
      const txt = bodies[i]?.textContent || '';
      const m = JIRA_KEY_RE.exec(txt);
      if (m) return m[0];
    }
    return null;
  }

  // --- DOM ---------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-ai-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-ai-header">
        <div class="huddle-ai-avatar" aria-hidden="true">
          ${svg('sparkles')}
        </div>
        <div class="huddle-ai-title-block">
          <div class="huddle-ai-title">Huddle AI</div>
          <div class="huddle-ai-subtitle">Reads your channels, Jira &amp; GitHub — with your access</div>
        </div>
        <div class="huddle-ai-spacer"></div>
        <span class="huddle-ai-model" data-model="">claude-opus-4</span>
        <button class="huddle-ai-close" aria-label="Close" title="Close">${svg('x')}</button>
      </div>
      <div class="huddle-ai-transcript" role="log" aria-live="polite"></div>
      <div class="huddle-ai-suggestions" aria-label="Suggested prompts"></div>
      <div class="huddle-ai-composer-wrap">
        <div class="huddle-ai-composer">
          <span class="huddle-ai-composer-icon" aria-hidden="true">${svg('sparkles')}</span>
          <input class="huddle-ai-composer-input" type="text"
                 placeholder="Ask anything, or describe a ticket to file…"
                 aria-label="Ask Huddle AI" autocomplete="off" />
          <button class="huddle-ai-send" aria-label="Send">${svg('send')}<span>Send</span></button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    transcript  = root.querySelector('.huddle-ai-transcript');
    composer    = root.querySelector('.huddle-ai-composer-input');
    sendBtn     = root.querySelector('.huddle-ai-send');
    chipsRow    = root.querySelector('.huddle-ai-suggestions');
    modelBadge  = root.querySelector('.huddle-ai-model');

    composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape') {
        close();
      }
    });
    sendBtn.addEventListener('click', send);
    root.querySelector('.huddle-ai-close').addEventListener('click', close);

    renderSuggestions();
    renderEmptyState();
    renderModelBadge();
  }

  // --- rendering ---------------------------------------------------

  function renderEmptyState() {
    if (conversation.length > 0) return;
    transcript.innerHTML = `
      <div class="huddle-ai-empty">
        <div class="huddle-ai-empty-icon">${svg('sparkles')}</div>
        <div class="huddle-ai-empty-title">Ask Huddle AI</div>
        <div class="huddle-ai-empty-hint">
          Summaries, drafts, tickets — grounded in your channels, Jira, and GitHub when configured.
        </div>
      </div>
    `;
  }

  function renderSuggestions() {
    const suggestions = defaultSuggestions();
    chipsRow.innerHTML = suggestions.map((s) => `
      <button class="huddle-ai-chip" type="button">${escapeHtml(s)}</button>
    `).join('');
    chipsRow.querySelectorAll('.huddle-ai-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        composer.value = btn.textContent;
        composer.focus();
      });
    });
  }

  function renderModelBadge() {
    const ai = window.huddleApp?.getAi?.();
    const model = ai?.defaultModel || 'claude-opus-4';
    if (modelBadge) {
      modelBadge.textContent = model;
      modelBadge.dataset.model = model;
    }
  }

  function appendTurn({ role, text, pending: isPending, error }) {
    if (transcript.querySelector('.huddle-ai-empty')) transcript.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = `huddle-ai-turn huddle-ai-turn-${role}`;
    const isAi = role === 'ai';
    const label = isAi ? 'Huddle AI' : 'You';
    const iconHtml = isAi
      ? `<div class="huddle-ai-turn-avatar huddle-ai-turn-avatar-bot">${svg('sparkles')}</div>`
      : `<div class="huddle-ai-turn-avatar huddle-ai-turn-avatar-me">${(window.huddleApp?.getMe?.()?.displayName || 'You').slice(0, 1).toUpperCase()}</div>`;

    let body = '';
    if (isPending) {
      body = '<div class="huddle-ai-pending"><span></span><span></span><span></span></div>';
    } else if (error) {
      body = `<div class="huddle-ai-error">${escapeHtml(text)}</div>`;
    } else {
      body = `<div class="huddle-ai-turn-body">${renderText(text)}</div>`;
    }

    let actions = '';
    if (isAi && !isPending && !error) {
      actions = `
        <div class="huddle-ai-turn-actions">
          <button class="huddle-ai-action huddle-ai-action-post">${svg('link')}<span>Post to channel</span></button>
        </div>
      `;
    }

    wrap.innerHTML = `
      ${iconHtml}
      <div class="huddle-ai-turn-main">
        <div class="huddle-ai-turn-name">${label}</div>
        ${body}
        ${actions}
      </div>
    `;
    transcript.appendChild(wrap);

    if (isAi && !isPending && !error) {
      const postBtn = wrap.querySelector('.huddle-ai-action-post');
      postBtn?.addEventListener('click', () => {
        window.huddleApp?.postIntoComposer?.(text);
        close();
      });
    }

    transcript.scrollTop = transcript.scrollHeight;
    return wrap;
  }

  function replacePendingWith({ text, error }) {
    const pendingEl = transcript.querySelector('.huddle-ai-turn.is-pending');
    if (pendingEl) pendingEl.remove();
    appendTurn({ role: 'ai', text, error });
  }

  // --- actions -----------------------------------------------------

  async function send() {
    const val = (composer.value || '').trim();
    if (!val || pending) return;
    const ai = window.huddleApp?.getAi?.();
    if (!ai || !ai.isConfigured?.()) {
      appendTurn({ role: 'ai', text: 'AI provider not configured. Open Settings to add an API key.', error: true });
      return;
    }

    appendTurn({ role: 'user', text: val });
    conversation.push({ role: 'user', content: val });
    composer.value = '';

    const pendingEl = appendTurn({ role: 'ai', pending: true });
    if (pendingEl) pendingEl.classList.add('is-pending');
    pending = true;
    sendBtn.disabled = true;

    try {
      const res = await ai.chat({
        system: 'You are Huddle AI, a concise, helpful assistant inside a team chat. Respond clearly. Use markdown for emphasis (**bold**, `code`).',
        messages: conversation.slice(),
      });
      const text = res?.text || '(no response)';
      conversation.push({ role: 'assistant', content: text });
      replacePendingWith({ text });
    } catch (e) {
      console.error('[ai-panel] chat failed:', e);
      replacePendingWith({ text: e?.message || 'Something went wrong.', error: true });
    } finally {
      pending = false;
      sendBtn.disabled = false;
      composer.focus();
    }
  }

  function open() {
    if (!root) buildDom();
    renderSuggestions();
    renderModelBadge();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    setTimeout(() => composer.focus(), 30);
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  function toggle() {
    if (!root) { open(); return; }
    if (root.classList.contains('hidden')) open();
    else close();
  }

  // Expose for the rail wiring + the ⌘K palette to call.
  window.HuddleAIPanel = { open, close, toggle };

  // ESC anywhere closes the panel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root && !root.classList.contains('hidden')) {
      close();
    }
  });
})();
