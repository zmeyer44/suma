/**
 * GlanceManager — the Glance preview (Zen's "Glance", Arc's "Peek", PRD §8.1
 * window behavior). A shift-clicked link, or a link opened from a pinned
 * tab, loads in a floating WebContentsView centered over the current page
 * instead of becoming a tab.
 *
 * Split ownership, same contract as the content hole: the CHROME renders the
 * frame around the page (GlanceOverlay.tsx — the veil, the title bar, the
 * dismiss/promote controls) and reports the frame's content hole via
 * `glance:bounds`; MAIN owns the page view itself, placed exactly inside
 * that hole and layered above the raised chrome (shell-window.ts). The view
 * runs in the opener's SPACE SESSION, fully sandboxed, no preload — the same
 * trust shape as a tab, because it shows the same kind of content.
 *
 * Promotion keeps the live page: `promote()` hands the view itself to
 * TabManager (create({ adoptView })), so scroll position, form state, and
 * session history survive the jump from preview to tab — the detail that
 * makes Glance feel native in Arc and Zen rather than a reload with extra
 * steps.
 */

import { randomUUID } from "node:crypto";
import { WebContentsView } from "electron";
import type { ContentBounds, GlanceInfo } from "../shared/ipc";
import type { PopupManager, PopupOpenerContext } from "./popups";
import type { ShellWindow } from "./shell-window";
import type { SpaceManager } from "./spaces";
import { isAllowedTabUrl } from "./tab-policy";
import { PopupRateLimiter } from "./tabs";

/** Corner radius of the page view — matches the frame's rounded-xl (12px),
 *  so the page's bottom corners tuck into the card instead of poking out. */
const GLANCE_RADIUS = 12;

/** What promotion needs from the tab layer (wired late — TabManager is
 *  constructed after this manager, and it calls back the other way). */
export type GlanceTabOpener = (args: {
  spaceId: string;
  url: string;
  adoptView?: WebContentsView;
  faviconUrl?: string;
}) => void;

interface GlanceRecord {
  /** Popup-limiter/popup-owner source id — glances are not tabs, but auth
   *  popups they open still need an owner to close with. */
  id: string;
  spaceId: string;
  view: WebContentsView;
  faviconUrl: string | null;
}

export class GlanceManager {
  private current: GlanceRecord | null = null;
  private tabOpener: GlanceTabOpener | null = null;
  /** Window-opens FROM the glance page get their own budget — the opener
   *  tab's limiter cannot see them, and a preview must not be a loophole. */
  private readonly limiter = new PopupRateLimiter(() => Date.now());

  constructor(
    private readonly shell: ShellWindow,
    private readonly spaces: SpaceManager,
    private readonly popups: PopupManager,
    private readonly onChanged: (state: GlanceInfo | null) => void,
    private readonly onDenied: (reason: string) => void = () => undefined,
  ) {}

  /** Wired at bootstrap; promotion before it is set just closes the glance. */
  setTabOpener(opener: GlanceTabOpener): void {
    this.tabOpener = opener;
  }

  /** Whether a glance is showing (chrome-raise/teardown bookkeeping). */
  get isOpen(): boolean {
    return this.current !== null;
  }

