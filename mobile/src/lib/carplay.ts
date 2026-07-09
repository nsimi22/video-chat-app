import { Platform } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// CarPlay controller
//
// A thin, imperative wrapper around `react-native-carplay` that the React tree
// drives through <CarPlayBridge> (components/CarPlayBridge.tsx). It renders an
// iMessage-style communication surface on the car head-unit:
//
//   • conversations — a CPListTemplate of the team's channels + DMs, each with a
//     last-message preview and an unread count (the root template).
//   • conversation  — tapping a row pushes a detail CPListTemplate: the most
//     recent messages (read-only), a set of canned quick-replies you can send
//     hands-free, and a "Join audio call" action.
//   • call          — an in-call CPInformationTemplate (name, live participant
//     count, Mute / Leave), pushed on top while a call is active.
//
// CarPlay forbids free-text entry and video while driving, so replies are canned
// presets and calls are audio-only (they reuse the existing LiveKit CallContext;
// this surface never touches camera tracks). Reading incoming message text aloud
// + full voice dictation is the SiriKit path — see docs/carplay.md.
//
// The controller is a small **stack reconciler**: the bridge computes a plain
// CarPlayViewState (conversations, optional open conversation, optional call)
// and calls render(state); the controller diffs it against the live template
// stack and issues the minimal setRoot / push / pop / update calls. Centralising
// the push/pop bookkeeping in one deterministic place keeps this correct without
// a device to test on.
//
// Everything is defensive: the native module is iOS-only and only present in a
// build that bundled the pod, so it's lazy-required and degrades to a no-op
// elsewhere; template classes are typed `any` and every native call is wrapped,
// so a react-native-carplay version skew logs a warning instead of red-boxing.
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationRow = {
  // Stable channel id — handed back to onOpenConversation verbatim.
  id: string;
  // Row title (channel name or DM peer's display name).
  label: string;
  // Last-message preview line ("" when the channel has no messages yet).
  preview: string;
  // Unread count for the badge-ish detail prefix (0 = none).
  unread: number;
};

export type OpenConversation = {
  id: string;
  title: string;
  // Preformatted recent-message lines, oldest→newest ("Name: body").
  lines: string[];
  // Canned reply strings shown as tappable rows.
  quickReplies: string[];
  // True while the messages are still being fetched.
  loading: boolean;
};

export type CallView = { title: string; detail: string; muted: boolean };

export type CarPlayViewState = {
  conversations: ConversationRow[];
  open: OpenConversation | null;
  call: CallView | null;
};

export type CarPlayHandlers = {
  // A conversation row was tapped → open its detail.
  onOpenConversation: (id: string) => void;
  // The car's system back button popped the open conversation.
  onCloseConversation: () => void;
  // A canned reply row was tapped → send it to the open conversation.
  onQuickReply: (text: string) => void;
  // The "Join audio call" row was tapped → start/join the open conversation's call.
  onStartCall: () => void;
  // The in-call Mute button was pressed.
  onToggleMute: () => void;
  // The in-call Leave button was pressed.
  onLeave: () => void;
};

type StackEntry = {
  key: string;
  kind: 'conv' | 'call';
  sig: string;
  data: OpenConversation | CallView;
  template: any;
};

type DetailAction = { type: 'noop' } | { type: 'reply'; text: string } | { type: 'call' };

// Lazy handle to the native module. `undefined` = not loaded yet, `null` =
// tried and unavailable (non-iOS, or the pod wasn't in this build).
let mod: any | null | undefined = undefined;

function carplay(): any | null {
  if (mod !== undefined) return mod;
  if (Platform.OS !== 'ios') {
    mod = null;
    return mod;
  }
  try {
    // Required lazily (never a static import) so `tsc`/Metro don't hard-fail when
    // the package isn't installed and Android never pulls in an iOS-only module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('react-native-carplay');
  } catch {
    mod = null;
  }
  return mod;
}

