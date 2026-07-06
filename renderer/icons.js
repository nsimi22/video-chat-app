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
    info: `<svg ${A}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    stop: `<svg ${A}><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`,
    x: `<svg ${A}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    paperclip: `<svg ${A}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    robot: `<svg ${A}><rect x="3" y="8" width="18" height="12" rx="2"/><circle cx="9" cy="14" r="1.4"/><circle cx="15" cy="14" r="1.4"/><line x1="12" y1="3" x2="12" y2="8"/><circle cx="12" cy="2.5" r="1"/></svg>`,
    spotlight: `<svg ${A}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
    fullscreen: `<svg ${A}><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/><polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>`,
    fullscreenExit: `<svg ${A}><polyline points="9 4 9 9 4 9"/><polyline points="15 4 15 9 20 9"/><polyline points="9 20 9 15 4 15"/><polyline points="15 20 15 15 20 15"/></svg>`,
    popout: `<svg ${A}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    hand: `<svg ${A}><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14"/><path d="M9 11V8.5a1.5 1.5 0 0 0-3 0v6.5a7 7 0 0 0 12 5l3-4a3 3 0 0 0-1-4"/></svg>`,
    headphones: `<svg ${A}><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
    pin: `<svg ${A}><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-2.5V7l1.5-2H5l1.5 2v7.5z"/></svg>`,
    link: `<svg ${A}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    bookmark: `<svg ${A}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
    tag: `<svg ${A}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    bell: `<svg ${A}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    bellOff: `<svg ${A}><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    bellPlus: `<svg ${A}><path d="M19.3 14.8C20.1 16.4 21 17 21 17H3s3-2 3-9c0-3.3 2.7-6 6-6 1 0 1.96.25 2.8.7"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M15 8h6"/><path d="M18 5v6"/></svg>`,
    blur: `<svg ${A}><circle cx="12" cy="8" r="3" stroke-dasharray="2 1.5"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" stroke-dasharray="2 1.5"/></svg>`,
    // Noise-suppression glyph: a mic flanked by sound-wave arcs with a
    // small sparkle, signalling "cleaned audio". Pairs visually with the
    // `mic` icon used by the mute button so the two read as a set.
    denoise: `<svg ${A}><rect x="10" y="2" width="4" height="11" rx="2"/><path d="M7 11a5 5 0 0 0 10 0"/><line x1="12" y1="16" x2="12" y2="20"/><path d="M4 8a4 4 0 0 1 0 6"/><path d="M20 8a4 4 0 0 1 0 6"/></svg>`,
    calendar: `<svg ${A}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    // Feather "users" — two figures, used as the group-DM glyph in
    // the sidebar (mobile uses the matching lucide Users icon there).
    users: `<svg ${A}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    // Feather "lock" — private-channel glyph in the sidebar; replaces
    // the 🔒 emoji that used to come from displayLabelFor.
    lock: `<svg ${A}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  };

  // ----------------------------------------------------------------
  // v2 design-bundle icons. Names match huddle/icons.jsx so v2 code
  // paths can use the design-canonical names directly. Where an
  // existing icon exists under a different name (cam, sparkle,
  // phoneDown, jira, spotlight, users, arrow), an alias is added
  // below so v2 callsites can use the design name without breaking
  // legacy callers.
  // ----------------------------------------------------------------
  const V2 = {
    hash: `<svg ${A}><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
    at: `<svg ${A}><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>`,
    chat: `<svg ${A}><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-4-1L3 20l1.3-4.5a8.38 8.38 0 0 1-1-4A8.5 8.5 0 0 1 21 11.5z"/></svg>`,
    video: `<svg ${A}><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3z"/></svg>`,
    videoOff: `<svg ${A}><path d="M15.5 10.5l5-3v9l-3.2-1.9"/><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    board: `<svg ${A}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v3M8.5 20h7"/><path d="M7 9.5l3 3 6.5-6"/></svg>`,
    sparkles: `<svg ${A}><path d="M12 3l1.8 4.9L18.7 9.7 13.8 11.5 12 16.4 10.2 11.5 5.3 9.7 10.2 7.9z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>`,
    settings: `<svg ${A}><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H4a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
    search: `<svg ${A}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>`,
    plus: `<svg ${A}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    chevronDown: `<svg ${A}><polyline points="6 9 12 15 18 9"/></svg>`,
    chevronRight: `<svg ${A}><polyline points="9 6 15 12 9 18"/></svg>`,
    chevronLeft: `<svg ${A}><polyline points="15 6 9 12 15 18"/></svg>`,
    phone: `<svg ${A}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>`,
    phoneOff: `<svg ${A}><path d="M10.7 13.3a16 16 0 0 1-2.6-3.4L9.4 8.6a2 2 0 0 0 .5-2.1c-.3-.9-.6-1.8-.7-2.8A2 2 0 0 0 7.1 2h-3a2 2 0 0 0-2 2.1 19.8 19.8 0 0 0 3.1 8.7M13 6a16 16 0 0 1 5 5l1.3-.8a2 2 0 0 1 2.1.4c.6.5.7 1 .7 1.5v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8-2.5"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    micOff: `<svg ${A}><path d="M9 5a3 3 0 0 1 6 0v4M15 11.5a3 3 0 0 1-4.6 1.4"/><path d="M5.5 11a6.5 6.5 0 0 0 10.8 4.9"/><line x1="12" y1="17.5" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    grid: `<svg ${A}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>`,
    reaction: `<svg ${A}><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/><line x1="9" y1="9.5" x2="9" y2="9.5"/><line x1="15" y1="9.5" x2="15" y2="9.5"/></svg>`,
    more: `<svg ${A}><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
    send: `<svg ${A}><path d="M4 12l16-7-7 16-2.5-6.5z"/></svg>`,
    logout: `<svg ${A}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    checks: `<svg ${A}><polyline points="2 12.5 7 17.5 16 7"/><polyline points="11 12.5 12 13.5 22 3.5"/></svg>`,
    command: `<svg ${A}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>`,
    pen: `<svg ${A}><path d="M12 19l7-7a2.1 2.1 0 0 0-3-3l-7 7-1 4z"/><line x1="5" y1="19" x2="9" y2="19"/></svg>`,
    arrowTool: `<svg ${A}><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>`,
    square: `<svg ${A}><rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/></svg>`,
    circle: `<svg ${A}><circle cx="12" cy="12" r="8"/></svg>`,
    diamond: `<svg ${A}><path d="M12 3l9 9-9 9-9-9z"/></svg>`,
    table: `<svg ${A}><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="3.5" y1="14.5" x2="20.5" y2="14.5"/><line x1="9.5" y1="4.5" x2="9.5" y2="19.5"/><line x1="14.5" y1="4.5" x2="14.5" y2="19.5"/></svg>`,
    text: `<svg ${A}><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></svg>`,
    cursor: `<svg ${A}><path d="M5 3l6.5 16 2-6.5 6.5-2z"/></svg>`,
    zoomIn: `<svg ${A}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
    zoomOut: `<svg ${A}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
    undo: `<svg ${A}><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 1 2.1 6"/></svg>`,
    ticket: `<svg ${A}><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v1a2 2 0 0 0 0 5v1a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 15.5v-1a2 2 0 0 0 0-5z"/><line x1="13" y1="6" x2="13" y2="18" stroke-dasharray="2 2"/></svg>`,
    github: `<svg ${A}><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>`,
    summarize: `<svg ${A}><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/><circle cx="18.5" cy="17" r="3.2"/></svg>`,
    caption: `<svg ${A}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 11a2 2 0 0 0 0 2.5M11 11a2 2 0 0 0 0 2.5"/><line x1="14.5" y1="12.2" x2="17" y2="12.2"/></svg>`,
    people: `<svg ${A}><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M16.5 19a5.5 5.5 0 0 0-2-3.7"/></svg>`,
    expand: `<svg ${A}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
    download: `<svg ${A}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    dot: `<svg ${A}><circle cx="12" cy="12" r="4"/></svg>`,
    arrowRight: `<svg ${A}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
    reply: `<svg ${A}><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
    star: `<svg ${A}><path d="M12 3l2.7 5.6L21 9.5l-4.5 4.4 1 6.1L12 17.2 6.5 20l1-6.1L3 9.5l6.3-.9z"/></svg>`,
    stickyNote: `<svg ${A}><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/></svg>`,
    frame: `<svg ${A}><rect x="3" y="6" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="6.5" cy="8" r="0.5"/></svg>`,
    // ── Jira board feature ──────────────────────────────────────
    kanban: `<svg ${A}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="9" y2="9"/><line x1="15" y1="13" x2="21" y2="13"/></svg>`,
    bug: `<svg ${A}><rect x="8" y="6" width="8" height="12" rx="4"/><path d="M19 7l-3 2M5 7l3 2M19 13h-3M5 13h3M19 19l-3-2M5 19l3-2M12 4V2"/></svg>`,
    block: `<svg ${A}><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>`,
    filter: `<svg ${A}><polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3"/></svg>`,
    chevronUp: `<svg ${A}><polyline points="6 15 12 9 18 15"/></svg>`,
    chevronsUp: `<svg ${A}><polyline points="6 14 12 8 18 14"/><polyline points="6 19 12 13 18 19"/></svg>`,
    chevronsDown: `<svg ${A}><polyline points="6 10 12 16 18 10"/><polyline points="6 5 12 11 18 5"/></svg>`,
    equal: `<svg ${A}><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg>`,
    external: `<svg ${A}><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/></svg>`,
    // ── Terminal feature (in-app pty / Claude Code) ─────────────
    terminal: `<svg ${A}><rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="12" y1="15" x2="16" y2="15"/></svg>`,
    // ── Recordings library ──────────────────────────────────────
    film: `<svg ${A}><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
    // ── Integrations (inbound webhooks) ─────────────────────────
    zap: `<svg ${A}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    copy: `<svg ${A}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    // ── Claude usage dashboard ──────────────────────────────────
    activity: `<svg ${A}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  };

  // Merge: V2 design icons land alongside legacy icons. Legacy keys
  // (cam, sparkle, phoneDown, jira, spotlight, users, arrow) are
  // untouched — existing callsites keep working. New v2 code uses
  // the design-canonical name (video, sparkles, phoneOff, ticket,
  // expand, people, arrowRight) and gets the design SVG.
  Object.assign(ICONS, V2);

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
