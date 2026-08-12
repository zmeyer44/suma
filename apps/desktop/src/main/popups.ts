/**
 * PopupManager — real popup windows for authentication ceremonies
 * (PRD §8.1 "pop-up/window behavior").
 *
 * Suma previously answered every `window.open` with `{ action: "deny" }`
 * and opened a tab instead. That silently breaks OAuth: the page receives a
 * `null` handle where it expected a window, so it cannot `postMessage` the
 * authorization code back, cannot poll `popup.closed`, and cannot read the
 * redirected location. Mainstream client libraries report this as "popup
 * blocked" or hang forever.
 *
 * Auth popups are therefore created for real, with Chromium's native opener
 * relationship intact, in the **opener's own space session** so the cookies
 * the ceremony sets land in the jar the tab actually reads (§8.8: the space
 * is the cookie-jar boundary — a popup in the wrong session logs you into
 * nothing).
 *
 * The popup is a small window parented to the shell, and its title tracks the
 * live origin: a user consenting to an identity provider must be able to see
 * which origin is asking. Popups close with their opener (`outlivesOpener`
 * stays false), so no orphan auth window can linger.
 */

import {
  BrowserWindow,
  type HandlerDetails,
  type Session,
  type WebContents,
} from "electron";
import type { ShellWindow } from "./shell-window";
import {
  classifyWindowOpen,
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
} from "./popup-policy";
import { isAllowedTabUrl } from "./tab-policy";

/** What the tab layer must supply for each window-open request. */
export interface PopupOpenerContext {
  tabId: string;
  spaceId: string;
  /** The opener's space session — the popup must share it. */
  session: Session;
  /** The opener is a pinned tab — its links preview in a glance (policy). */
  pinned: boolean;
  /** Rate-limit gate; false ⇒ the source tab is spawning too many windows. */
  allowAnotherWindow: () => boolean;
  /** Open a normal tab in the opener's space (non-auth `window.open`). */
  openTab: (url: string) => void;
  /** Open a glance preview over the opener (shift+click, pinned-tab links). */
  openGlance: (url: string) => void;
  /** Surfaced to the user when a window request is refused. */
  onDenied: (reason: string) => void;
}

type WindowOpenResponse =
  | { action: "deny" }
  | {
      action: "allow";
      outlivesOpener?: boolean;
      overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions;
    };

interface PopupRecord {
  window: BrowserWindow;
  spaceId: string;
  openerTabId: string;
}

export class PopupManager {
  private readonly popups = new Set<PopupRecord>();

  constructor(private readonly shell: ShellWindow) {}

  /**
   * Implements `webContents.setWindowOpenHandler`. Auth ceremonies are
   * allowed as real popups; ordinary new pages become tabs; everything else
   * is denied.
   */
  handleWindowOpen(
    details: HandlerDetails,
    ctx: PopupOpenerContext,
  ): WindowOpenResponse {
    const decision = classifyWindowOpen(
      {
        url: details.url,
        disposition: details.disposition,
        features: details.features,
        openerPinned: ctx.pinned,
      },
      isAllowedTabUrl,
    );

    if (decision.disposition === "deny") {
      ctx.onDenied(decision.reason);
      return { action: "deny" };
    }

    // Real popups, substituted tabs, and glances all consume the popup
    // budget, so a page cannot evade the limiter by choosing one shape over
    // another.
    if (!ctx.allowAnotherWindow()) {
      ctx.onDenied("too many windows opened by this page");
      return { action: "deny" };
    }

    if (decision.disposition === "tab") {
      ctx.openTab(details.url);
      return { action: "deny" };
    }

    if (decision.disposition === "glance") {
      ctx.openGlance(details.url);
      return { action: "deny" };
    }

    const size = decision.size ?? {
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT,
    };
    return {
      action: "allow",
      // Default, restated for clarity: an auth popup must never outlive the
      // page waiting on its result.
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        width: size.width,
        height: size.height,
        parent: this.shell.window,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: "#0f1115",
        title: originLabel(details.url),
        webPreferences: {
          // Same jar as the opener — the whole point of the fix.
          session: ctx.session,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      },
    };
  }

