import { create } from "zustand";
import { DEFAULT_WORKSPACE_SETTINGS } from "@suma/protocol";
import {
  isInternalPage,
  settingsUrl,
  TERMINAL_URL,
  type InternalPage,
  type SettingsSection,
} from "../../shared/internal-pages";
import { DEFAULT_SPLIT_RATIO } from "../../shared/pane-layout";
import {
  clampChatWidth,
  getStoredChatOpen,
  getStoredChatWidth,
  storeChatOpen,
  storeChatWidth,
  type ChatAttachment,
} from "./lib/chat";
import { speakText } from "./lib/audio";
import { hostOf } from "./lib/url";
import { speechTitle } from "../../shared/tts";
import type { SelectionActionPayload } from "../../shared/selection";
import {
  clampExplorerWidth,
  clampTerminalHeight,
  dropIdeBuffer,
  getStoredIdeLayout,
  storeIdeLayout,
  type IdePanel,
} from "./lib/ide";
import {
  clampSavesWidth,
  getStoredSavesOpen,
  getStoredSavesWidth,
  storeSavesOpen,
  storeSavesWidth,
} from "./lib/saves";
import {
  clampVideosWidth,
  getStoredVideosOpen,
  getStoredVideosWidth,
  storeVideosOpen,
  storeVideosWidth,
} from "./lib/videos";
import { clearStoredTheme } from "./lib/theme";
import { toast, type ToastType } from "./components/ui/toast";
import type { HistoryVisit, Transfer, WorkspaceSettings } from "@suma/protocol";
import { favoriteForUrl, type FavoriteSite } from "../../shared/favorites";
import {
  IDLE_BUZZ_STATE,
  type BuzzAgentsState,
  type NostrApprovalResponse,
  type NostrPendingRequest,
  type NostrRelayPolicy,
  type NostrSettingsInfo,
  type NostrSitePolicyPatch,
} from "../../shared/nostr";
import type { SavedItem, SavedItemPatch } from "../../shared/saves";
import type { SavedVideo } from "../../shared/videos";
import type {
  AuditEntry,
  CertErrorInfo,
  CloudFetchDeclined,
  ConnectedDeviceInfo,
  ContentBounds,
  CredentialItem,
  CredentialProviderStatus,
  DownloadItemInfo,
  EgressDecisionInfo,
  EgressStatus,
  EnrollmentStatus,
  GlanceInfo,
  SumaInvokeMap,
  InvokeChannel,
  MachineStatus,
  OriginContinuityInfo,
  PasskeyAccountRequest,
  PasskeyStatus,
  PlaneHealth,
  PortForwardInfo,
  RevocationReceipt,
  SignInQueueItem,
  SpaceInfo,
  SyncStatus,
  TabInfo,
  TabThumbnail,
  TerminalInfo,
  TransfersUpdate,
  WorkspaceFile,
  WorkspaceSyncStatus,
  WorkspaceSyncMode,
  WorkspaceTree,
} from "../../shared/ipc";

/**
 * Settings, appearance, and the audit trail are no longer overlays: they are
 * sections of the `suma://settings` PAGE, reached with `openSettings`. Nor is
 * the terminal — it is the `suma://terminal` PAGE, reached with `openTerminal`
 * (see shared/internal-pages.ts).
 */
export type OverlayKind =
  | "none"
  | "command"
  | "url"
  | "migration"
  | "downloads"
  | "credentials"
  | "workspace-sync";

/** A challenge-triggered per-site bypass offer (§8.4) — suggestion only. */
export interface BypassSuggestion {
  spaceId: string;
  host: string;
  reason: string;
}

export interface OriginPopoverAnchor {
  host: string;
  /** Viewport coordinates of the dot that opened the popover. */
  x: number;
  y: number;
}

const SPACE_COLORS = [
  "#5b8cff",
  "#45d19a",
  "#e8b45a",
  "#e5636c",
  "#b78cff",
  "#4cc3d9",
  "#ff8cc2",
];

interface SumaState {
  hydrated: boolean;
  spaces: SpaceInfo[];
  tabs: TabInfo[];
  syncStatus: SyncStatus;
  health: PlaneHealth;
  settings: WorkspaceSettings;
  devices: ConnectedDeviceInfo[];
  workspaceSync: WorkspaceSyncStatus;
  signInQueue: SignInQueueItem[];
  originInfo: Record<string, OriginContinuityInfo>;
  overlay: OverlayKind;
  originPopover: OriginPopoverAnchor | null;
  /** The top-bar status popover — raises the chrome view while open (§8.1). */
  statusPopoverOpen: boolean;
  /** AI chat sidebar. Open state and width narrow the content hole, so the tab
   *  WebContentsViews resize with it (ContentPanes reports the new bounds). */
  chatOpen: boolean;
  chatWidth: number;
  /** Page selections queued for the next chat message (`selection:addToChat`
   *  from the floating toolbar). Consumed by the composer at send time. */
  chatAttachments: ChatAttachment[];
  /** A chat image opened full-size (the thumbnail's expand button). Store
   *  state, not sidebar state, because the lightbox is a chrome modal — App
   *  folds it into `modalOpen` so main raises the chrome above the tabs. */
  chatImagePreview: { src: string; alt: string } | null;
  /** Saves panel — the chat sidebar's sibling on the right edge; same
   *  content-hole mechanics, own width. */
  savesOpen: boolean;
  savesWidth: number;
  /** Favorite sites in tile order — pushed whole by `favorites:updated`. */
  favorites: FavoriteSite[];
  /** The collection, newest first — pushed whole by `saves:updated`. */
  saves: SavedItem[];
  /** Item shown in the panel's detail view; set by a fresh capture so the
   *  user sees (and can correct) what was assumed about it. */
  savesSelectedId: string | null;
  /** Videos panel — the Saves panel's sibling; same content-hole mechanics. */
  videosOpen: boolean;
  videosWidth: number;
  /** Saved videos, newest first — pushed whole by `videos:updated`. */
  videos: SavedVideo[];
  /** Nostr signer approval queue (NIP-07), oldest first — pushed whole by
   *  `nostr:pendingChanged`; the overlay cards render the same list. */
  nostrPending: NostrPendingRequest[];
  /** The request detail panel — SavesPanel's sibling on the right edge. */
  nostrPanelOpen: boolean;
  nostrSelectedId: string | null;
  /** Signer settings (npub, relays, site rules) — no key material, ever. */
  nostrSettings: NostrSettingsInfo | null;
  /** Buzz workspace agent roster — pushed by `nostr:buzzAgentsChanged`. */
  buzzAgents: BuzzAgentsState;
  passkeyStatus: PasskeyStatus;
  /** The ceremony currently awaiting a credential choice, if any. */
  passkeyRequest: PasskeyAccountRequest | null;

  /** Enrollment state (§8.2). Never carries the shown-once recovery code. */
  auth: EnrollmentStatus;
  /** True once auth:status resolved or auth:changed fired — the Phase-1 backend exists. */
  authKnown: boolean;
  onboardingDismissed: boolean;
  downloads: DownloadItemInfo[];
  /** Cloud fetches, from any device (§8.6 / M-3 Lite). */
  transfers: Transfer[];
  /** Why the last download stayed on this Mac (§8.6) — shown, never silent. */
  declinedFetch: CloudFetchDeclined | null;
  /** Short-lived list of blocked TLS failures (§8.1) — entries expire on their own. */
  certErrors: CertErrorInfo[];
  credentialStatus: CredentialProviderStatus;

  /* ---- Phase 2: compute, terminal, egress, audit (§8.4, §8.5, §8.7) ---- */
  machine: MachineStatus | null;
  terminals: TerminalInfo[];
  ports: PortForwardInfo[];
  egressBySpace: Record<string, EgressStatus>;
  bypassSuggestions: BypassSuggestion[];
  audit: AuditEntry[];
  auditLoaded: boolean;

  /* ---- IDE on suma://terminal (explorer + editor + shell) ----
   * All of it lives HERE, not in TerminalPage state: leaving the tab unmounts
   * the page (ContentPanes), and the IDE must come back as it was left. */
  ideExplorerOpen: boolean;
  ideEditorOpen: boolean;
  ideTerminalOpen: boolean;
  ideExplorerWidth: number;
  ideTerminalHeight: number;
  /** The workspace file listing behind the explorer; null until first fetch. */
  workspaceTree: WorkspaceTree | null;
  /** Editor tabs, in open order; paths are workspace-relative. */
  ideOpenFiles: string[];
  ideActiveFile: string | null;
  /** Paths whose buffer differs from disk — the tab-dot flags. The text
   *  itself stays in lib/ide's buffer map. */
  ideDirty: Record<string, boolean>;

  hydrate: () => Promise<void>;
  attachEvents: () => () => void;

