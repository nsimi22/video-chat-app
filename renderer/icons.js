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
    mic: `<svg ${A}><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>`,
    cam: `<svg ${A}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    screen: `<svg ${A}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="9 8 12 5 15 8"/><line x1="12" y1="5" x2="12" y2="13"/></svg>`,
    phoneDown: `<svg ${A}><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`,
    jira: `<svg ${A}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/></svg>`,
    arrow: `<svg ${A}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
    eraser: `<svg ${A}><path d="M20 20H7l-4-4 9-9 11 11-3 2z"/><line x1="14" y1="6" x2="20" y2="12"/></svg>`,
    note: `<svg ${A}><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9z"/><polyline points="14 3 14 10 21 10"/></svg>`,
    stop: `<svg ${A}><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`,
    x: `<svg ${A}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    paperclip: `<svg ${A}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    robot: `<svg ${A}><rect x="3" y="8" width="18" height="12" rx="2"/><circle cx="9" cy="14" r="1.4"/><circle cx="15" cy="14" r="1.4"/><line x1="12" y1="3" x2="12" y2="8"/><circle cx="12" cy="2.5" r="1"/></svg>`,
    spotlight: `<svg ${A}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
    fullscreen: `<svg ${A}><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/><polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>`,
    fullscreenExit: `<svg ${A}><polyline points="9 4 9 9 4 9"/><polyline points="15 4 15 9 20 9"/><polyline points="9 20 9 15 4 15"/><polyline points="15 20 15 15 20 15"/></svg>`,
    hand: `<svg ${A}><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14"/><path d="M9 11V8.5a1.5 1.5 0 0 0-3 0v6.5a7 7 0 0 0 12 5l3-4a3 3 0 0 0-1-4"/></svg>`,
    pin: `<svg ${A}><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-2.5V7l1.5-2H5l1.5 2v7.5z"/></svg>`,
    link: `<svg ${A}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    bookmark: `<svg ${A}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
    tag: `<svg ${A}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    bell: `<svg ${A}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    bellOff: `<svg ${A}><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    bellPlus: `<svg ${A}><path d="M19.3 14.8C20.1 16.4 21 17 21 17H3s3-2 3-9c0-3.3 2.7-6 6-6 1 0 1.96.25 2.8.7"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M15 8h6"/><path d="M18 5v6"/></svg>`,
    blur: `<svg ${A}><circle cx="12" cy="8" r="3" stroke-dasharray="2 1.5"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" stroke-dasharray="2 1.5"/></svg>`,
    calendar: `<svg ${A}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    // Feather "users" — two figures, used as the group-DM glyph in
    // the sidebar (mobile uses the matching lucide Users icon there).
    users: `<svg ${A}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    // Feather "lock" — private-channel glyph in the sidebar; replaces
    // the 🔒 emoji that used to come from displayLabelFor.
    lock: `<svg ${A}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
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
