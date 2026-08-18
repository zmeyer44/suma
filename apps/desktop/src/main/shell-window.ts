/**
 * ShellWindow — one BaseWindow hosting the chrome renderer in a full-window
 * WebContentsView, with tab WebContentsViews attached ABOVE it and
 * positioned from renderer-reported `ui:setContentBounds` (PRD §8.1).
 * Each attached view occupies a pane region of the content hole — the whole
 * hole, or a share of it in split view (§6, shared/pane-layout.ts). The
 * renderer owns the split ratio (it renders the draggable divider) and
 * streams it here via `ui:setSplitRatio`; both sides resolve geometry with
 * the same shared engine, so the views and the divider never disagree.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseWindow,
  nativeTheme,
  screen,
  WebContentsView,
  type WebContents,
} from "electron";
import type { ContentBounds } from "../shared/ipc";
import {
  DEFAULT_SPLIT_RATIO,
  paneBoundsFor,
  type PaneRegion,
} from "../shared/pane-layout";
import type { SelectionRect } from "../shared/selection";
import { selectionToolbarBounds } from "./selection-core";
import {
  clampPipBounds,
  defaultPipBounds,
  PIP_MIN_WIDTH,
  pipHeightFor,
} from "./videos/videos-core";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The window's own fill, shown before the chrome paints and in the sliver a
 * resize opens up ahead of the renderer. One per scheme, each matching the
 * corresponding default palette's --color-chrome (lib/theme.ts), so neither a
 * dark nor a light default ever flashes the other one.
 */
const BACKGROUND_COLOR = "#232627";
const LIGHT_BACKGROUND_COLOR = "#fafaf8";

function backgroundFor(dark: boolean): string {
  return dark ? BACKGROUND_COLOR : LIGHT_BACKGROUND_COLOR;
}

/**
 * The macOS material behind a translucent chrome. "sidebar" is the same
 * blur AppKit gives a source-list column (Finder, Mail, Codex) — desaturated
 * and tinted by the wallpaper rather than a plain frosted white.
 */
const VIBRANCY_MATERIAL = "sidebar" as const;

/**
 * Height of the tab strip (TabStrip.tsx), used only to guess the content hole
 * before the renderer has measured and reported its own. The renderer's report
 * is the source of truth the moment it arrives.
 */
const STRIP_H = 40;

/**
 * The floating overlay (OverlayStack.tsx): a transparent WebContentsView
 * layered ABOVE the tab views inside the shell window, sized to exactly what
 * it shows — the floating audio player (AudioPlayer.tsx) stacked above the
 * save-preview cards (SavePreviewOverlay.tsx).
 *
 * Why not in the chrome: it renders BELOW the tab views, so a card there is
 * invisible over a page, and raising the whole chrome steals every click.
 * Why a view rather than the separate window this used to be: the window
 * tracked shell drags one move-event behind (a visible lag) and needed
 * hand-rolled z-order against other apps' windows; a view moves atomically
 * with the window and can never escape it. The trade is the frosted blur —
 * vibrancy is a window-level feature, and a view's backdrop-filter cannot
 * sample a sibling view's pixels — so the panel is a translucent TINT here
 * (.overlay-glass), not real frost.
 *
 * Views cannot be non-focusable, so a click on the panel focuses its
 * webContents; the constructor bounces that focus straight back to the
 * chrome so keyboard shortcuts keep working (parity with the old
 * `focusable: false` window, where clicks never moved focus at all).
 */
export const SAVE_PREVIEW_WIDTH = 352;
/** Gap from the content hole's top and right edges. */
export const SAVE_PREVIEW_MARGIN = 10;

/** Where the preview view sits for a given content hole and content size —
 *  pure, for the layering tests. Null ⇒ nothing to show ⇒ hide the view.
 *  The width defaults to the classic full card width; the overlay reports a
 *  narrower one while only the collapsed audio pill is showing, because the
 *  window swallows clicks over its whole rect and a full-width window around
 *  a 100px pill would deaden the page under the rest of it. Always anchored
 *  to the hole's top-RIGHT, so a narrower window hugs the corner. */
