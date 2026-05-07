// Slack-style chat view.
//
// Responsibilities:
//   - Channel + thread view modes, paginated history loading
//   - Message rendering with markdown, mentions, reactions, edit/delete
//   - Composer with shortcode emoji replacement, file attachments (pasted,
//     drag-dropped, or picked), and a typing indicator
//
// Per-channel state lives on `byChannel` (messages) and `paginationByChannel`
// (`{hasMore, oldestTs}`). View-only state (`nodeById`, `_currentLabel`) is
// reset on channel/thread switches.
class ChatView {
  constructor({ mesh, els, hooks }) {
    this.mesh = mesh;
    this.els = els;
    this.hooks = hooks || {};
    this.currentChannel = 'general';
    this.threadParentId = null;
    this.byChannel = new Map();
    this.paginationByChannel = new Map();
    this.nodeById = new Map();
    this.typingUsers = new Map();
    this.editingMessageId = null;
    this.composerAttachments = []; // [{file, status, info?}] where info = {url, name, contentType, size}
    this._uploadTokenWaiters = []; // queued resolvers awaiting next upload-token

    this.typingClock = setInterval(() => this._refreshTyping(), 800);
    this._wireDom();
    this._wireMesh();
    this._initEmojiPicker();
  }

  // --- Public API ---------------------------------------------------------

  setChannel(channelId, topic, displayLabel) {
    this.currentChannel = channelId;
    this.threadParentId = null;
    this.editingMessageId = null;
    this.composerAttachments = [];
    this._renderAttachmentChips();
    const label = displayLabel || ('#' + channelId);
    this._currentLabel = label;
    this.els.chatChannelName.textContent = label;
    this.els.channelName.textContent = label;
    this.els.channelTopic.textContent = topic || '';
    this.els.composer.placeholder = `Message ${label}`;
    this.els.threadBack.classList.add('hidden');
    this._render();
    this.mesh.send({ type: 'chat-history', channelId, limit: 50 });
  }

  openThread(messageId) {
    this.threadParentId = messageId;
    this.els.threadBack.classList.remove('hidden');
    this.els.chatChannelName.textContent = 'Thread';
    const parent = this._messages().find((m) => m.id === messageId);
    this.els.composer.placeholder = parent ? `Reply to ${parent.authorName}` : 'Reply';
    this._render();
  }

  closeThread() {
    this.threadParentId = null;
    this.els.threadBack.classList.add('hidden');
    const label = this._currentLabel || ('#' + this.currentChannel);
    this.els.chatChannelName.textContent = label;
    this.els.composer.placeholder = `Message ${label}`;
    this._render();
  }

  // --- Wiring -------------------------------------------------------------

