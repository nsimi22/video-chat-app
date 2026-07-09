import { Platform } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// CarPlay controller
//
// A thin, imperative wrapper around `react-native-carplay` that the React tree
// drives through <CarPlayBridge> (components/CarPlayBridge.tsx). It owns the two
// templates Huddle shows on the car head-unit:
//
//   • browse — a CPListTemplate of the team's channels + DMs. Selecting a row
//     starts (or joins) that channel's audio call.
//   • call   — a CPInformationTemplate with the active call's name, a live
//     participant count, and Mute / Leave buttons.
//
// CarPlay for a communication app is **audio-only** — Apple forbids video on the
// car screen while driving, so the car surface never touches camera tracks; it
// only browses and drives the existing LiveKit audio call (see CallContext).
//
// Everything here is defensive on purpose:
//   • The native module only exists on iOS and only in a dev-client / release
//     build that bundled `react-native-carplay` (Expo Go can't). We lazy-require
//     it and degrade to a no-op if it's missing, so Android and un-rebuilt iOS
//     JS bundles keep working untouched.
//   • The template classes are typed `any` and every native call is wrapped, so
//     a version skew in react-native-carplay's template API surfaces as a logged
//     warning rather than a red-box that takes down the whole app.
// ─────────────────────────────────────────────────────────────────────────────

export type CarPlayItem = {
  // Stable channel id — handed back to onSelectChannel verbatim.
  id: string;
  // Row title (channel name or DM peer's display name).
  label: string;
  // Secondary line ("# channel", "Direct message", etc.).
  sub?: string;
};

export type CarPlaySection = { header: string; items: CarPlayItem[] };

export type CarPlayHandlers = {
  // A row was tapped on the car screen → start/join that channel's call.
  onSelectChannel: (id: string) => void;
  // The Mute button was pressed on the in-call template.
  onToggleMute: () => void;
  // The Leave button was pressed on the in-call template.
  onLeave: () => void;
};

type BrowseState = { kind: 'browse'; sections: CarPlaySection[] };
type CallState = { kind: 'call'; title: string; detail: string; muted: boolean };
type Desired = BrowseState | CallState;

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
    // Required lazily (never as a static import) so that:
    //   • `tsc` and Metro don't hard-fail when the package isn't installed yet,
    //   • Android bundles never pull in an iOS-only native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('react-native-carplay');
  } catch {
    mod = null;
  }
  return mod;
}

class CarPlayControllerImpl {
  private handlers: CarPlayHandlers | null = null;
  private desired: Desired | null = null;
  private started = false;
  private connected = false;
  // Keeps the flat channel-id order used to build the current list template, so
  // CPListTemplate's flattened onItemSelect index maps back to a channel id.
  private flatIds: string[] = [];
  private unsubscribe: (() => void)[] = [];

  get isSupported(): boolean {
    return !!carplay();
  }

  // Registers the connect/disconnect listeners. Idempotent — safe to call from
  // a React effect that may re-run.
  start(handlers: CarPlayHandlers): void {
    this.handlers = handlers;
    const cp = carplay();
    if (!cp?.CarPlay || this.started) return;
    this.started = true;

    const onConnect = () => {
      this.connected = true;
      this.apply();
    };
    const onDisconnect = () => {
      this.connected = false;
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
      // The car may already be connected when the JS bridge (re)starts — e.g.
      // the app was backgrounded and resumed while docked. Seed from the
      // library's live flag so we don't wait for a connect event that already
      // fired.
      if (cp.CarPlay.connected) {
        this.connected = true;
        this.apply();
      }
    } catch (err) {
      console.warn('[carplay] failed to register scene listeners', err);
    }
  }

  // Only updates the handler refs — cheap, called every render so the templates
  // always invoke the latest closures (fresh activeTeam, startCall, etc.).
  setHandlers(handlers: CarPlayHandlers): void {
    this.handlers = handlers;
  }

  stop(): void {
    for (const fn of this.unsubscribe.splice(0)) fn();
    this.started = false;
    this.connected = false;
  }

  // ── Desired-state setters (called by the bridge) ──────────────────────────
  // These record intent and re-render if the car is connected. The bridge is
  // responsible for only calling them when the content actually changed (it
  // diffs a signature), so we don't rebuild native templates needlessly.

  setBrowse(sections: CarPlaySection[]): void {
    this.desired = { kind: 'browse', sections };
    this.apply();
  }

  setCall(title: string, detail: string, muted: boolean): void {
    this.desired = { kind: 'call', title, detail, muted };
    this.apply();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private apply(): void {
    const cp = carplay();
    if (!cp?.CarPlay || !this.connected || !this.desired) return;
    try {
      const template =
        this.desired.kind === 'browse'
          ? this.buildListTemplate(cp, this.desired.sections)
          : this.buildCallTemplate(cp, this.desired);
      if (template) cp.CarPlay.setRootTemplate(template, true);
    } catch (err) {
      console.warn('[carplay] setRootTemplate failed', err);
    }
  }

  private buildListTemplate(cp: any, sections: CarPlaySection[]): any {
    // Flatten in declaration order so CPListTemplate's global onItemSelect
    // index lines up with flatIds.
    this.flatIds = [];
    const nativeSections = sections.map((s) => ({
      header: s.header,
      items: s.items.map((it) => {
        this.flatIds.push(it.id);
        return { text: it.label, detailText: it.sub };
      }),
    }));

    return new cp.ListTemplate({
      id: 'huddle-root',
      title: 'Huddle',
      sections: nativeSections,
      emptyViewTitleVariants: ['No conversations'],
      emptyViewSubtitleVariants: ['Open Huddle on your phone to get started'],
      onItemSelect: async ({ index }: { index: number }) => {
        const id = this.flatIds[index];
        if (id) this.handlers?.onSelectChannel(id);
      },
    });
  }

  private buildCallTemplate(cp: any, state: CallState): any {
    return new cp.InformationTemplate({
      id: 'huddle-call',
      title: state.title,
      items: [{ title: state.detail || 'Connected', detail: '' }],
      actions: [
        { id: 'mute', title: state.muted ? 'Unmute' : 'Mute' },
        { id: 'leave', title: 'Leave call' },
      ],
      onActionButtonPressed: ({ id }: { id: string }) => {
        if (id === 'mute') this.handlers?.onToggleMute();
        else if (id === 'leave') this.handlers?.onLeave();
      },
    });
  }
}

// Module-level singleton — there is exactly one car screen, and the bridge is
// mounted once. A singleton lets connect events that arrive before/after a
// React re-render still resolve against the same desired-state.
export const CarPlayController = new CarPlayControllerImpl();
