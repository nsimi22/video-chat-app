// Tiny markdown -> HTML renderer for chat messages.
//
// Supports: ```fenced code```, `inline code`, **bold**, *italic*,
// autolinks, and @mentions for known names (highlighted but not navigable).
// Everything is HTML-escaped first so user input never reaches the DOM as
// live HTML; subsequent transforms only insert tags around already-escaped
// content.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function renderMarkdown(text, { mentionNames, myName } = {}) {
  if (!text) return '';
  let s = escapeHtml(text);

  // Fenced code blocks first; their content stays untouched by later passes.
  // Sentinels live in the Private Use Area so they can't collide with
  // anything users type, and won't be touched by any later regex.
  const SENT = '\uE000';
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => {
    const i = blocks.push(c.replace(/^\n/, '').replace(/\n$/, '')) - 1;
    return `${SENT}B${i}${SENT}`;
  });
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    const i = inlines.push(c) - 1;
    return `${SENT}I${i}${SENT}`;
  });

  // Bold then italic. Single-pass regexes — good enough for chat.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');

  // Autolinks (http/https only).
  s = s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m) =>
    `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);

  // @mentions — render highlighted; the "self" mention gets an extra class.
  if (mentionNames && mentionNames.length) {
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])@(${mentionNames.map(escapeRegex).join('|')})\\b`, 'gi');
    s = s.replace(pattern, (_, pre, name) => {
      const cls = myName && name.toLowerCase() === myName.toLowerCase() ? 'mention mention-self' : 'mention';
      return `${pre}<span class="${cls}">@${name}</span>`;
    });
  }

  // Newlines -> <br/> (outside code, which used sentinel placeholders).
  s = s.replace(/\n/g, '<br/>');

  // Reinsert preserved code spans/blocks.
  s = s.replace(/\uE000I(\d+)\uE000/g, (_, i) => `<code>${inlines[+i]}</code>`);
  s = s.replace(/\uE000B(\d+)\uE000/g, (_, i) => `<pre><code>${blocks[+i]}</code></pre>`);

  return s;
}

window.renderMarkdown = renderMarkdown;
window.escapeHtmlForChat = escapeHtml;
