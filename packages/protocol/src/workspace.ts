/**
 * Workspace-state synchronization model (PRD §8.3, "Workspace-state
 * synchronization"). Every state category has exactly one canonical location
 * and a defined ownership rule — without ownership rules, two active Macs
 * constantly rearrange and archive each other's workspace.
 *
 *   Spaces, archives, settings                         → globally synchronized
 *   Open tabs, URLs/order, active/split focus          → device-scoped restore point
 *   Canonical tab/focus state                          → explicit Push/Merge only
 *   Authentication state                     → per-origin continuity policy (§4)
 *   Browsing history                         → encrypted sync, OFF by default
 */

import { compareHlc, type Hlc } from "./hlc.js";

export type WorkspaceScope = "global" | "device-local";

export type EgressPolicy = "suma-ip" | "direct";

export interface SpaceMeta {
  id: string;
  name: string;
  color: string;
  icon?: string;
  position: number;
  egressPolicy: EgressPolicy;
  createdAtMs: number;
}

export interface PinnedTab {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  position: number;
}

/**
 * A live tab is split across three independent LWW registers. Keeping
 * presence, URL, and order separate is what lets two devices navigate and
 * reorder the same tab concurrently without either change clobbering the
 * other during an explicit merge. Presence is tombstoned on close inside
 * canonical registers and atomic device snapshots, so an older snapshot
 * cannot silently become canonical.
 */
export interface SyncedTabPresence {
  id: string;
  spaceId: string;
  createdAtMs: number;
}

export interface SyncedTabUrl {
  tabId: string;
  url: string;
}

export interface SyncedTabOrder {
  tabId: string;
  spaceId: string;
  /** Arbitrary-precision signed integer encoded in base 10. */
  rank: string;
}

/**
 * A device's encrypted collaboration identity. The friendly name is repeated
 * here so local/dev SessionHub presence remains human-readable when no
 * control-plane registry is available.
 */
export interface SyncedDeviceActivity {
  /** Id currently used by SessionHub presence (control id when enrolled). */
  deviceId: string;
  /** Stable local key identity and optional control-plane enrollment id. */
  identityDeviceId: string;
  controlDeviceId: string | null;
  name: string;
  platform: string;
  updatedAtMs: number;
}

/**
 * The canonical workspace focus. Like tab presence, URL, and rank, it changes
 * only during explicit reconciliation; each Mac separately auto-saves its
 * current focus inside its device-scoped workspace snapshot.
 */
export interface SyncedWorkspaceFocus {
  activeSpaceId: string | null;
  activeTabId: string | null;
  splitTabId: string | null;
}

export interface ArchivedTab {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  archivedAtMs: number;
}

export interface WorkspaceSettings {
  /** Browsing-history sync is off by default (§8.3). */
  historySyncEnabled: boolean;
  autoArchiveAfterHours: number;
  /** Key mode is a visible security state, never a silent downgrade (§8.2). */
  keyMode: "e2ee" | "suma-managed";
  /**
   * The page a new tab opens. Empty string means a blank tab. Only http/https
   * is loadable in a tab, so main re-validates this before every use rather
   * than trusting the stored (and synced) value.
   */
  newTabUrl: string;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  historySyncEnabled: false,
  autoArchiveAfterHours: 12,
  keyMode: "e2ee",
  newTabUrl: "https://www.google.com",
};

/**
 * One browsing-history visit (§8.3: "user-configurable encrypted sync, off by
 * default"). Synced as its own LWW register at `history:<id>`, sealed like
 * every other workspace doc — the server never sees a URL or title. Visits
 * are recorded locally regardless of the toggle; they are PUBLISHED only
 * while `historySyncEnabled` is true, from the moment it was enabled.
 */
export interface HistoryVisit {
  id: string;
  url: string;
  title: string;
  atMs: number;
}

/** Retention, applied symmetrically on every device: visits older than this
 *  (or beyond the cap, oldest first) are pruned locally, registers included.
 *  Pruning is retention, not deletion — only an explicit clear tombstones. */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_VISITS = 2000;

