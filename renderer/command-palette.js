// v2 Cmd-K command palette. Active only when [data-ui="v2"] is set
// on <html>. Provides quick keyboard navigation to channels, DMs,
// people, and common actions (start call, open whiteboard, summarize,
// ask AI, create Jira ticket). Builds DOM lazily on first open so
// legacy renders carry no overhead.
//
// All actions bridge to existing app.js elements (button IDs, sidebar
// list items) — no new app.js state, no new IPC, no backend changes.
(function () {
  let root = null;
  let input = null;
  let body = null;
  let selectedIndex = 0;
  let items = [];

  function isV2() {
    return document.documentElement.getAttribute('data-ui') === 'v2';
  }

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function insertComposer(text) {
    const composer = document.getElementById('composer-input');
    if (!composer) return;
    composer.value = text;
    composer.focus();
    try {
      composer.setSelectionRange(text.length, text.length);
    } catch (_) { /* contenteditable variants */ }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Static commands. Each `do` bridges to an existing legacy element
  // so we don't fork app.js state.
  function getStaticCommands() {
    return [
      { group: 'Go to', icon: 'video',     label: 'Start a call',     hint: '/huddle',
        do: () => document.getElementById('btn-start-call')?.click() },
      { group: 'Go to', icon: 'board',     label: 'Open whiteboard',
        do: () => document.getElementById('whiteboard-btn')?.click() },
      { group: 'Go to', icon: 'calendar',  label: 'Open calendar',
        do: () => document.getElementById('open-calendar')?.click() },
      { group: 'Go to', icon: 'bookmark',  label: 'Open Saved',
        do: () => document.getElementById('open-saved')?.click() },
      { group: 'Go to', icon: 'settings',  label: 'Open Settings',
        do: () => document.getElementById('open-settings')?.click() },
      { group: 'Go to', icon: 'sparkles',  label: 'Ask Huddle AI',
        do: () => window.HuddleAIPanel?.open?.() || insertComposer('/ai ') },
      { group: 'Actions', icon: 'summarize', label: 'Summarize current channel', hint: '/summarize',
        do: () => insertComposer('/summarize ') },
      { group: 'Actions', icon: 'ticket',    label: 'Create a Jira ticket', hint: '/jira create',
        do: () => document.getElementById('btn-jira')?.click() },
      { group: 'Actions', icon: 'search',    label: 'Search messages',
        do: () => document.getElementById('search-btn')?.click() },
    ];
  }

  function readListCommands(listId, group, iconResolver) {
    const out = [];
    document.querySelectorAll(`#${listId} li`).forEach((li) => {
      const name = (li.querySelector('.ch-name')?.textContent || li.textContent || '').trim();
      if (!name) return;
      out.push({
        group,
        icon: iconResolver(li),
        label: name,
        do: () => li.click(),
      });
    });
    return out;
  }

  function gatherCommands() {
    const channels = readListCommands('channels', 'Channels', (li) =>
      li.classList.contains('private') ? 'lock' : 'hash'
    );
    const dms = readListCommands('dms', 'Direct messages', () => 'people');
    const people = readListCommands('people', 'People', () => 'at');
    return [...getStaticCommands(), ...channels, ...dms, ...people];
  }

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-command-palette hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-cp-modal" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="huddle-cp-search">
          <span class="huddle-cp-search-icon" aria-hidden="true">${svg('search')}</span>
          <input class="huddle-cp-input" type="text"
                 placeholder="Search or jump to… try a command"
                 aria-label="Search commands" autocomplete="off" spellcheck="false" />
          <span class="huddle-cp-esc" aria-hidden="true">ESC</span>
        </div>
        <div class="huddle-cp-body" role="listbox"></div>
      </div>
    `;
    document.body.appendChild(root);
    input = root.querySelector('.huddle-cp-input');
    body = root.querySelector('.huddle-cp-body');

    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', onInputKey);
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
  }

  function renderResults() {
    const query = (input.value || '').toLowerCase();
    const all = gatherCommands();
    items = query
      ? all.filter((c) => c.label.toLowerCase().includes(query))
      : all;
    selectedIndex = 0;

    if (items.length === 0) {
      body.innerHTML = `<div class="huddle-cp-empty">No results for "${escapeHtml(query)}"</div>`;
      return;
    }

    let lastGroup = null;
    const html = items.map((item, i) => {
      const group = item.group !== lastGroup
        ? `<div class="huddle-cp-group">${escapeHtml(item.group)}</div>`
        : '';
      lastGroup = item.group;
      return `
        ${group}
        <button class="huddle-cp-item${i === selectedIndex ? ' selected' : ''}"
                data-index="${i}" role="option">
          <span class="huddle-cp-item-icon">${svg(item.icon)}</span>
          <span class="huddle-cp-item-label">${escapeHtml(item.label)}</span>
          ${item.hint ? `<span class="huddle-cp-item-hint">${escapeHtml(item.hint)}</span>` : ''}
        </button>
      `;
    }).join('');

    body.innerHTML = html;
    body.querySelectorAll('.huddle-cp-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (!isNaN(idx)) execute(idx);
      });
    });
  }

  function updateSelection() {
    body.querySelectorAll('.huddle-cp-item').forEach((btn) => {
      const idx = parseInt(btn.dataset.index, 10);
      btn.classList.toggle('selected', idx === selectedIndex);
    });
    const sel = body.querySelector('.huddle-cp-item.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function execute(idx) {
    const item = items[idx];
    if (!item) return;
    close();
    // Defer so the close animation doesn't collide with the action
    // (some actions open modals that focus-trap and would yank
    // focus away from the palette mid-close).
    setTimeout(() => {
      try { item.do(); } catch (e) { console.error('[cmd-palette] action failed:', e); }
    }, 30);
  }

  function onInputKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(selectedIndex);
    }
  }

  function open() {
    if (!root) buildDom();
    input.value = '';
    renderResults();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    setTimeout(() => input.focus(), 30);
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  // Global ⌘K / Ctrl+K — only fires under v2. Toggle if already open
  // so a second press dismisses.
  document.addEventListener('keydown', (e) => {
    if (!isV2()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (root && !root.classList.contains('hidden')) close();
      else open();
    }
  });
})();
