// Reusable right-click context menu. One floating menu at a time, opened
// via window.HuddleContextMenu.show(items, x, y) from the global contextmenu
// dispatcher in app.js. Dismisses on outside mousedown / Escape / scroll /
// resize / window blur / item click.
//
// Item shapes:
//   { label, icon?, hint?, onClick, danger?, disabled?, keepOpen? }
//   { type: 'divider' }
//   { type: 'header', label }
//
// `icon` is a HuddleIcons name (same set the rest of the app uses). `danger`
// styles destructive actions (delete / leave). `keepOpen` leaves the menu up
// after a click (e.g. an inline reaction strip handles its own dismissal).
(function () {
  let openEl = null;
  let cleanup = null;

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function close() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (openEl) { openEl.remove(); openEl = null; }
  }

  function show(items, x, y) {
    close();
    items = (items || []).filter(Boolean);
    if (!items.length) return;

    const menu = el('div', 'ctx-menu');
    menu.setAttribute('role', 'menu');
    const actionable = []; // focusable item buttons, for keyboard nav

    for (const it of items) {
      if (it.type === 'divider') { menu.appendChild(el('div', 'ctx-menu-divider')); continue; }
      if (it.type === 'header') {
        const h = el('div', 'ctx-menu-header');
        h.textContent = it.label;
        menu.appendChild(h);
        continue;
      }
      const btn = el('button', 'ctx-menu-item' + (it.danger ? ' danger' : ''));
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      if (it.disabled) btn.disabled = true;
      const ic = el('span', 'ctx-menu-ic');
      if (it.icon) ic.innerHTML = window.HuddleIcons?.[it.icon] || '';
      btn.appendChild(ic);
      const lbl = el('span', 'ctx-menu-label');
      lbl.textContent = it.label;
      btn.appendChild(lbl);
      if (it.hint) {
        const hn = el('span', 'ctx-menu-hint');
        hn.textContent = it.hint;
        btn.appendChild(hn);
      }
      if (!it.disabled) {
        btn.addEventListener('click', () => {
          if (!it.keepOpen) close();
          try { it.onClick?.(); } catch (err) { console.warn('[ctx-menu] item handler failed', err); }
        });
        actionable.push(btn);
      }
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Clamp to the viewport: flip left/up off the cursor when we'd overflow.
    const pad = 8;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = x, top = y;
    if (left + w + pad > window.innerWidth) left = x - w;
    if (top + h + pad > window.innerHeight) top = window.innerHeight - h - pad;
    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';
    openEl = menu;

    const onDown = (e) => { if (!menu.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!actionable.length) return;
        const i = actionable.indexOf(document.activeElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = actionable[((i < 0 ? 0 : i + step) + actionable.length) % actionable.length];
        next?.focus();
      }
    };
    // Defer wiring so the contextmenu event that opened this menu (and its
    // trailing mousedown) doesn't immediately dismiss it.
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', close);
      window.addEventListener('resize', close);
      window.addEventListener('wheel', close, { passive: true, capture: true });
    }, 0);
    cleanup = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close, true);
    };

    actionable[0]?.focus();
  }

  window.HuddleContextMenu = { show, close };
})();