  /**
   * Called from the opener's `did-create-window`. Chromium has built the
   * window; here we constrain navigation, keep the title honest, and track
   * it for teardown. Only popups reach this path — every other disposition
   * is answered with `deny`.
   */
  adopt(window: BrowserWindow, ctx: PopupOpenerContext): void {
    const record: PopupRecord = {
      window,
      spaceId: ctx.spaceId,
      openerTabId: ctx.tabId,
    };
    this.popups.add(record);

    const wc = window.webContents;

    // Site content in a popup gets the same navigation policy as a tab: no
    // suma://, file://, or chrome:// (§8.1 privileged-UI isolation).
    wc.on("will-navigate", (event, url) => {
      if (!isAllowedTabUrl(url)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (!isAllowedTabUrl(url)) event.preventDefault();
    });

    // OAuth libraries can use an intermediate popup which then opens the
    // provider window (Google Identity Services does this in some flows).
    // Run nested opens through the same policy and adopt each allowed child:
    // substituting a tab here returns `null` and strands the intermediate on
    // its "One moment please..." screen.
    wc.setWindowOpenHandler((details) => this.handleWindowOpen(details, ctx));
    wc.on("did-create-window", (child) => this.adopt(child, ctx));

    // The origin is the anti-phishing signal in an auth ceremony — keep it
    // visible and current, and never let the page forge it.
    const applyTitle = (): void => {
      if (!window.isDestroyed() && !wc.isDestroyed())
        window.setTitle(originLabel(wc.getURL()));
    };
    wc.on("did-navigate", applyTitle);
    wc.on("did-navigate-in-page", applyTitle);
    wc.on("page-title-updated", (event) => {
      // Suppress the page-supplied title; the origin stays authoritative.
      event.preventDefault();
      applyTitle();
    });

    window.once("closed", () => this.popups.delete(record));
    window.center();
    applyTitle();
  }

  /** Close popups opened by a tab that is going away. */
  closeForTab(tabId: string): void {
    for (const record of [...this.popups]) {
      if (record.openerTabId !== tabId) continue;
      this.popups.delete(record);
      if (!record.window.isDestroyed()) record.window.close();
    }
  }

  /** Close every popup in a space (space removed, or app shutting down). */
  closeForSpace(spaceId: string): void {
    for (const record of [...this.popups]) {
      if (record.spaceId !== spaceId) continue;
      this.popups.delete(record);
      if (!record.window.isDestroyed()) record.window.close();
    }
  }

  closeAll(): void {
    for (const record of [...this.popups]) {
      this.popups.delete(record);
      if (!record.window.isDestroyed()) record.window.close();
    }
  }

  /** True while any auth popup is open — the WebAuthn layer focuses these. */
  get openCount(): number {
    return this.popups.size;
  }

  /** Is this WebContents an open popup belonging to the space? (permission attribution) */
  isPopupInSpace(webContentsId: number, spaceId: string): boolean {
    for (const record of this.popups) {
      if (record.spaceId !== spaceId || record.window.isDestroyed()) continue;
      if (record.window.webContents.id === webContentsId) return true;
    }
    return false;
  }

  /** The frontmost popup's WebContents, if any (used to focus a ceremony). */
  focusTopmost(): WebContents | null {
    let last: PopupRecord | null = null;
    for (const record of this.popups) {
      if (!record.window.isDestroyed()) last = record;
    }
    if (last === null) return null;
    last.window.focus();
    return last.window.webContents;
  }
}

/** "accounts.google.com" — origin host, or a neutral label if unparseable. */
function originLabel(url: string): string {
  try {
    return new URL(url).host || "Sign in";
  } catch {
    return "Sign in";
  }
}