/**
 * Settings fields are synced as INDEPENDENT LWW registers, one doc key each
 * ("settings:historySync", "settings:autoArchive", "settings:keyMode",
 * "settings:newTabUrl"). A
 * single whole-object "settings" register let a concurrent edit to any field
 * clobber every other field and, worse, silently flip/downgrade keyMode
 * across devices — a §8.2 beta-gate violation ("zero silent
 * E2EE→server-readable transitions"). Per-field registers converge each field
 * on its own HLC, so keyMode only moves when keyMode itself was written.
 */
export type WorkspaceSettingsField =
  | "historySync"
  | "autoArchive"
  | "keyMode"
  | "newTabUrl";

/** Typed workspace document — the plaintext inside a sealed WorkspaceRecordWire. */
export type WorkspaceDoc =
  | { kind: "space"; space: SpaceMeta }
  | { kind: "pin"; pin: PinnedTab }
  | { kind: "tabPresence"; tab: SyncedTabPresence }
  | { kind: "tabUrl"; tab: SyncedTabUrl }
  | { kind: "tabOrder"; tab: SyncedTabOrder }
  | { kind: "workspaceFocus"; focus: SyncedWorkspaceFocus }
  | { kind: "deviceActivity"; activity: SyncedDeviceActivity }
  | { kind: "archive"; archive: ArchivedTab }
  | { kind: "history"; visit: HistoryVisit }
  | { kind: "settings"; field: "historySync"; historySyncEnabled: boolean }
  | { kind: "settings"; field: "autoArchive"; autoArchiveAfterHours: number }
  | {
      kind: "settings";
      field: "keyMode";
      keyMode: WorkspaceSettings["keyMode"];
    }
  | { kind: "settings"; field: "newTabUrl"; newTabUrl: string };

/** A single per-field settings doc (its own LWW register). */
export type WorkspaceSettingsDoc = Extract<WorkspaceDoc, { kind: "settings" }>;

export function workspaceKeyFor(doc: WorkspaceDoc): string {
  switch (doc.kind) {
    case "space":
      return `space:${doc.space.id}`;
    case "pin":
      return `pin:${doc.pin.id}`;
    case "tabPresence":
      return `tab:${doc.tab.id}:presence`;
    case "tabUrl":
      return `tab:${doc.tab.tabId}:url`;
    case "tabOrder":
      return `tab:${doc.tab.tabId}:order`;
    case "workspaceFocus":
      return "workspace:focus";
    case "deviceActivity":
      return `device:${doc.activity.deviceId}:activity`;
    case "archive":
      return `archive:${doc.archive.id}`;
    case "history":
      return `history:${doc.visit.id}`;
    case "settings":
      return `settings:${doc.field}`;
  }
}

/** Every settings field as its own LWW doc — hydration/reconcile mapping. */
export function settingsDocs(
  settings: WorkspaceSettings,
): WorkspaceSettingsDoc[] {
  return [
    {
      kind: "settings",
      field: "historySync",
      historySyncEnabled: settings.historySyncEnabled,
    },
    {
      kind: "settings",
      field: "autoArchive",
      autoArchiveAfterHours: settings.autoArchiveAfterHours,
    },
    { kind: "settings", field: "keyMode", keyMode: settings.keyMode },
    { kind: "settings", field: "newTabUrl", newTabUrl: settings.newTabUrl },
  ];
}

/** Fold one per-field settings doc into a settings object (LWW winner apply). */
export function applySettingsDoc(
  settings: WorkspaceSettings,
  doc: WorkspaceSettingsDoc,
): WorkspaceSettings {
  switch (doc.field) {
    case "historySync":
      return { ...settings, historySyncEnabled: doc.historySyncEnabled };
    case "autoArchive":
      return { ...settings, autoArchiveAfterHours: doc.autoArchiveAfterHours };
    case "keyMode":
      return { ...settings, keyMode: doc.keyMode };
    case "newTabUrl":
      return { ...settings, newTabUrl: doc.newTabUrl };
  }
}

export interface LwwRegister<T> {
  value: T | null;
  hlc: Hlc;
}

/** LWW merge for globally-synchronized workspace records. Returns the winner. */
export function mergeLww<T>(
  current: LwwRegister<T> | undefined,
  incoming: LwwRegister<T>,
): LwwRegister<T> {
  if (!current) return incoming;
  return compareHlc(incoming.hlc, current.hlc) > 0 ? incoming : current;
}
