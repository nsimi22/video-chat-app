// Profile card popover. One global instance — show(targetEl, userId)
// positions the card next to the click target, lazily fetches the
// full profile (incl. email when caller and target share a team),
// renders avatar / name / email / bio + Message + Edit-profile
// buttons, and dismisses on outside click or Escape.
//
// Editing your own profile lives in the Settings panel rather than
// in this popover — the card's "Edit profile" button just opens
// settings and scrolls to the profile section.

(function () {
  class ProfileCard {
    constructor({ huddle, onMessage, onEditProfile }) {
      this.huddle = huddle;
      this.onMessage = onMessage;
      this.onEditProfile = onEditProfile;
      this.el = document.createElement('div');
      this.el.className = 'profile-card hidden';
      this.el.setAttribute('role', 'dialog');
      this.el.setAttribute('aria-label', 'User profile');
      document.body.appendChild(this.el);
      this._currentUserId = null;
      this._onDocClick = (e) => {
        if (this.el.classList.contains('hidden')) return;
        if (this.el.contains(e.target)) return;
        // Suppress dismissal when the click came from the same target
        // that opened us — otherwise toggle-clicks reopen immediately.
        if (this._opener && this._opener.contains(e.target)) return;
        this.hide();
      };
      this._onKey = (e) => {
        if (e.key === 'Escape' && !this.el.classList.contains('hidden')) {
          this.hide();
          this._opener?.focus?.();
        }
      };
      document.addEventListener('mousedown', this._onDocClick, true);
      document.addEventListener('keydown', this._onKey);
    }

    // Tear down the popover. Called from teardownTeam so a new
    // HuddleClient gets a fresh ProfileCard — without this the old
    // instance's document listeners stay attached on every team
    // rejoin, eventually firing N copies of the dismissal logic per
    // mousedown.
    destroy() {
      this.hide();
      document.removeEventListener('mousedown', this._onDocClick, true);
      document.removeEventListener('keydown', this._onKey);
      this.el.remove();
    }

    async show(targetEl, userId) {
      if (!userId) return;
      this._opener = targetEl;
      this._currentUserId = userId;
      this.el.innerHTML = '<div class="profile-card-loading">Loading…</div>';
      this.el.classList.remove('hidden');
      this._position(targetEl);
      let profile;
      try {
        profile = await this.huddle.getProfile(userId);
      } catch (err) {
        this.el.innerHTML = `<div class="profile-card-error">Couldn't load profile: ${escapeText(err?.message || String(err))}</div>`;
        return;
      }
      // Bail if the user closed/reopened on a different target while
      // the RPC was in flight.
      if (this._currentUserId !== userId) return;
      if (!profile) {
        this.el.innerHTML = '<div class="profile-card-error">Profile not found.</div>';
        return;
      }
      this._render(profile);
      this._position(targetEl);
    }

    hide() {
      this.el.classList.add('hidden');
      this._currentUserId = null;
      this._opener = null;
    }

    _render(p) {
      const isSelf = p.user_id === this.huddle.peerId;
      const initial = (p.name || '?').slice(0, 1).toUpperCase();
      const avatarHtml = p.avatar_url
        ? `<img class="profile-card-avatar" src="${escapeAttr(p.avatar_url)}" alt="">`
        : `<div class="profile-card-avatar fallback" style="background:${escapeAttr(p.color || '#888')}">${escapeText(initial)}</div>`;
      this.el.innerHTML = `
        <div class="profile-card-head">
          ${avatarHtml}
          <div class="profile-card-id">
            <div class="profile-card-name">${escapeText(p.name || 'Unknown')}</div>
            ${p.email ? `<div class="profile-card-email">${escapeText(p.email)}</div>` : ''}
          </div>
        </div>
        ${p.bio ? `<div class="profile-card-bio">${escapeText(p.bio)}</div>` : ''}
        <div class="profile-card-actions">
          ${isSelf
            ? `<button class="profile-card-btn primary" data-act="edit">Edit profile</button>`
            : `<button class="profile-card-btn primary" data-act="message">Message</button>`}
        </div>
      `;
      this.el.querySelector('[data-act="message"]')?.addEventListener('click', () => {
        // Pass the full profile so the host can DM by user_id (the
        // FK) rather than re-looking-up by display name. The string
        // form was fragile after profile renames and ambiguous
        // when two teammates share a name.
        this.hide();
        this.onMessage?.(p);
      });
      this.el.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
        this.hide();
        this.onEditProfile?.();
      });
    }

    _position(targetEl) {
      // Anchor below the target by default, flip up if we'd run off
      // the bottom of the viewport. Same for left/right edges.
      const rect = targetEl.getBoundingClientRect();
      const cardW = this.el.offsetWidth || 280;
      const cardH = this.el.offsetHeight || 200;
      const margin = 8;
      let top = rect.bottom + margin;
      let left = rect.left;
      if (top + cardH > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - cardH - margin);
      }
      if (left + cardW > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - cardW - margin);
      }
      this.el.style.top = `${top}px`;
      this.el.style.left = `${left}px`;
    }
  }

  function escapeText(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeText(s); }

  window.ProfileCard = ProfileCard;
})();
