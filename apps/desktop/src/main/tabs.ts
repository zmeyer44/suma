/**
 * TabManager — per-space tab WebContentsViews (PRD §8.1).
 *
 * Each tab runs site content in the space's session, fully sandboxed, no
 * preload. Every live tab's presence, URL, and order are independent
 * encrypted workspace registers (§8.3), so a navigation never clobbers a
 * concurrent reorder. Active space/tab/split focus is a canonical encrypted
 * workspace register, so every connected client renders the same layout.
 */

import { createHash, randomUUID } from "node:crypto";
import { clearTimeout, setInterval, setTimeout } from "node:timers";
import { Menu, WebContentsView, type WebContents } from "electron";
import { canonicalVideoUrl } from "../shared/videos";
import {
  canonicalInternalUrl,
  internalPageTitle,
} from "../shared/internal-pages";
import type { TabInfo, TabThumbnail } from "../shared/ipc";
import type { SelectionActionPayload } from "../shared/selection";
import type { PopupManager, PopupOpenerContext } from "./popups";
import {
  sanitizeSelectionSignal,
  SELECTION_WAIT_SCRIPT,
  type SelectionSignal,
} from "./selection-core";
import type { ShellWindow } from "./shell-window";
import type { SpaceManager } from "./spaces";
import { focusAfterClose, focusAfterSelect } from "./tab-focus";
import {
  isAllowedTabTarget,
  isAllowedTabUrl,
  newTabUrlFor,
  NEW_TAB_URL,
} from "./tab-policy";
import type { SyncedTabState, WorkspaceStore } from "./workspace-store";

interface TabRecord {
  id: string;
  spaceId: string;
  view: WebContentsView;
  pinned: boolean;
  faviconUrl: string | null;
  /** URL requested before the first load commits (getURL() is "" until then). */
  pendingUrl: string;
  /**
   * Canonical `suma://` address when this tab is an INTERNAL page, else null
   * (shared/internal-pages.ts). Set ⇒ the view never loads and never shows;
   * the chrome renderer paints the page into this tab's pane instead. It is
   * also the tab's authoritative address, which is why the WebContents
   * observers below ignore an internal tab entirely: the blank view they
   * would otherwise report is not what the user is looking at.
   */
  internalUrl: string | null;
  /** Renderer process gone (§8.1) — select/reload rebuilds the view. */
  crashed: boolean;
  /** View destroyed to save memory (§8.1 tab discard); URL/title retained. */
  discarded: boolean;
  /** Last title seen — survives crash/discard so the strip stays labeled. */
  lastTitle: string;
  /** Last select/navigate wall time — idle-discard policy input. */
  lastActiveAtMs: number;
  /**
   * Last page snapshot as a JPEG data: URL (hover preview shelf). Like
   * lastTitle it survives crash/discard — a stale picture of the page still
   * answers "which tab was this?" better than a blank card.
   */
  thumbnailUrl: string | null;
  thumbnailAtMs: number;
  /** A capturePage is in flight — collapses bursts to one capture. */
  thumbnailCapturing: boolean;
}

/** Hard ceiling on tabs per space — create() refuses beyond this. */
export const MAX_TABS_PER_SPACE = 500;

/**
 * §8.1 tab discard policy: OFF by default — discarding logs tabs out of
 * nothing but does drop scroll/form state, so the automatic policy stays
 * conservative and opt-in (flip the constant). Manual discardTab() always
 * works.
 */
export const AUTO_DISCARD_ENABLED: boolean = false;
export const AUTO_DISCARD_IDLE_MS = 30 * 60_000;
const AUTO_DISCARD_SWEEP_MS = 60_000;

/**
 * Preview thumbnails: 480px is 2× the shelf's ~176px card, so the JPEG stays
 * crisp on retina at roughly 15–40 KB — cheap enough to hold one per tab and
 * push whole over IPC. Capture waits for the page to sit still: a paint-storm
 * of did-stop-loading ticks (SPAs fire them freely) becomes one capture.
 */
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_JPEG_QUALITY = 65;
const THUMBNAIL_SETTLE_MS = 400;
/** Wide integer spacing makes ordinary inserts a one-register update. */
const TAB_ORDER_STEP = 1n << 64n;

function canonicalTabUrl(url: string): string {
  if (url === NEW_TAB_URL) return url;
  // Internal pages canonicalize themselves — `new URL` would spell them
  // differently in the two processes (see shared/internal-pages.ts).
  const internal = canonicalInternalUrl(url);
  if (internal !== null) return internal;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function tabRank(value: string): bigint {
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}

/** Exact midpoint rank for an insertion, or null when the list needs spacing. */
export function rankForTabInsertion(
  ordered: ReadonlyArray<Pick<SyncedTabState, "rank">>,
  index: number,
): bigint | null {
  const target = Math.min(Math.max(index, 0), ordered.length);
  const left = target > 0 ? tabRank(ordered[target - 1]?.rank ?? "0") : null;
  const right =
    target < ordered.length ? tabRank(ordered[target]?.rank ?? "0") : null;
  if (left === null && right === null) return 0n;
  if (left === null) return (right as bigint) - TAB_ORDER_STEP;
  if (right === null) return left + TAB_ORDER_STEP;
  if (right - left <= 1n) return null;
  return left + (right - left) / 2n;
}

/**
 * Rolling-window rate limiter for window.open-initiated tabs: at most
 * `maxOpens` per source per `windowMs`. Pure — the clock is injected, and
 * denied attempts never consume quota.
 */
export class PopupRateLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly maxOpens = 5,
    private readonly windowMs = 10_000,
  ) {}

  /** Record a popup from sourceId if under the limit; false ⇒ deny. */
  tryOpen(sourceId: string): boolean {
    const at = this.now();
    const cutoff = at - this.windowMs;
    const times = (this.recent.get(sourceId) ?? []).filter((t) => t > cutoff);
    const allowed = times.length < this.maxOpens;
    if (allowed) times.push(at);
    if (times.length > 0) this.recent.set(sourceId, times);
    else this.recent.delete(sourceId);
    return allowed;
  }

  forget(sourceId: string): void {
    this.recent.delete(sourceId);
  }
}