function truncate(s: string, n: number): string {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

class CarPlayControllerImpl {
  private handlers: CarPlayHandlers | null = null;
  private desired: CarPlayViewState | null = null;
  private started = false;
  private connected = false;
  private unsubscribe: (() => void)[] = [];

  // Live template bookkeeping (reset on disconnect — the native side is torn
  // down when the car disconnects, so we rebuild from scratch on reconnect).
  private rootTemplate: any = null;
  private rootSig = '';
  private rootIds: string[] = [];
  private stack: StackEntry[] = [];
  // Action map for the single open conversation detail (only one at a time), so
  // its flat onItemSelect index can resolve to noop / reply / call.
  private openActions: DetailAction[] = [];

  get isSupported(): boolean {
    return !!carplay();
  }

  start(handlers: CarPlayHandlers): void {
    this.handlers = handlers;
    const cp = carplay();
    if (!cp?.CarPlay || this.started) return;
    this.started = true;

    const onConnect = () => {
      this.connected = true;
      // Fresh native session — drop any stale template refs and rebuild.
      this.resetTemplates();
      this.reconcile();
    };
    const onDisconnect = () => {
      this.connected = false;
      this.resetTemplates();
    };

    try {
      cp.CarPlay.registerOnConnect(onConnect);
      cp.CarPlay.registerOnDisconnect(onDisconnect);
      this.unsubscribe.push(() => {
        try {
          cp.CarPlay.unregisterOnConnect(onConnect);
          cp.CarPlay.unregisterOnDisconnect(onDisconnect);
        } catch {}
      });
      // The car may already be connected when the JS bridge (re)starts.
      if (cp.CarPlay.connected) {
        this.connected = true;
        this.resetTemplates();
        this.reconcile();
      }
    } catch (err) {
      console.warn('[carplay] failed to register scene listeners', err);
    }
  }

  setHandlers(handlers: CarPlayHandlers): void {
    this.handlers = handlers;
  }

  stop(): void {
    for (const fn of this.unsubscribe.splice(0)) fn();
    this.started = false;
    this.connected = false;
    this.resetTemplates();
  }

  private resetTemplates(): void {
    this.rootTemplate = null;
    this.rootSig = '';
    this.rootIds = [];
    this.stack = [];
    this.openActions = [];
  }

  // The one entry point the bridge calls whenever its view state changes.
  render(state: CarPlayViewState): void {
    this.desired = state;
    this.reconcile();
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  private reconcile(): void {
    const cp = carplay();
    if (!cp?.CarPlay || !this.connected || !this.desired) return;
    try {
      this.reconcileRoot(cp, this.desired);
      this.reconcileStack(cp, this.desired);
    } catch (err) {
      console.warn('[carplay] reconcile failed', err);
    }
  }

  private reconcileRoot(cp: any, state: CarPlayViewState): void {
    const sig = state.conversations
      .map((c) => `${c.id}|${c.label}|${c.unread}|${c.preview}`)
      .join(';');
    if (!this.rootTemplate) {
      this.rootTemplate = this.buildRoot(cp, state.conversations);
      this.rootSig = sig;
      this.stack = [];
      cp.CarPlay.setRootTemplate(this.rootTemplate, false);
      return;
    }
    if (sig !== this.rootSig) {
      this.rootIds = state.conversations.map((c) => c.id);
      try {
        this.rootTemplate.updateSections([
          { header: 'Messages', items: state.conversations.map((c) => this.rootItem(c)) },
        ]);
      } catch (err) {
        console.warn('[carplay] root updateSections failed', err);
      }
      this.rootSig = sig;
    }
  }

  private reconcileStack(cp: any, state: CarPlayViewState): void {
    const desired: Omit<StackEntry, 'template'>[] = [];
    if (state.open) {
      desired.push({
        key: `conv:${state.open.id}`,
        kind: 'conv',
        sig: this.sigOpen(state.open),
        data: state.open,
      });
    }
    if (state.call) {
      desired.push({ key: 'call', kind: 'call', sig: this.sigCall(state.call), data: state.call });
    }

    // Longest common prefix of live stack vs desired (by key).
    let i = 0;
    while (i < this.stack.length && i < desired.length && this.stack[i].key === desired[i].key) i++;

    // Pop everything above the common prefix (top-down).
    for (let j = this.stack.length - 1; j >= i; j--) {
      try {
        cp.CarPlay.popTemplate(true);
      } catch (err) {
        console.warn('[carplay] popTemplate failed', err);
      }
    }
    this.stack = this.stack.slice(0, i);

    // Update common entries whose content changed (in place, no pop/push).
    for (let j = 0; j < i; j++) {
      if (this.stack[j].sig === desired[j].sig) continue;
      if (desired[j].kind === 'conv') this.updateDetail(this.stack[j].template, desired[j].data as OpenConversation);
      else this.updateCall(this.stack[j].template, desired[j].data as CallView);
      this.stack[j].sig = desired[j].sig;
      this.stack[j].data = desired[j].data;
    }

    // Push the rest.
    for (let j = i; j < desired.length; j++) {
      const e = desired[j];
      const template =
        e.kind === 'conv'
          ? this.buildDetail(cp, e.data as OpenConversation)
          : this.buildCall(cp, e.data as CallView);
      try {
        cp.CarPlay.pushTemplate(template, true);
      } catch (err) {
        console.warn('[carplay] pushTemplate failed', err);
      }
      this.stack.push({ ...e, template });
    }
  }

  // ── Template builders ─────────────────────────────────────────────────────

  private rootItem(c: ConversationRow): any {
    const preview = c.preview || 'No messages yet';
    return {
      text: c.label,
      detailText: c.unread > 0 ? `${c.unread} new · ${preview}` : preview,
      showsDisclosureIndicator: true,
    };
  }

  private buildRoot(cp: any, conversations: ConversationRow[]): any {
    this.rootIds = conversations.map((c) => c.id);
    return new cp.ListTemplate({
      id: 'huddle-conversations',
      title: 'Huddle',
      sections: [{ header: 'Messages', items: conversations.map((c) => this.rootItem(c)) }],
      emptyViewTitleVariants: ['No conversations'],
      emptyViewSubtitleVariants: ['Open Huddle on your phone to get started'],
      onItemSelect: async ({ index }: { index: number }) => {
        const id = this.rootIds[index];
        if (id) this.handlers?.onOpenConversation(id);
      },
    });
  }

  // Builds the detail sections and, as a side effect, refreshes this.openActions
  // so the flat onItemSelect index resolves to the right action.
  private detailSections(open: OpenConversation): { sections: any[] } {
    const actions: DetailAction[] = [];
    const msgItems = open.loading
      ? [{ text: 'Loading…' }]
      : open.lines.length
        ? open.lines.map((l) => ({ text: l }))
        : [{ text: 'No messages yet' }];
    msgItems.forEach(() => actions.push({ type: 'noop' }));

    const replyItems = open.quickReplies.map((r) => ({ text: r, showsDisclosureIndicator: true }));
    open.quickReplies.forEach((r) => actions.push({ type: 'reply', text: r }));

    const callItems = [{ text: '📞 Join audio call', showsDisclosureIndicator: true }];
    actions.push({ type: 'call' });

    this.openActions = actions;
    return {
      sections: [
        { header: 'Recent messages', items: msgItems },
        { header: 'Quick reply', items: replyItems },
        { header: 'Call', items: callItems },
      ],
    };
  }

  private buildDetail(cp: any, open: OpenConversation): any {
    const { sections } = this.detailSections(open);
    return new cp.ListTemplate({
      id: `huddle-conv-${open.id}`,
      title: truncate(open.title, 30) || 'Conversation',
      sections,
      onItemSelect: async ({ index }: { index: number }) => {
        const action = this.openActions[index];
        if (!action) return;
        if (action.type === 'reply') this.handlers?.onQuickReply(action.text);
        else if (action.type === 'call') this.handlers?.onStartCall();
        // 'noop' rows (message lines) do nothing.
      },
      onBackButtonPressed: () => {
        // The user popped the detail on the car. Native has already removed it,
        // so drop our bookkeeping for it and let the bridge clear its open id
        // (a plain onCloseConversation would otherwise trigger a second pop).
        const top = this.stack[this.stack.length - 1];
        if (top && top.key === `conv:${open.id}`) this.stack.pop();
        this.handlers?.onCloseConversation();
      },
    });
  }

  private updateDetail(template: any, open: OpenConversation): void {
    const { sections } = this.detailSections(open);
    try {
      template.updateSections(sections);
    } catch (err) {
      console.warn('[carplay] detail updateSections failed', err);
    }
  }

  private buildCall(cp: any, call: CallView): any {
    return new cp.InformationTemplate({
      id: 'huddle-call',
      title: truncate(call.title, 30) || 'On a call',
      items: [{ title: call.detail || 'Connected', detail: '' }],
      actions: [
        { id: 'mute', title: call.muted ? 'Unmute' : 'Mute' },
        { id: 'leave', title: 'Leave call' },
      ],
      onActionButtonPressed: ({ id }: { id: string }) => {
        if (id === 'mute') this.handlers?.onToggleMute();
        else if (id === 'leave') this.handlers?.onLeave();
      },
    });
  }

  private updateCall(template: any, call: CallView): void {
    try {
      template.updateInformationTemplateItems([{ title: call.detail || 'Connected', detail: '' }]);
      template.updateInformationTemplateActions([
        { id: 'mute', title: call.muted ? 'Unmute' : 'Mute' },
        { id: 'leave', title: 'Leave call' },
      ]);
    } catch (err) {
      console.warn('[carplay] call update failed', err);
    }
  }

  private sigOpen(open: OpenConversation): string {
    return `${open.id}|${open.loading}|${open.title}|${open.lines.join('¦')}|${open.quickReplies.join('¦')}`;
  }

  private sigCall(call: CallView): string {
    return `${call.title}|${call.detail}|${call.muted}`;
  }
}

// Module-level singleton — there is exactly one car screen and one mounted
// bridge; a singleton lets connect events that arrive around a React re-render
// resolve against the same desired-state.
export const CarPlayController = new CarPlayControllerImpl();
