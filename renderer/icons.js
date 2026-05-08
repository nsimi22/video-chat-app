// Shared inline-SVG icon set. Feather-style strokes (24×24
// viewBox, stroke-width 2, currentColor) so icons inherit the
// host element's color and match the existing SVGs in
// index.html. Consumers either inject the raw HTML
// (`el.innerHTML = HuddleIcons.smile`) or use the helper:
//
//   HuddleIcons.set(button, 'edit');
//
// Icons can be resized via CSS — `button svg { width: 14px;
// height: 14px; }` — without touching the source strings.
(function () {
  const A = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    smile: `<svg ${A}><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    thread: `<svg ${A}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    edit: `<svg ${A}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    trash: `<svg ${A}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    refresh: `<svg ${A}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    check: `<svg ${A}><polyline points="20 6 9 17 4 12"/></svg>`,
    sparkle: `<svg ${A}><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z"/></svg>`,
  };
  window.HuddleIcons = Object.assign(
    {
      set(el, name) {
        const svg = ICONS[name];
        if (svg) el.innerHTML = svg;
      },
    },
    ICONS,
  );
})();