  setOverlay: (overlay: OverlayKind) => void;
  toggleCommandBar: () => void;
  setStatusPopoverOpen: (open: boolean) => void;
  toggleChat: () => void;
  setChatOpen: (open: boolean) => void;
  setChatWidth: (px: number) => void;
  /** Queue a selection for the next message and make sure the sidebar shows. */
  addChatAttachment: (selection: SelectionActionPayload) => void;
  removeChatAttachment: (id: string) => void;
  clearChatAttachments: () => void;
  setChatImagePreview: (preview: { src: string; alt: string } | null) => void;
  toggleSaves: () => void;
  setSavesOpen: (open: boolean) => void;
  setSavesWidth: (px: number) => void;
  /** Add `url` to the favorites, or retitle it if already there. */
  addFavorite: (url: string, title?: string) => Promise<void>;
  removeFavorite: (id: string) => Promise<void>;
  /** The tab star: favorite the address, or un-favorite it if it already is. */
  toggleFavorite: (url: string, title: string) => Promise<void>;
  selectSavedItem: (id: string | null) => void;
  refreshSaves: () => Promise<void>;
  /** Save the active tab now — the button twin of double-Shift. */
  captureSave: () => Promise<void>;
  updateSavedItem: (id: string, patch: SavedItemPatch) => Promise<void>;
  deleteSavedItem: (id: string) => Promise<void>;

  /* ---- Saved videos (shared/videos.ts) ---- */
  toggleVideos: () => void;
  setVideosOpen: (open: boolean) => void;
  setVideosWidth: (px: number) => void;
  /** Save the video behind a YouTube/X URL (the panel button's path). */
  saveVideo: (url: string) => Promise<void>;
  /** Open the floating PIP player on a saved video. */
  playVideo: (id: string) => Promise<void>;
  retryVideo: (id: string) => Promise<void>;
  removeVideo: (id: string) => Promise<void>;

  /* ---- Nostr signer (shared/nostr.ts) ---- */
  setNostrPanelOpen: (open: boolean) => void;
  selectNostrRequest: (id: string | null) => void;
  /** Answer a pending request (panel buttons; the overlay answers directly). */
  respondNostr: (response: NostrApprovalResponse) => Promise<void>;
  refreshNostrSettings: () => Promise<void>;
  setNostrKey: (key: string) => Promise<boolean>;
  /** Resolves with the shown-once nsec, or null when generation failed. */
  generateNostrKey: () => Promise<string | null>;
  removeNostrKey: () => Promise<void>;
  setNostrRelays: (relays: NostrRelayPolicy) => Promise<void>;
  setNostrSitePolicy: (host: string, patch: NostrSitePolicyPatch) => Promise<void>;
  removeNostrSitePolicy: (host: string) => Promise<void>;
  /** Save ("" clears) the Buzz relay URL; saving starts a roster fetch. */
  setBuzzRelay: (url: string) => Promise<boolean>;
  /** Pull the roster snapshot; `refresh` forces a refetch. */
  loadBuzzAgents: (refresh?: boolean) => Promise<void>;
  openOriginControls: (anchor: OriginPopoverAnchor) => void;
  closeOriginControls: () => void;
  /** Raise a non-blocking toast (ui/toast.tsx owns the stack and its timers). */
  pushToast: (message: string, type?: ToastType) => void;
  /**
   * Open the URL bar modal (⌘L, or clicking a visible tab's address). Edits
   * `tabId` when given — both panes of a split show their own address, and
   * either one may be the one being edited — and the active tab otherwise.
   */
  openUrlBar: (tabId?: string) => void;
  /** Which tab the open URL bar is editing; null ⇒ the active tab. */
  urlBarTabId: string | null;
  /**
   * Go to a section of `suma://settings` — ⌘,, the strip's gear, the command
   * bar, and every "…settings" link in the chrome. Reuses this space's
   * existing settings tab when there is one (like Chrome: ⌘, twice is one
   * tab, not two), otherwise opens one.
   */
  openSettings: (section?: SettingsSection) => Promise<void>;
  /**
   * Go to `suma://terminal` — the command bar, the machine status card, and
   * the empty state's Terminal action. Same reuse rule as settings: a space
   * has at most one terminal tab, and asking again selects it rather than
   * opening a second one on top of the shells already running in it.
   */
  openTerminal: () => Promise<void>;

  setActiveSpace: (spaceId: string) => Promise<void>;
  createSpace: () => Promise<void>;
  updateSpace: (
    spaceId: string,
    patch: SumaInvokeMap["spaces:update"]["args"]["patch"],
  ) => Promise<void>;
  removeSpace: (spaceId: string) => Promise<void>;

  createTab: (url?: string, pinned?: boolean) => Promise<void>;
  selectTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  navigate: (tabId: string | null, url: string) => Promise<void>;
  /* Nav acts on `tabId` when given — a split shows two live pages, and each
   * pane drives its own history — and on the active tab otherwise (⌘[, ⌘], ⌘R). */
  goBack: (tabId?: string) => Promise<void>;
  goForward: (tabId?: string) => Promise<void>;
  reload: (tabId?: string) => Promise<void>;
  togglePin: (tabId: string) => Promise<void>;
  /** Move a tab to `index` within the space order (index taken after removal). */
  reorderTab: (tabId: string, index: number) => Promise<void>;
  /** Split view (§6): open the tab in the second pane, or close the split. */
  toggleSplit: (tabId: string) => Promise<void>;
  /**
   * Drop-to-split (TabStrip): put `tabId` in a specific pane of a two-pane
   * split, pairing it with whatever tab is best placed to face it. The left
   * pane is the active tab and the right pane is the split assignment, so
   * "which side" is not a flag we can send — it is which of the two roles the
   * dragged tab takes, and the other role goes to its partner.
   */
  splitTabToSide: (tabId: string, side: "left" | "right") => Promise<void>;

  fetchOriginInfo: (host: string) => Promise<void>;
  setOriginOverride: (
    host: string,
    override: "sync" | "never" | null,
  ) => Promise<void>;
  rollbackOrigin: (host: string) => Promise<void>;

  /** Browsing history (§8.3) — searched live by the command bar. An empty
   *  query lists the most recent visits (the URL bar's browse mode). */
  searchHistory: (query: string, limit?: number) => Promise<HistoryVisit[]>;
  clearHistory: () => Promise<void>;

  updateSettings: (patch: Partial<WorkspaceSettings>) => Promise<void>;
  refreshDevices: () => Promise<void>;
  renameDevice: (deviceId: string, name: string) => Promise<boolean>;
  syncWorkspace: (
    mode: WorkspaceSyncMode,
    sourceDeviceId?: string,
  ) => Promise<boolean>;

  refreshSignInQueue: () => Promise<void>;
  markSignedIn: (domain: string) => Promise<void>;

  /** Answer the pending passkey ceremony; null credentialId cancels it. */
  choosePasskeyAccount: (credentialId: string | null) => Promise<void>;

  reportContentBounds: (bounds: ContentBounds) => void;
  /** The last content-hole rect reported to main, in CSS px. Kept here so
   *  chrome drawn OVER the hole (the tab-drag split zones) lands on the same
   *  region the tab views occupy, sidebar and banners already accounted for. */
  contentBounds: ContentBounds | null;
  /** Modal overlay open/closed — main raises/lowers the chrome view (§8.1). */
  reportOverlayActive: (active: boolean) => void;

  /* ---- Glance preview (GlanceOverlay; main/glance.ts owns the page) ---- */
  /** The open glance's live state, pushed whole by `glance:changed`; null ⇒
   *  closed. App folds it into `modalOpen`, which is what raises the chrome
   *  frame above the tab views while a glance is up. */
  glance: GlanceInfo | null;
  closeGlance: () => Promise<void>;
  /** Open the glanced page as a real tab (the live view moves — no reload). */
  promoteGlance: () => Promise<void>;
  glanceGoBack: () => Promise<void>;
  glanceGoForward: () => Promise<void>;
  /** The frame's content hole, in window CSS px — main places the page view
   *  exactly there (same contract as reportContentBounds). */
  reportGlanceBounds: (bounds: ContentBounds) => void;

  /* ---- Split-view divider (§6): the renderer owns the ratio + drag ---- */
  /** A separator drag is in progress — the split-view divider or the chat
   *  sidebar's handle. Raises the chrome view (via the overlay mechanism) so
   *  pointer moves over the tab WebContentsViews reach us instead of the
   *  page. Both drags need it for the same reason, so they share the flag. */
  paneResizing: boolean;
  setPaneResizing: (resizing: boolean) => void;
  /** A tab is being dragged in the strip. Raises the chrome view for the same
   *  reason a divider drag does — the drag leaves the strip and crosses the
   *  tab WebContentsViews, and its drop zones are drawn over them. */
  tabDragging: boolean;
  setTabDragging: (dragging: boolean) => void;

