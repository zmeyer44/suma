/**
 * Local workspace persistence at userData/workspace.json: spaces, pinned
 * tabs, archives, settings, per-origin overrides, sign-in queue state,
 * permission grants, and materialized local focus. Globally-synchronized
 * categories—including the canonical active space/tab/split layout—are kept
 * as WorkspaceDoc LWW registers stamped by a module-level HLC clock.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  applySettingsDoc,
  DEFAULT_WORKSPACE_SETTINGS,
  HISTORY_MAX_VISITS,
  HISTORY_RETENTION_MS,
  HlcClock,
  workspaceKeyFor,
  type ArchivedTab,
  type HistoryVisit,
  type Hlc,
  type PinnedTab,
  type SpaceMeta,
  type SyncedDeviceActivity,
  type SyncedTabOrder,
  type SyncedTabPresence,
  type SyncedTabUrl,
  type SyncedWorkspaceFocus,
  type WorkspaceDoc,
  type WorkspaceSettings,
} from "@suma/protocol";
import type { DownloadItemInfo, SignInQueueItem } from "../shared/ipc";
import type { StoredSpaceEgress } from "./egress/egress-state";
import type { WorkspaceRegister } from "./sync/workspace-map";

export type OriginOverrideValue = "sync" | "never";

export interface PermissionGrant {
  origin: string;
  permission: string;
  granted: boolean;
  decidedAtMs: number;
}

/** Local LWW register (null doc = tombstone, published as sealedValue: null). */
interface LwwEntry {
  doc: WorkspaceDoc | null;
  hlc: Hlc;
}

interface DeviceLocalState {
  activeSpaceId: string | null;
  /** Legacy attach/detach preference retained for file compatibility. */
  workspaceAttached?: boolean;
  /** False/absent until this installation has inherited its first snapshot. */
  manualSyncInitialized?: boolean;
  /** Account scope for the one-time inheritance marker. A device that was
   * initialized against its local loopback must still inherit after linking. */
  manualSyncAccountId?: string;
  activeTabBySpace: Record<string, string>;
  /** Legacy URL-only Today state, consumed once by realtime-tab migration. */
  todayTabsBySpace: Record<string, string[]>;
  /** One-way migration marker: legacy URL-only Today state has been promoted
   *  into the realtime tab registers for this space. */
  realtimeTabsMigratedBySpace: Record<string, boolean>;
  /** Materialized second split-view pane per space (§6). */
  splitTabBySpace: Record<string, string>;
  /** Origins dynamically promoted from structured fetch to Chromium-native
   * networking after an anti-bot challenge. Device-local by design: network
   * reputation and challenge behavior can differ between Macs. */
  nativeTransportDomains: string[];
}

interface WorkspaceFile {
  version: 1;
  spaces: SpaceMeta[];
  pins: PinnedTab[];
  archives: ArchivedTab[];
  settings: WorkspaceSettings;
  originOverrides: Record<string, OriginOverrideValue>;
  signInQueue: SignInQueueItem[];
  permissionGrants: PermissionGrant[];
  deviceLocal: DeviceLocalState;
  /** Browsing history, newest last (§8.3). Local always; synced only while
   *  `settings.historySyncEnabled` — see addHistoryVisit. */
  history: HistoryVisit[];
  lww: Record<string, LwwEntry>;
  /** Completed-download metadata so the panel survives restart (§8.1). */
  downloads: DownloadItemInfo[];
  /** Per-space egress extras (§8.4): site bypass + media bypass. Policy
   *  itself lives on SpaceMeta; the temporary direct override never persists. */
  egress: Record<string, StoredSpaceEgress>;
}

/** Materialized winner assembled from a tab's independent workspace fields. */
export interface SyncedTabState extends SyncedTabPresence {
  url: string;
  rank: string;
}

const WRITE_DEBOUNCE_MS = 150;

let moduleClock: HlcClock | null = null;

function stamp(deviceId: string): Hlc {
  moduleClock ??= new HlcClock(deviceId);
  return moduleClock.send();
}

