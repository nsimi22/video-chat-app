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
  // Autolinks (http/https only) — extracted to sentinels HERE, before the
  // bold/italic/@mention passes, so those can't reach inside a URL. A path
  // like https://x.com/@handle would otherwise have the @mention pass
  // inject a <span> into the href, and a literal ** in a URL would get a
  // <strong> mid-attribute — both produce broken markup and dead links.
  const links = [];
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (m) => {
    const i = links.push(m) - 1;
    return `${SENT}L${i}${SENT}`;
  });

  // Bold then italic. Single-pass regexes — good enough for chat.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');

  // @mentions — single pass that handles both user mentions and the
  // broadcast keywords @here / @channel. Combining them in one regex avoids
  // a second pass re-matching the `@here` text we just emitted inside a
  // <span>, which would produce nested broken markup.
  {
    const userAlt = mentionNames && mentionNames.length
      ? mentionNames.map(escapeRegex).join('|')
      : null;
    const alt = userAlt ? `here|channel|${userAlt}` : 'here|channel';
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])@(${alt})\\b`, 'gi');
    s = s.replace(pattern, (_, pre, token) => {
      const lower = token.toLowerCase();
      if (lower === 'here' || lower === 'channel') {
        return `${pre}<span class="mention mention-broadcast">@${lower}</span>`;
      }
      const cls = myName && lower === myName.toLowerCase() ? 'mention mention-self' : 'mention';
      return `${pre}<span class="${cls}">@${token}</span>`;
    });
  }

  // Blockquotes: collapse runs of consecutive lines starting with `> ` into
  // a single <blockquote>. Done before the \n -> <br/> pass so we can split
  // on real newlines; inside the blockquote, internal line breaks become
  // <br/> manually so the later pass doesn't re-process them.
  // We're operating on already-escaped text, so the literal `>` shows up as
  // the entity `&gt;`.
  {
    const lines = s.split('\n');
    const out = [];
    let buf = null;
    for (const line of lines) {
      const m = /^&gt;\s?(.*)$/.exec(line);
      if (m) {
        (buf ||= []).push(m[1]);
      } else {
        if (buf) { out.push('<blockquote>' + buf.join('<br/>') + '</blockquote>'); buf = null; }
        out.push(line);
      }
    }
    if (buf) out.push('<blockquote>' + buf.join('<br/>') + '</blockquote>');
    s = out.join('\n');
  }

  // Newlines -> <br/> (outside code, which used sentinel placeholders).
  s = s.replace(/\n/g, '<br/>');

  // Reinsert preserved code spans/blocks + autolinks.
  s = s.replace(/\uE000I(\d+)\uE000/g, (_, i) => `<code>${inlines[+i]}</code>`);
  s = s.replace(/\uE000B(\d+)\uE000/g, (_, i) => `<pre><code>${blocks[+i]}</code></pre>`);
  s = s.replace(/\uE000L(\d+)\uE000/g, (_, i) =>
    `<a href="${links[+i]}" target="_blank" rel="noopener noreferrer">${links[+i]}</a>`);

  return s;
}

window.renderMarkdown = renderMarkdown;
window.escapeHtmlForChat = escapeHtml;