  /** Page snapshots for the preview shelf, keyed by tab id (`tabs:thumbnail`). */
  tabThumbnails: Record<string, TabThumbnail>;
  /** The preview shelf under the strip is open — it takes layout height, so
   *  the content hole (and with it the tab views) slides down while it shows. */
  tabPreviewOpen: boolean;
  /** Opening also pulls the space's cached thumbnails and asks main to
   *  re-capture the visible tab, so the shelf is fresh by the time it lands. */
  setTabPreviewOpen: (open: boolean) => void;
  /** The tab the pointer is on in the STRIP — its shelf card mirrors the
   *  hover, so the row above and the picture below read as one control:
   *  the lit card is the page a click right now would land on. Maintained
   *  purely by the strip's enter/leave pairs (never cleared on shelf close:
   *  the pointer may still be sitting on the tab when it reopens). */
  tabPreviewHoverId: string | null;
  setTabPreviewHoverId: (tabId: string) => void;
  /** Clear only if `tabId` is still the hovered one — a leave firing after
   *  the next tab's enter must not wipe the newer hover. */
  clearTabPreviewHoverId: (tabId: string) => void;
  /** Left-pane fraction per space; device-local, persisted in localStorage. */
  splitRatios: Record<string, number>;
  /** Update a space's divider position and stream it to main; persisted on
   *  commit (drag end / discrete change), not per pointer-move. */
  setSplitRatio: (spaceId: string, ratio: number) => void;
  /** Re-send the stored ratio for a space (space switch, startup). */
  pushSplitRatio: (spaceId: string) => void;
  /** Set by OnboardingWizard: it derives its own visibility (recovery step
   *  included), and the chrome must be raised exactly while it shows. */
  wizardOpen: boolean;
  setWizardOpen: (open: boolean) => void;

  openOnboarding: () => void;
  dismissOnboarding: () => void;
  /** Results are returned raw — auth:enroll may carry the shown-once recovery code. */
  signup: (
    email: string,
    displayName?: string,
    inviteCode?: string,
  ) => Promise<EnrollmentStatus | undefined>;
  enrollDevice: (name: string) => Promise<EnrollmentStatus | undefined>;
  /** §8.2 second-device flow: mint on the enrolled Mac, sign in on the new one. */
  mintEnrollmentCode: () => Promise<
    { code: string; expiresAt: string } | undefined
  >;
  signinWithCode: (code: string) => Promise<EnrollmentStatus | undefined>;
  registerDeviceCredential: () => Promise<EnrollmentStatus | undefined>;
  passkeyBegin: () => Promise<{ options: unknown } | undefined>;
  passkeyFinish: (credential: unknown) => Promise<EnrollmentStatus | undefined>;
  recoverKeys: (
    recoveryCode: string,
  ) => Promise<{ spacesRecovered: number } | undefined>;
  /** Sign out of the account and reset this Mac to first run (§8.2). The app
   *  relaunches, so this never resolves in practice. */
  signOut: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<RevocationReceipt | undefined>;

  refreshDownloads: () => Promise<void>;
  openDownload: (id: string) => Promise<void>;
  revealDownload: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;

  refreshTransfers: () => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;

  refreshCredentialStatus: () => Promise<void>;
  searchCredentials: (host: string) => Promise<CredentialItem[]>;
  fillCredential: (tabId: string, itemId: string) => Promise<boolean>;

  dismissCertError: (host: string, atMs: number) => void;

  /* ---- Phase 2 actions ---- */
  refreshMachine: () => Promise<void>;
  wakeMachine: () => Promise<void>;
  suspendMachine: () => Promise<void>;
  refreshTerminals: () => Promise<TerminalInfo[]>;
  /** Refresh AND ask the agent for sessions this device didn't create —
   *  other devices' shells appear as attachable tabs (§8.5). */
  discoverTerminals: () => Promise<TerminalInfo[]>;
  createTerminal: () => Promise<TerminalInfo | undefined>;
  /**
   * Open a NEW shell and show it — the tab strip's terminal button, beside
   * ⌘T's. Distinct from `openTerminal`, which goes to the page and leaves
   * whatever shell was running on it alone.
   */
  newTerminal: () => Promise<void>;
  /**
   * The shell the terminal page should attach to when it next renders. Set by
   * `newTerminal`, which creates the pty before the page necessarily exists;
   * the page claims it with `consumePendingTerminal`.
   */
  pendingPtyId: string | null;
  /** Read-and-clear `pendingPtyId` — atomic, so only one claimant wins. */
  consumePendingTerminal: () => string | null;
  attachTerminal: (ptyId: string) => Promise<TerminalInfo | undefined>;
  closeTerminal: (ptyId: string) => Promise<void>;
  setJobMode: (ptyId: string, enabled: boolean) => Promise<void>;
  sendTerminalInput: (ptyId: string, data: string) => void;
  resizeTerminal: (ptyId: string, cols: number, rows: number) => void;
  refreshPorts: () => Promise<void>;
  setPortForward: (port: number, enabled: boolean) => Promise<void>;

  /* ---- IDE actions (suma://terminal) ---- */
  toggleIdePanel: (panel: IdePanel) => void;
  setIdeExplorerWidth: (px: number) => void;
  setIdeTerminalHeight: (px: number) => void;
  refreshWorkspaceTree: () => Promise<void>;
  /** Read a file for the editor; undefined on failure (already toasted). */
  readIdeFile: (path: string) => Promise<WorkspaceFile | undefined>;
  /** Write a buffer back to disk; true on success. */
  saveIdeFile: (path: string, contents: string) => Promise<boolean>;
  /** Open `path` in the editor (adding a tab) and reveal the editor panel. */
  openIdeFile: (path: string) => void;
  /** Close the tab; its unsaved buffer, if any, is discarded. */
  closeIdeFile: (path: string) => void;
  setIdeActiveFile: (path: string) => void;
  setIdeFileDirty: (path: string, dirty: boolean) => void;
  refreshEgress: (spaceId: string) => Promise<void>;
  setEgressPolicy: (
    spaceId: string,
    policy: "suma-ip" | "direct",
  ) => Promise<void>;
  browseDirectForNow: (spaceId: string) => Promise<void>;
  setSiteBypass: (
    spaceId: string,
    host: string,
    bypass: boolean,
  ) => Promise<void>;
  explainEgress: (
    spaceId: string,
    host: string,
  ) => Promise<EgressDecisionInfo | undefined>;
  dismissBypassSuggestion: (spaceId: string, host: string) => void;
  refreshAudit: () => Promise<void>;
}

const FALLBACK_SYNC_STATUS: SyncStatus = {
  state: "connecting",
  queueDepth: 0,
  lastConvergedMs: null,
  keyMode: "e2ee",
};

const FALLBACK_HEALTH: PlaneHealth = {
  sessionPlane: "ok",
  egressPlane: "ok",
  computePlane: "ok",
};

/** Local-only default (§8.2) — what an absent Phase-1 backend implies. */
const FALLBACK_AUTH: EnrollmentStatus = {
  state: "unenrolled",
  controlUrl: null,
  email: null,
  displayName: null,
  userId: null,
  deviceId: "",
  deviceName: null,
  suggestedDeviceName: "My Mac",
  passkeyRegistered: false,
  credentialKind: null,
};

const FALLBACK_CREDENTIAL_STATUS: CredentialProviderStatus = {
  provider: "none",
  available: false,
  detail: null,
};

const CERT_ERROR_TTL_MS = 30_000;
const MAX_CERT_ERRORS = 4;

/**
 * Enrollment responses may carry the shown-once recovery code (§8.2). It is
 * surfaced exactly once by the OnboardingWizard and never enters the store.
 */
function sanitizeAuth(status: EnrollmentStatus): EnrollmentStatus {
  const clean = { ...status };
  delete clean.recoveryCode;
  return clean;
}

const FALLBACK_PASSKEY_STATUS: PasskeyStatus = {
  support: "unsupported-platform",
  detail: "Checking passkey support…",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const originInFlight = new Set<string>();

/** Monotonic id source for read-aloud selections — each tap is a new track. */
let selectionSpeechSeq = 0;

/** Divider positions are presentation, so they live beside the renderer
 *  (localStorage), not in synced workspace state — device-local like the
 *  split assignment itself (§8.3). */
const SPLIT_RATIO_STORAGE_KEY = "suma.splitRatios";

function loadSplitRatios(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const ratios: Record<string, number> = {};
    for (const [spaceId, ratio] of Object.entries(parsed)) {
      if (typeof ratio === "number" && Number.isFinite(ratio))
        ratios[spaceId] = ratio;
    }
    return ratios;
  } catch {
    return {};
  }
}

function saveSplitRatios(ratios: Record<string, number>): void {
  try {
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, JSON.stringify(ratios));
  } catch {
    // Quota/privacy failures just lose persistence, never the drag.
  }
}

/** First paint reads localStorage once; every mutation writes back through
 *  `persistIdeLayout`, same commit-on-set shape as the chat width. */
const initialIdeLayout = getStoredIdeLayout();

function persistIdeLayout(s: SumaState): void {
  storeIdeLayout({
    explorerOpen: s.ideExplorerOpen,
    editorOpen: s.ideEditorOpen,
    terminalOpen: s.ideTerminalOpen,
    explorerWidth: s.ideExplorerWidth,
    terminalHeight: s.ideTerminalHeight,
  });
}