/** Fold a remote doc's HLC into the module clock so later local stamps sort after it. */
export function receiveWorkspaceHlc(deviceId: string, hlc: Hlc): void {
  moduleClock ??= new HlcClock(deviceId);
  moduleClock.receive(hlc);
}

/**
 * Drop the clock so the next stamp adopts the CURRENT device id. Only sign-out
 * (§8.2) needs this: it replaces the device identity inside a running process,
 * and a clock still keyed to the erased device would stamp the new account's
 * registers with the old node id.
 */
export function resetWorkspaceHlc(): void {
  moduleClock = null;
}

function emptyFile(): WorkspaceFile {
  return {
    version: 1,
    spaces: [],
    pins: [],
    archives: [],
    settings: { ...DEFAULT_WORKSPACE_SETTINGS },
    originOverrides: {},
    signInQueue: [],
    permissionGrants: [],
    deviceLocal: {
      activeSpaceId: null,
      workspaceAttached: true,
      manualSyncInitialized: false,
      activeTabBySpace: {},
      todayTabsBySpace: {},
      realtimeTabsMigratedBySpace: {},
      splitTabBySpace: {},
      nativeTransportDomains: [],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

export class WorkspaceStore {
  private readonly file: WorkspaceFile;
  private writeTimer: NodeJS.Timeout | null = null;
  private readonly docListeners = new Set<(keys: string[]) => void>();

  constructor(
    private readonly filePath: string,
    private readonly deviceId: string,
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.file = this.read();
  }

  /** Fires after every LOCAL globally-synced doc mutation (never remote applies). */
  onDocsChanged(listener: (keys: string[]) => void): () => void {
    this.docListeners.add(listener);
    return () => this.docListeners.delete(listener);
  }

  /* -------------------------------- spaces ------------------------------- */

  spaces(): SpaceMeta[] {
    return this.file.spaces.map((space) => ({ ...space }));
  }

  upsertSpace(space: SpaceMeta): void {
    const index = this.file.spaces.findIndex((s) => s.id === space.id);
    if (index >= 0) this.file.spaces[index] = { ...space };
    else this.file.spaces.push({ ...space });
    this.recordDoc({ kind: "space", space });
  }

  /** Remove a space and tombstone it so the deletion propagates to every
   *  device (§8.3) — otherwise a peer just re-publishes it back. Pins of the
   *  space are tombstoned too, so no orphaned pins resurrect it in spirit. */
  removeSpace(id: string): void {
    const index = this.file.spaces.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.file.spaces.splice(index, 1);
    for (const pin of this.file.pins.filter((p) => p.spaceId === id)) {
      this.file.pins = this.file.pins.filter((p) => p.id !== pin.id);
      this.recordTombstone(`pin:${pin.id}`);
    }
    for (const tab of this.syncedTabsFor(id)) this.closeSyncedTab(tab.id);
    this.recordTombstone(`space:${id}`);
  }

  /* ---------------------------- space folders ---------------------------- */

  /**
   * spaceId → folder name in the shared filesystem. Materialized straight
   * from the LWW registers (like tab presence): the binding is authoritative
   * and synced, so every device derives a folder from the name at most once
   * and looks it up ever after.
   */
  spaceFolders(): Record<string, string> {
    const folders: Record<string, string> = {};
    for (const entry of Object.values(this.file.lww)) {
      const doc = entry.doc;
      if (doc !== null && doc.kind === "spaceFolder") {
        folders[doc.spaceId] = doc.folder;
      }
    }
    return folders;
  }

  setSpaceFolder(spaceId: string, folder: string): void {
    this.recordDoc({ kind: "spaceFolder", spaceId, folder });
  }

  /** Drop the binding (space deleted). The FOLDER is deliberately kept —
   *  user data outlives the persona that named it. */
  removeSpaceFolder(spaceId: string): void {
    this.recordTombstone(`spaceFolder:${spaceId}`);
  }

  /* --------------------------------- pins -------------------------------- */

  pinsFor(spaceId: string): PinnedTab[] {
    return this.file.pins
      .filter((pin) => pin.spaceId === spaceId)
      .sort((a, b) => a.position - b.position)
      .map((pin) => ({ ...pin }));
  }

  upsertPin(pin: PinnedTab): void {
    const index = this.file.pins.findIndex((p) => p.id === pin.id);
    if (index >= 0) this.file.pins[index] = { ...pin };
    else this.file.pins.push({ ...pin });
    this.recordDoc({ kind: "pin", pin });
  }

  updatePin(
    id: string,
    patch: Partial<Pick<PinnedTab, "url" | "title" | "faviconUrl">>,
  ): void {
    const pin = this.file.pins.find((p) => p.id === id);
    if (pin === undefined) return;
    Object.assign(pin, patch);
    this.recordDoc({ kind: "pin", pin });
  }

  removePin(id: string): void {
    const index = this.file.pins.findIndex((p) => p.id === id);
    if (index < 0) return;
    this.file.pins.splice(index, 1);
    // Deletions keep an LWW tombstone, published as sealedValue: null (§8.3).
    this.recordTombstone(`pin:${id}`);
  }

  /* ----------------------- realtime open tabs (§8.3) --------------------- */

  /** Current live-tab winners, ordered by exact integer rank then stable id. */
  syncedTabsFor(spaceId: string): SyncedTabState[] {
    const presence = new Map<string, SyncedTabPresence>();
    const urls = new Map<string, SyncedTabUrl>();
    const orders = new Map<string, SyncedTabOrder>();
    for (const entry of Object.values(this.file.lww)) {
      const doc = entry.doc;
      if (doc === null) continue;
      switch (doc.kind) {
        case "tabPresence":
          if (doc.tab.spaceId === spaceId)
            presence.set(doc.tab.id, { ...doc.tab });
          break;
        case "tabUrl":
          urls.set(doc.tab.tabId, { ...doc.tab });
          break;
        case "tabOrder":
          if (doc.tab.spaceId === spaceId)
            orders.set(doc.tab.tabId, { ...doc.tab });
          break;
        default:
          break;
      }
    }
    const out: SyncedTabState[] = [];
    for (const tab of presence.values()) {
      out.push({
        ...tab,
        url: urls.get(tab.id)?.url ?? "about:blank",
        rank: orders.get(tab.id)?.rank ?? "0",
      });
    }
    return out.sort((a, b) => {
      const aRank = this.parseRank(a.rank);
      const bRank = this.parseRank(b.rank);
      if (aRank < bRank) return -1;
      if (aRank > bRank) return 1;
      return a.id.localeCompare(b.id);
    });
  }

  /** Includes a live presence value or its close tombstone. */
  hasSyncedTabPresenceRecord(tabId: string): boolean {
    return this.file.lww[`tab:${tabId}:presence`] !== undefined;
  }

  /** Publish a new tab's independent fields as one listener batch. */
  openSyncedTab(tab: SyncedTabState): void {
    this.recordDocs([
      {
        kind: "tabPresence",
        tab: { id: tab.id, spaceId: tab.spaceId, createdAtMs: tab.createdAtMs },
      },
      { kind: "tabUrl", tab: { tabId: tab.id, url: tab.url } },
      {
        kind: "tabOrder",
        tab: { tabId: tab.id, spaceId: tab.spaceId, rank: tab.rank },
      },
    ]);
  }

  updateSyncedTabUrl(tabId: string, url: string): void {
    const current = this.file.lww[`tab:${tabId}:url`]?.doc;
    if (current?.kind === "tabUrl" && current.tab.url === url) return;
    this.recordDoc({ kind: "tabUrl", tab: { tabId, url } });
  }

  updateSyncedTabOrder(tabId: string, spaceId: string, rank: string): void {
    const normalized = this.parseRank(rank).toString();
    const current = this.file.lww[`tab:${tabId}:order`]?.doc;
    if (current?.kind === "tabOrder" && current.tab.rank === normalized) return;
    this.recordDoc({
      kind: "tabOrder",
      tab: { tabId, spaceId, rank: normalized },
    });
  }

  updateSyncedTabOrders(
    values: ReadonlyArray<{ tabId: string; spaceId: string; rank: string }>,
  ): void {
    const docs: WorkspaceDoc[] = [];
    for (const value of values) {
      const rank = this.parseRank(value.rank).toString();
      const current = this.file.lww[`tab:${value.tabId}:order`]?.doc;
      if (current?.kind === "tabOrder" && current.tab.rank === rank) continue;
      docs.push({ kind: "tabOrder", tab: { ...value, rank } });
    }
    this.recordDocs(docs);
  }

  closeSyncedTab(tabId: string): void {
    const key = `tab:${tabId}:presence`;
    if (this.file.lww[key]?.doc === null) return;
    this.recordTombstone(key);
  }

  /* ----------------------- canonical workspace focus -------------------- */

  syncedWorkspaceFocus(): SyncedWorkspaceFocus | null {
    const doc = this.file.lww["workspace:focus"]?.doc;
    return doc?.kind === "workspaceFocus" ? { ...doc.focus } : null;
  }

  /** Publish the currently materialized local focus as the shared winner. */
  publishCurrentWorkspaceFocus(): void {
    const activeSpaceId = this.activeSpaceId();
    this.updateSyncedWorkspaceFocus({
      activeSpaceId,
      activeTabId:
        activeSpaceId === null ? null : this.activeTabFor(activeSpaceId),
      splitTabId:
        activeSpaceId === null ? null : this.splitTabFor(activeSpaceId),
    });
  }

  updateSyncedWorkspaceFocus(focus: SyncedWorkspaceFocus): void {
    const current = this.syncedWorkspaceFocus();
    if (
      current?.activeSpaceId === focus.activeSpaceId &&
      current.activeTabId === focus.activeTabId &&
      current.splitTabId === focus.splitTabId
    ) {
      return;
    }
    this.recordDoc({ kind: "workspaceFocus", focus: { ...focus } });
  }

  /* ---------------------- device collaboration identity ----------------- */

  syncedDeviceActivities(): SyncedDeviceActivity[] {
    const activities: SyncedDeviceActivity[] = [];
    for (const entry of Object.values(this.file.lww)) {
      if (entry.doc?.kind === "deviceActivity")
        activities.push({ ...entry.doc.activity });
    }
    return activities;
  }

  syncedDeviceActivity(deviceId: string): SyncedDeviceActivity | null {
    const doc = this.file.lww[`device:${deviceId}:activity`]?.doc;
    return doc?.kind === "deviceActivity" ? { ...doc.activity } : null;
  }

  updateSyncedDeviceActivity(activity: SyncedDeviceActivity): void {
    const current = this.syncedDeviceActivity(activity.deviceId);
    if (
      current !== null &&
      current.identityDeviceId === activity.identityDeviceId &&
      current.controlDeviceId === activity.controlDeviceId &&
      current.name === activity.name &&
      current.platform === activity.platform
    ) {
      return;
    }
    this.recordDoc({ kind: "deviceActivity", activity: { ...activity } });
  }

  /* ------------------------------- archives ------------------------------ */

  addArchive(archive: ArchivedTab): void {
    this.file.archives.push({ ...archive });
    this.recordDoc({ kind: "archive", archive });
  }

  archives(): ArchivedTab[] {
    return this.file.archives.map((archive) => ({ ...archive }));
  }

  /* ------------------------------- settings ------------------------------ */

  settings(): WorkspaceSettings {
    return { ...this.file.settings };
  }

  updateSettings(patch: Partial<WorkspaceSettings>): WorkspaceSettings {
    this.file.settings = { ...this.file.settings, ...patch };
    // One LWW register per field: record ONLY the fields the caller set, so a
    // concurrent edit to another field can never revert them and keyMode is
    // published (and thus can change on peers) only when keyMode was set (§8.2).
    if (patch.historySyncEnabled !== undefined) {
      this.recordDoc({
        kind: "settings",
        field: "historySync",
        historySyncEnabled: this.file.settings.historySyncEnabled,
      });
    }
    if (patch.autoArchiveAfterHours !== undefined) {
      this.recordDoc({
        kind: "settings",
        field: "autoArchive",
        autoArchiveAfterHours: this.file.settings.autoArchiveAfterHours,
      });
    }
    if (patch.keyMode !== undefined) {
      this.recordDoc({
        kind: "settings",
        field: "keyMode",
        keyMode: this.file.settings.keyMode,
      });
    }
    if (patch.newTabUrl !== undefined) {
      this.recordDoc({
        kind: "settings",
        field: "newTabUrl",
        newTabUrl: this.file.settings.newTabUrl,
      });
    }
    return this.settings();
  }

  /* ------------------------- browsing history (§8.3) ---------------------- */

  /** Newest first. */
  historyVisits(): HistoryVisit[] {
    return [...this.file.history]
      .sort((a, b) => b.atMs - a.atMs)
      .map((v) => ({ ...v }));
  }

  /**
   * Record a visit. Always stored locally; PUBLISHED (as a sealed LWW doc at
   * `history:<id>`) only while history sync is enabled — enabling the toggle
   * syncs visits from that moment forward, never retroactively.
   */
  addHistoryVisit(visit: HistoryVisit): void {
    this.file.history.push({ ...visit });
    this.pruneHistory(visit.atMs);
    if (this.file.settings.historySyncEnabled) {
      this.recordDoc({ kind: "history", visit });
    } else {
      this.scheduleWrite();
    }
  }

  /** Late title for a recorded visit (pages title after they navigate). */
  updateHistoryVisitTitle(id: string, title: string): void {
    const visit = this.file.history.find((v) => v.id === id);
    if (visit === undefined || visit.title === title) return;
    visit.title = title;
    // Republish only if this visit was published — an unsynced visit must not
    // leak via its title update.
    if (
      this.file.settings.historySyncEnabled &&
      this.file.lww[`history:${id}`] !== undefined
    ) {
      this.recordDoc({ kind: "history", visit });
    } else {
      this.scheduleWrite();
    }
  }

  /**
   * Explicit clear — the one case that TOMBSTONES (deletes on every device)
   * rather than prunes. Visits that were never published just vanish locally.
   */
  clearHistory(): void {
    const ids = this.file.history.map((v) => v.id);
    this.file.history = [];
    const keys: string[] = [];
    for (const id of ids) {
      const key = `history:${id}`;
      if (this.file.lww[key] !== undefined) {
        this.file.lww[key] = { doc: null, hlc: stamp(this.deviceId) };
        keys.push(key);
      }
    }
    this.scheduleWrite();
    if (keys.length > 0) this.notifyDocs(keys);
  }

  /**
   * Retention (§8.3): drop visits past HISTORY_RETENTION_MS or beyond
   * HISTORY_MAX_VISITS (oldest first), and their registers WITHOUT tombstones
   * — every device applies the same rule locally, so nothing needs to sync.
   */
  private pruneHistory(nowMs: number): void {
    const cutoff = nowMs - HISTORY_RETENTION_MS;
    let keep = this.file.history.filter((v) => v.atMs >= cutoff);
    if (keep.length > HISTORY_MAX_VISITS) {
      keep = [...keep]
        .sort((a, b) => a.atMs - b.atMs)
        .slice(keep.length - HISTORY_MAX_VISITS);
    }
    const kept = new Set(keep.map((v) => v.id));
    this.file.history = keep;
    // Sweep registers for pruned visits — including hydration echoes of
    // visits pruned before they arrived. Tombstones stay: they are explicit
    // clears still propagating, not retention.
    for (const key of Object.keys(this.file.lww)) {
      if (!key.startsWith("history:")) continue;
      if (this.file.lww[key]?.doc === null) continue;
      if (!kept.has(key.slice("history:".length))) delete this.file.lww[key];
    }
  }

  /* --------------------------- origin overrides -------------------------- */

  originOverrides(): Record<string, OriginOverrideValue> {
    return { ...this.file.originOverrides };
  }

  setOriginOverride(host: string, value: OriginOverrideValue | null): void {
    if (value === null) delete this.file.originOverrides[host];
    else this.file.originOverrides[host] = value;
    this.scheduleWrite();
  }

  /* ----------------------------- sign-in queue --------------------------- */

  signInQueue(): SignInQueueItem[] {
    return this.file.signInQueue.map((item) => ({ ...item }));
  }

  setSignInQueue(queue: SignInQueueItem[]): void {
    this.file.signInQueue = queue.map((item) => ({ ...item }));
    this.scheduleWrite();
  }

  markSignedIn(domain: string): SignInQueueItem[] {
    for (const item of this.file.signInQueue) {
      if (item.domain === domain) item.done = true;
    }
    this.scheduleWrite();
    return this.signInQueue();
  }

  /* --------------------------- permission grants ------------------------- */

  permissionDecision(origin: string, permission: string): boolean | null {
    const grant = this.file.permissionGrants.find(
      (g) => g.origin === origin && g.permission === permission,
    );
    return grant === undefined ? null : grant.granted;
  }

  setPermissionDecision(
    origin: string,
    permission: string,
    granted: boolean,
  ): void {
    const existing = this.file.permissionGrants.find(
      (g) => g.origin === origin && g.permission === permission,
    );
    if (existing !== undefined) {
      existing.granted = granted;
      existing.decidedAtMs = Date.now();
    } else {
      this.file.permissionGrants.push({
        origin,
        permission,
        granted,
        decidedAtMs: Date.now(),
      });
    }
    this.scheduleWrite();
  }

  /* ------------------------ device-local state (§8.3) --------------------- */

  activeSpaceId(): string | null {
    return this.file.deviceLocal.activeSpaceId;
  }

  setActiveSpaceId(spaceId: string | null): void {
    this.file.deviceLocal.activeSpaceId = spaceId;
    this.scheduleWrite();
  }

  activeTabFor(spaceId: string): string | null {
    return this.file.deviceLocal.activeTabBySpace[spaceId] ?? null;
  }

  setActiveTabFor(spaceId: string, tabId: string | null): void {
    if (tabId === null) delete this.file.deviceLocal.activeTabBySpace[spaceId];
    else this.file.deviceLocal.activeTabBySpace[spaceId] = tabId;
    this.scheduleWrite();
  }

  /** Materialized split pane; local until the next explicit reconciliation. */
  splitTabFor(spaceId: string): string | null {
    return this.file.deviceLocal.splitTabBySpace[spaceId] ?? null;
  }

  setSplitTabFor(spaceId: string, tabId: string | null): void {
    if (tabId === null) delete this.file.deviceLocal.splitTabBySpace[spaceId];
    else this.file.deviceLocal.splitTabBySpace[spaceId] = tabId;
    this.scheduleWrite();
  }

  /** Legacy URL-only Today state retained solely for one-way migration. */
  todayTabs(spaceId: string): string[] {
    return [...(this.file.deviceLocal.todayTabsBySpace[spaceId] ?? [])];
  }

  setTodayTabs(spaceId: string, urls: string[]): void {
    const current = this.file.deviceLocal.todayTabsBySpace[spaceId] ?? [];
    if (
      current.length === urls.length &&
      current.every((url, i) => url === urls[i])
    )
      return;
    this.file.deviceLocal.todayTabsBySpace[spaceId] = [...urls];
    this.scheduleWrite();
  }

  realtimeTabsMigrated(spaceId: string): boolean {
    return this.file.deviceLocal.realtimeTabsMigratedBySpace[spaceId] === true;
  }

  markRealtimeTabsMigrated(spaceId: string): void {
    if (this.realtimeTabsMigrated(spaceId)) return;
    this.file.deviceLocal.realtimeTabsMigratedBySpace[spaceId] = true;
    this.scheduleWrite();
  }

  nativeTransportDomains(): string[] {
    return [...this.file.deviceLocal.nativeTransportDomains];
  }

  addNativeTransportDomain(domain: string): void {
    if (this.file.deviceLocal.nativeTransportDomains.includes(domain)) return;
    this.file.deviceLocal.nativeTransportDomains.push(domain);
    this.file.deviceLocal.nativeTransportDomains.sort();
    this.scheduleWrite();
  }

  /* ------------------------------- downloads ------------------------------ */

  downloads(): DownloadItemInfo[] {
    return this.file.downloads.map((item) => ({ ...item }));
  }

  setDownloads(items: DownloadItemInfo[]): void {
    this.file.downloads = items.map((item) => ({ ...item }));
    this.scheduleWrite();
  }

  /* -------------------------- egress config (§8.4) ------------------------ */

  egressConfig(spaceId: string): StoredSpaceEgress | null {
    const config = this.file.egress[spaceId];
    return config === undefined
      ? null
      : { siteBypass: [...config.siteBypass], mediaBypass: config.mediaBypass };
  }

  setEgressConfig(spaceId: string, config: StoredSpaceEgress): void {
    this.file.egress[spaceId] = {
      siteBypass: [...config.siteBypass],
      mediaBypass: config.mediaBypass,
    };
    this.scheduleWrite();
  }

  /* ------------------------- workspace sync (§8.3) ------------------------ */

  manualSyncInitialized(accountId?: string): boolean {
    if (this.file.deviceLocal.manualSyncInitialized !== true) return false;
    const initializedAccountId = this.file.deviceLocal.manualSyncAccountId;
    // Files written before account-scoped initialization already belonged to
    // their enrolled account; retain that state during migration.
    return (
      accountId === undefined ||
      initializedAccountId === undefined ||
      initializedAccountId === accountId
    );
  }

  markManualSyncInitialized(accountId?: string): void {
    if (
      this.manualSyncInitialized(accountId) &&
      (accountId === undefined ||
        this.file.deviceLocal.manualSyncAccountId === accountId)
    ) {
      return;
    }
    this.file.deviceLocal.manualSyncInitialized = true;
    if (accountId !== undefined) {
      this.file.deviceLocal.manualSyncAccountId = accountId;
    }
    this.scheduleWrite();
  }

  lwwRegisters(): Record<string, WorkspaceRegister> {
    const out: Record<string, WorkspaceRegister> = {};
    for (const [key, entry] of Object.entries(this.file.lww)) {
      out[key] = { doc: entry.doc, hlc: entry.hlc };
    }
    return out;
  }

  /** Stamp an encrypted sync envelope without mutating the materialized LWW
   * registers. Device-scoped snapshots have their own server key and clock,
   * so saving one must never make the canonical workspace look newer. */
  nextSyncHlc(): Hlc {
    return stamp(this.deviceId);
  }

  /**
   * Replace only the registers governed by workspace attachment. Tabs and
   * focus materialize directly from these values, so Pull/Merge can swap the
   * local view atomically without disturbing spaces, settings, or devices.
   */
  replaceAttachmentRegisters(
    registers: Readonly<Record<string, WorkspaceRegister>>,
  ): void {
    for (const key of Object.keys(this.file.lww)) {
      if (key.startsWith("tab:") || key === "workspace:focus") {
        delete this.file.lww[key];
      }
    }
    for (const [key, register] of Object.entries(registers)) {
      if (!key.startsWith("tab:") && key !== "workspace:focus") continue;
      this.file.lww[key] = { doc: register.doc, hlc: register.hlc };
    }
    this.scheduleWrite();
  }

  /** Restamp selected attachment registers as fresh local winners and emit once. */
  publishAttachmentRegisters(keys: readonly string[]): void {
    const changed: string[] = [];
    for (const key of keys) {
      const current = this.file.lww[key];
      if (current === undefined) continue;
      current.hlc = stamp(this.deviceId);
      changed.push(key);
    }
    if (changed.length === 0) return;
    this.scheduleWrite();
    this.notifyDocs(changed);
  }

  /**
   * Adopt a remote LWW winner: mutate the concrete category and store the
   * register under the REMOTE HLC. Deliberately never notifies doc listeners
   * — applying a remote doc must not republish it (echo guard, §8.3).
   */
  applyRemoteDoc(key: string, value: WorkspaceDoc | null, hlc: Hlc): void {
    if (value === null) {
      if (key.startsWith("space:")) {
        const id = key.slice("space:".length);
        this.file.spaces = this.file.spaces.filter((s) => s.id !== id);
      } else if (key.startsWith("pin:")) {
        const id = key.slice("pin:".length);
        this.file.pins = this.file.pins.filter((p) => p.id !== id);
      } else if (key.startsWith("archive:")) {
        const id = key.slice("archive:".length);
        this.file.archives = this.file.archives.filter((a) => a.id !== id);
      } else if (key.startsWith("history:")) {
        const id = key.slice("history:".length);
        this.file.history = this.file.history.filter((v) => v.id !== id);
      }
    } else {
      switch (value.kind) {
        case "space": {
          const index = this.file.spaces.findIndex(
            (s) => s.id === value.space.id,
          );
          if (index >= 0) this.file.spaces[index] = { ...value.space };
          else this.file.spaces.push({ ...value.space });
          break;
        }
        case "pin": {
          const index = this.file.pins.findIndex((p) => p.id === value.pin.id);
          if (index >= 0) this.file.pins[index] = { ...value.pin };
          else this.file.pins.push({ ...value.pin });
          break;
        }
        case "archive": {
          const index = this.file.archives.findIndex(
            (a) => a.id === value.archive.id,
          );
          if (index >= 0) this.file.archives[index] = { ...value.archive };
          else this.file.archives.push({ ...value.archive });
          break;
        }
        case "history": {
          // Hydration can echo visits this device already pruned; retention
          // re-drops them, so store-then-prune keeps every device convergent.
          const index = this.file.history.findIndex(
            (v) => v.id === value.visit.id,
          );
          if (index >= 0) this.file.history[index] = { ...value.visit };
          else this.file.history.push({ ...value.visit });
          this.pruneHistory(Date.now());
          break;
        }
        case "settings":
          // Per-field register: fold in exactly this field's winner, leaving
          // every other settings field (notably keyMode) untouched (§8.2).
          this.file.settings = applySettingsDoc(this.file.settings, value);
          break;
        case "tabPresence":
        case "tabUrl":
        case "tabOrder":
        case "workspaceFocus":
        case "deviceActivity":
        case "spaceFolder":
          // Realtime tabs, focus, device identities, and space-folder
          // bindings materialize directly from their independent LWW
          // registers.
          break;
      }
    }
    this.file.lww[key] = { doc: value, hlc };
    this.scheduleWrite();
  }

  /* ------------------------------ persistence ---------------------------- */

  flushSync(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.write();
  }

  private recordDoc(doc: WorkspaceDoc): void {
    const key = workspaceKeyFor(doc);
    this.file.lww[key] = { doc, hlc: stamp(this.deviceId) };
    this.scheduleWrite();
    this.notifyDocs([key]);
  }

  private recordDocs(docs: readonly WorkspaceDoc[]): void {
    if (docs.length === 0) return;
    const keys: string[] = [];
    for (const doc of docs) {
      const key = workspaceKeyFor(doc);
      this.file.lww[key] = { doc, hlc: stamp(this.deviceId) };
      keys.push(key);
    }
    this.scheduleWrite();
    this.notifyDocs(keys);
  }

  private recordTombstone(key: string): void {
    this.file.lww[key] = { doc: null, hlc: stamp(this.deviceId) };
    this.scheduleWrite();
    this.notifyDocs([key]);
  }

  private notifyDocs(keys: string[]): void {
    for (const listener of this.docListeners) listener(keys);
  }

  private parseRank(value: string): bigint {
    return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.write();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  private write(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    renameSync(tmp, this.filePath);
  }

  private read(): WorkspaceFile {
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as Partial<WorkspaceFile>;
      if (parsed.version !== 1) return emptyFile();
      const base = emptyFile();
      const lww = { ...(parsed.lww ?? base.lww) };
      // Drop the legacy whole-object "settings" register (pre per-field split,
      // §8.2) so it is never republished under the now-ambiguous key.
      delete lww["settings"];
      return {
        ...base,
        ...parsed,
        version: 1,
        settings: { ...base.settings, ...parsed.settings },
        deviceLocal: { ...base.deviceLocal, ...parsed.deviceLocal },
        lww,
      };
    } catch {
      return emptyFile();
    }
  }
}