/** Browsing-history hooks (§8.3) — see history.ts. */
export interface TabHistoryRecorder {
  noteVisit(url: string, title: string): void;
  noteTitle(url: string, title: string): void;
}

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly orderBySpace = new Map<string, string[]>();
  private readonly materialized = new Set<string>();
  /** Spaces mid-rebuild in materialize(); remote reconcile is paused for them. */
  private readonly materializing = new Set<string>();
  /** Main-initiated loads already represented in the synced URL register. */
  private readonly expectedNavigationByTab = new Map<string, string>();
  /** A fresh linked device may learn its tab graph before its encrypted
   * cookie snapshot has finished applying. Until a space is ready, views are
   * materialized locally but make no network request. */
  private readonly sessionReadySpaces = new Set<string>();
  private readonly popupLimiter = new PopupRateLimiter(() => Date.now());
  private history: TabHistoryRecorder | null = null;
  /** Wired at bootstrap — the right-click "Save Video" action (videos). */
  private videoSave: ((url: string) => void) | null = null;
  /** Wired at bootstrap — opens a glance preview (main/glance.ts). Unwired,
   *  the glance dispositions fall back to ordinary tabs. */
  private glanceOpener: ((spaceId: string, url: string) => void) | null = null;
  private discardTimer: NodeJS.Timeout | null = null;
  /** Per-tab arm counter for the selection watcher — a re-arm (new load, a
   *  revived view) bumps it, and the superseded loop sees the mismatch and
   *  stops instead of double-reporting. */
  private readonly selectionWatchGen = new Map<string, number>();
  /** The selection the toolbar is showing for, cached for the moment a
   *  toolbar action arrives (selectionToolbar:action in main/ipc.ts). */
  private selection: ({ tabId: string } & SelectionActionPayload) | null = null;
  /** Wired at bootstrap — pushes a landed capture as `tabs:thumbnail`. */
  private onThumbnail: ((thumb: TabThumbnail) => void) | null = null;
  /** Per-tab settle timers for the post-load thumbnail capture. */
  private readonly thumbnailTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly shell: ShellWindow,
    private readonly spaces: SpaceManager,
    private readonly store: WorkspaceStore,
    private readonly onTabsChanged: (spaceId: string) => void,
    private readonly popups: PopupManager,
    private readonly onPopupDenied: (reason: string) => void = () => undefined,
  ) {}

  /** Wired at bootstrap; navigations before it is set are simply not recorded. */
  setHistoryRecorder(recorder: TabHistoryRecorder): void {
    this.history = recorder;
  }

  /** Wired at bootstrap; right-clicks before it is set show no menu. */
  setVideoSaveHandler(handler: (url: string) => void): void {
    this.videoSave = handler;
  }

  /** Wired at bootstrap; glance dispositions before it is set become tabs. */
  setGlanceOpener(handler: (spaceId: string, url: string) => void): void {
    this.glanceOpener = handler;
  }

  /** Wired at bootstrap; captures landing before it is set are only cached. */
  setThumbnailListener(handler: (thumb: TabThumbnail) => void): void {
    this.onThumbnail = handler;
  }

  markSessionHydrating(spaceId: string): void {
    this.sessionReadySpaces.delete(spaceId);
  }

  markSessionReady(spaceId: string): void {
    if (this.sessionReadySpaces.has(spaceId)) return;
    this.sessionReadySpaces.add(spaceId);
    for (const tab of this.tabs.values()) {
      if (tab.spaceId === spaceId) this.loadPending(tab);
    }
  }

  isTabInSpace(webContentsId: number, spaceId: string): boolean {
    for (const tab of this.tabs.values()) {
      if (
        tab.spaceId === spaceId &&
        !tab.view.webContents.isDestroyed() &&
        tab.view.webContents.id === webContentsId
      ) {
        return true;
      }
    }
    return false;
  }

  list(spaceId: string): TabInfo[] {
    this.materialize(spaceId);
    const activeId = this.activeTabId(spaceId);
    const splitId = this.splitTabId(spaceId);
    const infos: TabInfo[] = [];
    for (const id of this.orderFor(spaceId)) {
      const tab = this.tabs.get(id);
      if (tab !== undefined) infos.push(this.infoFor(tab, activeId, splitId));
    }
    return infos;
  }

  countFor(spaceId: string): number {
    if (this.materialized.has(spaceId)) return this.orderFor(spaceId).length;
    const synced = this.store.syncedTabsFor(spaceId);
    return synced.length > 0 || this.store.realtimeTabsMigrated(spaceId)
      ? synced.length
      : this.store.pinsFor(spaceId).length +
          this.store.todayTabs(spaceId).length;
  }

  create(args: {
    spaceId: string;
    url?: string;
    pinned?: boolean;
    /**
     * Main-only (never crosses IPC): adopt this LIVE view as the new tab's
     * instead of building one — how a promoted glance keeps its page state
     * (main/glance.ts). Must already be in the space's session; the caller
     * hands over ownership entirely.
     */
    adoptView?: WebContentsView;
    /** Main-only: the favicon the adopted view already reported — the
     *  page-favicon-updated event will not fire again until it navigates. */
    faviconUrl?: string;
  }): TabInfo {
    if (this.spaces.get(args.spaceId) === undefined) {
      throw new Error(`unknown space ${args.spaceId}`);
    }
    this.materialize(args.spaceId);
    if (this.orderFor(args.spaceId).length >= MAX_TABS_PER_SPACE) {
      throw new Error(
        `This space is at its ${MAX_TABS_PER_SPACE}-tab limit — close a tab to open a new one.`,
      );
    }
    // No explicit URL ⇒ the user's configured new-tab page (blank if unset).
    const url = args.url ?? newTabUrlFor(this.store.settings());
    if (!isAllowedTabTarget(url))
      throw new Error(`refusing to open ${url} in a tab`);
    const tab = this.buildTab(
      args.spaceId,
      url,
      args.pinned === true,
      undefined,
      args.adoptView,
    );
    if (args.faviconUrl !== undefined) tab.faviconUrl = args.faviconUrl;
    const ordered = this.store.syncedTabsFor(args.spaceId);
    const rank =
      rankForTabInsertion(ordered, ordered.length) ??
      BigInt(ordered.length) * TAB_ORDER_STEP;
    this.store.openSyncedTab({
      id: tab.id,
      spaceId: tab.spaceId,
      createdAtMs: Date.now(),
      url: canonicalTabUrl(url),
      rank: rank.toString(),
    });
    if (tab.pinned) this.persistPin(tab);
    this.setActive(args.spaceId, tab.id);
    this.store.publishCurrentWorkspaceFocus();
    this.emit(args.spaceId);
    return this.infoFor(tab, tab.id, this.splitTabId(args.spaceId));
  }

  close(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;
    this.store.closeSyncedTab(tabId);
    this.removeLocalTab(tab, true, true);
    this.store.publishCurrentWorkspaceFocus();
  }

  /** Remove one materialized view without writing the shared presence field. */
  private removeLocalTab(
    tab: TabRecord,
    removePin: boolean,
    notify: boolean,
  ): void {
    const tabId = tab.id;
    const order = this.orderFor(tab.spaceId);
    const index = order.indexOf(tabId);
    if (index >= 0) order.splice(index, 1);
    this.tabs.delete(tabId);
    const thumbTimer = this.thumbnailTimers.get(tabId);
    if (thumbTimer !== undefined) {
      clearTimeout(thumbTimer);
      this.thumbnailTimers.delete(tabId);
    }
    this.expectedNavigationByTab.delete(tabId);
    this.popupLimiter.forget(tabId);
    // An auth popup must never outlive the page waiting on its result.
    this.popups.closeForTab(tabId);
    if (tab.pinned && removePin) this.store.removePin(tabId);
    // Closing one half of a split leaves one page, and one page fills the hole
    // (tab-focus.ts owns the rule). The re-layout is unconditional on a pane
    // change, NOT folded into the active-tab branch: closing the split half
    // leaves the active tab exactly where it was, and without showActive its
    // view would keep the "left" region it was given — half the hole, with
    // nothing beside it.
    const prevActive = this.store.activeTabFor(tab.spaceId);
    const prevSplit = this.store.splitTabFor(tab.spaceId);
    const focus = focusAfterClose({
      order,
      index,
      closedId: tabId,
      activeId: prevActive,
      splitId: prevSplit,
    });
    if (focus.splitId !== prevSplit)
      this.store.setSplitTabFor(tab.spaceId, focus.splitId);
    if (focus.activeId !== prevActive)
      this.store.setActiveTabFor(tab.spaceId, focus.activeId);
    if (
      (focus.splitId !== prevSplit || focus.activeId !== prevActive) &&
      tab.spaceId === this.spaces.activeSpaceId
    ) {
      this.showActive(tab.spaceId);
    }
    this.shell.detachTabView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (notify) this.emit(tab.spaceId);
  }

  select(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    if (tab.crashed || tab.discarded) this.revive(tab);
    tab.lastActiveAtMs = Date.now();
    // Which panes survive the click is tab-focus.ts's rule: the split half
    // swaps the panes, any other tab ends the split and fills the hole.
    const prevSplit = this.splitTabId(tab.spaceId);
    const focus = focusAfterSelect({
      selectedId: tabId,
      activeId: this.activeTabId(tab.spaceId),
      splitId: prevSplit,
    });
    if (focus.splitId !== prevSplit)
      this.store.setSplitTabFor(tab.spaceId, focus.splitId);
    this.setActive(tab.spaceId, tabId);
    this.store.publishCurrentWorkspaceFocus();
    this.emit(tab.spaceId);
  }

  /**
   * Split view (§6, 2-pane): show `tabId` in a second pane beside the active
   * tab. Splitting the ACTIVE tab moves it to the split pane and promotes the
   * next tab in order — a split needs two tabs, so with no other tab this
   * throws. The assignment is part of canonical workspace focus and therefore
   * moves every connected client to the same two-pane layout.
   */
  setSplit(tabId: string, split: boolean): void {
    const tab = this.require(tabId);
    if (!split) {
      if (this.store.splitTabFor(tab.spaceId) === tabId) {
        this.store.setSplitTabFor(tab.spaceId, null);
        if (tab.spaceId === this.spaces.activeSpaceId)
          this.showActive(tab.spaceId);
        this.store.publishCurrentWorkspaceFocus();
        this.emit(tab.spaceId);
      }
      return;
    }
    if (this.activeTabId(tab.spaceId) === tabId) {
      const other =
        this.orderFor(tab.spaceId).find((id) => id !== tabId) ?? null;
      if (other === null) {
        throw new Error(
          "Split view needs a second tab — open another tab first.",
        );
      }
      this.store.setActiveTabFor(tab.spaceId, other);
    }
    this.store.setSplitTabFor(tab.spaceId, tabId);
    if (tab.crashed || tab.discarded) this.revive(tab);
    if (tab.spaceId === this.spaces.activeSpaceId) this.showActive(tab.spaceId);
    this.store.publishCurrentWorkspaceFocus();
    this.emit(tab.spaceId);
  }

  /** Materialize the canonical focus winner without publishing an echo. */
  applySyncedFocus(
    spaceId: string,
    activeTabId: string | null,
    splitTabId: string | null,
  ): void {
    this.materialize(spaceId);
    const order = this.orderFor(spaceId);
    const active =
      activeTabId !== null && order.includes(activeTabId)
        ? activeTabId
        : (order[0] ?? null);
    const split =
      splitTabId !== null && splitTabId !== active && order.includes(splitTabId)
        ? splitTabId
        : null;
    this.store.setActiveTabFor(spaceId, active);
    this.store.setSplitTabFor(spaceId, split);
    if (spaceId === this.spaces.activeSpaceId) this.showActive(spaceId);
    this.emit(spaceId);
  }

  navigate(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    if (!isAllowedTabTarget(url))
      throw new Error(`refusing to navigate a tab to ${url}`);
    const canonical = canonicalTabUrl(url);
    // Crossing between a web page and an internal one changes who paints this
    // pane — the tab's own view, or the chrome underneath it — so the layout
    // has to be re-resolved rather than just the address rewritten.
    const wasInternal = tab.internalUrl !== null;
    tab.internalUrl = canonicalInternalUrl(canonical);
    tab.pendingUrl = canonical;
    tab.lastActiveAtMs = Date.now();
    this.store.updateSyncedTabUrl(tab.id, canonical);
    if (tab.internalUrl !== null) {
      // Leave nothing of the outgoing page behind the internal one: the view
      // is about to be hidden, but a live page would keep running (and
      // playing audio) under a settings page the user thinks replaced it.
      this.blankView(tab);
    } else if (tab.crashed || tab.discarded) {
      this.revive(tab);
    } else {
      this.loadPending(tab, true);
    }
    if (
      wasInternal !== (tab.internalUrl !== null) &&
      tab.spaceId === this.spaces.activeSpaceId
    ) {
      this.showActive(tab.spaceId);
    }
    this.emit(tab.spaceId);
  }

  goBack(tabId: string): void {
    const tab = this.require(tabId);
    if (!this.sessionReadySpaces.has(tab.spaceId)) return;
    if (tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    const tab = this.require(tabId);
    if (!this.sessionReadySpaces.has(tab.spaceId)) return;
    if (tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.navigationHistory.goForward();
  }

  reload(tabId: string): void {
    const tab = this.require(tabId);
    // An internal page is a live React view over the same store the rest of
    // the chrome reads — there is nothing stale to re-fetch.
    if (tab.internalUrl !== null) return;
    if (!this.sessionReadySpaces.has(tab.spaceId)) return;
    if (tab.crashed || tab.discarded) {
      // §8.1 crash recovery: reloading a dead tab rebuilds it at its URL.
      this.revive(tab);
      this.emit(tab.spaceId);
      return;
    }
    tab.view.webContents.reload();
  }

  /** Re-request every live page in a space after a manual session pull. */
  reloadSpace(spaceId: string): void {
    if (!this.sessionReadySpaces.has(spaceId)) return;
    for (const tab of this.tabs.values()) {
      if (
        tab.spaceId !== spaceId ||
        tab.pendingUrl === NEW_TAB_URL ||
        tab.internalUrl !== null ||
        tab.crashed ||
        tab.discarded ||
        tab.view.webContents.isDestroyed()
      ) {
        continue;
      }
      this.loadPending(tab, true);
    }
  }

  print(tabId: string): void {
    const tab = this.require(tabId);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.print();
  }

  toggleDevTools(tabId: string): void {
    const wc = this.require(tabId).view.webContents;
    if (wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  }

  /** Live webContents for a tab (credentials fill) — null when crashed/discarded. */
  webContentsFor(tabId: string): WebContents | null {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return null;
    const wc = tab.view.webContents;
    return wc.isDestroyed() ? null : wc;
  }

  /** Current URL of a live tab; null for unknown ids. */
  urlForTab(tabId: string): string | null {
    const tab = this.tabs.get(tabId);
    return tab === undefined ? null : this.urlFor(tab);
  }

  /** §8.1 tab discard: drop a background tab's renderer, keep URL/title. */
  discardTab(tabId: string): void {
    const tab = this.require(tabId);
    // An internal tab's view is already empty — discarding it would free
    // nothing and only add a "discarded" badge to a page that still works.
    if (tab.internalUrl !== null) return;
    if (tab.discarded || tab.crashed) return;
    if (this.activeTabId(tab.spaceId) === tab.id) return; // never the visible tab
    if (this.splitTabId(tab.spaceId) === tab.id) return; // the split pane is visible too
    tab.pendingUrl = this.urlFor(tab);
    tab.lastTitle = this.titleFor(tab);
    tab.discarded = true;
    this.shell.detachTabView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.emit(tab.spaceId);
  }

  /** Idle-discard sweep — separate from discardTab so policy stays testable. */
  discardIdleTabs(now: number = Date.now()): void {
    for (const tab of [...this.tabs.values()]) {
      if (tab.discarded || tab.crashed) continue;
      if (now - tab.lastActiveAtMs > AUTO_DISCARD_IDLE_MS)
        this.discardTab(tab.id);
    }
  }

  /** Starts the conservative idle-discard timer — a no-op while disabled. */
  startDiscardPolicy(): void {
    if (!AUTO_DISCARD_ENABLED || this.discardTimer !== null) return;
    this.discardTimer = setInterval(
      () => this.discardIdleTabs(),
      AUTO_DISCARD_SWEEP_MS,
    );
    this.discardTimer.unref();
  }

  /**
   * Tear every tab view off the window and drop it — for sign-out (§8.2),
   * where the whole manager is being replaced. Unlike `close`, it writes
   * NOTHING back to the workspace store: that store is about to be deleted,
   * and a close-by-close teardown would busily rewrite pins and active-tab
   * state on the way out.
   */
  destroyAll(): void {
    if (this.discardTimer !== null) {
      clearInterval(this.discardTimer);
      this.discardTimer = null;
    }
    for (const tab of this.tabs.values()) {
      this.shell.detachTabView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    for (const timer of this.thumbnailTimers.values()) clearTimeout(timer);
    this.thumbnailTimers.clear();
    this.tabs.clear();
    this.orderBySpace.clear();
    this.materialized.clear();
    this.materializing.clear();
    this.expectedNavigationByTab.clear();
  }

  setPinned(tabId: string, pinned: boolean): void {
    const tab = this.require(tabId);
    if (tab.pinned === pinned) return;
    tab.pinned = pinned;
    if (pinned) this.persistPin(tab);
    else this.store.removePin(tabId);
    // Keep stored pin positions matching the live order so a restart
    // rebuilds the strip as it looked.
    this.persistPinOrder(tab.spaceId);
    this.emit(tab.spaceId);
  }

  /** Move a tab to `index` within its space's order (index taken after removal). */
  reorder(tabId: string, index: number): void {
    const tab = this.require(tabId);
    const order = this.orderFor(tab.spaceId);
    const from = order.indexOf(tabId);
    if (from < 0) return;
    order.splice(from, 1);
    const target = Math.min(Math.max(index, 0), order.length);
    order.splice(target, 0, tabId);
    const stateById = new Map(
      this.store.syncedTabsFor(tab.spaceId).map((item) => [item.id, item]),
    );
    const withoutTarget = order
      .filter((id) => id !== tabId)
      .map(
        (id, position) =>
          stateById.get(id) ?? {
            id,
            spaceId: tab.spaceId,
            createdAtMs: 0,
            url: NEW_TAB_URL,
            rank: (BigInt(position) * TAB_ORDER_STEP).toString(),
          },
      );
    const rank = rankForTabInsertion(withoutTarget, target);
    if (rank === null) {
      // Concurrent inserts can legitimately share a rank. Re-spacing is a
      // bounded multi-register update; HLC still resolves a concurrent move
      // of the same tab, while moves of different tabs remain independent.
      this.store.updateSyncedTabOrders(
        order.map((id, position) => ({
          tabId: id,
          spaceId: tab.spaceId,
          rank: (BigInt(position) * TAB_ORDER_STEP).toString(),
        })),
      );
    } else {
      this.store.updateSyncedTabOrder(tab.id, tab.spaceId, rank.toString());
    }
    if (tab.pinned) this.persistPinOrder(tab.spaceId);
    this.emit(tab.spaceId);
  }

  /** Rewrite stored pin positions to match the live order (restart fidelity). */
  private persistPinOrder(spaceId: string): void {
    const pins = new Map(this.store.pinsFor(spaceId).map((p) => [p.id, p]));
    let position = 0;
    for (const id of this.orderFor(spaceId)) {
      const tab = this.tabs.get(id);
      if (tab === undefined || !tab.pinned) continue;
      const pin = pins.get(id);
      if (pin !== undefined && pin.position !== position) {
        this.store.upsertPin({ ...pin, position });
      }
      position++;
    }
  }

  /** Show the active space's active tab; hide every other space's views. */
  syncVisibility(): void {
    const activeSpace = this.spaces.activeSpaceId;
    for (const tab of this.tabs.values()) {
      if (tab.spaceId !== activeSpace) this.shell.hideTabView(tab.view);
    }
    if (activeSpace === null) return;
    this.materialize(activeSpace);
    this.showActive(activeSpace);
  }

  /** Apply remote workspace winners to already-materialized WebContents. */
  reconcileSyncedTabs(): void {
    for (const space of this.spaces.list()) {
      if (!this.materialized.has(space.id) || this.materializing.has(space.id))
        continue;
      const desired = this.store
        .syncedTabsFor(space.id)
        .filter((tab) => isAllowedTabTarget(tab.url));
      const desiredById = new Map(desired.map((tab) => [tab.id, tab]));
      for (const id of [...this.orderFor(space.id)]) {
        const tab = this.tabs.get(id);
        if (tab !== undefined && !desiredById.has(id))
          this.removeLocalTab(tab, false, false);
      }

      const pins = new Map(
        this.store.pinsFor(space.id).map((pin) => [pin.id, pin]),
      );
      for (const state of desired) {
        const pin = pins.get(state.id);
        let tab = this.tabs.get(state.id);
        if (tab === undefined) {
          tab = this.buildTab(space.id, state.url, pin !== undefined, state.id);
        } else {
          tab.pinned = pin !== undefined;
          const remoteUrl = canonicalTabUrl(state.url);
          if (canonicalTabUrl(this.urlFor(tab)) !== remoteUrl) {
            this.applySyncedNavigation(tab, remoteUrl);
          }
        }
        tab.faviconUrl = pin?.faviconUrl ?? tab.faviconUrl;
      }

      this.orderBySpace.set(
        space.id,
        desired.map((tab) => tab.id).filter((id) => this.tabs.has(id)),
      );
      const active = this.store.activeTabFor(space.id);
      if (active === null || !this.tabs.has(active)) {
        this.store.setActiveTabFor(
          space.id,
          this.orderFor(space.id)[0] ?? null,
        );
      }
      const split = this.store.splitTabFor(space.id);
      if (split !== null && !this.tabs.has(split))
        this.store.setSplitTabFor(space.id, null);
      if (space.id === this.spaces.activeSpaceId) this.showActive(space.id);
      this.emit(space.id);
    }
  }

  private applySyncedNavigation(tab: TabRecord, url: string): void {
    tab.pendingUrl = url;
    tab.internalUrl = canonicalInternalUrl(url);
    if (tab.internalUrl !== null) {
      this.blankView(tab);
    } else if (tab.crashed || tab.discarded) {
      this.revive(tab);
    } else {
      this.loadPending(tab, true);
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private require(tabId: string): TabRecord {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    return tab;
  }

  /** Per-tab context the popup layer needs; rebuilt per request so a closed
   * tab can never hand out a stale session. */
  private popupCtx(tab: TabRecord): PopupOpenerContext {
    const openTab = (url: string): void => {
      try {
        this.create({ spaceId: tab.spaceId, url });
      } catch (err) {
        // Space at its tab cap — refuse the window, never crash the page.
        this.onPopupDenied(
          err instanceof Error ? err.message : "could not open a tab",
        );
      }
    };
    return {
      tabId: tab.id,
      spaceId: tab.spaceId,
      session: this.spaces.sessionFor(tab.spaceId),
      pinned: tab.pinned,
      allowAnotherWindow: () => this.popupLimiter.tryOpen(tab.id),
      openTab,
      openGlance: (url: string) => {
        const opener = this.glanceOpener;
        if (opener === null) openTab(url);
        else opener(tab.spaceId, url);
      },
      onDenied: this.onPopupDenied,
    };
  }

  private orderFor(spaceId: string): string[] {
    let order = this.orderBySpace.get(spaceId);
    if (order === undefined) {
      order = [];
      this.orderBySpace.set(spaceId, order);
    }
    return order;
  }

  private activeTabId(spaceId: string): string | null {
    const stored = this.store.activeTabFor(spaceId);
    if (stored !== null && this.tabs.has(stored)) return stored;
    return this.orderFor(spaceId)[0] ?? null;
  }

  /** The split pane's live tab — null when unset, gone, or degenerate
   *  (pointing at the active tab, e.g. after restart moved the fallback). */
  private splitTabId(spaceId: string): string | null {
    const stored = this.store.splitTabFor(spaceId);
    if (stored === null || !this.tabs.has(stored)) return null;
    if (stored === this.activeTabId(spaceId)) return null;
    return stored;
  }

  private setActive(spaceId: string, tabId: string): void {
    // The page(s) about to be hidden are visible RIGHT NOW — the last moment
    // capturePage can still see their pixels. Fire-and-forget: the switch
    // must not wait on a frame copy, and a capture that loses the race comes
    // back empty and is dropped (the settle-capture already covered the tab).
    this.captureVisibleTabs();
    // The caller decides whether this is a local interaction (publish) or a
    // remote materialization (do not echo).
    this.store.setActiveTabFor(spaceId, tabId);
    if (spaceId === this.spaces.activeSpaceId) this.showActive(spaceId);
  }

  /** Cached page snapshots for a space's tabs, capture order preserved. */
  thumbnails(spaceId: string): TabThumbnail[] {
    const thumbs: TabThumbnail[] = [];
    for (const id of this.orderFor(spaceId)) {
      const tab = this.tabs.get(id);
      if (tab === undefined || tab.thumbnailUrl === null) continue;
      thumbs.push({
        tabId: tab.id,
        dataUrl: tab.thumbnailUrl,
        capturedAtMs: tab.thumbnailAtMs,
      });
    }
    return thumbs;
  }

  /**
   * Snapshot whatever is on screen now — the active tab, and the split pane
   * beside it. The other tabs' cached captures are already the best available
   * picture of them: a hidden WebContentsView has no frames to copy (macOS
   * returns an empty image), so "refresh everything" is not on the menu.
   */
  captureVisibleTabs(): void {
    const spaceId = this.spaces.activeSpaceId;
    if (spaceId === null) return;
    for (const id of [this.activeTabId(spaceId), this.splitTabId(spaceId)]) {
      const tab = id === null ? undefined : this.tabs.get(id);
      if (tab !== undefined) void this.captureThumbnail(tab);
    }
  }

  /** One settle-delayed capture per load burst; the timer is per tab. */
  private scheduleThumbnail(tab: TabRecord): void {
    const pending = this.thumbnailTimers.get(tab.id);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.thumbnailTimers.delete(tab.id);
      void this.captureThumbnail(tab);
    }, THUMBNAIL_SETTLE_MS);
    timer.unref();
    this.thumbnailTimers.set(tab.id, timer);
  }

  /**
   * Capture the tab's current frame into its cached thumbnail. Silently a
   * no-op unless the view is live and actually on screen: an internal page's
   * view is blank (the chrome draws the real page), a hidden view has no
   * frames, and a blank new-tab is not worth a card. Every failure mode —
   * empty frame, capture error — keeps the previous thumbnail, which is the
   * newest true picture of the page we have.
   */
  private async captureThumbnail(tab: TabRecord): Promise<void> {
    const wc = tab.view.webContents;
    if (
      tab.thumbnailCapturing ||
      tab.internalUrl !== null ||
      tab.crashed ||
      tab.discarded ||
      wc.isDestroyed() ||
      tab.pendingUrl === NEW_TAB_URL
    ) {
      return;
    }
    const spaceId = this.spaces.activeSpaceId;
    if (spaceId === null || tab.spaceId !== spaceId) return;
    if (
      this.activeTabId(spaceId) !== tab.id &&
      this.splitTabId(spaceId) !== tab.id
    ) {
      return;
    }
    tab.thumbnailCapturing = true;
    try {
      const image = await wc.capturePage();
      if (image.isEmpty()) return;
      const scaled =
        image.getSize().width > THUMBNAIL_WIDTH
          ? image.resize({ width: THUMBNAIL_WIDTH })
          : image;
      const jpeg = scaled.toJPEG(THUMBNAIL_JPEG_QUALITY);
      if (jpeg.length === 0) return;
      // The record may have been closed while the frame was copying.
      if (this.tabs.get(tab.id) !== tab) return;
      tab.thumbnailUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      tab.thumbnailAtMs = Date.now();
      this.onThumbnail?.({
        tabId: tab.id,
        dataUrl: tab.thumbnailUrl,
        capturedAtMs: tab.thumbnailAtMs,
      });
    } catch {
      // A capture can reject mid-navigation or mid-teardown; keep the old one.
    } finally {
      tab.thumbnailCapturing = false;
    }
  }

  /** The selection under the visible toolbar, for the action relay. */
  currentSelection(): SelectionActionPayload | null {
    if (this.selection === null) return null;
    const { text, url, title } = this.selection;
    return { text, url, title };
  }

  /** Drop the cached selection and hide the toolbar. */
  clearSelection(): void {
    this.selection = null;
    this.shell.hideSelectionToolbar();
  }

  /**
   * (Re)arm the in-page selection long-poll for this tab. Each armed loop
   * awaits the next selection change, applies it, and re-arms; a navigation
   * kills the page context (the await rejects or never resolves) and the
   * next dom-ready arms a fresh loop, whose generation bump retires this
   * one. Everything the page resolves is untrusted — see selection-core.ts.
   */
  private watchSelection(tab: TabRecord): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || tab.internalUrl !== null) return;
    const gen = (this.selectionWatchGen.get(tab.id) ?? 0) + 1;
    this.selectionWatchGen.set(tab.id, gen);
    const live = (): boolean =>
      this.selectionWatchGen.get(tab.id) === gen &&
      !wc.isDestroyed() &&
      this.tabs.get(tab.id)?.view.webContents === wc;
    const loop = async (): Promise<void> => {
      while (live()) {
        let raw: unknown;
        try {
          raw = await wc.executeJavaScript(SELECTION_WAIT_SCRIPT, true);
        } catch {
          return; // context gone; the next dom-ready re-arms
        }
        if (!live()) return;
        const signal = sanitizeSelectionSignal(raw);
        // A malformed answer means the page is impersonating the watcher —
        // stop listening to it rather than retry into a hostile loop.
        if (signal === null) return;
        this.applySelectionSignal(tab, signal);
      }
    };
    void loop();
  }

  private applySelectionSignal(tab: TabRecord, signal: SelectionSignal): void {
    const visible =
      tab.spaceId === this.spaces.activeSpaceId &&
      (this.activeTabId(tab.spaceId) === tab.id ||
        this.splitTabId(tab.spaceId) === tab.id);
    if (signal.kind === "clear" || !visible) {
      if (this.selection?.tabId === tab.id) this.clearSelection();
      return;
    }
    if (this.shell.showSelectionToolbarFor(tab.view, signal.rect)) {
      this.selection = {
        tabId: tab.id,
        text: signal.text,
        url: this.urlFor(tab),
        title: this.titleFor(tab),
      };
    } else if (this.selection?.tabId === tab.id) {
      this.clearSelection();
    }
  }

  private showActive(spaceId: string): void {
    // Whatever this reshuffle shows, the toolbar's anchor no longer matches
    // what is on screen (tab switch, space switch, split change).
    this.clearSelection();
    const activeId = this.activeTabId(spaceId);
    const splitId = this.splitTabId(spaceId);
    for (const id of this.orderFor(spaceId)) {
      const tab = this.tabs.get(id);
      if (tab === undefined) continue;
      if (tab.internalUrl !== null) {
        // The chrome view under the hole draws this one. Keeping its own view
        // off screen is what uncovers that pane — an attached view, even an
        // empty one, would sit on top of the page we want visible.
        this.shell.hideTabView(tab.view);
      } else if (id === activeId || id === splitId) {
        // A restored/crashed visible tab revives the moment it must be shown.
        if (tab.crashed || tab.discarded) this.revive(tab);
        // Attaching also shows the view (or defers to the layout when its
        // pane is collapsed) — visibility of attached views lives in shell.
        this.shell.attachTabView(
          tab.view,
          splitId === null ? "full" : id === activeId ? "left" : "right",
        );
      } else {
        this.shell.hideTabView(tab.view);
      }
    }
  }

  private materialize(spaceId: string): void {
    if (this.materialized.has(spaceId)) return;
    this.materialized.add(spaceId);
    this.materializing.add(spaceId);
    try {
      this.migrateLegacyTabs(spaceId);
      const pins = new Map(
        this.store.pinsFor(spaceId).map((pin) => [pin.id, pin]),
      );
      for (const state of this.store.syncedTabsFor(spaceId)) {
        if (!isAllowedTabTarget(state.url)) continue;
        const pin = pins.get(state.id);
        const tab = this.buildTab(
          spaceId,
          state.url,
          pin !== undefined,
          state.id,
        );
        tab.faviconUrl = pin?.faviconUrl ?? null;
      }
      if (
        this.store.activeTabFor(spaceId) === null &&
        this.orderFor(spaceId).length > 0
      ) {
        this.store.setActiveTabFor(spaceId, this.orderFor(spaceId)[0] ?? null);
      }
    } finally {
      this.materializing.delete(spaceId);
    }
  }

  /** Promote the pre-realtime URL-only state exactly once per device/space. */
  private migrateLegacyTabs(spaceId: string): void {
    if (this.store.realtimeTabsMigrated(spaceId)) return;
    const existing = this.store.syncedTabsFor(spaceId);
    let rank =
      existing.length === 0
        ? -TAB_ORDER_STEP
        : tabRank(existing[existing.length - 1]?.rank ?? "0");
    for (const pin of this.store.pinsFor(spaceId)) {
      if (
        this.store.hasSyncedTabPresenceRecord(pin.id) ||
        !isAllowedTabUrl(pin.url)
      )
        continue;
      rank += TAB_ORDER_STEP;
      this.store.openSyncedTab({
        id: pin.id,
        spaceId,
        createdAtMs: Date.now(),
        url: canonicalTabUrl(pin.url),
        rank: rank.toString(),
      });
    }
    const occurrences = new Map<string, number>();
    for (const url of this.store.todayTabs(spaceId)) {
      if (!isAllowedTabUrl(url) || url === NEW_TAB_URL) continue;
      const canonical = canonicalTabUrl(url);
      const occurrence = occurrences.get(canonical) ?? 0;
      occurrences.set(canonical, occurrence + 1);
      // Legacy Today state had no identity. Derive one so two Macs migrating
      // the same pre-realtime URL converge on one tab instead of duplicating
      // it; repeated same-URL tabs stay distinct by occurrence index.
      const id = `legacy-${createHash("sha256")
        .update(`${spaceId}\0${canonical}\0${occurrence}`)
        .digest("hex")
        .slice(0, 32)}`;
      if (this.store.hasSyncedTabPresenceRecord(id)) continue;
      rank += TAB_ORDER_STEP;
      this.store.openSyncedTab({
        id,
        spaceId,
        createdAtMs: Date.now(),
        url: canonical,
        rank: rank.toString(),
      });
    }
    this.store.markRealtimeTabsMigrated(spaceId);
  }

  private buildView(spaceId: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: this.spaces.sessionFor(spaceId),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    view.setVisible(false);
    return view;
  }

  private buildTab(
    spaceId: string,
    url: string,
    pinned: boolean,
    id?: string,
    adoptView?: WebContentsView,
  ): TabRecord {
    const canonical = canonicalTabUrl(url);
    // An adopted view (promoted glance) arrives already loaded at `url`, so
    // loadPending below sees the match and skips the reload — the page's
    // scroll, form state, and history survive the promotion.
    const view = adoptView ?? this.buildView(spaceId);
    const tab: TabRecord = {
      id: id ?? randomUUID(),
      spaceId,
      view,
      pinned,
      faviconUrl: null,
      pendingUrl: canonical,
      internalUrl: canonicalInternalUrl(canonical),
      crashed: false,
      discarded: false,
      lastTitle: "",
      lastActiveAtMs: Date.now(),
      thumbnailUrl: null,
      thumbnailAtMs: 0,
      thumbnailCapturing: false,
    };
    this.tabs.set(tab.id, tab);
    this.orderFor(spaceId).push(tab.id);
    this.wireEvents(tab);
    this.loadPending(tab);
    return tab;
  }

  /** Load the canonical pending URL only after session hydration. Registering
   * the expected navigation at this exact point also prevents the delayed
   * load from echoing a stale URL back into realtime workspace state. */
  private loadPending(tab: TabRecord, force = false): void {
    if (
      !this.sessionReadySpaces.has(tab.spaceId) ||
      tab.pendingUrl === NEW_TAB_URL ||
      // An internal page has no document to request — and must never be
      // handed to loadURL, where the space session has no handler for the
      // scheme and would only produce a net error under the settings UI.
      tab.internalUrl !== null ||
      tab.crashed ||
      tab.discarded ||
      tab.view.webContents.isDestroyed()
    ) {
      return;
    }
    const canonical = canonicalTabUrl(tab.pendingUrl);
    if (
      !force &&
      tab.view.webContents.getURL() !== "" &&
      canonicalTabUrl(tab.view.webContents.getURL()) === canonical
    ) {
      return;
    }
    this.expectedNavigationByTab.set(tab.id, canonical);
    void tab.view.webContents.loadURL(canonical).catch(() => undefined);
  }

  /**
   * Drop whatever page a tab was showing, without touching its address. Used
   * when a tab turns into an internal page: the view is hidden either way,
   * but a page left loaded behind it keeps running, keeps its session, and
   * keeps playing whatever it was playing.
   */
  private blankView(tab: TabRecord): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || wc.getURL() === "" || wc.getURL() === NEW_TAB_URL)
      return;
    void wc.loadURL(NEW_TAB_URL).catch(() => undefined);
  }

  /** Rebuild a crashed/discarded tab's view at its last URL (§8.1). */
  private revive(tab: TabRecord): void {
    this.shell.detachTabView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    tab.view = this.buildView(tab.spaceId);
    tab.crashed = false;
    tab.discarded = false;
    this.wireEvents(tab);
    this.loadPending(tab);
    if (
      this.spaces.activeSpaceId === tab.spaceId &&
      (this.activeTabId(tab.spaceId) === tab.id ||
        this.splitTabId(tab.spaceId) === tab.id)
    ) {
      this.showActive(tab.spaceId);
    }
  }

  private wireEvents(tab: TabRecord): void {
    const wc = tab.view.webContents;
    const push = (): void => this.emit(tab.spaceId);
    /**
     * An internal tab's view is blank and hidden, so everything it reports —
     * the about:blank address, the empty title, the load it just finished —
     * describes a page nobody is looking at. Letting any of it through would
     * overwrite the tab's real address in the synced register and relabel the
     * strip, so the observers below bail out wholesale.
     */
    const internal = (): boolean => tab.internalUrl !== null;

    wc.on("page-title-updated", (_event, title) => {
      if (internal()) return;
      tab.lastTitle = title;
      if (tab.pinned) this.store.updatePin(tab.id, { title });
      this.history?.noteTitle(this.urlFor(tab), title);
      push();
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      if (internal()) return;
      tab.faviconUrl = favicons[0] ?? null;
      if (tab.pinned && tab.faviconUrl !== null) {
        this.store.updatePin(tab.id, { faviconUrl: tab.faviconUrl });
      }
      push();
    });
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    // Refresh the preview thumbnail once the page sits still. Visibility is
    // checked at capture time, so a background load never captures a blank.
    wc.on("did-stop-loading", () => this.scheduleThumbnail(tab));
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) this.scheduleThumbnail(tab);
    });
    // The page a selection lived on is going away; drop the toolbar with it.
    wc.on("did-start-loading", () => {
      if (this.selection?.tabId === tab.id) this.clearSelection();
    });
    // Arm the selection watcher once the document exists — fires per load,
    // and the generation bump retires the previous load's loop.
    wc.on("dom-ready", () => this.watchSelection(tab));
    wc.on("did-navigate", (_event, url) => {
      if (internal()) return;
      const canonical = canonicalTabUrl(url);
      tab.pendingUrl = canonical;
      const expected = this.expectedNavigationByTab.get(tab.id);
      if (expected === canonical) this.expectedNavigationByTab.delete(tab.id);
      else {
        this.expectedNavigationByTab.delete(tab.id);
        this.store.updateSyncedTabUrl(tab.id, canonical);
      }
      if (tab.pinned) this.store.updatePin(tab.id, { url });
      this.history?.noteVisit(url, this.titleFor(tab));
      push();
    });
    // SPA route changes are visits too — but only main-frame ones.
    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (internal()) return;
      if (isMainFrame) {
        const canonical = canonicalTabUrl(url);
        tab.pendingUrl = canonical;
        const expected = this.expectedNavigationByTab.get(tab.id);
        if (expected === canonical) this.expectedNavigationByTab.delete(tab.id);
        else {
          this.expectedNavigationByTab.delete(tab.id);
          this.store.updateSyncedTabUrl(tab.id, canonical);
        }
        if (tab.pinned) this.store.updatePin(tab.id, { url: canonical });
        this.history?.noteVisit(canonical, this.titleFor(tab));
      }
      push();
    });

    // Web content may never navigate a tab off http/https — suma://,
    // file://, chrome:// are privileged or local surfaces (§8.1).
    wc.on("will-navigate", (event, url) => {
      if (!isAllowedTabUrl(url)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (!isAllowedTabUrl(url)) event.preventDefault();
    });

    // window.open: authentication ceremonies become real popups with a live
    // window.opener (OAuth breaks without one — see popups.ts); ordinary new
    // pages become tabs in this space; the rest is denied. Rate-limited per
    // source tab either way.
    wc.setWindowOpenHandler((details) =>
      this.popups.handleWindowOpen(details, this.popupCtx(tab)),
    );
    wc.on("did-create-window", (window) =>
      this.popups.adopt(window, this.popupCtx(tab)),
    );

    // Right-click on (or around) a video: offer to save it. The only context
    // menu the app shows — everything else keeps Suma's no-menu default. A
    // link to a video page wins over the page itself, so right-clicking a
    // YouTube link in search results saves the linked video, not the page.
    wc.on("context-menu", (_event, params) => {
      const handler = this.videoSave;
      if (handler === null) return;
      const candidate = [params.linkURL, params.frameURL, params.pageURL]
        .map((raw) => (raw === "" ? null : canonicalVideoUrl(raw)))
        .find((info) => info !== null);
      if (candidate === undefined || candidate === null) return;
      // On non-video X statuses the item downloads nothing useful, so only
      // offer the action when the click was on/near a video for X pages.
      if (candidate.source === "x" && params.mediaType !== "video") return;
      const url = candidate.url;
      Menu.buildFromTemplate([
        {
          label: "Save Video to Suma",
          click: () => handler(url),
        },
      ]).popup({ window: this.shell.window });
    });

    // §8.1 crash recovery: mark the tab; select/reload rebuilds the view at
    // the same URL and clears the flag.
    wc.on("render-process-gone", () => {
      if (internal()) return;
      tab.pendingUrl = this.urlFor(tab);
      tab.lastTitle = this.titleFor(tab);
      tab.crashed = true;
      push();
    });
  }

  private persistPin(tab: TabRecord): void {
    const wc = tab.view.webContents;
    this.store.upsertPin({
      id: tab.id,
      spaceId: tab.spaceId,
      url: wc.isDestroyed() ? tab.pendingUrl : wc.getURL() || tab.pendingUrl,
      title: wc.isDestroyed()
        ? tab.pendingUrl
        : wc.getTitle() || tab.pendingUrl,
      position: this.store.pinsFor(tab.spaceId).length,
    });
  }

  private urlFor(tab: TabRecord): string {
    if (tab.internalUrl !== null) return tab.internalUrl;
    const wc = tab.view.webContents;
    return wc.isDestroyed() ? tab.pendingUrl : wc.getURL() || tab.pendingUrl;
  }

  private titleFor(tab: TabRecord): string {
    // The fallback is unreachable — internalUrl is only ever set from
    // canonicalInternalUrl, so it parses — but the address is the honest
    // stand-in for a page we somehow cannot name, not one page's title.
    if (tab.internalUrl !== null)
      return internalPageTitle(tab.internalUrl) ?? tab.internalUrl;
    const wc = tab.view.webContents;
    return wc.isDestroyed() ? tab.lastTitle : wc.getTitle() || tab.lastTitle;
  }

  private infoFor(
    tab: TabRecord,
    activeId: string | null,
    splitId: string | null,
  ): TabInfo {
    const wc = tab.view.webContents;
    // An internal page has no WebContents state worth reporting: it is never
    // loading, has no session history of its own, and cannot crash or be
    // discarded. Reading the blank view instead would light up the strip's
    // back/forward arrows with whatever the tab used to be.
    const inert = tab.internalUrl !== null || wc.isDestroyed();
    const url = this.urlFor(tab);
    return {
      id: tab.id,
      spaceId: tab.spaceId,
      url,
      title: this.titleFor(tab) || url,
      faviconUrl: tab.internalUrl !== null ? null : tab.faviconUrl,
      isLoading: inert ? false : wc.isLoading(),
      canGoBack: inert ? false : wc.navigationHistory.canGoBack(),
      canGoForward: inert ? false : wc.navigationHistory.canGoForward(),
      pinned: tab.pinned,
      active: tab.id === activeId,
      split: tab.id === splitId,
      crashed: tab.internalUrl !== null ? false : tab.crashed,
      discarded: tab.internalUrl !== null ? false : tab.discarded,
    };
  }

  private emit(spaceId: string): void {
    this.onTabsChanged(spaceId);
  }
}
