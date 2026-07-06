// v2 Integrations view. The rail's "Integrations" destination: manage the
// team's inbound webhooks (team_integrations) — endpoints external
// services POST to and land as app-authored messages in a channel.
//
// Reads/updates/deletes ride RLS directly; creation goes through the
// create_team_integration RPC (via the huddleApp.integrations facade),
// which returns the webhook secret exactly once — this view is the one
// place that ever shows it, immediately after create.
//
// Same surface shape as recordings.js / calendar-grid.js: lazily built
// full-stage overlay, open()/close() toggling .hidden, registered in
// ui-v2-shell.js SURFACES.
(function () {
  let root = null;
  let rows = [];

  const PRESETS = [
    { value: 'github', label: 'GitHub (CI + PRs + issues + pushes)' },
    { value: 'sentry', label: 'Sentry (issue alerts)' },
    { value: '', label: 'Custom (template or raw JSON)' },
  ];

  const SETUP_HINTS = {
    github: 'In the repo: Settings → Webhooks → Add webhook. Payload URL = the URL above, content type = application/json, paste the secret into the "Secret" field, pick the events you want (Workflow runs, Pull requests, Issues, Pushes).',
    sentry: 'In Sentry: Settings → Integrations → Webhooks. Use the URL above with ?secret=<secret> appended, or send the secret in an x-webhook-secret header via an Internal Integration.',
    '': 'Send POSTs with JSON to the URL above, authenticated by an `x-webhook-secret: <secret>` header (or `?secret=` in the URL). A {{ field.path }} template controls the message; without one, a title/message field or a JSON snippet is posted.',
  };

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function channelLabel(id) {
    return window.huddleApp?.getChannelName?.(id) || id || '—';
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const old = btn.innerHTML; btn.innerHTML = svg('check'); setTimeout(() => { btn.innerHTML = old; }, 1200); }
    } catch (err) { console.warn('[integrations] copy failed', err); }
  }

  // ----- DOM ------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-integrations-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-int-header">
        <span class="huddle-int-header-icon" aria-hidden="true">${svg('zap')}</span>
        <span class="huddle-int-title">Integrations</span>
        <div class="huddle-int-spacer"></div>
        <button class="huddle-int-new">${svg('plus')}<span>New webhook</span></button>
        <button class="huddle-int-iconbtn huddle-int-refresh" title="Refresh" aria-label="Refresh">${svg('refresh')}</button>
        <button class="huddle-int-iconbtn huddle-int-close" title="Close" aria-label="Close">${svg('x')}</button>
      </div>
      <div class="huddle-int-body">
        <div class="huddle-int-list"></div>
        <div class="huddle-int-editor hidden"></div>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.huddle-int-close').addEventListener('click', close);
    root.querySelector('.huddle-int-refresh').addEventListener('click', () => refresh());
    root.querySelector('.huddle-int-new').addEventListener('click', openCreate);
  }

  // ----- List -----------------------------------------------------

  async function refresh() {
    if (!root) return;
    const listEl = root.querySelector('.huddle-int-list');
    listEl.innerHTML = `<div class="huddle-int-empty">Loading…</div>`;
    try {
      rows = await window.huddleApp.integrations.list();
    } catch (err) {
      console.warn('[integrations] load failed', err);
      listEl.innerHTML = `<div class="huddle-int-empty">Couldn’t load integrations — ${escapeHtml(err?.message || 'unknown error')}</div>`;
      return;
    }
    renderList();
  }

  function renderList() {
    const listEl = root.querySelector('.huddle-int-list');
    if (!rows.length) {
      listEl.innerHTML = `<div class="huddle-int-empty">
        No integrations yet.<br/>
        A webhook gives external services (GitHub, Sentry, CI, cron jobs —
        anything that can POST JSON) a URL that posts into a channel as an app.
      </div>`;
      return;
    }
    listEl.innerHTML = '';
    for (const r of rows) listEl.appendChild(renderCard(r));
  }

  function renderCard(r) {
    const url = window.huddleApp.integrations.webhookUrl(r.id);
    const presetLabel = (PRESETS.find((p) => p.value === (r.config?.preset || ''))?.label || 'Custom').split(' (')[0];
    const card = document.createElement('div');
    card.className = 'huddle-int-card' + (r.enabled ? '' : ' is-disabled');
    card.innerHTML = `
      <div class="huddle-int-card-head">
        <span class="huddle-int-card-name">${escapeHtml(r.name)}</span>
        <span class="huddle-int-chip">${escapeHtml(presetLabel)}</span>
        <span class="huddle-int-card-target">→ #${escapeHtml(channelLabel(r.channel_id))}</span>
        <div class="huddle-int-card-spacer"></div>
        <label class="huddle-int-toggle" title="${r.enabled ? 'Disable' : 'Enable'}">
          <input type="checkbox" ${r.enabled ? 'checked' : ''}/>
          <span>${r.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
        <button class="huddle-int-iconbtn huddle-int-delete" title="Delete integration" aria-label="Delete integration">${svg('trash')}</button>
      </div>
      <div class="huddle-int-card-url">
        <code class="mono">${escapeHtml(url)}</code>
        <button class="huddle-int-iconbtn huddle-int-copy" title="Copy URL" aria-label="Copy URL">${svg('copy') || svg('link') || 'copy'}</button>
      </div>
    `;
    card.querySelector('.huddle-int-copy').addEventListener('click', (e) => copy(url, e.currentTarget));
    card.querySelector('.huddle-int-toggle input').addEventListener('change', async (e) => {
      try {
        await window.huddleApp.integrations.update(r.id, { enabled: e.target.checked });
        refresh();
      } catch (err) {
        console.warn('[integrations] toggle failed', err);
        e.target.checked = !e.target.checked;
      }
    });
    card.querySelector('.huddle-int-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${r.name}"? Its webhook URL stops working immediately; past messages stay.`)) return;
      try {
        await window.huddleApp.integrations.remove(r.id);
        refresh();
      } catch (err) {
        console.warn('[integrations] delete failed', err);
        alert(`Delete failed: ${err?.message || 'unknown error'}`);
      }
    });
    return card;
  }

  // ----- Create ---------------------------------------------------

  function openCreate() {
    const editor = root.querySelector('.huddle-int-editor');
    const listEl = root.querySelector('.huddle-int-list');
    listEl.classList.add('hidden');
    editor.classList.remove('hidden');
    const channels = window.huddleApp.integrations.channels();
    editor.innerHTML = `
      <div class="huddle-int-form">
        <h3 class="huddle-int-h">New inbound webhook</h3>
        <label>Name <span class="huddle-int-sub">(shows as the message author)</span>
          <input type="text" class="int-name" maxlength="80" placeholder="e.g. GitHub CI" />
        </label>
        <label>Post into
          <select class="int-channel">
            ${channels.map((c) => `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </label>
        <label>Sender
          <select class="int-preset">
            ${PRESETS.map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join('')}
          </select>
        </label>
        <label class="int-template-row hidden">Message template <span class="huddle-int-sub">({{ field.path }} placeholders, optional)</span>
          <textarea class="int-template" rows="3" placeholder="🚀 {{ user }} deployed {{ service }} to {{ env }}"></textarea>
        </label>
        <div class="huddle-int-form-actions">
          <button class="huddle-int-primary int-create">Create webhook</button>
          <button class="huddle-int-secondary int-cancel">Cancel</button>
        </div>
        <div class="huddle-int-error hidden"></div>
      </div>
    `;
    const presetSel = editor.querySelector('.int-preset');
    presetSel.addEventListener('change', () => {
      editor.querySelector('.int-template-row').classList.toggle('hidden', presetSel.value !== '');
    });
    presetSel.dispatchEvent(new Event('change'));
    editor.querySelector('.int-cancel').addEventListener('click', closeEditor);
    editor.querySelector('.int-create').addEventListener('click', async () => {
      const name = editor.querySelector('.int-name').value.trim();
      const channelId = editor.querySelector('.int-channel').value;
      const preset = presetSel.value;
      const template = editor.querySelector('.int-template').value.trim();
      const errEl = editor.querySelector('.huddle-int-error');
      if (!name) { errEl.textContent = 'Give it a name.'; errEl.classList.remove('hidden'); return; }
      if (!channelId) { errEl.textContent = 'Pick a channel.'; errEl.classList.remove('hidden'); return; }
      const config = {};
      if (preset) config.preset = preset;
      else if (template) config.template = template;
      try {
        const res = await window.huddleApp.integrations.create({ name, channelId, config });
        showCreated(res, preset);
      } catch (err) {
        console.warn('[integrations] create failed', err);
        errEl.textContent = `Create failed: ${err?.message || 'unknown error'}`;
        errEl.classList.remove('hidden');
      }
    });
  }

  // The one and only secret reveal. After this panel is dismissed the
  // secret is unrecoverable client-side (service-role-only table).
  function showCreated(res, preset) {
    const editor = root.querySelector('.huddle-int-editor');
    const url = window.huddleApp.integrations.webhookUrl(res.integration.id);
    editor.innerHTML = `
      <div class="huddle-int-form">
        <h3 class="huddle-int-h">Webhook created — copy the secret now</h3>
        <p class="huddle-int-sub">This is the only time the secret is shown. If you lose it, delete the integration and create a new one.</p>
        <label>Webhook URL
          <div class="huddle-int-reveal"><code class="mono">${escapeHtml(url)}</code><button class="huddle-int-iconbtn int-copy-url" title="Copy URL">${svg('copy') || svg('link')}</button></div>
        </label>
        <label>Secret
          <div class="huddle-int-reveal"><code class="mono">${escapeHtml(res.secret)}</code><button class="huddle-int-iconbtn int-copy-secret" title="Copy secret">${svg('copy') || svg('link')}</button></div>
        </label>
        <p class="huddle-int-hint">${escapeHtml(SETUP_HINTS[preset] ?? SETUP_HINTS[''])}</p>
        <div class="huddle-int-form-actions">
          <button class="huddle-int-primary int-done">Done</button>
        </div>
      </div>
    `;
    editor.querySelector('.int-copy-url').addEventListener('click', (e) => copy(url, e.currentTarget));
    editor.querySelector('.int-copy-secret').addEventListener('click', (e) => copy(res.secret, e.currentTarget));
    editor.querySelector('.int-done').addEventListener('click', () => { closeEditor(); refresh(); });
  }

  function closeEditor() {
    const editor = root.querySelector('.huddle-int-editor');
    editor.innerHTML = ''; // drop any revealed secret from the DOM
    editor.classList.add('hidden');
    root.querySelector('.huddle-int-list').classList.remove('hidden');
  }

  // ----- Open / close ---------------------------------------------

  function open() {
    if (!root) buildDom();
    closeEditor();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    refresh();
  }

  function close() {
    if (!root) return;
    closeEditor();
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  window.HuddleIntegrations = { open, close };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !root || root.classList.contains('hidden')) return;
    const editorOpen = !root.querySelector('.huddle-int-editor').classList.contains('hidden');
    if (editorOpen) closeEditor();
    else close();
  });
})();