  _wireDom() {
    this.els.threadBack.addEventListener('click', () => this.closeThread());
    this.els.send.addEventListener('click', () => this._submit());
    this.els.composer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._submit();
      } else {
        this.mesh.send({ type: 'typing', channelId: this.currentChannel, parentId: this.threadParentId });
      }
    });
    this.els.composer.addEventListener('input', () => {
      this.els.composer.style.height = 'auto';
      this.els.composer.style.height = Math.min(160, this.els.composer.scrollHeight) + 'px';
    });
    this.els.composer.addEventListener('paste', (e) => this._onPaste(e));
    this.els.emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.els.emojiPicker.classList.toggle('hidden');
      this._emojiPickerMode = 'compose';
    });
    document.addEventListener('click', (e) => {
      if (!this.els.emojiPicker.contains(e.target) && e.target !== this.els.emojiBtn) {
        this.els.emojiPicker.classList.add('hidden');
      }
    });
    if (this.els.attachBtn) {
      this.els.attachBtn.addEventListener('click', () => this.els.fileInput?.click());
    }
    if (this.els.fileInput) {
      this.els.fileInput.addEventListener('change', (e) => {
        for (const f of e.target.files) this._beginUpload(f);
        e.target.value = '';
      });
    }
    // Drag-and-drop onto the chat pane.
    const drop = this.els.messages.parentElement;
    if (drop) {
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('drag-over');
        for (const f of e.dataTransfer.files || []) this._beginUpload(f);
      });
    }
  }

  _wireMesh() {
    this.mesh.addEventListener('chat-history', (e) => {
      const { channelId, messages, hasMore } = e.detail;
      const existing = this.byChannel.get(channelId) || [];
      // Merge dedupe-by-id, keep chronological.
      const ids = new Set(existing.map((m) => m.id));
      const merged = existing.slice();
      for (const m of messages) if (!ids.has(m.id)) merged.unshift(m);
      merged.sort((a, b) => a.ts - b.ts);
      this.byChannel.set(channelId, merged);
      const oldest = merged.length ? merged[0].ts : null;
      this.paginationByChannel.set(channelId, { hasMore: !!hasMore, oldestTs: oldest });
      if (channelId === this.currentChannel) this._render();
    });
    this.mesh.addEventListener('chat-message', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      arr.push(m);
      this.byChannel.set(m.channelId, arr);
      if (m.channelId === this.currentChannel) this._appendIncremental(m);
      this.hooks.onMessage?.(m);
    });
    this.mesh.addEventListener('chat-update', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      const idx = arr.findIndex((x) => x.id === m.id);
      if (idx >= 0) arr[idx] = m;
      if (m.channelId === this.currentChannel) this._replaceNode(m);
    });
    this.mesh.addEventListener('chat-message-deleted', (e) => {
      const { channelId, messageId } = e.detail;
      const arr = this.byChannel.get(channelId) || [];
      const idx = arr.findIndex((x) => x.id === messageId);
      if (idx >= 0) arr.splice(idx, 1);
      if (channelId === this.currentChannel) {
        const node = this.nodeById.get(messageId);
        if (node) node.remove();
        this.nodeById.delete(messageId);
      }
    });
    this.mesh.addEventListener('typing', (e) => {
      const { from, fromName, channelId, parentId } = e.detail;
      if (channelId !== this.currentChannel) return;
      if ((parentId || null) !== (this.threadParentId || null)) return;
      this.typingUsers.set(from, { name: fromName, until: Date.now() + 2500 });
      this._refreshTyping();
    });
    this.mesh.addEventListener('upload-token', (e) => {
      const fn = this._uploadTokenWaiters.shift();
      if (fn) fn(e.detail.token);
    });
  }

  // --- Submit / edit ------------------------------------------------------

  async _submit() {
    if (this.editingMessageId) return; // edits use their own inline path

    // Wait for any in-flight uploads to settle before sending.
    const pending = this.composerAttachments.filter((a) => a.status === 'uploading');
    if (pending.length) return;
    const failed = this.composerAttachments.filter((a) => a.status === 'failed');
    if (failed.length) {
      alert(`Some files failed to upload: ${failed.map((a) => a.file.name).join(', ')}`);
      return;
    }

    const text = this.els.composer.value.trim();
    const attachments = this.composerAttachments.filter((a) => a.status === 'done').map((a) => a.info);
    if (!text && attachments.length === 0) return;

    this.mesh.send({
      type: 'chat-send',
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: window.replaceShortcodes(text),
      attachments,
    });
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
    this.composerAttachments = [];
    this._renderAttachmentChips();
  }

  _beginEdit(messageId) {
    this.editingMessageId = messageId;
    this._replaceNodeById(messageId);
  }

  _saveEdit(messageId, newText) {
    this.mesh.send({ type: 'chat-edit', messageId, text: newText });
    this.editingMessageId = null;
    // Server will broadcast chat-update; render happens then.
  }

  _cancelEdit() {
    const id = this.editingMessageId;
    this.editingMessageId = null;
    if (id) this._replaceNodeById(id);
  }

  _delete(messageId) {
    if (!confirm('Delete this message? It will be removed for everyone.')) return;
    this.mesh.send({ type: 'chat-delete-message', messageId });
  }

  // --- File uploads -------------------------------------------------------

  _onPaste(e) {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) this._beginUpload(f);
      }
    }
  }

  async _beginUpload(file) {
    if (!file) return;
    const slot = { file, status: 'uploading', info: null };
    this.composerAttachments.push(slot);
    this._renderAttachmentChips();
    try {
      const token = await this._requestUploadToken();
      const httpBase = this.mesh.url.replace(/^ws/, 'http').replace(/\/$/, '');
      const res = await fetch(`${httpBase}/upload?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': file.name || 'file',
        },
        body: file,
      });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
      const json = await res.json();
      slot.info = {
        url: `${httpBase}${json.url}`,
        name: json.name,
        contentType: json.contentType,
        size: json.size,
      };
      slot.status = 'done';
    } catch (err) {
      console.warn('upload failed', err);
      slot.status = 'failed';
    }
    this._renderAttachmentChips();
  }

  _requestUploadToken() {
    return new Promise((resolve) => {
      this._uploadTokenWaiters.push(resolve);
      this.mesh.send({ type: 'request-upload-token', channelId: this.currentChannel });
    });
  }

  _renderAttachmentChips() {
    if (!this.els.attachmentChips) return;
    this.els.attachmentChips.replaceChildren();
    if (this.composerAttachments.length === 0) {
      this.els.attachmentChips.classList.add('hidden');
      return;
    }
    this.els.attachmentChips.classList.remove('hidden');
    for (const a of this.composerAttachments) {
      const chip = document.createElement('span');
      chip.className = 'chip ' + a.status;
      const dot = document.createElement('span');
      dot.className = 'chip-status';
      const txt = document.createElement('span');
      txt.textContent = a.file.name + (a.status === 'uploading' ? ' …' : a.status === 'failed' ? ' (failed)' : '');
      const x = document.createElement('button');
      x.textContent = '✕';
      x.onclick = () => {
        this.composerAttachments = this.composerAttachments.filter((c) => c !== a);
        this._renderAttachmentChips();
      };
      chip.append(dot, txt, x);
      this.els.attachmentChips.appendChild(chip);
    }
  }

  // --- Rendering ----------------------------------------------------------

  _refreshTyping() {
    const now = Date.now();
    const live = [];
    for (const [id, info] of this.typingUsers) {
      if (info.until > now) live.push(info.name);
      else this.typingUsers.delete(id);
    }
    this.els.typing.textContent = live.length === 0 ? ''
      : live.length === 1 ? `${live[0]} is typing…`
      : `${live.slice(0, -1).join(', ')} and ${live.at(-1)} are typing…`;
  }

  _messages() { return this.byChannel.get(this.currentChannel) || []; }

  _render() {
    const all = this._messages();
    const container = this.els.messages;
    container.replaceChildren();
    this.nodeById.clear();

    const pagination = this.paginationByChannel.get(this.currentChannel);
    if (pagination?.hasMore && !this.threadParentId) {
      const more = document.createElement('button');
      more.className = 'load-more';
      more.textContent = '↑ Load older messages';
      more.onclick = () => {
        const oldest = pagination.oldestTs || Date.now();
        this.mesh.send({ type: 'chat-history', channelId: this.currentChannel, before: oldest, limit: 50 });
      };
      container.appendChild(more);
    }

    for (const m of this._visibleList(all)) {
      const node = this._renderMessage(m, all);
      this.nodeById.set(m.id, node);
      container.appendChild(node);
    }
    container.scrollTop = container.scrollHeight;
  }

  _visibleList(all) {
    if (this.threadParentId) {
      const parent = all.find((m) => m.id === this.threadParentId);
      const replies = all.filter((m) => m.parentId === this.threadParentId);
      return parent ? [parent, ...replies] : replies;
    }
    return all.filter((m) => !m.parentId);
  }

  _isInCurrentView(m) {
    if (this.threadParentId) {
      return m.id === this.threadParentId || m.parentId === this.threadParentId;
    }
    return !m.parentId;
  }

  _appendIncremental(m) {
    if (this._isInCurrentView(m)) {
      const node = this._renderMessage(m, this._messages());
      this.nodeById.set(m.id, node);
      this.els.messages.appendChild(node);
      this.els.messages.scrollTop = this.els.messages.scrollHeight;
      return;
    }
    if (m.parentId && !this.threadParentId) this._replaceNodeById(m.parentId);
  }

  _replaceNode(m) {
    if (this._isInCurrentView(m)) this._replaceNodeById(m.id);
  }

  _replaceNodeById(id) {
    const old = this.nodeById.get(id);
    if (!old) return;
    const all = this._messages();
    const target = all.find((x) => x.id === id);
    if (!target) return;
    const fresh = this._renderMessage(target, all);
    this.nodeById.set(id, fresh);
    old.replaceWith(fresh);
  }

  _knownNames() {
    const set = new Set();
    if (this.mesh.name) set.add(this.mesh.name);
    for (const p of this.mesh.peerInfo.values()) set.add(p.name);
    for (const arr of this.byChannel.values()) for (const m of arr) set.add(m.authorName);
    set.delete('');
    return [...set];
  }

  _renderMessage(m, all) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    const myName = this.mesh.name;
    const isMine = m.authorName === myName;
    const mentionsMe = Array.isArray(m.mentions) && m.mentions.includes(myName);
    if (mentionsMe) wrap.classList.add('msg-mentions-me');

    const initials = (m.authorName || '?').slice(0, 1).toUpperCase();
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = m.authorColor || '#666';
    avatar.textContent = initials;

    const right = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'msg-head';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = m.authorName;
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    head.append(author, time);
    if (m.editedTs) {
      const edited = document.createElement('span');
      edited.className = 'msg-edited';
      edited.textContent = '(edited)';
      head.append(edited);
    }

    // Body: edit-mode textarea or rendered markdown.
    let body;
    if (this.editingMessageId === m.id) {
      body = document.createElement('div');
      body.className = 'msg-body editing';
      const ta = document.createElement('textarea');
      ta.value = m.text;
      ta.rows = Math.max(2, m.text.split('\n').length);
      const row = document.createElement('div');
      row.className = 'edit-actions';
      const save = document.createElement('button');
      save.textContent = 'Save';
      save.className = 'primary';
      save.onclick = () => this._saveEdit(m.id, ta.value);
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => this._cancelEdit();
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
        if (e.key === 'Escape') cancel.click();
      });
      row.append(save, cancel);
      body.append(ta, row);
      setTimeout(() => ta.focus(), 0);
    } else {
      body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = window.renderMarkdown(m.text || '', {
        mentionNames: this._knownNames(),
        myName,
      });
    }

    // Attachments — inline image previews; everything else as a download chip.
    let attachmentsEl = null;
    if (Array.isArray(m.attachments) && m.attachments.length) {
      attachmentsEl = document.createElement('div');
      attachmentsEl.className = 'msg-attachments';
      for (const a of m.attachments) {
        const isImage = (a.contentType || '').startsWith('image/');
        if (isImage) {
          const img = document.createElement('img');
          img.src = a.url;
          img.alt = a.name;
          img.className = 'msg-image';
          img.onclick = () => window.open(a.url, '_blank');
          attachmentsEl.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.href = a.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'attachment-chip';
          link.textContent = `📎 ${a.name}${a.size ? ` (${formatBytes(a.size)})` : ''}`;
          attachmentsEl.appendChild(link);
        }
      }
    }

    const reactions = document.createElement('div');
    reactions.className = 'reactions';
    for (const [emoji, peers] of Object.entries(m.reactions || {})) {
      const pill = document.createElement('span');
      pill.className = 'reaction' + (peers.includes(this.mesh.peerId) ? ' mine' : '');
      pill.textContent = `${emoji} ${peers.length}`;
      pill.onclick = () => this.mesh.send({ type: 'chat-react', messageId: m.id, emoji });
      reactions.appendChild(pill);
    }

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    for (const e of window.QUICK_REACTIONS.slice(0, 5)) {
      const b = document.createElement('button');
      b.textContent = e;
      b.onclick = () => this.mesh.send({ type: 'chat-react', messageId: m.id, emoji: e });
      actions.appendChild(b);
    }
    const more = document.createElement('button');
    more.textContent = '➕';
    more.title = 'Add reaction';
    more.onclick = (ev) => this._openReactionPicker(ev, m.id);
    actions.appendChild(more);
    if (isMine) {
      const edit = document.createElement('button');
      edit.textContent = '✏️';
      edit.title = 'Edit message';
      edit.onclick = () => this._beginEdit(m.id);
      const del = document.createElement('button');
      del.textContent = '🗑';
      del.title = 'Delete message';
      del.onclick = () => this._delete(m.id);
      actions.append(edit, del);
    }

    const children = [head, body];
    if (attachmentsEl) children.push(attachmentsEl);
    children.push(reactions, actions);
    if (!m.parentId && this.threadParentId === null) {
      const replies = (all || []).filter((x) => x.parentId === m.id);
      const link = document.createElement('div');
      link.className = 'thread-link';
      link.textContent = replies.length === 0
        ? '↪ Reply in thread'
        : `↪ ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
      link.onclick = () => this.openThread(m.id);
      children.push(link);
    }
    right.append(...children);
    wrap.append(avatar, right);
    return wrap;
  }

  _initEmojiPicker() {
    const p = this.els.emojiPicker;
    p.innerHTML = '';
    for (const group of window.EMOJI_GROUPS) {
      const h = document.createElement('div');
      h.className = 'group-header';
      h.textContent = group.name;
      p.appendChild(h);
      for (const [, char] of group.list) {
        const b = document.createElement('button');
        b.textContent = char;
        b.onclick = (e) => {
          e.stopPropagation();
          if (this._emojiPickerMode === 'react' && this._emojiPickerTarget) {
            this.mesh.send({ type: 'chat-react', messageId: this._emojiPickerTarget, emoji: char });
          } else {
            this.els.composer.value += char;
            this.els.composer.focus();
          }
          p.classList.add('hidden');
        };
        p.appendChild(b);
      }
    }
  }

  _openReactionPicker(ev, messageId) {
    ev.stopPropagation();
    this._emojiPickerMode = 'react';
    this._emojiPickerTarget = messageId;
    this.els.emojiPicker.classList.remove('hidden');
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

window.ChatView = ChatView;