export function savePreviewBounds(
  hole: ContentBounds,
  stackHeight: number,
  stackWidth: number = SAVE_PREVIEW_WIDTH,
): ContentBounds | null {
  if (stackHeight <= 0 || stackWidth <= 0) return null;
  const width = Math.min(stackWidth, hole.width);
  return {
    x: Math.max(hole.x, hole.x + hole.width - width - SAVE_PREVIEW_MARGIN),
    y: hole.y + SAVE_PREVIEW_MARGIN,
    width,
    height: Math.min(
      stackHeight,
      Math.max(hole.height - SAVE_PREVIEW_MARGIN * 2, 0),
    ),
  };
}

export class ShellWindow {
  readonly window: BaseWindow;
  private readonly chromeView: WebContentsView;
  private readonly tabViews = new Map<WebContentsView, PaneRegion>();
  private lastContentBounds: ContentBounds | null = null;
  private splitRatio = DEFAULT_SPLIT_RATIO;
  /**
   * Views TabManager wants on screen (attachTabView adds, hideTabView
   * removes). Actual visibility is this intent AND the layout resolving the
   * view's pane — a collapsed pane hides its view until widening brings it
   * back, without ever re-showing a view whose tab is a background one.
   */
  private readonly wantsVisible = new Set<WebContentsView>();
  /**
   * Whether a chrome modal is open. Held rather than acted on once: attaching
   * a tab view re-tops it, so any re-attach while a modal is up (a sync push
   * running syncVisibility, a space switch) would bury the modal under the
   * page — leaving its backdrop dimming the chrome around a hole that shows
   * live site content. Every attach re-raises the chrome while this is set.
   */
  private overlayActive = false;
  /** The floating overlay panel (see the block comment above). */
  private readonly savePreviewView: WebContentsView;
  /**
   * The selection toolbar — a second transparent view on the same model as
   * the preview panel, but positioned AT the page selection rather than
   * anchored to a corner (tabs.ts drives it from the in-page watcher; the
   * geometry is selection-core.ts). Sized to exactly the fixed toolbar box,
   * because it too swallows clicks over its whole rect.
   */
  private readonly selectionToolbarView: WebContentsView;
  /** Last size the overlay reported; height 0 ⇒ hidden. Held so resizes and
   *  content-bounds changes can re-place the view without a round trip. */
  private savePreviewHeight = 0;
  private savePreviewWidth = SAVE_PREVIEW_WIDTH;
  /**
   * The floating video player (VideoPip.tsx) — a fourth transparent view on
   * the overlay model, but FREELY POSITIONED: main owns its bounds outright
   * (no self-measuring contract), and drags/resizes are cursor-polled here so
   * the pointer can never outrun the view it is moving (a renderer-reported
   * drag dies the moment the cursor leaves the view's own rect).
   */
  private readonly videoPipView: WebContentsView;
  /**
   * The glance preview's page view (main/glance.ts owns its lifecycle; the
   * shell only hosts it). Layered ABOVE the raised chrome — the chrome draws
   * the frame and veil around it — and below the floating panel, which must
   * stay reachable over everything. Registered hidden; the chrome reporting
   * its frame's content hole (`setGlanceBounds`) is what shows it.
   */
  private glanceView: WebContentsView | null = null;
  /** Where the player sits; survives hide/show. Null ⇒ never placed. */
  private pipBounds: ContentBounds | null = null;
  private pipVisible = false;
  /** The cursor-follow timer for an active drag/resize, with the grab data. */
  private pipPointerTimer: NodeJS.Timeout | null = null;
  /** Which fill the window carries. Held because translucency clears it and
   *  a scheme change must not repaint over a vibrancy layer. */
  private darkBackground = nativeTheme.shouldUseDarkColors;
  private translucent = false;

