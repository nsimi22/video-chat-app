// v2 Claude usage dashboard. The rail's "Usage" destination: token +
// estimated-cost aggregates from the LOCAL Claude Code transcripts
// (<config-dir>/projects/**.jsonl), scanned in the main process across
// every configured account profile — no API calls, no credentials.
//
// Costs shown are API-list-price equivalents (what the tokens would have
// cost with API-key billing). Subscription usage has no per-request
// charge, so the number sizes the value of the plan — labeled as such.
//
// Same surface shape as recordings.js: lazily built full-stage overlay,
// open()/close() toggling .hidden, registered in ui-v2-shell SURFACES.
(function () {
  let root = null;
  let data = null;          // last scan result { days, profiles }
  let profileFilter = '*';  // '*' = all profiles, else profile name
  let days = 30;
  let scanning = false;

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTokens(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  function fmtCost(usd) {
    return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
  }

  // Merge per-profile aggregates according to the active filter.
  function selected() {
    const out = { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 }, byDay: {}, byModel: {}, truncated: false };
    if (!data) return out;
    const profs = data.profiles.filter((p) => p.found && (profileFilter === '*' || p.name === profileFilter));
    for (const p of profs) {
      out.truncated = out.truncated || !!p.truncated;
      for (const k of Object.keys(out.totals)) out.totals[k] += p.totals[k];
      for (const [bucketName, src] of [['byDay', p.byDay], ['byModel', p.byModel]]) {
        for (const [key, v] of Object.entries(src)) {
          const b = out[bucketName][key] || (out[bucketName][key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
          for (const k of Object.keys(v)) b[k] += v[k];
        }
      }
    }
    return out;
  }

  // ----- DOM ------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-usage-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-usage-header">
        <span class="huddle-usage-header-icon" aria-hidden="true">${svg('activity')}</span>
        <span class="huddle-usage-title">Claude usage</span>
        <select class="huddle-usage-profile" title="Account"></select>
        <select class="huddle-usage-days" title="Window">
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
        </select>
        <div class="huddle-usage-spacer"></div>
        <button class="huddle-usage-iconbtn huddle-usage-refresh" title="Rescan" aria-label="Rescan">${svg('refresh')}</button>
        <button class="huddle-usage-iconbtn huddle-usage-close" title="Close" aria-label="Close">${svg('x')}</button>
      </div>
      <div class="huddle-usage-body">
        <div class="huddle-usage-scroll"></div>
      </div>
      <div class="huddle-usage-tooltip hidden" role="tooltip"></div>
    `;
    document.body.appendChild(root);
    root.querySelector('.huddle-usage-close').addEventListener('click', close);
    root.querySelector('.huddle-usage-refresh').addEventListener('click', () => scan());
    root.querySelector('.huddle-usage-profile').addEventListener('change', (e) => {
      profileFilter = e.target.value;
      render();
    });
    root.querySelector('.huddle-usage-days').addEventListener('change', (e) => {
      days = Number(e.target.value) || 30;
      scan();
    });
  }

  async function scan() {
    if (!root || scanning) return;
    scanning = true;
    const scroll = root.querySelector('.huddle-usage-scroll');
    scroll.innerHTML = `<div class="huddle-usage-empty">Scanning local Claude Code transcripts…</div>`;
    try {
      data = await window.huddleApp.claudeUsage.scan({ days });
    } catch (err) {
      console.warn('[usage] scan failed', err);
      scroll.innerHTML = `<div class="huddle-usage-empty">Scan failed — ${escapeHtml(err?.message || 'unknown error')}</div>`;
      scanning = false;
      return;
    }
    scanning = false;
    rebuildProfileSelect();
    render();
  }

  function rebuildProfileSelect() {
    const sel = root.querySelector('.huddle-usage-profile');
    const keep = profileFilter;
    sel.innerHTML = '<option value="*">All accounts</option>';
    for (const p of data?.profiles || []) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.found ? p.name : `${p.name} (no data)`;
      sel.appendChild(opt);
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '*';
    profileFilter = sel.value;
  }

  // ----- Render ---------------------------------------------------

  function render() {
    const scroll = root.querySelector('.huddle-usage-scroll');
    const s = selected();
    if (!s.totals.messages) {
      scroll.innerHTML = `<div class="huddle-usage-empty">
        No Claude Code usage found in the last ${data?.days || days} days.<br/>
        Usage appears here after you run Claude Code (or the /ai Claude Code provider) on this machine.
      </div>`;
      return;
    }
    const activeDays = Object.keys(s.byDay).length;
    scroll.innerHTML = `
      <div class="huddle-usage-tiles">
        ${tile('Total tokens', fmtTokens(s.totals.input + s.totals.output + s.totals.cacheRead + s.totals.cacheWrite), 'in + out + cache')}
        ${tile('Output tokens', fmtTokens(s.totals.output), `input ${fmtTokens(s.totals.input)}`)}
        ${tile('Est. API value', fmtCost(s.totals.costUsd), 'at API list prices')}
        ${tile('Requests', fmtTokens(s.totals.messages), `${activeDays} active day${activeDays === 1 ? '' : 's'}`)}
      </div>
      <h3 class="huddle-usage-h">Tokens per day</h3>
      <div class="huddle-usage-chart" role="img" aria-label="Daily token usage bar chart"></div>
      <h3 class="huddle-usage-h">By model</h3>
      <table class="huddle-usage-table">
        <thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Est. value</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="huddle-usage-note">Estimated at Claude API list prices — on a subscription these tokens have no per-request charge. Data comes from local Claude Code transcripts on this machine only.${s.truncated ? ' Some history was skipped (per-account file cap reached), so totals are a lower bound.' : ''}</p>
    `;
    renderChart(scroll.querySelector('.huddle-usage-chart'), s.byDay);
    renderModelTable(scroll.querySelector('.huddle-usage-table tbody'), s.byModel);
  }

  function tile(label, value, sub) {
    return `<div class="huddle-usage-tile">
      <div class="huddle-usage-tile-label">${escapeHtml(label)}</div>
      <div class="huddle-usage-tile-value">${escapeHtml(value)}</div>
      <div class="huddle-usage-tile-sub">${escapeHtml(sub)}</div>
    </div>`;
  }

  // Single-series bar chart (total tokens/day), house accent, thin bars
  // with rounded data-ends, per-bar hover tooltip. Last `days` calendar
  // days, zero-filled so gaps read as gaps.
  function renderChart(el, byDay) {
    const n = Math.min(data?.days || days, 90);
    const dayKeys = [];
    for (let i = n - 1; i >= 0; i--) {
      dayKeys.push(new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
    }
    const vals = dayKeys.map((d) => {
      const b = byDay[d];
      return b ? b.input + b.output + b.cacheRead + b.cacheWrite : 0;
    });
    const max = Math.max(...vals, 1);
    el.innerHTML = `
      <div class="huddle-usage-chart-max mono">${fmtTokens(max)}</div>
      <div class="huddle-usage-bars"></div>
      <div class="huddle-usage-chart-x mono"><span>${escapeHtml(dayKeys[0])}</span><span>${escapeHtml(dayKeys[dayKeys.length - 1])}</span></div>
    `;
    const barsEl = el.querySelector('.huddle-usage-bars');
    const tooltip = root.querySelector('.huddle-usage-tooltip');
    dayKeys.forEach((d, i) => {
      const bar = document.createElement('div');
      bar.className = 'huddle-usage-bar' + (vals[i] ? '' : ' is-zero');
      bar.style.height = `${Math.max(vals[i] ? 3 : 1, Math.round((vals[i] / max) * 100))}%`;
      bar.dataset.day = d;
      barsEl.appendChild(bar);
    });
    // One delegated hover tooltip for all bars (hit target = column strip).
    barsEl.addEventListener('mousemove', (e) => {
      const bar = e.target.closest('.huddle-usage-bar');
      if (!bar) { tooltip.classList.add('hidden'); return; }
      const b = byDay[bar.dataset.day];
      const total = b ? b.input + b.output + b.cacheRead + b.cacheWrite : 0;
      tooltip.innerHTML = `<strong>${escapeHtml(bar.dataset.day)}</strong><br/>`
        + `${fmtTokens(total)} tokens · ${b ? b.messages : 0} req<br/>`
        + (b ? `in ${fmtTokens(b.input)} · out ${fmtTokens(b.output)} · cache ${fmtTokens(b.cacheRead + b.cacheWrite)}<br/>≈ ${fmtCost(b.costUsd)}` : 'no usage');
      tooltip.classList.remove('hidden');
      const r = root.getBoundingClientRect();
      tooltip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 190)}px`;
      tooltip.style.top = `${e.clientY - r.top - 10}px`;
    });
    barsEl.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  }

  function renderModelTable(tbody, byModel) {
    const rows = Object.entries(byModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
    tbody.innerHTML = rows.map(([model, v]) => `
      <tr>
        <td class="mono">${escapeHtml(model)}</td>
        <td>${fmtTokens(v.messages)}</td>
        <td>${fmtTokens(v.input)}</td>
        <td>${fmtTokens(v.output)}</td>
        <td>${fmtTokens(v.cacheRead)}</td>
        <td>${fmtTokens(v.cacheWrite)}</td>
        <td>${fmtCost(v.costUsd)}</td>
      </tr>
    `).join('');
  }

  // ----- Open / close ---------------------------------------------

  function open() {
    if (!root) buildDom();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    if (!data) scan();
    else render();
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  window.HuddleUsage = { open, close };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root && !root.classList.contains('hidden')) close();
  });
})();
