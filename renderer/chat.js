// Slack-style chat: channels, threaded replies, emoji reactions, an emoji
// picker for both the composer and the reaction menu, and a typing indicator.
//
// View modes:
//   - "channel": shows top-level messages in the current channel; clicking a
//     message's thread link switches to "thread" view rooted at that message.
//   - "thread":  shows the parent + replies; the composer posts replies.
class ChatView {
  constructor({ mesh, els }) {
    this.mesh = mesh;
    this.els = els;
    this.currentChannel = 'general';
    this.threadParentId = null; // null => channel view
    this.byChannel = new Map(); // channelId -> Message[]
    this.typingUsers = new Map(); // peerId -> {name, until}
    this.typingClock = setInterval(() => this._refreshTyping(), 800);
    this._wireDom();
    this._wireMesh();
    this._initEmojiPicker();
  }

  setChannel(channelId, topic) {
    this.currentChannel = channelId;
    this.threadParentId = null;
    this.els.chatChannelName.textContent = '#' + channelId;
    this.els.channelName.textContent = '#' + channelId;
    this.els.channelTopic.textContent = topic || '';
    this.els.composer.placeholder = 'Message #' + channelId;
    this.els.threadBack.classList.add('hidden');
    this._render();
    this.mesh.send({ type: 'chat-history', channelId });
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
    this.els.chatChannelName.textContent = '#' + this.currentChannel;
    this.els.composer.placeholder = 'Message #' + this.currentChannel;
    this._render();
  }

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
  }

  _wireMesh() {
    this.mesh.addEventListener('chat-history', (e) => {
      const { channelId, messages } = e.detail;
      this.byChannel.set(channelId, messages);
      if (channelId === this.currentChannel) this._render();
    });
    this.mesh.addEventListener('chat-message', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      arr.push(m);
      this.byChannel.set(m.channelId, arr);
      if (m.channelId === this.currentChannel) this._render(true);
    });
    this.mesh.addEventListener('chat-update', (e) => {
      const m = e.detail.message;
      const arr = this.byChannel.get(m.channelId) || [];
      const idx = arr.findIndex((x) => x.id === m.id);
      if (idx >= 0) arr[idx] = m;
      if (m.channelId === this.currentChannel) this._render();
    });
    this.mesh.addEventListener('typing', (e) => {
      const { from, fromName, channelId, parentId } = e.detail;
      if (channelId !== this.currentChannel) return;
      if ((parentId || null) !== (this.threadParentId || null)) return;
      this.typingUsers.set(from, { name: fromName, until: Date.now() + 2500 });
      this._refreshTyping();
    });
  }

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

  _submit() {
    const text = this.els.composer.value.trim();
    if (!text) return;
    this.mesh.send({
      type: 'chat-send',
      channelId: this.currentChannel,
      parentId: this.threadParentId,
      text: window.replaceShortcodes(text),
    });
    this.els.composer.value = '';
    this.els.composer.style.height = 'auto';
  }

  _messages() { return this.byChannel.get(this.currentChannel) || []; }

  _render(scrollToBottom) {
    const all = this._messages();
    const container = this.els.messages;
    container.innerHTML = '';
    const list = this.threadParentId
      ? [all.find((m) => m.id === this.threadParentId), ...all.filter((m) => m.parentId === this.threadParentId)]
          .filter(Boolean)
      : all.filter((m) => !m.parentId);
    for (const m of list) container.appendChild(this._renderMessage(m, all));
    if (scrollToBottom || true) container.scrollTop = container.scrollHeight;
  }

  _renderMessage(m, all) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
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

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = m.text;

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

    if (!m.parentId && this.threadParentId === null) {
      const replies = (all || []).filter((x) => x.parentId === m.id);
      const link = document.createElement('div');
      link.className = 'thread-link';
      link.textContent = replies.length === 0
        ? '↪ Reply in thread'
        : `↪ ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
      link.onclick = () => this.openThread(m.id);
      right.append(head, body, reactions, actions, link);
    } else {
      right.append(head, body, reactions, actions);
    }

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

window.ChatView = ChatView;