export const useSumaStore = create<SumaState>()((set, get) => {
  /** Every invoke error surfaces as a non-blocking toast; callers get undefined. */
  async function call<C extends InvokeChannel>(
    channel: C,
    args: SumaInvokeMap[C]["args"],
  ): Promise<SumaInvokeMap[C]["result"] | undefined> {
    try {
      if (!window.suma) throw new Error("bridge unavailable");
      return await window.suma.invoke(channel, args);
    } catch (err) {
      get().pushToast(`${channel} failed — ${errorMessage(err)}`, "error");
      return undefined;
    }
  }

  /** Phase-1 channels may not exist yet (backend mid-build) — fail silently to defaults. */
  async function callQuiet<C extends InvokeChannel>(
    channel: C,
    args: SumaInvokeMap[C]["args"],
  ): Promise<SumaInvokeMap[C]["result"] | undefined> {
    try {
      if (!window.suma) return undefined;
      return await window.suma.invoke(channel, args);
    } catch {
      return undefined;
    }
  }

  function setAuthStatus(status: EnrollmentStatus): void {
    set({ auth: sanitizeAuth(status), authKnown: true });
  }

  /**
   * §8.6: an authenticated download that stayed local gets SAID OUT LOUD once.
   * Without it the user sees Suma route one download to the cloud and not
   * the next, and concludes it is arbitrary rather than protecting them.
   */
  function applyTransfers(update: TransfersUpdate): void {
    const previous = get().declinedFetch;
    set({ transfers: update.transfers, declinedFetch: update.declined });
    const declined = update.declined;
    if (declined === null) return;
    if (previous !== null && previous.atMs === declined.atMs) return;
    get().pushToast(
      `${declined.filename} downloaded to this Mac — ${declined.explanation}`,
    );
  }

  function pushCertError(err: CertErrorInfo): void {
    set((s) => ({
      certErrors: [
        ...s.certErrors.filter((e) => e.host !== err.host),
        err,
      ].slice(-MAX_CERT_ERRORS),
    }));
    setTimeout(() => {
      set((s) => ({
        certErrors: s.certErrors.filter(
          (e) => !(e.host === err.host && e.atMs === err.atMs),
        ),
      }));
    }, CERT_ERROR_TTL_MS);
  }

  /**
   * Thumbnails outlive their tabs on purpose (a closed tab's capture is
   * harmless and a reopened space wants its pictures back instantly), so the
   * map is capped instead of pruned — beyond the cap the oldest captures go.
   */
  const MAX_TAB_THUMBNAILS = 80;
  function mergeThumbnail(thumb: TabThumbnail): void {
    set((s) => {
      const next = { ...s.tabThumbnails, [thumb.tabId]: thumb };
      const ids = Object.keys(next);
      if (ids.length > MAX_TAB_THUMBNAILS) {
        ids.sort(
          (a, b) =>
            (next[a]?.capturedAtMs ?? 0) - (next[b]?.capturedAtMs ?? 0),
        );
        for (const id of ids.slice(0, ids.length - MAX_TAB_THUMBNAILS)) {
          delete next[id];
        }
      }
      return { tabThumbnails: next };
    });
  }

  function activeSpaceId(): string | null {
    return get().spaces.find((s) => s.active)?.id ?? null;
  }

  function activeTab(): TabInfo | null {
    return get().tabs.find((t) => t.active) ?? null;
  }

  async function refreshTabs(spaceId?: string): Promise<void> {
    const id = spaceId ?? activeSpaceId();
    if (id === null) {
      set({ tabs: [] });
      return;
    }
    const tabs = await call("tabs:list", { spaceId: id });
    if (tabs !== undefined) set({ tabs });
  }

  async function refreshSpaces(): Promise<void> {
    const spaces = await call("spaces:list", undefined);
    if (spaces !== undefined) set({ spaces });
  }

  /**
   * Select this space's tab for an internal page and put `url` in it, or open
   * one. Matching is per PAGE, not "any suma:// tab": settings and the
   * terminal are separate destinations, and reusing whichever internal tab
   * happened to exist would navigate a running shell away to settings.
   */
  async function goToInternalPage(
    page: InternalPage,
    url: string,
  ): Promise<void> {
    // Any overlay that was open asked for this page — get out of its way, or
    // the page opens behind a modal nobody meant to keep.
    set({ overlay: "none", originPopover: null, statusPopoverOpen: false });
    const existing = get().tabs.find((t) => isInternalPage(t.url, page));
    if (existing === undefined) {
      await get().createTab(url);
      return;
    }
    if (!existing.active) await get().selectTab(existing.id);
    if (existing.url !== url) await get().navigate(existing.id, url);
  }

  async function refreshEgressFor(spaceId: string | null): Promise<void> {
    if (spaceId === null) return;
    const status = await callQuiet("egress:status", { spaceId });
    if (status !== undefined) {
      set((s) => ({
        egressBySpace: { ...s.egressBySpace, [spaceId]: status },
      }));
    }
  }

  return {
    hydrated: false,
    spaces: [],
    tabs: [],
    syncStatus: FALLBACK_SYNC_STATUS,
    health: FALLBACK_HEALTH,
    settings: DEFAULT_WORKSPACE_SETTINGS,
    devices: [],
    workspaceSync: {
      remoteReady: false,
      pending: false,
      canonicalPending: false,
      localChanged: false,
      remoteChanged: false,
      sources: [],
    },
    signInQueue: [],
    originInfo: {},
    overlay: "none",
    originPopover: null,
    statusPopoverOpen: false,
    chatOpen: getStoredChatOpen(),
    chatWidth: getStoredChatWidth(),
    chatAttachments: [],
    chatImagePreview: null,
    savesOpen: getStoredSavesOpen(),
    savesWidth: getStoredSavesWidth(),
    favorites: [],
    saves: [],
    savesSelectedId: null,
    videosOpen: getStoredVideosOpen(),
    videosWidth: getStoredVideosWidth(),
    videos: [],
    nostrPending: [],
    nostrPanelOpen: false,
    nostrSelectedId: null,
    nostrSettings: null,
    buzzAgents: { ...IDLE_BUZZ_STATE },
    passkeyStatus: FALLBACK_PASSKEY_STATUS,
    passkeyRequest: null,

    auth: FALLBACK_AUTH,
    authKnown: false,
    onboardingDismissed: false,
    downloads: [],
    transfers: [],
    declinedFetch: null,
    certErrors: [],
    credentialStatus: FALLBACK_CREDENTIAL_STATUS,

    machine: null,
    terminals: [],
    ports: [],
    egressBySpace: {},
    bypassSuggestions: [],
    audit: [],
    auditLoaded: false,

    ideExplorerOpen: initialIdeLayout.explorerOpen,
    ideEditorOpen: initialIdeLayout.editorOpen,
    ideTerminalOpen: initialIdeLayout.terminalOpen,
    ideExplorerWidth: initialIdeLayout.explorerWidth,
    ideTerminalHeight: initialIdeLayout.terminalHeight,
    workspaceTree: null,
    ideOpenFiles: [],
    ideActiveFile: null,
    ideDirty: {},

    hydrate: async () => {
      const [
        spaces,
        syncStatus,
        health,
        settings,
        auth,
        downloads,
        credentialStatus,
        passkeyStatus,
        machine,
        terminals,
        ports,
        workspaceSync,
      ] = await Promise.all([
        call("spaces:list", undefined),
        call("sync:status", undefined),
        call("health:get", undefined),
        call("settings:get", undefined),
        callQuiet("auth:status", undefined),
        callQuiet("downloads:list", undefined),
        callQuiet("credentials:status", undefined),
        callQuiet("passkeys:status", undefined),
        callQuiet("machine:status", undefined),
        callQuiet("terminal:list", undefined),
        callQuiet("ports:list", undefined),
        callQuiet("workspaceSync:get", undefined),
      ]);
      const saves = await callQuiet("saves:list", undefined);
      const videos = await callQuiet("videos:list", undefined);
      const favorites = await callQuiet("favorites:list", undefined);
      const nostrPending = await callQuiet("nostr:pending", undefined);
      const nostrSettings = await callQuiet("nostr:settings", undefined);
      set({
        nostrPending: nostrPending ?? [],
        nostrSettings: nostrSettings ?? null,
        spaces: spaces ?? [],
        syncStatus: syncStatus ?? FALLBACK_SYNC_STATUS,
        health: health ?? FALLBACK_HEALTH,
        settings: settings ?? DEFAULT_WORKSPACE_SETTINGS,
        auth: auth !== undefined ? sanitizeAuth(auth) : FALLBACK_AUTH,
        authKnown: auth !== undefined,
        downloads: downloads ?? [],
        credentialStatus: credentialStatus ?? FALLBACK_CREDENTIAL_STATUS,
        passkeyStatus: passkeyStatus ?? FALLBACK_PASSKEY_STATUS,
        machine: machine ?? null,
        terminals: terminals ?? [],
        ports: ports ?? [],
        saves: saves ?? [],
        videos: videos ?? [],
        favorites: favorites ?? [],
        workspaceSync: workspaceSync ?? {
          remoteReady: false,
          pending: false,
          canonicalPending: false,
          localChanged: false,
          remoteChanged: false,
          sources: [],
        },
        hydrated: true,
      });
      await refreshTabs();
      await refreshEgressFor(activeSpaceId());
    },

    attachEvents: () => {
      if (!window.suma) return () => undefined;
      const offs = [
        window.suma.on("tabs:updated", ({ spaceId, tabs }) => {
          if (spaceId === activeSpaceId()) set({ tabs });
        }),
        window.suma.on("tabs:thumbnail", (thumb) => mergeThumbnail(thumb)),
        window.suma.on("spaces:updated", (spaces) => {
          const prevActive = activeSpaceId();
          set({ spaces });
          const nextActive = spaces.find((s) => s.active)?.id ?? null;
          if (nextActive !== prevActive) {
            // The shelf previews ONE space's tabs; a space switch closes it.
            set({ tabPreviewOpen: false });
            void refreshTabs(nextActive ?? undefined);
            void refreshEgressFor(nextActive);
          }
        }),
        window.suma.on("sync:statusChanged", (syncStatus) =>
          set({ syncStatus }),
        ),
        window.suma.on("health:changed", (health) => set({ health })),
        window.suma.on("ui:toggleCommandBar", () => get().toggleCommandBar()),
        window.suma.on("migration:queueChanged", (signInQueue) =>
          set({ signInQueue }),
        ),
        window.suma.on("downloads:updated", (downloads) => set({ downloads })),
        window.suma.on("auth:changed", (status) => setAuthStatus(status)),
        window.suma.on("devices:updated", (devices) => set({ devices })),
        window.suma.on("workspaceSync:changed", (workspaceSync) =>
          set({ workspaceSync }),
        ),
        window.suma.on("security:certError", (err) => pushCertError(err)),
        window.suma.on("passkeys:accountRequest", (passkeyRequest) => {
          // The ceremony blocks until answered — the picker takes precedence
          // over any open overlay.
          set({ passkeyRequest, overlay: "none", originPopover: null });
        }),
        window.suma.on("passkeys:accountRequestCancelled", ({ requestId }) => {
          if (get().passkeyRequest?.requestId === requestId)
            set({ passkeyRequest: null });
        }),
        window.suma.on("glance:changed", (glance) => set({ glance })),
        window.suma.on("popups:denied", ({ reason }) =>
          get().pushToast(
            `Blocked a window this page tried to open — ${reason}`,
            "warning",
          ),
        ),
        window.suma.on("machine:changed", (machine) => set({ machine })),
        // terminal:data streams straight to the TerminalPanel — the byte
        // stream never routes through the store.
        window.suma.on("terminal:updated", (terminals) => set({ terminals })),
        window.suma.on("ports:updated", (ports) => set({ ports })),
        window.suma.on("egress:changed", (status) =>
          set((s) => ({
            egressBySpace: { ...s.egressBySpace, [status.spaceId]: status },
          })),
        ),
        window.suma.on("transfers:updated", (update) => applyTransfers(update)),
        window.suma.on("saves:updated", (saves) => set({ saves })),
        window.suma.on("videos:updated", (videos) => set({ videos })),
        // A gesture/menu save landed — surface the download in the panel so
        // it is never invisibly running.
        window.suma.on("videos:openPanel", () => {
          set({ videosOpen: true });
          storeVideosOpen(true);
        }),
        window.suma.on("favorites:updated", (favorites) => set({ favorites })),
        // A capture no longer opens the panel — the preview overlay (its own
        // view, SavePreviewOverlay) is the feedback. Clicking its card is
        // what lands here, and THAT opens the panel on the item.
        window.suma.on("saves:openDetail", ({ itemId }) => {
          set({ savesOpen: true, savesSelectedId: itemId });
          storeSavesOpen(true);
        }),
        window.suma.on("nostr:pendingChanged", (nostrPending) => {
          set((s) => {
            const stillThere = nostrPending.some(
              (request) => request.id === s.nostrSelectedId,
            );
            return {
              nostrPending,
              // The selected request was answered (from either surface):
              // advance to the oldest remaining, or close an emptied panel
              // rather than leaving it open on nothing.
              nostrSelectedId: stillThere
                ? s.nostrSelectedId
                : (nostrPending[0]?.id ?? null),
              nostrPanelOpen: s.nostrPanelOpen && nostrPending.length > 0,
            };
          });
        }),
        // An overlay card was expanded — show the request's full detail.
        window.suma.on("nostr:openDetail", ({ requestId }) => {
          set({ nostrPanelOpen: true, nostrSelectedId: requestId });
        }),
        window.suma.on("nostr:settingsChanged", (nostrSettings) =>
          set({ nostrSettings }),
        ),
        // The key-missing card's "Set up" tap, relayed via main.
        window.suma.on("nostr:openSettings", () => {
          void get().openSettings("nostr");
        }),
        window.suma.on("nostr:buzzAgentsChanged", (buzzAgents) =>
          set({ buzzAgents }),
        ),
        // The floating selection toolbar's two actions, relayed via main.
        // Read-aloud feeds the same player the chat's speak buttons use; a
        // fresh id per tap makes it always start reading (never a toggle).
        window.suma.on("selection:readAloud", ({ text, url, title }) => {
          selectionSpeechSeq += 1;
          speakText({
            id: `page-selection-${selectionSpeechSeq}`,
            title: speechTitle(text),
            origin: hostOf(url) || title || "This page",
            source: { kind: "tts", text },
          });
        }),
        window.suma.on("selection:addToChat", (selection) =>
          get().addChatAttachment(selection),
        ),
        window.suma.on("egress:bypassSuggested", (suggestion) =>
          set((s) => ({
            bypassSuggestions: [
              ...s.bypassSuggestions.filter(
                (b) =>
                  !(
                    b.spaceId === suggestion.spaceId &&
                    b.host === suggestion.host
                  ),
              ),
              suggestion,
            ],
          })),
        ),
      ];
      return () => offs.forEach((off) => off());
    },

    setOverlay: (overlay) => set({ overlay, originPopover: null }),
    setStatusPopoverOpen: (open) => set({ statusPopoverOpen: open }),

    toggleChat: () => get().setChatOpen(!get().chatOpen),

    setChatOpen: (open) => {
      storeChatOpen(open);
      set({ chatOpen: open });
    },

    setChatWidth: (px) => {
      const width = clampChatWidth(px);
      storeChatWidth(width);
      set({ chatWidth: width });
    },

    addChatAttachment: (selection) => {
      const attachment: ChatAttachment = {
        id: crypto.randomUUID(),
        ...selection,
      };
      set((s) => ({ chatAttachments: [...s.chatAttachments, attachment] }));
      get().setChatOpen(true);
    },

    removeChatAttachment: (id) =>
      set((s) => ({
        chatAttachments: s.chatAttachments.filter((a) => a.id !== id),
      })),

    clearChatAttachments: () => set({ chatAttachments: [] }),
    setChatImagePreview: (preview) => set({ chatImagePreview: preview }),

    toggleSaves: () => get().setSavesOpen(!get().savesOpen),

    setSavesOpen: (open) => {
      storeSavesOpen(open);
      set({ savesOpen: open });
    },

    setSavesWidth: (px) => {
      const width = clampSavesWidth(px);
      storeSavesWidth(width);
      set({ savesWidth: width });
    },

    addFavorite: async (url, title) => {
      const favorites = await call("favorites:add", {
        url,
        ...(title === undefined ? {} : { title }),
      });
      if (favorites !== undefined) set({ favorites });
    },

    removeFavorite: async (id) => {
      const favorites = await call("favorites:remove", { id });
      if (favorites !== undefined) set({ favorites });
    },

    toggleFavorite: async (url, title) => {
      const existing = favoriteForUrl(get().favorites, url);
      if (existing !== null) await get().removeFavorite(existing.id);
      else await get().addFavorite(url, title);
    },

    selectSavedItem: (id) => set({ savesSelectedId: id }),

    refreshSaves: async () => {
      const saves = await callQuiet("saves:list", undefined);
      if (saves !== undefined) set({ saves });
    },

    captureSave: async () => {
      // The outcome lands via the saves:captured event (open + select, or a
      // toast with the refusal) — same path as the double-Shift gesture.
      await call("saves:capture", undefined);
    },

    updateSavedItem: async (id, patch) => {
      const updated = await call("saves:update", { id, patch });
      if (updated !== undefined) {
        set((s) => ({
          saves: s.saves.map((item) => (item.id === id ? updated : item)),
        }));
      }
    },

    deleteSavedItem: async (id) => {
      set((s) => ({
        saves: s.saves.filter((item) => item.id !== id),
        savesSelectedId: s.savesSelectedId === id ? null : s.savesSelectedId,
      }));
      await call("saves:delete", { id });
    },

    /* ---- Saved videos (shared/videos.ts) ---- */

    toggleVideos: () => get().setVideosOpen(!get().videosOpen),

    setVideosOpen: (open) => {
      storeVideosOpen(open);
      set({ videosOpen: open });
    },

    setVideosWidth: (px) => {
      const width = clampVideosWidth(px);
      storeVideosWidth(width);
      set({ videosWidth: width });
    },

    saveVideo: async (url) => {
      const item = await call("videos:save", { url });
      if (item === undefined) return; // the call helper already toasted
      if (item === null) {
        get().pushToast(
          "This page isn't a YouTube or X video — double-tap Shift to bookmark it instead.",
          "warning",
        );
        return;
      }
      get().setVideosOpen(true);
    },

    playVideo: async (id) => {
      await call("videos:play", { id });
    },

    retryVideo: async (id) => {
      await call("videos:retry", { id });
    },

    removeVideo: async (id) => {
      set((s) => ({ videos: s.videos.filter((item) => item.id !== id) }));
      await call("videos:remove", { id });
    },

    /* ---- Nostr signer (shared/nostr.ts) ---- */

    setNostrPanelOpen: (open) => set({ nostrPanelOpen: open }),
    selectNostrRequest: (id) => set({ nostrSelectedId: id }),

    respondNostr: async (response) => {
      // The queue update arrives as nostr:pendingChanged — main is the one
      // source of truth for what is still pending on both surfaces.
      await call("nostr:respond", response);
    },

    refreshNostrSettings: async () => {
      const nostrSettings = await callQuiet("nostr:settings", undefined);
      if (nostrSettings !== undefined) set({ nostrSettings });
    },

    setNostrKey: async (key) => {
      const info = await call("nostr:setKey", { key });
      if (info === undefined) return false;
      set({ nostrSettings: info });
      return true;
    },

    generateNostrKey: async () => {
      const info = await call("nostr:generateKey", undefined);
      if (info === undefined) return null;
      // The nsec is shown ONCE from this reply and kept out of the store —
      // nostrSettings holds the key-free view.
      const { generatedNsec, ...rest } = info;
      set({ nostrSettings: rest });
      return generatedNsec ?? null;
    },

    removeNostrKey: async () => {
      const info = await call("nostr:removeKey", undefined);
      if (info !== undefined) set({ nostrSettings: info });
    },

    setNostrRelays: async (relays) => {
      const info = await call("nostr:setRelays", { relays });
      if (info !== undefined) set({ nostrSettings: info });
    },

    setNostrSitePolicy: async (host, patch) => {
      const info = await call("nostr:setSitePolicy", { host, patch });
      if (info !== undefined) set({ nostrSettings: info });
    },

    removeNostrSitePolicy: async (host) => {
      const info = await call("nostr:removeSitePolicy", { host });
      if (info !== undefined) set({ nostrSettings: info });
    },

    setBuzzRelay: async (url) => {
      const info = await call("nostr:setBuzzRelay", { url });
      if (info === undefined) return false;
      set({ nostrSettings: info });
      // Clearing the relay clears the roster; a set relay's fetch results
      // arrive via nostr:buzzAgentsChanged.
      if (info.buzzRelayUrl === null) set({ buzzAgents: { ...IDLE_BUZZ_STATE } });
      return true;
    },

    loadBuzzAgents: async (refresh = false) => {
      const buzzAgents = await callQuiet("nostr:buzzAgents", { refresh });
      if (buzzAgents !== undefined) set({ buzzAgents });
    },

    toggleCommandBar: () =>
      set((s) => ({
        overlay: s.overlay === "command" ? "none" : "command",
        originPopover: null,
      })),

    openOriginControls: (anchor) => set({ originPopover: anchor }),
    closeOriginControls: () => set({ originPopover: null }),

    // The message doubles as the toast id, which is how the old hand-rolled
    // stack's dedupe survives: Base UI updates a toast in place when one with
    // that id is already up, so a repeated message refreshes its dismiss timer
    // rather than piling a second identical card. Stacking, timers, and
    // dismissal all live in the component now (ui/toast.tsx).
    pushToast: (message, type) => {
      toast.add({ id: message, description: message, type });
    },

    urlBarTabId: null,
    openUrlBar: (tabId) =>
      set({
        overlay: "url",
        originPopover: null,
        urlBarTabId: tabId ?? null,
      }),

    openSettings: (section = "") =>
      goToInternalPage("settings", settingsUrl(section)),

    openTerminal: () => goToInternalPage("terminal", TERMINAL_URL),

    setActiveSpace: async (spaceId) => {
      const done = await call("spaces:setActive", { spaceId });
      set((s) => ({
        spaces: s.spaces.map((sp) => ({ ...sp, active: sp.id === spaceId })),
      }));
      if (done !== undefined) {
        await refreshTabs(spaceId);
        await refreshEgressFor(spaceId);
      }
    },

    createSpace: async () => {
      const n = get().spaces.length;
      const color = SPACE_COLORS[n % SPACE_COLORS.length] ?? "#5b8cff";
      const created = await call("spaces:create", {
        name: `Space ${n + 1}`,
        color,
      });
      await refreshSpaces();
      if (created !== undefined) await get().setActiveSpace(created.id);
    },

    updateSpace: async (spaceId, patch) => {
      const updated = await call("spaces:update", { spaceId, patch });
      if (updated !== undefined) {
        set((s) => ({
          spaces: s.spaces.map((sp) => (sp.id === spaceId ? updated : sp)),
        }));
      }
    },

    removeSpace: async (spaceId) => {
      const spaces = await call("spaces:remove", { spaceId });
      if (spaces !== undefined) set({ spaces });
    },

    createTab: async (url, pinned) => {
      const spaceId = activeSpaceId();
      if (spaceId === null) {
        get().pushToast("No active space — create one first", "warning");
        return;
      }
      const args: SumaInvokeMap["tabs:create"]["args"] = { spaceId };
      if (url !== undefined) args.url = url;
      if (pinned !== undefined) args.pinned = pinned;
      await call("tabs:create", args);
      await refreshTabs(spaceId);
    },

    selectTab: async (tabId) => {
      // Mirror main's rule (tabs.ts select) so the panes don't flash a wrong
      // layout before the refresh: selecting a tab that is in neither pane of
      // a split ends the split rather than displacing one of its tabs.
      set((s) => {
        const target = s.tabs.find((t) => t.id === tabId) ?? null;
        const endsSplit =
          target !== null &&
          !target.active &&
          !target.split &&
          s.tabs.some((t) => t.split);
        return {
          tabs: s.tabs.map((t) => ({
            ...t,
            active: t.id === tabId,
            split: endsSplit ? false : t.split,
          })),
          // Selecting is the shelf's exit: the chosen page should land in a
          // full-height hole, not one still shortened by the previews.
          tabPreviewOpen: false,
        };
      });
      await call("tabs:select", { tabId });
      await refreshTabs();
    },

    closeTab: async (tabId) => {
      set((s) => ({ tabs: s.tabs.filter((t) => t.id !== tabId) }));
      await call("tabs:close", { tabId });
      await refreshTabs();
    },

    navigate: async (tabId, url) => {
      if (tabId === null) {
        await get().createTab(url);
        return;
      }
      await call("tabs:navigate", { tabId, url });
      await refreshTabs();
    },

    goBack: async (tabId) => {
      const id = tabId ?? activeTab()?.id;
      if (id !== undefined) await call("tabs:goBack", { tabId: id });
    },

    goForward: async (tabId) => {
      const id = tabId ?? activeTab()?.id;
      if (id !== undefined) await call("tabs:goForward", { tabId: id });
    },

    reload: async (tabId) => {
      const id = tabId ?? activeTab()?.id;
      if (id !== undefined) await call("tabs:reload", { tabId: id });
    },

    togglePin: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab === undefined) return;
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pinned: !tab.pinned } : t,
        ),
      }));
      await call("tabs:setPinned", { tabId, pinned: !tab.pinned });
      await refreshTabs();
    },

    reorderTab: async (tabId, index) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab === undefined) return {};
        const rest = s.tabs.filter((t) => t.id !== tabId);
        rest.splice(Math.min(Math.max(index, 0), rest.length), 0, tab);
        return { tabs: rest };
      });
      await call("tabs:reorder", { tabId, index });
      await refreshTabs();
    },

    toggleSplit: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab === undefined) return;
      await call("tabs:setSplit", { tabId, split: !tab.split });
      await refreshTabs();
    },

    splitTabToSide: async (tabId, side) => {
      const tabs = get().tabs;
      const tab = tabs.find((t) => t.id === tabId);
      if (tab === undefined) return;
      const splitTab = tabs.find((t) => t.split) ?? null;
      // Selecting the tab that holds the split pane SWAPS the panes (main's
      // TabManager.select), which is what makes both of these two calls
      // rather than a bespoke channel: assign the pane, then let the swap put
      // the dragged tab on the side it was dropped on.
      if (side === "left") {
        // Already the left pane — unless nothing faces it yet, in which case
        // the drop still means "split", so give it the nearest partner.
        if (tab.active) {
          if (splitTab !== null) return;
          const partner = tabs.find((t) => t.id !== tabId);
          if (partner === undefined) {
            get().pushToast(
              "Split view needs a second tab — open another tab first",
              "warning",
            );
            return;
          }
          await call("tabs:setSplit", { tabId: partner.id, split: true });
        } else {
          await call("tabs:setSplit", { tabId, split: true });
          await call("tabs:select", { tabId });
        }
      } else {
        if (tab.split) return;
        if (tab.active) {
          // Hand the left pane to the tab already facing it when there is one,
          // so dragging the active tab across the divider swaps the pair
          // instead of pulling in an unrelated tab.
          const partner = splitTab ?? tabs.find((t) => t.id !== tabId);
          if (partner === undefined) {
            get().pushToast(
              "Split view needs a second tab — open another tab first",
              "warning",
            );
            return;
          }
          await call("tabs:select", { tabId: partner.id });
        }
        await call("tabs:setSplit", { tabId, split: true });
      }
      await refreshTabs();
    },

    fetchOriginInfo: async (host) => {
      if (
        host.length === 0 ||
        get().originInfo[host] !== undefined ||
        originInFlight.has(host)
      ) {
        return;
      }
      originInFlight.add(host);
      try {
        const info = await call("sync:originInfo", { host });
        if (info !== undefined) {
          set((s) => ({ originInfo: { ...s.originInfo, [host]: info } }));
        }
      } finally {
        originInFlight.delete(host);
      }
    },

    setOriginOverride: async (host, override) => {
      const info = await call("sync:setOriginOverride", { host, override });
      if (info !== undefined) {
        set((s) => ({ originInfo: { ...s.originInfo, [host]: info } }));
      }
    },

    rollbackOrigin: async (host) => {
      const spaceId = activeSpaceId();
      if (spaceId === null) return;
      const result = await call("sync:rollbackOrigin", { host, spaceId });
      if (result !== undefined) {
        get().pushToast(
          `Rolled back ${host} — ${result.restored} record(s) restored`,
          "success",
        );
      }
    },

    searchHistory: async (query, limit) =>
      (await callQuiet("history:list", { query, limit: limit ?? 8 })) ?? [],

    clearHistory: async () => {
      await call("history:clear", undefined);
      get().pushToast(
        "Browsing history cleared — synced visits are removed everywhere",
        "success",
      );
    },

    updateSettings: async (patch) => {
      const settings = await call("settings:update", patch);
      if (settings !== undefined) set({ settings });
    },

    refreshDevices: async () => {
      const devices = await call("devices:list", undefined);
      if (devices !== undefined) set({ devices });
    },

    renameDevice: async (deviceId, name) => {
      const devices = await call("devices:rename", { deviceId, name });
      if (devices === undefined) return false;
      set({ devices });
      return true;
    },

    syncWorkspace: async (mode, sourceDeviceId) => {
      const workspaceSync = await call("workspaceSync:run", {
        mode,
        ...(sourceDeviceId === undefined ? {} : { sourceDeviceId }),
      });
      if (workspaceSync === undefined) return false;
      set({ workspaceSync, overlay: "none" });
      await Promise.all([refreshSpaces(), refreshTabs()]);
      get().pushToast("Workspace and sessions synchronized", "success");
      return true;
    },

    refreshSignInQueue: async () => {
      const signInQueue = await call("migration:signInQueue", undefined);
      if (signInQueue !== undefined) set({ signInQueue });
    },

    markSignedIn: async (domain) => {
      const signInQueue = await call("migration:markSignedIn", { domain });
      if (signInQueue !== undefined) set({ signInQueue });
    },

    choosePasskeyAccount: async (credentialId) => {
      const request = get().passkeyRequest;
      if (request === null) return;
      // Clear first: the ceremony resolves in the main process either way, and
      // a stuck picker would be worse than a lost repaint.
      set({ passkeyRequest: null });
      await call("passkeys:chooseAccount", {
        requestId: request.requestId,
        credentialId,
      });
    },

    contentBounds: null,
    reportContentBounds: (bounds) => {
      set({ contentBounds: bounds });
      void call("ui:setContentBounds", bounds);
    },

    reportOverlayActive: (active) => {
      void callQuiet("ui:setOverlayActive", { active });
    },

    glance: null,
    closeGlance: async () => {
      await call("glance:close", undefined);
    },
    promoteGlance: async () => {
      await call("glance:promote", undefined);
    },
    glanceGoBack: async () => {
      await call("glance:goBack", undefined);
    },
    glanceGoForward: async () => {
      await call("glance:goForward", undefined);
    },
    reportGlanceBounds: (bounds) => {
      void callQuiet("glance:bounds", bounds);
    },

    paneResizing: false,
    setPaneResizing: (resizing) => {
      if (get().paneResizing === resizing) return;
      set({ paneResizing: resizing });
      if (!resizing) saveSplitRatios(get().splitRatios);
    },

    tabDragging: false,
    setTabDragging: (dragging) => {
      if (get().tabDragging === dragging) return;
      // A drag and the preview shelf fight over the same strip real estate —
      // picking a tab up dismisses the shelf.
      if (dragging) set({ tabDragging: dragging, tabPreviewOpen: false });
      else set({ tabDragging: dragging });
    },

    tabThumbnails: {},
    tabPreviewOpen: false,
    setTabPreviewOpen: (open) => {
      if (get().tabPreviewOpen === open) return;
      set({ tabPreviewOpen: open });
      if (!open) return;
      const spaceId = activeSpaceId();
      if (spaceId === null) return;
      // Pull the cache (captures pushed before this session's shelf ever
      // opened) and kick a fresh capture of the visible tab — that frame
      // arrives as a `tabs:thumbnail` push while the shelf slides in.
      void callQuiet("tabs:thumbnails", { spaceId }).then((thumbs) => {
        if (thumbs === undefined) return;
        for (const thumb of thumbs) mergeThumbnail(thumb);
      });
    },

    tabPreviewHoverId: null,
    setTabPreviewHoverId: (tabId) => {
      if (get().tabPreviewHoverId === tabId) return;
      set({ tabPreviewHoverId: tabId });
    },
    clearTabPreviewHoverId: (tabId) => {
      if (get().tabPreviewHoverId !== tabId) return;
      set({ tabPreviewHoverId: null });
    },

    splitRatios: loadSplitRatios(),
    setSplitRatio: (spaceId, ratio) => {
      set((s) => ({ splitRatios: { ...s.splitRatios, [spaceId]: ratio } }));
      void callQuiet("ui:setSplitRatio", { ratio });
      if (!get().paneResizing) saveSplitRatios(get().splitRatios);
    },

    pushSplitRatio: (spaceId) => {
      void callQuiet("ui:setSplitRatio", {
        ratio: get().splitRatios[spaceId] ?? DEFAULT_SPLIT_RATIO,
      });
    },

    wizardOpen: false,
    setWizardOpen: (open) => {
      if (get().wizardOpen !== open) set({ wizardOpen: open });
    },

    openOnboarding: () =>
      set({ onboardingDismissed: false, overlay: "none", originPopover: null }),
    dismissOnboarding: () => set({ onboardingDismissed: true }),

    signup: async (email, displayName, inviteCode) => {
      const args: SumaInvokeMap["auth:signup"]["args"] = { email };
      if (displayName !== undefined && displayName.length > 0)
        args.displayName = displayName;
      if (inviteCode !== undefined && inviteCode.length > 0)
        args.inviteCode = inviteCode;
      const status = await call("auth:signup", args);
      if (status !== undefined) setAuthStatus(status);
      return status;
    },

    mintEnrollmentCode: async () => {
      return call("auth:mintEnrollmentCode", undefined);
    },

    signinWithCode: async (code) => {
      const status = await call("auth:signinWithCode", { code });
      if (status !== undefined) setAuthStatus(status);
      return status;
    },

    enrollDevice: async (name) => {
      const status = await call("auth:enroll", { name });
      if (status !== undefined) setAuthStatus(status);
      return status;
    },

    registerDeviceCredential: async () => {
      const status = await call("auth:registerDeviceCredential", undefined);
      if (status !== undefined) setAuthStatus(status);
      return status;
    },

    passkeyBegin: async () => call("auth:passkeyBegin", undefined),

    passkeyFinish: async (credential) => {
      const status = await call("auth:passkeyFinish", { credential });
      if (status !== undefined) setAuthStatus(status);
      return status;
    },

    recoverKeys: async (recoveryCode) =>
      call("auth:recoverKeys", { recoveryCode }),

    signOut: async () => {
      // The renderer owns two device-local preferences that live in
      // localStorage rather than in any store main can rewrite (theme,
      // split-view ratios) — clear them here, before main relaunches, so the
      // fresh app really does come up at its defaults.
      clearStoredTheme();
      try {
        localStorage.removeItem(SPLIT_RATIO_STORAGE_KEY);
      } catch {
        // Nothing to clear if storage is unavailable.
      }
      set({ splitRatios: {} });
      await call("auth:signOut", undefined);
    },

    revokeDevice: async (deviceId) => {
      const receipt = await call("devices:revoke", { deviceId });
      if (receipt !== undefined) await get().refreshDevices();
      return receipt;
    },

    refreshDownloads: async () => {
      const downloads = await callQuiet("downloads:list", undefined);
      if (downloads !== undefined) set({ downloads });
    },

    openDownload: async (id) => {
      await call("downloads:open", { id });
    },

    revealDownload: async (id) => {
      await call("downloads:reveal", { id });
    },

    cancelDownload: async (id) => {
      await call("downloads:cancel", { id });
    },

    refreshTransfers: async () => {
      const update = await callQuiet("transfers:list", undefined);
      if (update !== undefined) applyTransfers(update);
    },

    cancelTransfer: async (id) => {
      set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) }));
      await call("transfers:cancel", { id });
      await get().refreshTransfers();
    },

    refreshCredentialStatus: async () => {
      const credentialStatus = await callQuiet("credentials:status", undefined);
      if (credentialStatus !== undefined) set({ credentialStatus });
    },

    searchCredentials: async (host) =>
      (await call("credentials:search", { host })) ?? [],

    fillCredential: async (tabId, itemId) => {
      const result = await call("credentials:fill", { tabId, itemId });
      return result?.ok === true;
    },

    dismissCertError: (host, atMs) =>
      set((s) => ({
        certErrors: s.certErrors.filter(
          (e) => !(e.host === host && e.atMs === atMs),
        ),
      })),

    /* ---- Phase 2: machine (§8.5) ---- */

    refreshMachine: async () => {
      const machine = await callQuiet("machine:status", undefined);
      if (machine !== undefined) set({ machine });
    },

    wakeMachine: async () => {
      const machine = await call("machine:wake", undefined);
      if (machine !== undefined) set({ machine });
    },

    suspendMachine: async () => {
      const machine = await call("machine:suspend", undefined);
      if (machine !== undefined) set({ machine });
    },

    /* ---- Phase 2: terminal (§8.5) ---- */

    refreshTerminals: async () => {
      const terminals = await call("terminal:list", undefined);
      if (terminals !== undefined) set({ terminals });
      return terminals ?? get().terminals;
    },

    discoverTerminals: async () => {
      const terminals = await call("terminal:discover", undefined);
      if (terminals !== undefined) set({ terminals });
      return terminals ?? get().terminals;
    },

    pendingPtyId: null,

    newTerminal: async () => {
      // The shell is created FIRST, then the page is opened on it. The page
      // may not be mounted yet (no terminal tab), and it is the page — not
      // this action — that decides which shell is on screen, so the id is
      // left here for it to claim.
      const info = await get().createTerminal();
      if (info !== undefined) set({ pendingPtyId: info.ptyId });
      await get().openTerminal();
    },

    consumePendingTerminal: () => {
      const pending = get().pendingPtyId;
      if (pending !== null) set({ pendingPtyId: null });
      return pending;
    },

    createTerminal: async () => {
      const info = await call("terminal:create", {});
      if (info !== undefined) {
        set((s) => ({
          terminals: [
            ...s.terminals.filter((t) => t.ptyId !== info.ptyId),
            info,
          ],
        }));
      }
      return info;
    },

    attachTerminal: async (ptyId) => {
      const info = await call("terminal:attach", { ptyId });
      if (info !== undefined) {
        set((s) => ({
          terminals: s.terminals.map((t) => (t.ptyId === ptyId ? info : t)),
        }));
      }
      return info;
    },

    closeTerminal: async (ptyId) => {
      set((s) => ({ terminals: s.terminals.filter((t) => t.ptyId !== ptyId) }));
      await call("terminal:close", { ptyId });
    },

    setJobMode: async (ptyId, enabled) => {
      const info = await call("terminal:setJobMode", { ptyId, enabled });
      if (info !== undefined) {
        set((s) => ({
          terminals: s.terminals.map((t) => (t.ptyId === ptyId ? info : t)),
        }));
      }
    },

    sendTerminalInput: (ptyId, data) => {
      void callQuiet("terminal:input", { ptyId, data });
    },

    resizeTerminal: (ptyId, cols, rows) => {
      void callQuiet("terminal:resize", { ptyId, cols, rows });
    },

    /* ---- Phase 2: ports (§8.5) ---- */

    refreshPorts: async () => {
      const ports = await callQuiet("ports:list", undefined);
      if (ports !== undefined) set({ ports });
    },

    /* ---- IDE (suma://terminal) ---- */

    toggleIdePanel: (panel) => {
      const key =
        panel === "explorer"
          ? ("ideExplorerOpen" as const)
          : panel === "editor"
            ? ("ideEditorOpen" as const)
            : ("ideTerminalOpen" as const);
      set((s) => ({ [key]: !s[key] }));
      persistIdeLayout(get());
    },

    setIdeExplorerWidth: (px) => {
      set({ ideExplorerWidth: clampExplorerWidth(px) });
      persistIdeLayout(get());
    },

    setIdeTerminalHeight: (px) => {
      set({ ideTerminalHeight: clampTerminalHeight(px) });
      persistIdeLayout(get());
    },

    refreshWorkspaceTree: async () => {
      const workspaceTree = await call("workspace:tree", undefined);
      if (workspaceTree !== undefined) set({ workspaceTree });
    },

    readIdeFile: (path) => call("workspace:readFile", { path }),

    saveIdeFile: async (path, contents) => {
      const result = await call("workspace:writeFile", { path, contents });
      return result !== undefined;
    },

    openIdeFile: (path) => {
      set((s) => ({
        ideOpenFiles: s.ideOpenFiles.includes(path)
          ? s.ideOpenFiles
          : [...s.ideOpenFiles, path],
        ideActiveFile: path,
        // Selecting a file is an explicit ask to SEE it, so a hidden editor
        // reopens — mirroring how VS Code treats explorer clicks.
        ideEditorOpen: true,
      }));
      persistIdeLayout(get());
    },

    closeIdeFile: (path) => {
      dropIdeBuffer(path);
      set((s) => {
        const remaining = s.ideOpenFiles.filter((p) => p !== path);
        const { [path]: _dropped, ...dirty } = s.ideDirty;
        let active = s.ideActiveFile;
        if (active === path) {
          // Activate the neighbor the closed tab was sitting next to.
          const index = s.ideOpenFiles.indexOf(path);
          active = remaining[Math.min(index, remaining.length - 1)] ?? null;
        }
        return { ideOpenFiles: remaining, ideActiveFile: active, ideDirty: dirty };
      });
    },

    setIdeActiveFile: (path) => set({ ideActiveFile: path }),

    setIdeFileDirty: (path, dirty) =>
      set((s) => {
        if ((s.ideDirty[path] ?? false) === dirty) return s;
        if (dirty) return { ideDirty: { ...s.ideDirty, [path]: true } };
        const { [path]: _dropped, ...rest } = s.ideDirty;
        return { ideDirty: rest };
      }),

    setPortForward: async (port, enabled) => {
      const info = await call("ports:forward", { port, enabled });
      if (info !== undefined) {
        set((s) => ({
          ports: s.ports.map((p) => (p.port === port ? info : p)),
        }));
      }
    },

    /* ---- Phase 2: identity egress (§8.4, §8.7) ---- */

    refreshEgress: async (spaceId) => refreshEgressFor(spaceId),

    setEgressPolicy: async (spaceId, policy) => {
      const status = await call("egress:setPolicy", { spaceId, policy });
      if (status !== undefined) {
        set((s) => ({
          egressBySpace: { ...s.egressBySpace, [spaceId]: status },
          spaces: s.spaces.map((sp) =>
            sp.id === spaceId ? { ...sp, egressPolicy: policy } : sp,
          ),
        }));
      }
    },

    browseDirectForNow: async (spaceId) => {
      const status = await call("egress:browseDirectForNow", { spaceId });
      if (status !== undefined) {
        set((s) => ({
          egressBySpace: { ...s.egressBySpace, [spaceId]: status },
        }));
        get().pushToast(
          "Browsing direct for now — resets when the gateway is back",
          "warning",
        );
      }
    },

    setSiteBypass: async (spaceId, host, bypass) => {
      const status = await call("egress:setSiteBypass", {
        spaceId,
        host,
        bypass,
      });
      if (status !== undefined) {
        set((s) => ({
          egressBySpace: { ...s.egressBySpace, [spaceId]: status },
          bypassSuggestions: s.bypassSuggestions.filter(
            (b) => !(b.spaceId === spaceId && b.host === host),
          ),
        }));
      }
    },

    explainEgress: async (spaceId, host) =>
      call("egress:explain", { spaceId, host }),

    dismissBypassSuggestion: (spaceId, host) =>
      set((s) => ({
        bypassSuggestions: s.bypassSuggestions.filter(
          (b) => !(b.spaceId === spaceId && b.host === host),
        ),
      })),

    /* ---- Phase 2: audit trail (§8.7) ---- */

    refreshAudit: async () => {
      const audit = await call("audit:list", {});
      if (audit !== undefined) set({ audit, auditLoaded: true });
    },
  };
});

export function selectActiveSpace(s: SumaState): SpaceInfo | null {
  return s.spaces.find((sp) => sp.active) ?? null;
}

export function selectActiveTab(s: SumaState): TabInfo | null {
  return s.tabs.find((t) => t.active) ?? null;
}
