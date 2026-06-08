// Action items → one-click Jira / GitHub tickets.
//
// The AI recap (/summarize and the post-call recap) is asked to append a
// machine-readable, fenced ```action-items block to its output — one JSON
// object per line: {"text": "...", "owner": "..."}. (See
// ACTION_ITEMS_PROMPT below; both ai.js's summarizer and app.js's recap
// path append window.ACTION_ITEMS_PROMPT, so this is the single source.)
//
// This module does two things:
//   1. parseActionItems(text) — pull that fenced block out of an AI message
//      and return { items, cleanText }. cleanText has the block removed so
//      the chat renderer never shows a raw code fence; items is the parsed
//      list (empty when there's no block).
//   2. renderActionItems(items, ctx) — build a small interactive widget: one
//      row per item with a "Create ticket" button that opens the EXISTING
//      Jira create modal or the EXISTING /gh issue flow, pre-filled with the
//      action text (and an owner hint when present). No ticket-creation
//      logic is duplicated here — we call back into chat.js / app.js.
//
// Both are pure of any framework; the widget is plain DOM so it slots into
// chat.js's _renderMessage alongside the markdown body.

(function () {
  'use strict';

  // The instruction block we append to recap/summarize system prompts. Kept
  // here — next to the parser that consumes it — and exported as
  // window.ACTION_ITEMS_PROMPT so ai.js's summarizer and app.js's recap
  // path both reference this one definition rather than duplicating it.
  const ACTION_ITEMS_PROMPT = [
    'After the recap, IF AND ONLY IF there are action items, append a fenced',
    'code block tagged `action-items` containing one JSON object per line, e.g.:',
    '',
    '```action-items',
    '{"text": "Write the migration for the new column", "owner": "Dana"}',
    '{"text": "Follow up with the vendor about pricing"}',
    '```',
    '',
    'Rules: "text" is the action phrased as an imperative task title (concise,',
    'no owner prefix). "owner" is the person responsible if you can infer one,',
    'otherwise omit it. Do not wrap the block in extra prose, and omit the',
    'block entirely when there are no action items.',
  ].join('\n');

  // Matches a fenced block whose info-string is exactly `action-items`
  // (optionally with surrounding whitespace). [\s\S] so the body can span
  // lines; non-greedy so we stop at the first closing fence. `g` so we catch
  // *every* such block, not just the first — a model occasionally emits the
  // block more than once (e.g. a stray second copy), and a block we don't
  // strip would otherwise survive as a raw ```action-items fence in the
  // visible message. `m` isn't needed — ^/$ aren't used — but we keep the
  // fences anchored to their own lines via the explicit \n around them.
  // NOTE: this RegExp is stateful (`g` ⇒ carries .lastIndex); never share a
  // single .exec/.test loop across calls. parseActionItems uses matchAll +
  // String.replace, both of which manage state internally per call.
  const BLOCK_RE = /\n?```[ \t]*action-items[ \t]*\n([\s\S]*?)\n?```[ \t]*\n?/gi;

  // Pull the action-items block(s) out of an AI message.
  // Returns { items: Array<{text, owner?}>, cleanText: string }.
  //   - items: parsed records, in order, with non-empty text, gathered from
  //     every action-items block in the message. Lines that aren't valid
  //     JSON (or lack text) are skipped rather than throwing — a partially-
  //     malformed block still yields whatever parsed.
  //   - cleanText: the message with every fenced block removed and trailing
  //     whitespace trimmed, so the renderer shows only the human-readable
  //     part (and never a leftover raw fence). Unchanged when there's no block.
  function parseActionItems(text) {
    const src = String(text == null ? '' : text);

    const items = [];
    // matchAll gives us a fresh iterator each call, so the global flag's
    // lastIndex doesn't leak between invocations.
    for (const m of src.matchAll(BLOCK_RE)) {
      for (const rawLine of m[1].split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        const itemText = typeof obj.text === 'string' ? obj.text.trim() : '';
        if (!itemText) continue;
        const owner = typeof obj.owner === 'string' && obj.owner.trim()
          ? obj.owner.trim()
          : null;
        items.push({ text: itemText, owner });
      }
    }

    // Fast path: no block at all → return the original text untouched.
    if (items.length === 0 && !BLOCK_RE.test(src)) {
      BLOCK_RE.lastIndex = 0; // .test left lastIndex advanced; reset it.
      return { items: [], cleanText: src };
    }
    BLOCK_RE.lastIndex = 0; // reset after the .test above (if it ran)

    // Strip every block (and collapse the gap it leaves) from the display
    // text. String.replace with a global RegExp replaces all matches.
    const cleanText = src.replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { items, cleanText };
  }

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Build the body description for a created ticket from an item. We add a
  // short provenance line so the ticket isn't a bare one-liner — matches the
  // tone of openTicketModal's default description ("From a discussion in …").
  function ticketDescriptionFor(item, ctx) {
    const channelName = ctx?.channelName ? `#${ctx.channelName}` : 'a channel';
    const owner = item.owner ? `\n\nSuggested owner: ${item.owner}` : '';
    return `Action item captured from an AI recap in ${channelName}.${owner}`;
  }

  // Open a tiny anchored menu offering the integrations that are usable, so
  // a single button can route to Jira *or* GitHub without a second modal.
  // When only one is configured we skip the menu and go straight there;
  // when neither is, we explain how to fix it. `anchor` is the clicked
  // button — the menu positions just below it.
  function openTargetMenu(anchor, item, ctx) {
    const jiraOk = !!ctx?.getJira?.()?.isConfigured?.();
    const ghOk = !!ctx?.getGitHub?.()?.isConfigured?.();

    if (!jiraOk && !ghOk) {
      // Reuse the host app's toast rather than a blocking alert so the user
      // stays in context; point them at the one place keys are configured.
      ctx?.toast?.('No issue tracker configured. Open Settings → Jira or GitHub to connect one.');
      return;
    }
    if (jiraOk && !ghOk) { createJiraTicket(item, ctx); return; }
    if (ghOk && !jiraOk) { createGitHubIssue(item, ctx); return; }

    // Both available → show a small chooser. Single-instance: tear down any
    // previously-open menu first.
    closeTargetMenu();
    const menu = document.createElement('div');
    menu.className = 'action-item-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button class="action-item-menu-opt" data-target="jira" role="menuitem">${svg('ticket') || ''}<span>Jira ticket</span></button>
      <button class="action-item-menu-opt" data-target="github" role="menuitem">${svg('github') || ''}<span>GitHub issue</span></button>
    `;
    document.body.appendChild(menu);

    const r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    // Right-align the menu to the button so it doesn't run off-screen for
    // buttons near the right edge of the feed.
    menu.style.left = `${Math.round(Math.max(8, r.right - menu.offsetWidth))}px`;

    menu.querySelector('[data-target="jira"]').onclick = () => { closeTargetMenu(); createJiraTicket(item, ctx); };
    menu.querySelector('[data-target="github"]').onclick = () => { closeTargetMenu(); createGitHubIssue(item, ctx); };

    // Dismiss on the next outside click / Escape. Defer the listener a tick
    // so the click that opened the menu doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
    _openMenu = menu;
  }

  let _openMenu = null;
  function closeTargetMenu() {
    if (!_openMenu) return;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    _openMenu.remove();
    _openMenu = null;
  }
  function onDocDown(e) { if (_openMenu && !_openMenu.contains(e.target)) closeTargetMenu(); }
  function onDocKey(e) { if (e.key === 'Escape') closeTargetMenu(); }

  // Jira path: reuse the existing create-ticket modal (openTicketModal in
  // app.js), pre-filled with the action text as the summary and a short
  // provenance description. The modal itself handles project/issue-type
  // selection, the "post to channel" toggle, and the not-configured state.
  function createJiraTicket(item, ctx) {
    // Jira summaries are capped at 255 chars by the API; trim defensively so
    // a long action line still opens the modal cleanly.
    const summary = item.text.slice(0, 250);
    ctx?.openTicketModal?.({ summary, description: ticketDescriptionFor(item, ctx) });
  }

  // GitHub path: reuse the EXISTING `/gh issue <owner>/<repo> <title>` flow
  // by pre-filling the composer with that command. The user reviews and
  // sends it, which runs chat.js's _runSlashGh (create + post URL) verbatim —
  // no create logic is duplicated here. We seed the repo from the configured
  // "AI ticket GitHub repo" setting when present; otherwise we leave an
  // `owner/repo` placeholder for the user to fill. Owner hint goes into the
  // body after `--`.
  function createGitHubIssue(item, ctx) {
    const repo = (ctx?.getAiTicketRepo?.() || 'owner/repo').trim() || 'owner/repo';
    // Keep the title on one line — newlines would break the slash parse.
    const title = item.text.replace(/\s+/g, ' ').trim();
    const body = item.owner ? ` -- Suggested owner: ${item.owner}` : '';
    const cmd = `/gh issue ${repo} ${title}${body}`;
    if (ctx?.prefillComposer) {
      ctx.prefillComposer(cmd);
      ctx?.toast?.(repo === 'owner/repo'
        ? 'Edit owner/repo in the composer, then send to create the issue.'
        : 'Review the command in the composer, then send to create the issue.');
    } else {
      // No composer hook (shouldn't happen from chat) — fall back to a toast
      // so the action still tells the user what to do.
      ctx?.toast?.(`Run: ${cmd}`);
    }
  }

  // Build the widget. Returns a single <div class="action-items"> element
  // (or null when there are no items). `ctx` carries the integration hooks
  // chat.js wires up — see ChatView._renderMessage.
  function renderActionItems(items, ctx) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'action-items';

    const header = document.createElement('div');
    header.className = 'action-items-head';
    header.innerHTML = `${svg('ticket') || ''}<span>Action items</span>`;
    wrap.appendChild(header);

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'action-item-row';

      const textEl = document.createElement('div');
      textEl.className = 'action-item-text';
      // owner (when present) renders as a small pill before the text.
      const ownerHtml = item.owner
        ? `<span class="action-item-owner">${escapeHtml(item.owner)}</span>`
        : '';
      textEl.innerHTML = `${ownerHtml}<span>${escapeHtml(item.text)}</span>`;
      row.appendChild(textEl);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-item-create';
      btn.innerHTML = `${svg('plus') || ''}<span>Create ticket</span>`;
      btn.title = 'Create a Jira ticket or GitHub issue from this item';
      btn.onclick = () => openTargetMenu(btn, item, ctx);
      row.appendChild(btn);

      wrap.appendChild(row);
    }

    return wrap;
  }

  window.HuddleActionItems = { parseActionItems, renderActionItems };
  window.ACTION_ITEMS_PROMPT = ACTION_ITEMS_PROMPT;
})();