  /**
   * Open `url` as a glance over the active page. A glance already showing in
   * the same space navigates in place (a second shift+click retargets the
   * preview, it does not stack previews); one from another space is torn
   * down first — its session is the wrong cookie jar.
   */
  open(spaceId: string, url: string): void {
    // The policy layer already classified this, but the guard is re-checked
    // where the load actually happens, same as tabs do.
    if (!isAllowedTabUrl(url) || url === "about:blank") return;
    const existing = this.current;
    if (existing !== null && existing.spaceId === spaceId) {
      if (!existing.view.webContents.isDestroyed()) {
        void existing.view.webContents.loadURL(url).catch(() => undefined);
        this.emitState();
        return;
      }
      this.close();
    } else if (existing !== null) {
      this.close();
    }

    const view = new WebContentsView({
      webPreferences: {
        session: this.spaces.sessionFor(spaceId),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    view.setBorderRadius(GLANCE_RADIUS);
    const record: GlanceRecord = {
      id: `glance-${randomUUID()}`,
      spaceId,
      view,
      faviconUrl: null,
    };
    this.current = record;
    this.wireEvents(record);
    // Registered hidden; the first `glance:bounds` report (the chrome frame
    // finishing its entrance) is what actually shows it.
    this.shell.setGlanceView(view);
    void view.webContents.loadURL(url).catch(() => undefined);
    this.emitState();
  }

  /** The chrome frame's content hole (`glance:bounds`) — place the page. */
  setBounds(bounds: ContentBounds): void {
    if (this.current === null) return;
    this.shell.setGlanceBounds(bounds);
  }

  /** Dismiss the preview and drop its page. */
  close(): void {
    const record = this.current;
    if (record === null) return;
    this.current = null;
    this.shell.setGlanceView(null);
    // An auth popup opened from the preview must not outlive it.
    this.popups.closeForTab(record.id);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.limiter.forget(record.id);
    this.onChanged(null);
    // Focus may have been inside the page that just vanished.
    this.shell.focusChrome();
  }

  /**
   * Open the glanced page as a real tab and dismiss the preview. The LIVE
   * view is adopted by TabManager, so the page carries its scroll, form
   * state, and history into the tab; the glance listeners stay attached but
   * go inert (every one of them checks it still owns the view).
   */
  promote(): void {
    const record = this.current;
    if (record === null) return;
    const wc = record.view.webContents;
    const url = wc.isDestroyed() ? "" : wc.getURL();
    const opener = this.tabOpener;
    if (url === "" || !isAllowedTabUrl(url) || opener === null) {
      this.close();
      return;
    }
    this.current = null;
    this.shell.setGlanceView(null);
    // A tab's corners are square — the pane fills the content hole.
    record.view.setBorderRadius(0);
    opener({
      spaceId: record.spaceId,
      url,
      adoptView: record.view,
      ...(record.faviconUrl !== null ? { faviconUrl: record.faviconUrl } : {}),
    });
    this.limiter.forget(record.id);
    this.onChanged(null);
  }

  goBack(): void {
    const wc = this.current?.view.webContents;
    if (wc !== undefined && !wc.isDestroyed()) wc.navigationHistory.goBack();
  }

  goForward(): void {
    const wc = this.current?.view.webContents;
    if (wc !== undefined && !wc.isDestroyed()) wc.navigationHistory.goForward();
  }

  /* ------------------------------ internals ------------------------------ */

  private emitState(): void {
    const record = this.current;
    if (record === null) {
      this.onChanged(null);
      return;
    }
    const wc = record.view.webContents;
    if (wc.isDestroyed()) {
      this.onChanged(null);
      return;
    }
    this.onChanged({
      url: wc.getURL(),
      title: wc.getTitle(),
      faviconUrl: record.faviconUrl,
      isLoading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  /** Window-open context for pages inside the glance: auth ceremonies still
   *  pop up (they need the live opener), ordinary new pages become real
   *  tabs, and a nested glance gesture just navigates the preview itself. */
  private popupCtx(record: GlanceRecord): PopupOpenerContext {
    return {
      tabId: record.id,
      spaceId: record.spaceId,
      session: this.spaces.sessionFor(record.spaceId),
      pinned: false,
      allowAnotherWindow: () => this.limiter.tryOpen(record.id),
      openTab: (url: string) => {
        this.tabOpener?.({ spaceId: record.spaceId, url });
      },
      openGlance: (url: string) => {
        if (this.current !== record) return;
        if (!isAllowedTabUrl(url)) return;
        if (!record.view.webContents.isDestroyed()) {
          void record.view.webContents.loadURL(url).catch(() => undefined);
        }
      },
      onDenied: this.onDenied,
    };
  }

  /**
   * Observers for the preview's WebContents. Every handler is gated on the
   * record still being current: promotion hands this exact WebContents to
   * TabManager (which wires its own copies of these), and removing listeners
   * wholesale would also strip app-level ones (the double-Shift observer
   * attaches to every webContents at creation). Inert-when-disowned is the
   * safe teardown.
   */
  private wireEvents(record: GlanceRecord): void {
    const wc = record.view.webContents;
    const live = (): boolean => this.current === record && !wc.isDestroyed();
    const push = (): void => {
      if (live()) this.emitState();
    };

    wc.on("page-title-updated", push);
    wc.on("page-favicon-updated", (_event, favicons) => {
      if (!live()) return;
      record.faviconUrl = favicons[0] ?? null;
      push();
    });
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);

    // Same navigation policy as a tab: site content never leaves http/https.
    wc.on("will-navigate", (event, url) => {
      if (live() && !isAllowedTabUrl(url)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (live() && !isAllowedTabUrl(url)) event.preventDefault();
    });

    // Esc dismisses and Cmd+Enter promotes even while focus is INSIDE the
    // page — the chrome's own key handlers cannot see keystrokes there.
    wc.on("before-input-event", (event, input) => {
      if (!live()) return;
      if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
      if (input.key === "Escape") {
        event.preventDefault();
        this.close();
      } else if (input.key === "Enter" && input.meta) {
        event.preventDefault();
        this.promote();
      }
    });

    wc.setWindowOpenHandler((details) => {
      if (!live()) return { action: "deny" };
      return this.popups.handleWindowOpen(details, this.popupCtx(record));
    });
    wc.on("did-create-window", (window) => {
      if (live()) this.popups.adopt(window, this.popupCtx(record));
    });

    // A crashed preview is not worth a recovery flow — it just goes away.
    wc.on("render-process-gone", () => {
      if (live()) this.close();
    });
  }
}
