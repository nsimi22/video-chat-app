// v2 Recordings library view. The rail's "Recordings" destination:
// browse every finished call recording the caller can see (RLS scopes
// call_recordings to visible channels), search across recaps +
// transcripts (server-side ilike via huddleApp.recordings.search), and
// play a recording inline off a short-lived signed URL from the private
// `recordings` bucket. Pure read UI — every write to call_recordings
// stays with the recording-egress / livekit-egress-webhook functions.
//
// Same surface shape as calendar-grid.js: lazily built full-stage
// overlay root (.huddle-recordings-view), open()/close() toggling
// .hidden, registered in ui-v2-shell.js SURFACES.
(function () {
  let root = null;
  let rows = [];            // current list (filtered when searching)
  let openDetailId = null;  // recording id the detail view shows, or null
  let searchSeq = 0;        // stale-response guard for the debounced search
  let searchTimer = null;

  const { escapeHtml, svg } = window.HuddleSurface;
  const channelLabel = (id) => window.HuddleSurface.channelLabel(id, 'unknown');

  function fmtWhen(iso) {
    const d = new Date(iso);
    // started_at is NOT NULL server-side, but an invalid Date's
    // toLocale* throws in Chromium — never let one bad row kill the list.
    if (!iso || isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today · ${time}`;
    if (d.toDateString() === yest.toDateString()) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })} · ${time}`;
  }

  function fmtDuration(r) {
    if (!r.started_at || !r.ended_at) return '';
    const mins = Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000);
    if (mins < 1) return '<1 min';
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  // In-flight statuses render a pill; completed rows render duration only.
  function statusPill(r) {
    if (r.status === 'completed') return '';
    if (r.status === 'failed') return '<span class="huddle-rec-pill is-failed">failed</span>';
    return `<span class="huddle-rec-pill is-live">● ${escapeHtml(r.status)}</span>`;
  }

  // ----- DOM ------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-recordings-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-rec-header">
        <span class="huddle-rec-header-icon" aria-hidden="true">${svg('film')}</span>
        <span class="huddle-rec-title">Recordings</span>
        <div class="huddle-rec-search">
          ${svg('search')}
          <input type="search" placeholder="Search recaps &amp; transcripts…" aria-label="Search recordings" />
        </div>
        <div class="huddle-rec-spacer"></div>
        <button class="huddle-rec-refresh" title="Refresh" aria-label="Refresh">${svg('refresh')}</button>
        <button class="huddle-rec-close" title="Close" aria-label="Close">${svg('x')}</button>
      </div>
      <div class="huddle-rec-body">
        <div class="huddle-rec-list" role="list"></div>
        <div class="huddle-rec-detail hidden"></div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector('.huddle-rec-close').addEventListener('click', close);
    root.querySelector('.huddle-rec-refresh').addEventListener('click', () => refresh());

    const input = root.querySelector('.huddle-rec-search input');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refresh(), 300);
    });

    // Delegated list clicks → detail view. Cards are tabbable divs, so
    // Enter/Space must activate them too (divs don't get that for free).
    const listEl = root.querySelector('.huddle-rec-list');
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.huddle-rec-card');
      if (card?.dataset.id) openDetail(card.dataset.id);
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.huddle-rec-card');
      if (card?.dataset.id) { e.preventDefault(); openDetail(card.dataset.id); }
    });
  }

  // ----- List -----------------------------------------------------

  async function refresh() {
    if (!root) return;
    const listEl = root.querySelector('.huddle-rec-list');
    const q = root.querySelector('.huddle-rec-search input').value.trim();
    const seq = ++searchSeq;
    listEl.innerHTML = `<div class="huddle-rec-empty">Loading…</div>`;
    let result;
    try {
      result = q
        ? await window.huddleApp.recordings.search(q)
        : await window.huddleApp.recordings.list();
    } catch (err) {
      console.warn('[recordings] load failed', err);
      if (seq === searchSeq) listEl.innerHTML = `<div class="huddle-rec-empty">Couldn’t load recordings — ${escapeHtml(err?.message || 'unknown error')}</div>`;
      return;
    }
    if (seq !== searchSeq) return; // superseded by a newer search/refresh
    rows = result;
    renderList(q);
  }

  function renderList(q) {
    const listEl = root.querySelector('.huddle-rec-list');
    if (!rows.length) {
      listEl.innerHTML = `<div class="huddle-rec-empty">${q
        ? `No recordings match “${escapeHtml(q)}”.`
        : 'No recordings yet. Start one from the Record button during a call.'}</div>`;
      return;
    }
    listEl.innerHTML = rows.map((r) => {
      const starter = r.started_by_name ? ` · ${escapeHtml(r.started_by_name)}` : '';
      const dur = fmtDuration(r);
      // recap_snippet is the server-truncated (200-char) generated column
      // the list query selects instead of the full recap; slice to the
      // display length and use the overflow char as the "there's more" cue.
      const snip = r.recap_snippet || '';
      const recapSnippet = snip
        ? `<div class="huddle-rec-card-recap">${escapeHtml(snip.slice(0, 180))}${snip.length > 180 ? '…' : ''}</div>`
        : '';
      return `
        <div class="huddle-rec-card" role="listitem" data-id="${escapeHtml(r.id)}" tabindex="0">
          <div class="huddle-rec-card-head">
            <span class="huddle-rec-card-channel">#${escapeHtml(channelLabel(r.channel_id))}</span>
            ${statusPill(r)}
            <span class="huddle-rec-card-meta mono">${escapeHtml(fmtWhen(r.started_at))}${dur ? ` · ${dur}` : ''}${starter}</span>
          </div>
          ${recapSnippet}
        </div>
      `;
    }).join('');
  }

  // ----- Detail ---------------------------------------------------

  async function openDetail(id) {
    openDetailId = id;
    const listEl = root.querySelector('.huddle-rec-list');
    const detailEl = root.querySelector('.huddle-rec-detail');
    listEl.classList.add('hidden');
    detailEl.classList.remove('hidden');
    detailEl.innerHTML = `<div class="huddle-rec-empty">Loading…</div>`;

    let r;
    try {
      r = await window.huddleApp.recordings.detail(id);
    } catch (err) {
      console.warn('[recordings] detail load failed', err);
      if (openDetailId === id) {
        detailEl.innerHTML = `<div class="huddle-rec-empty">Couldn’t load this recording — ${escapeHtml(err?.message || 'unknown error')}</div>`;
      }
      return;
    }
    if (openDetailId !== id) return; // user navigated away meanwhile
    if (!r) {
      detailEl.innerHTML = `<div class="huddle-rec-empty">Recording not found.</div>`;
      return;
    }

    const dur = fmtDuration(r);
    detailEl.innerHTML = `
      <div class="huddle-rec-detail-bar">
        <button class="huddle-rec-back">${svg('chevronLeft')}<span>All recordings</span></button>
        <span class="huddle-rec-card-channel">#${escapeHtml(channelLabel(r.channel_id))}</span>
        ${statusPill(r)}
        <span class="huddle-rec-card-meta mono">${escapeHtml(fmtWhen(r.started_at))}${dur ? ` · ${dur}` : ''}</span>
      </div>
      <div class="huddle-rec-detail-scroll">
        <div class="huddle-rec-player"></div>
        ${r.recap ? `<h3 class="huddle-rec-h">Meeting recap</h3><div class="huddle-rec-recap"></div>` : ''}
        ${r.transcript ? `<h3 class="huddle-rec-h">Transcript</h3><pre class="huddle-rec-transcript"></pre>` : ''}
        ${!r.recap && !r.transcript ? '<div class="huddle-rec-empty">No recap or transcript was captured for this recording.</div>' : ''}
      </div>
    `;
    detailEl.querySelector('.huddle-rec-back').addEventListener('click', closeDetail);

    // Recap may contain markdown (it's AI-generated, same as the posted
    // recap message, which chat.js renders through renderMarkdown).
    if (r.recap) {
      const recapEl = detailEl.querySelector('.huddle-rec-recap');
      if (typeof window.renderMarkdown === 'function') recapEl.innerHTML = window.renderMarkdown(r.recap);
      else recapEl.textContent = r.recap;
    }
    // Transcript is plain "Name: line" text — textContent, never HTML.
    if (r.transcript) {
      detailEl.querySelector('.huddle-rec-transcript').textContent = r.transcript;
    }

    // Playback: mint a fresh signed URL on open (the private bucket has no
    // permanent public link; storage RLS re-checks membership per mint).
    const playerEl = detailEl.querySelector('.huddle-rec-player');
    if (r.status === 'completed' && r.storage_path) {
      let url = null;
      try {
        url = await window.huddleApp.recordings.signedUrl(r.storage_path);
      } catch (err) {
        console.warn('[recordings] signedUrl failed', err);
      }
      if (openDetailId !== id) return;
      if (url) {
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = url;
        playerEl.appendChild(video);
      } else {
        playerEl.innerHTML = `<div class="huddle-rec-empty">Couldn’t get a playback link (the file may still be uploading).</div>`;
      }
    } else if (r.status === 'failed') {
      playerEl.innerHTML = `<div class="huddle-rec-empty">This recording failed${r.error ? `: ${escapeHtml(r.error)}` : '.'}</div>`;
    } else {
      playerEl.innerHTML = `<div class="huddle-rec-empty">Still ${escapeHtml(r.status)} — the video appears here when the recording finishes.</div>`;
    }
  }

  function closeDetail() {
    openDetailId = null;
    const detailEl = root.querySelector('.huddle-rec-detail');
    // Drop the <video> so playback (and its signed-URL fetch) stops.
    detailEl.innerHTML = '';
    detailEl.classList.add('hidden');
    root.querySelector('.huddle-rec-list').classList.remove('hidden');
  }

  // ----- Open / close ---------------------------------------------

  function open() {
    if (!root) buildDom();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    if (openDetailId) closeDetail();
    refresh();
  }

  function close() {
    if (!root) return;
    if (openDetailId) closeDetail(); // stops playback
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  window.HuddleRecordings = { open, close };

  // Escape closes an open detail view first, then the panel (the shared
  // helper handles the "blur a focused field instead" guard).
  window.HuddleSurface.wireEscClose(() => root, {
    onEscape: () => { if (openDetailId) { closeDetail(); return true; } return false; },
    close,
  });
})();