  constructor() {
    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: "Suma",
      titleBarStyle: "hiddenInset",
      // Center the traffic lights in the 40px tab strip (TabStrip.tsx) — the
      // same offset Chrome uses, since the strip is now the same height.
      trafficLightPosition: { x: 14, y: 14 },
      // The window exists before the renderer has read its theme, so it opens
      // on whatever this Mac asks for — the same thing lib/theme.ts will pick.
      backgroundColor: backgroundFor(this.darkBackground),
    });
    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: path.join(dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        // The preload bundle is ESM (package "type": "module" — electron-vite
        // emits index.mjs) and Electron cannot load ESM preloads in a
        // sandboxed renderer. The chrome view therefore runs unsandboxed with
        // context isolation; it only ever loads Suma's own bundled UI. Tab
        // views — which run site content — are fully sandboxed (tabs.ts).
        sandbox: false,
      },
    });
    // The chrome page paints transparent outside its own surfaces (styles.css),
    // but the *view* underneath it defaults to opaque — invisible while tab
    // views sit on top, and a full-window blank the moment raiseChrome() puts
    // it in front of them. Transparent here is what lets the raised chrome
    // overhang the content hole while the tab view still shows through.
    this.chromeView.setBackgroundColor("#00000000");
    this.window.contentView.addChildView(this.chromeView);
    // Same bundle, same preload, second entry: main.tsx renders only the
    // preview stack when the URL carries #save-preview. Added hidden so it
    // loads eagerly and the first card never waits on a page load; a child
    // of the shell's contentView, so it moves with the window in the same
    // compositor frame — no drag lag, no cross-window z-order to manage.
    this.savePreviewView = new WebContentsView({
      webPreferences: {
        preload: path.join(dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // Transparent outside the panel's own pixels: the corner notches around
    // the panel's CSS radius show the page beneath, not a fill.
    this.savePreviewView.setBackgroundColor("#00000000");
    this.savePreviewView.setVisible(false);
    this.window.contentView.addChildView(this.savePreviewView);
    // Views cannot opt out of focus the way the old window could
    // (`focusable: false`), and a focused overlay would eat every keyboard
    // shortcut the chrome handles. Clicks still land (input routing is by
    // hit test, not focus) — only the keyboard is bounced back.
    this.savePreviewView.webContents.on("focus", () => this.focusChrome());
    // Third sibling, same story as the preview view: transparent outside its
    // own pixels, hidden until a selection settles, keyboard bounced back.
    this.selectionToolbarView = new WebContentsView({
      webPreferences: {
        preload: path.join(dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.selectionToolbarView.setBackgroundColor("#00000000");
    this.selectionToolbarView.setVisible(false);
    this.window.contentView.addChildView(this.selectionToolbarView);
    this.selectionToolbarView.webContents.on("focus", () => this.focusChrome());
    // Fourth sibling: the floating video player. Transparent outside its own
    // rounded corners, hidden until a video plays, keyboard bounced back like
    // the other overlay views (clicks land; shortcuts stay with the chrome).
    this.videoPipView = new WebContentsView({
      webPreferences: {
        preload: path.join(dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.videoPipView.setBackgroundColor("#00000000");
    this.videoPipView.setVisible(false);
    this.window.contentView.addChildView(this.videoPipView);
    this.videoPipView.webContents.on("focus", () => this.focusChrome());
    this.fitChrome();
    this.window.on("resize", () => {
      this.fitChrome();
      // Reapply the last renderer-reported absolute bounds immediately; the
      // renderer re-measures and re-reports a frame later (avoids flicker).
      this.applyTabBounds();
      this.applySavePreviewBounds();
      // A shrinking window must not strand the player off screen.
      this.applyVideoPipBounds();
      // The selection rect the toolbar was placed on is stale now.
      this.hideSelectionToolbar();
    });
    void this.loadRenderer();
    void this.loadSavePreview();
    void this.loadSelectionToolbar();
    void this.loadVideoPip();
  }

  get chromeWebContents(): WebContents {
    return this.chromeView.webContents;
  }

  get savePreviewWebContents(): WebContents {
    return this.savePreviewView.webContents;
  }

  /** Whether this sender is the preview overlay — its slice of the IPC trust
   *  (registerIpc lets it call only the savePreview:* channels). */
  ownsSavePreview(webContentsId: number): boolean {
    return (
      !this.savePreviewView.webContents.isDestroyed() &&
      this.savePreviewView.webContents.id === webContentsId
    );
  }

  /** Whether this sender is the selection toolbar — trusted for exactly the
   *  selectionToolbar:* channels, nothing else. */
  ownsSelectionToolbar(webContentsId: number): boolean {
    return (
      !this.selectionToolbarView.webContents.isDestroyed() &&
      this.selectionToolbarView.webContents.id === webContentsId
    );
  }

  get videoPipWebContents(): WebContents {
    return this.videoPipView.webContents;
  }

  /** Whether this sender is the PIP player — trusted for the videoPip:*
   *  channels only (main/ipc.ts handleVideoPip). */
  ownsVideoPip(webContentsId: number): boolean {
    return (
      !this.videoPipView.webContents.isDestroyed() &&
      this.videoPipView.webContents.id === webContentsId
    );
  }

  /** Attach (or re-top / re-region) a tab view above the chrome view and
   *  show it — unless its pane is collapsed, in which case it shows the
   *  moment the layout resolves it again. */
  attachTabView(view: WebContentsView, region: PaneRegion = "full"): void {
    this.window.contentView.addChildView(view);
    this.tabViews.set(view, region);
    this.wantsVisible.add(view);
    this.applyBoundsTo(view, region);
    // Adding put this view on top of the chrome; an open modal has to go back
    // above it, in the same tick, before anything composites.
    if (this.overlayActive) this.raiseChrome();
    // …and the floating panel goes back above EVERYTHING, same tick: it is
    // the one surface that must stay reachable whatever is on screen.
    this.stackSavePreview();
  }

  /** Take an attached view off screen (background tab / space switch). */
  hideTabView(view: WebContentsView): void {
    this.wantsVisible.delete(view);
    view.setVisible(false);
  }

  detachTabView(view: WebContentsView): void {
    if (!this.tabViews.has(view)) return;
    this.window.contentView.removeChildView(view);
    this.tabViews.delete(view);
    this.wantsVisible.delete(view);
  }

  /** Renderer-reported content hole (`ui:setContentBounds`); persisted for resizes. */
  setContentBounds(bounds: ContentBounds): void {
    this.lastContentBounds = { ...bounds };
    this.applyTabBounds();
    // The preview anchors to the hole's top-right, so a sidebar opening (or a
    // banner appearing) moves it along with the page.
    this.applySavePreviewBounds();
    // The player is confined to the hole; a sidebar opening nudges it back in.
    this.applyVideoPipBounds();
    // The page just moved under the toolbar; its anchor rect is stale.
    this.hideSelectionToolbar();
  }

  /**
   * Place the selection toolbar over `view`'s pane, anchored to the
   * selection rect (viewport coordinates of that view). False ⇒ the view is
   * not on screen or the rect resolves nowhere sensible — the toolbar stays
   * (or goes) hidden, and the caller should drop its cached selection.
   */
  showSelectionToolbarFor(view: WebContentsView, rect: SelectionRect): boolean {
    const region = this.tabViews.get(view);
    if (
      region === undefined ||
      !this.wantsVisible.has(view) ||
      this.lastContentBounds === null
    ) {
      this.hideSelectionToolbar();
      return false;
    }
    const pane = paneBoundsFor(this.lastContentBounds, region, this.splitRatio);
    const bounds = pane === null ? null : selectionToolbarBounds(pane, rect);
    if (bounds === null) {
      this.hideSelectionToolbar();
      return false;
    }
    this.selectionToolbarView.setBounds(bounds);
    this.selectionToolbarView.setVisible(true);
    this.stackSavePreview();
    return true;
  }

  hideSelectionToolbar(): void {
    this.selectionToolbarView.setVisible(false);
  }

  /* ---------------------------- glance preview ---------------------------- */

  /**
   * Register (or, with null, unhost) the glance page view. Added hidden and
   * ABOVE everything current — the chrome is already raised when a glance
   * opens (its frame is a chrome modal), and the page must cover the frame's
   * content hole, not sit under it.
   */
  setGlanceView(view: WebContentsView | null): void {
    if (this.glanceView !== null && this.glanceView !== view) {
      this.window.contentView.removeChildView(this.glanceView);
    }
    this.glanceView = view;
    if (view === null) return;
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.stackSavePreview();
  }

  /**
   * The chrome frame's measured content hole (`glance:bounds`) — window
   * coordinates, same contract as `setContentBounds`. The first report is
   * what actually shows the view (the frame's entrance animation finishes
   * before it measures, so the page never flashes at a mid-animation size).
   */
  setGlanceBounds(bounds: ContentBounds): void {
    const view = this.glanceView;
    if (view === null) return;
    view.setBounds(bounds);
    if (!view.getVisible()) {
      view.setVisible(true);
      // Whatever raised or attached since registration, the page goes back
      // above the chrome frame around it.
      this.window.contentView.addChildView(view);
      this.stackSavePreview();
    }
  }

  /**
   * The overlay's measured content size (`savePreview:bounds`). Sizing the
   * view to exactly the content is the input story: the view swallows clicks
   * over its whole rect, so slack would deaden a corner of the page. Height
   * 0 ⇒ nothing to show ⇒ the view leaves the screen entirely; a missing
   * width means the classic full card width.
   */
  setSavePreviewSize(height: number, width?: number): void {
    this.savePreviewHeight = Math.max(0, Math.round(height));
    this.savePreviewWidth =
      width === undefined ? SAVE_PREVIEW_WIDTH : Math.max(0, Math.round(width));
    this.applySavePreviewBounds();
  }

  private applySavePreviewBounds(): void {
    let hole = this.lastContentBounds;
    if (hole === null) {
      // Before the renderer's first report: below where the strip will be.
      const { width, height } = this.window.getContentBounds();
      hole = { x: 0, y: STRIP_H, width, height: Math.max(height - STRIP_H, 0) };
    }
    const bounds = savePreviewBounds(
      hole,
      this.savePreviewHeight,
      this.savePreviewWidth,
    );
    if (bounds === null) {
      this.savePreviewView.setVisible(false);
      return;
    }
    // View bounds are window-content coordinates — exactly what the hole is
    // in. No screen offset, and moving the window moves the view with it.
    this.savePreviewView.setBounds(bounds);
    if (!this.savePreviewView.getVisible()) {
      this.savePreviewView.setVisible(true);
      this.stackSavePreview();
    }
  }

  /** Re-top the overlay views above whatever was just added to the stack —
   *  tab attaches and modal raises both land above them otherwise. The
   *  selection toolbar rides along only while it is showing (its hidden
   *  order does not matter, and re-adding it here unconditionally would
   *  churn the child list on every attach). The video player sits below the
   *  transient surfaces: a save card or toolbar must never be lost behind a
   *  long-running video. */
  private stackSavePreview(): void {
    if (this.pipVisible) {
      this.window.contentView.addChildView(this.videoPipView);
    }
    if (this.selectionToolbarView.getVisible()) {
      this.window.contentView.addChildView(this.selectionToolbarView);
    }
    this.window.contentView.addChildView(this.savePreviewView);
  }

  /* ------------------------- floating video player ------------------------- */

  /** The hole the player is confined to (pre-first-report fallback matches
   *  applySavePreviewBounds). */
  private pipHole(): ContentBounds {
    if (this.lastContentBounds !== null) return this.lastContentBounds;
    const { width, height } = this.window.getContentBounds();
    return { x: 0, y: STRIP_H, width, height: Math.max(height - STRIP_H, 0) };
  }

  /** Show the player (placing it bottom-right on first use) and top it. */
  showVideoPip(): void {
    const hole = this.pipHole();
    this.pipBounds =
      this.pipBounds === null
        ? defaultPipBounds(hole)
        : clampPipBounds(this.pipBounds, hole);
    this.videoPipView.setBounds(this.pipBounds);
    this.pipVisible = true;
    this.videoPipView.setVisible(true);
    this.stackSavePreview();
  }

  hideVideoPip(): void {
    this.pipVisible = false;
    this.endVideoPipPointer();
    this.videoPipView.setVisible(false);
  }

  /**
   * Follow the cursor at ~60fps for a drag (grabOffset = pointer position
   * inside the view) or a resize (bottom-right corner tracks the cursor,
   * aspect-locked). Polled HERE rather than streamed from the renderer: the
   * renderer only sees pointer events over its own rect, so any lag between
   * "pointer moved" and "view moved" would drop the drag mid-gesture. The
   * renderer just says when the gesture starts and ends.
   */
  beginVideoPipDrag(grabOffset: { x: number; y: number }): void {
    if (!this.pipVisible) return;
    this.startVideoPipPointer((cursor) => {
      const hole = this.pipHole();
      const current = this.pipBounds ?? defaultPipBounds(hole);
      this.pipBounds = clampPipBounds(
        {
          x: cursor.x - grabOffset.x,
          y: cursor.y - grabOffset.y,
          width: current.width,
          height: current.height,
        },
        hole,
      );
      this.videoPipView.setBounds(this.pipBounds);
    });
  }

  beginVideoPipResize(): void {
    if (!this.pipVisible) return;
    this.startVideoPipPointer((cursor) => {
      const hole = this.pipHole();
      const current = this.pipBounds ?? defaultPipBounds(hole);
      const width = Math.max(PIP_MIN_WIDTH, cursor.x - current.x);
      const height = pipHeightFor(width);
      this.pipBounds = clampPipBounds(
        { x: current.x, y: current.y, width, height: Math.round(height) },
        hole,
      );
      this.videoPipView.setBounds(this.pipBounds);
    });
  }

  endVideoPipPointer(): void {
    if (this.pipPointerTimer === null) return;
    clearInterval(this.pipPointerTimer);
    this.pipPointerTimer = null;
  }

  private startVideoPipPointer(
    apply: (cursor: { x: number; y: number }) => void,
  ): void {
    this.endVideoPipPointer();
    const tick = (): void => {
      if (!this.pipVisible) {
        this.endVideoPipPointer();
        return;
      }
      // Cursor in window-content coordinates — the space view bounds live in.
      const cursor = screen.getCursorScreenPoint();
      const content = this.window.getContentBounds();
      apply({ x: cursor.x - content.x, y: cursor.y - content.y });
    };
    tick();
    this.pipPointerTimer = setInterval(tick, 16);
  }

  private applyVideoPipBounds(): void {
    if (!this.pipVisible || this.pipBounds === null) return;
    this.pipBounds = clampPipBounds(this.pipBounds, this.pipHole());
    this.videoPipView.setBounds(this.pipBounds);
  }

  /** Renderer-reported split ratio (`ui:setSplitRatio`) — the divider drag. */
  setSplitRatio(ratio: number): void {
    this.splitRatio = ratio;
    this.applyTabBounds();
    // The divider drag moved the pane the toolbar was placed in.
    this.hideSelectionToolbar();
  }

  /**
   * Modal overlay opened or closed (§8.1). Open puts the chrome view ABOVE
   * the tab views so the overlay and its dimmed backdrop are visible — tab
   * views otherwise cover the content hole and every dialog drawn under it —
   * and latches, so later attaches keep it there (see `overlayActive`).
   * Closing unlatches; the way back down is TabManager.syncVisibility, whose
   * attachTabView calls re-top the visible tabs above the chrome again.
   */
  setOverlayActive(active: boolean): void {
    this.overlayActive = active;
    if (active) this.raiseChrome();
  }

  private raiseChrome(): void {
    this.window.contentView.addChildView(this.chromeView);
    // The glance page sits in the raised chrome's frame — re-top it with the
    // chrome or the frame would cover its own preview.
    if (this.glanceView !== null) {
      this.window.contentView.addChildView(this.glanceView);
    }
    // The floating panel outranks even a raised modal — playback must stay
    // reachable while a dialog is up, as it was when it lived in its own
    // window above the whole stack.
    this.stackSavePreview();
  }

  /**
   * Back to a bare window showing only the chrome, freshly loaded — the
   * window half of a sign-out reset (§8.2). The chrome WebContents survives
   * (its id is what the IPC sender check trusts); only its page is reloaded,
   * which drops all renderer state including the onboarding dismissal.
   */
  async resetToChrome(): Promise<void> {
    for (const view of [...this.tabViews.keys()]) this.detachTabView(view);
    this.lastContentBounds = null;
    this.splitRatio = DEFAULT_SPLIT_RATIO;
    // The reload drops the renderer state that owns the overlay, so any modal
    // that was open is gone — keeping the latch would raise the chrome over
    // every tab attached after the next sign-in.
    this.overlayActive = false;
    // The preview page reloads with its stack empty; its state was the old
    // account's captures mid-flight, which are gone with the service graph.
    this.savePreviewHeight = 0;
    this.savePreviewWidth = SAVE_PREVIEW_WIDTH;
    this.savePreviewView.setVisible(false);
    this.hideSelectionToolbar();
    // The player's video (and its media cache) belonged to the old account.
    this.hideVideoPip();
    this.pipBounds = null;
    // The glance page was the old account's too — GlanceManager destroys the
    // view in teardown; this drops the shell's hosting of it either way.
    this.setGlanceView(null);
    await this.loadRenderer();
    await this.loadSavePreview();
    await this.loadSelectionToolbar();
    await this.loadVideoPip();
  }

  /**
   * Translucent chrome (Appearance panel): put a macOS vibrancy layer behind
   * the whole window and clear the window's own opaque fill, so the chrome's
   * semi-transparent surfaces (styles.css, `[data-translucent="on"]`) blur
   * what sits behind the window. The tab WebContentsViews stay opaque and
   * cover the content hole, so page content is never blurred — only the
   * chrome around it. Off macOS there is no equivalent material; the renderer
   * hides the control there, and this stays a no-op rather than leaving the
   * window transparently unfilled.
   */
  setTranslucent(enabled: boolean): void {
    if (process.platform !== "darwin") return;
    this.translucent = enabled;
    if (enabled) {
      // Order matters: the fill paints OVER the vibrancy view, so it has to
      // go clear or the blur never shows.
      this.window.setBackgroundColor("#00000000");
      this.window.setVibrancy(VIBRANCY_MATERIAL);
      return;
    }
    this.window.setVibrancy(null);
    this.window.setBackgroundColor(backgroundFor(this.darkBackground));
  }

  /**
   * Follow the chrome between light and dark. Only the window's own fill moves
   * — every surface above it is the renderer's. A translucent window has no
   * fill to move (the vibrancy layer is the ground), so the color is only
   * recorded for whenever translucency goes back off.
   */
  setBackgroundScheme(dark: boolean): void {
    if (this.darkBackground === dark) return;
    this.darkBackground = dark;
    if (!this.translucent) this.window.setBackgroundColor(backgroundFor(dark));
  }

  focus(): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  focusChrome(): void {
    this.chromeView.webContents.focus();
  }

  private fitChrome(): void {
    const { width, height } = this.window.getContentBounds();
    this.chromeView.setBounds({ x: 0, y: 0, width, height });
  }

  private applyTabBounds(): void {
    for (const [view, region] of this.tabViews)
      this.applyBoundsTo(view, region);
  }

  private applyBoundsTo(view: WebContentsView, region: PaneRegion): void {
    if (this.lastContentBounds === null || !this.wantsVisible.has(view)) return;
    const bounds = paneBoundsFor(
      this.lastContentBounds,
      region,
      this.splitRatio,
    );
    // A collapsed pane (window too narrow to split) hides rather than crushes —
    // and re-shows when widening resolves its pane again.
    if (bounds === null) {
      view.setVisible(false);
      return;
    }
    view.setBounds(bounds);
    view.setVisible(true);
  }

  private async loadRenderer(): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl !== undefined && devUrl.length > 0) {
      await this.chromeView.webContents.loadURL(devUrl);
      return;
    }
    await this.chromeView.webContents.loadFile(
      path.join(dirname, "../renderer/index.html"),
    );
  }

  private async loadSavePreview(): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl !== undefined && devUrl.length > 0) {
      await this.savePreviewView.webContents.loadURL(`${devUrl}#save-preview`);
      return;
    }
    await this.savePreviewView.webContents.loadFile(
      path.join(dirname, "../renderer/index.html"),
      { hash: "save-preview" },
    );
  }

  private async loadSelectionToolbar(): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl !== undefined && devUrl.length > 0) {
      await this.selectionToolbarView.webContents.loadURL(
        `${devUrl}#selection-toolbar`,
      );
      return;
    }
    await this.selectionToolbarView.webContents.loadFile(
      path.join(dirname, "../renderer/index.html"),
      { hash: "selection-toolbar" },
    );
  }

  private async loadVideoPip(): Promise<void> {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl !== undefined && devUrl.length > 0) {
      await this.videoPipView.webContents.loadURL(`${devUrl}#video-pip`);
      return;
    }
    await this.videoPipView.webContents.loadFile(
      path.join(dirname, "../renderer/index.html"),
      { hash: "video-pip" },
    );
  }
}
