/**
 * Typed IPC contract between the Suma main process and the chrome renderer.
 *
 * This file is the single source of truth for the preload bridge
 * (`window.suma`). Main implements every channel in `SumaInvokeMap`;
 * renderer subscribes to events in `SumaEventMap`. Both sides import ONLY
 * types from here — no runtime dependencies cross the boundary.
 */

import type {
  ContinuityMode,
  FileEntry,
  HistoryVisit,
  MachineState,
  PtyRestoreKind,
  QuotaState,
  SpaceMeta,
  SyncTier,
  Transfer,
  WorkspaceSettings,
} from "@suma/protocol";
import type {
  ChatChunkEvent,
  ChatErrorEvent,
  ChatSettingsInfo,
  ChatSettingsPatch,
  ChatStreamRequest,
} from "./chat";
import type { FavoriteSite } from "./favorites";
import type {
  BuzzAgentsState,
  NostrApprovalResponse,
  NostrPendingRequest,
  NostrRelayPolicy,
  NostrSettingsInfo,
  NostrSitePolicyPatch,
} from "./nostr";
import type { SavedItem, SavedItemPatch } from "./saves";
import type { SavedVideo, VideoPipCommand, VideoPipState } from "./videos";
import type {
  SelectionActionPayload,
  SelectionToolbarAction,
} from "./selection";
import type {
  TtsClip,
  TtsProviderId,
  TtsSettingsInfo,
  TtsSettingsPatch,
  TtsVoice,
} from "./tts";
import type { UpdateState } from "./updates";
import type {
  VoiceAudioInArgs,
  VoiceAudioOutEvent,
  VoiceSettingsInfo,
  VoiceSettingsPatch,
  VoiceStatus,
  VoiceTranscriptEvent,
} from "./voice";

/* ------------------------------------------------------------------ *
 * Data shapes
 * ------------------------------------------------------------------ */

export interface TabInfo {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Every open tab can be manually synchronized; pinned is shared presentation state. */
  pinned: boolean;
  active: boolean;
  /** Shown in the second split-view pane (§6 2-pane split; synced focus). */
  split: boolean;
  /** Renderer process gone (§8.1 crash recovery) — select/reload revives it. */
  crashed: boolean;
  /** Backgrounded tab whose contents were discarded to save memory (§8.1). */
  discarded: boolean;
}

export interface SpaceInfo extends SpaceMeta {
  active: boolean;
  tabCount: number;
}

/**
 * The Glance preview (Zen "Glance" / Arc "Peek"): a link opened as a floating
 * page over the current tab instead of a new one. Main owns the page's
 * WebContentsView (main/glance.ts); this is the chrome-facing snapshot the
 * GlanceOverlay frame renders around it. Null ⇒ no glance is open.
 */
export interface GlanceInfo {
  url: string;
  title: string;
  faviconUrl: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type SyncConnectionState =
  | "connected"
  | "connecting"
  | "offline"
  | "paused";

export interface SyncStatus {
  state: SyncConnectionState;
  /** Mutations queued locally while offline — surfaced in the "Sync paused" pill (§10). */
  queueDepth: number;
  lastConvergedMs: number | null;
  keyMode: "e2ee" | "suma-managed";
}

export interface OriginContinuityInfo {
  host: string;
  label: string;
  mode: ContinuityMode;
  syncTier: SyncTier;
  rotatingAuth: boolean;
  sensitive: boolean;
  /** User override: 'sync' | 'never' | null (= corpus default) (§8.7). */
  userOverride: "sync" | "never" | null;
}

export interface MigrationSource {
  browser: "chrome" | "arc";
  profileName: string;
  profilePath: string;
  bookmarkCount: number;
}

export interface SignInQueueItem {
  domain: string;
  label: string;
  mode: ContinuityMode;
  sensitive: boolean;
  /** Position in the guided queue, most-used first. */
  rank: number;
  done: boolean;
}

export interface MigrationResult {
  spacesCreated: number;
  pinnedTabsCreated: number;
  bookmarksImported: number;
  signInQueue: SignInQueueItem[];
}

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A tab's captured page snapshot, for the hover preview shelf (TabStrip →
 * TabPreviewStrip). Deliberately NOT part of TabInfo: `tabs:updated` fires on
 * every title/favicon/loading tick, and a base64 JPEG per tab riding each
 * push would dwarf the state it accompanies. Thumbnails travel on their own
 * channels instead, one tab at a time, only when a capture actually landed.
 */
export interface TabThumbnail {
  tabId: string;
  /** JPEG data: URL, ≤480px wide — small enough to cross IPC whole. */
  dataUrl: string;
  capturedAtMs: number;
}

/** Degraded-mode banner state per plane (§10 failure-mode matrix). */
export interface PlaneHealth {
  sessionPlane: "ok" | "degraded" | "down";
  egressPlane: "ok" | "degraded" | "down" | "bypassed";
  computePlane: "ok" | "degraded" | "down" | "cold_booted";
}

/* ---- Phase 1 additions (§8.1 daily-driver baseline, §8.2 identity) ---- */

export interface DownloadItemInfo {
  id: string;
  spaceId: string;
  url: string;
  filename: string;
  savePath: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAtMs: number;
  /** Cloud mode: where the finished file was also mirrored on the account's
   *  computer (a vfs wire path like "/Personal/Downloads/report.pdf"). */
  cloudPath?: string;
}

export interface EnrollmentStatus {
  /** unenrolled → signed-up (account exists) → enrolled (device registered). */
  state: "unenrolled" | "signed-up" | "enrolled";
  controlUrl: string | null;
  email: string | null;
  /** Display name given at signup — what the UI greets the user by. */
  displayName: string | null;
  userId: string | null;
  deviceId: string;
  deviceName: string | null;
  /** Human default derived from this Mac's Computer Name/hostname. */
  suggestedDeviceName: string;
  /** A WebAuthn or device-key credential is registered for login. */
  passkeyRegistered: boolean;
  credentialKind: "webauthn" | "device-key" | null;
  /** Where the account's computer lives ("cloud" VM vs this Mac). null =
   *  unknown (legacy/linked record awaiting /v1/me backfill) ⇒ treat as cloud. */
  computeMode: "cloud" | "local" | null;
  /** Present ONLY in the response that first reveals it — shown once (§8.2). */
  recoveryCode?: string;
}

/** Human-readable control-plane identity merged with live SessionHub presence. */
export interface ConnectedDeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenMs: number;
  enrolledAtMs: number | null;
  revoked: boolean;
  isThisDevice: boolean;
  canRename: boolean;
}

export type WorkspaceSyncMode = "push" | "pull" | "merge";

/** A device-scoped workspace snapshot that is distinct from both this Mac and
 * the canonical workspace. Device snapshots are automatic restore points;
 * peers can read them but never overwrite them. */
export interface WorkspaceSyncSource {
  deviceId: string;
  name: string;
  platform: string;
  updatedAtMs: number;
}

/** Manual reconciliation state for the shared browser workspace. */
export interface WorkspaceSyncStatus {
  /** A complete canonical snapshot has arrived from SessionHub. */
  remoteReady: boolean;
  /** Local and canonical state differ, so the sync control is actionable. */
  pending: boolean;
  /** The canonical workspace or account-wide session differs from this Mac. */
  canonicalPending: boolean;
  /** Tabs, URLs, order, or focus changed locally since the last reconciliation. */
  localChanged: boolean;
  /** Workspace or session records arrived from another device. */
  remoteChanged: boolean;
  /** Other-device snapshots worth offering as an explicit Pull/Merge source.
   * Snapshots identical to canonical or to this Mac are omitted. */
  sources: WorkspaceSyncSource[];
}

/** The §8.2 honest revocation contract, surfaced verbatim in the UI. */
export interface RevocationReceipt {
  deviceId: string;
  stoppedFutureAccess: boolean;
  purgeOnReconnect: boolean;
  cannotInvalidateThirdPartySessions: boolean;
  affectedOrigins: Array<{
    domain: string;
    label: string;
    remoteLogoutUrl?: string;
  }>;
}

export interface CredentialProviderStatus {
  provider: "1password-cli" | "none";
  available: boolean;
  detail: string | null;
}

export interface CredentialItem {
  id: string;
  title: string;
  username: string;
}

export interface CertErrorInfo {
  host: string;
  url: string;
  /** Chromium error code string, e.g. "net::ERR_CERT_AUTHORITY_INVALID". */
  error: string;
  atMs: number;
}

/* ------------------------------------------------------------------ *
 * Passkeys (WebAuthn)
 * ------------------------------------------------------------------ */

/**
 * Whether this build can drive the macOS platform authenticator. Touch ID
 * passkeys require a signed build whose `keychain-access-groups` entitlement
 * matches the configured group, so an unsigned dev run is honestly reported
 * rather than failing mid-ceremony (§4 Assisted mode).
 */
export interface PasskeyStatus {
  support: "available" | "unsigned-build" | "unsupported-platform";
  detail: string;
}

export interface PasskeyAccountChoice {
  credentialId: string;
  name: string;
  detail: string;
}

/** An in-flight ceremony waiting for the user to pick a credential. */
export interface PasskeyAccountRequest {
  requestId: string;
  relyingPartyId: string;
  accounts: PasskeyAccountChoice[];
}

/* ------------------------------------------------------------------ *
 * Phase 2: compute, terminal, egress (§8.4, §8.5, §8.7)
 * ------------------------------------------------------------------ */

export interface MachineStatus {
  machineId: string | null;
  state: MachineState;
  spec: { cpus: number; memoryMb: number };
  /** Why the machine is awake or suspending, for the status pill (§8.5). */
  reason: string;
  /** Visible cost meter — "~$0.0X/hr while awake". */
  hourlyRate: string;
  accruedUsd: number;
  /** True after a cold boot: the process was lost, the context restored. */
  reconstructed: boolean;
}

export interface TerminalInfo {
  ptyId: string;
  title: string;
  cwd: string;
  /** Whether the last attach resumed a live process or rebuilt context (§8.5). */
  restore: PtyRestoreKind | null;
  /** Job Mode: "keep running" while unattended. */
  jobMode: boolean;
  exited: boolean;
}

export interface PortForwardInfo {
  port: number;
  process: string;
  /** Forwarded to the same localhost port on this Mac. */
  forwarded: boolean;
  localUrl: string;
}

/**
 * The IDE surfaces on suma://terminal (explorer + editor) browse a workspace
 * directory on the machine the shells run on. Paths are always
 * workspace-relative POSIX strings ("src/index.ts") — the root never leaves
 * main except as a display label, and main refuses any path that resolves
 * outside it.
 */
export interface WorkspaceTree {
  /** Absolute root directory, for display (header, tooltips) only. */
  root: string;
  /**
   * Every file under the root, workspace-relative. Directories are implied by
   * their children; an EMPTY directory appears itself with a trailing "/".
   */
  paths: string[];
  /** True when the walk stopped at its entry or depth cap. */
  truncated: boolean;
}

/**
 * What the IDE got back for a file: editable text, an image it can render but
 * not edit, or a notice. The kind decides the pane — main never hands the
 * renderer bytes it has no way to show.
 */
export type WorkspaceFile =
  | { path: string; kind: "text"; contents: string }
  | {
      path: string;
      kind: "image";
      /** `data:` URL, ready for an <img src>. The chrome's CSP allows data:. */
      dataUrl: string;
      /** Sniffed from the file's magic bytes, not its extension. */
      mime: string;
      bytes: number;
    }
  | {
      path: string;
      kind: "audio";
      /**
       * suma-workspace:// stream URL for an <audio src>. Unlike an image, the
       * bytes never cross IPC — the protocol serves Range requests so the
       * player can seek (main/workspace-media.ts).
       */
      url: string;
      /** Sniffed from the file's magic bytes, not its extension. */
      mime: string;
      bytes: number;
    }
  | {
      path: string;
      kind: "unreadable";
      reason: "binary" | "too-large" | "unsupported";
    };

/** Per-space egress state surfaced in the site controls (§8.4, §8.7). */
export interface EgressStatus {
  spaceId: string;
  policy: "suma-ip" | "direct";
  gateway: "up" | "down";
  /** One-click "browse direct for now", reset on reconnect. */
  temporaryDirectOverride: boolean;
  mediaBypass: boolean;
  /** Hosted checkout pages route direct — payment processors refuse proxied
   *  requests outright rather than challenge them (§8.4). */
  checkoutBypass: boolean;
  /** Merchant-branded checkout hosts recognised this session; not persisted. */
  detectedCheckoutHosts: string[];
  siteBypass: string[];
  /** Set when the gateway is down and requests are being blocked. */
  failClosed: boolean;
  vpnActive: boolean;
  /**
   * The space is configured for the identity IP but is NOT being routed this
   * run: QUIC can only be disabled before app start, and proxying with QUIC
   * live would leak the real IP over UDP (§8.4). Takes effect next launch.
   */
  restartRequired: boolean;
}

export interface EgressDecisionInfo {
  host: string;
  route: "gateway" | "direct" | "blocked";
  explanation: string;
}

export interface AuditEntry {
  id: string;
  type: string;
  createdAtMs: number;
  actorDeviceId: string | null;
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Phase 3: Files (§8.6, M-3 Lite)
 * ------------------------------------------------------------------ */

/** A folder in the Files tree, derived from the flat `~/cloud` path list. */
export interface FileDirInfo {
  name: string;
  /** Absolute VFS path of the folder, e.g. "/Downloads". */
  path: string;
  /** Files at or below this folder. */
  fileCount: number;
  sizeBytes: number;
}

/** One directory level of `~/cloud` — the only cloud-native tree (§8.6). */
export interface DirectoryListing {
  /** Normalized directory path; "/" is the root of ~/cloud. */
  path: string;
  dirs: FileDirInfo[];
  /** Files directly in `path`. */
  files: FileEntry[];
  /** Everything under `path`, recursively — what a client-side tree needs. */
  entries: FileEntry[];
}

/** Quota meter (§8.6: Pro 100 GB, soft-block at the limit — never deletion). */
export interface QuotaMeter {
  usedBytes: number;
  limitBytes: number;
  usedLabel: string;
  limitLabel: string;
  /** 0..1, clamped — for the meter bar. */
  fraction: number;
  /** At the limit: existing files stay readable, new writes are refused. */
  softBlocked: boolean;
  explanation: string;
}

/**
 * A download Suma kept on this Mac, with the §8.6 reason. Surfaced so the
 * user learns why THIS one stayed local instead of assuming Suma is
 * inconsistent — `credentialed_request` is the case that must never be silent.
 */
export interface CloudFetchDeclined {
  url: string;
  filename: string;
  /** `CloudFetchRefusal` from the protocol, or a desktop-side refusal. */
  reason: string;
  explanation: string;
  atMs: number;
}

/**
 * The transfers snapshot: cloud fetches in flight (visible on every device,
 * §5 M-3 Lite) plus the most recent download that was NOT handed to the cloud.
 * Both belong to the same question — "where is this download happening?" — so
 * they travel together.
 */
export interface TransfersUpdate {
  transfers: Array<
    Transfer & {
      /** False while an agent-side fetch is running — the agent has no
       *  cancel op yet, and the UI says so instead of faking a button. */
      cancellable?: boolean;
    }
  >;
  declined: CloudFetchDeclined | null;
}

export interface FileUploadResult {
  file: FileEntry;
  /** Chunks uploaded vs. skipped because the store already had them (dedup). */
  uploadedChunks: number;
  dedupedChunks: number;
}

/* ------------------------------------------------------------------ *
 * Floating audio player (chrome ⇄ save-preview overlay window, via main)
 * ------------------------------------------------------------------ */

/** Mirrors lib/audio.ts's PlaybackStatus — the overlay renders from this. */
export type AudioPlaybackStatus =
  | "idle"
  | "preparing"
  | "playing"
  | "paused"
  | "error";

/**
 * Everything the floating player needs to draw itself, and nothing the
 * overlay window has no business holding (no text, no URLs, no queue
 * contents). The chrome owns the real store; this is a display snapshot.
 */
export interface AudioOverlayState {
  status: AudioPlaybackStatus;
  /** Null exactly when nothing is loaded — the player unmounts. */
  track: {
    title: string;
    origin: string | null;
    voiceLabel: string | null;
  } | null;
  /** Seconds. */
  position: number;
  /** Seconds; 0 until the element knows. */
  duration: number;
  index: number;
  queueLength: number;
  rate: number;
  muted: boolean;
  ended: boolean;
  error: string | null;
}

/** One tap in the overlay, applied by the chrome's audio store verbatim. */
export type AudioOverlayCommand =
  | { command: "toggle" | "next" | "previous" | "stop" | "openVoiceSettings" }
  | { command: "seek" | "setRate"; value: number }
  | { command: "setMuted"; value: boolean };

/* ------------------------------------------------------------------ *
 * Invoke channels (renderer → main, request/response)
 * ------------------------------------------------------------------ */

export interface SumaInvokeMap {
  "spaces:list": { args: void; result: SpaceInfo[] };
  "spaces:create": { args: { name: string; color: string }; result: SpaceInfo };
  "spaces:update": {
    args: {
      spaceId: string;
      patch: Partial<
        Pick<SpaceMeta, "name" | "color" | "position" | "egressPolicy">
      >;
    };
    result: SpaceInfo;
  };
  "spaces:setActive": { args: { spaceId: string }; result: void };
  /** Remove a space (tombstoned; propagates to all devices). §8.8 cleanup. */
  "spaces:remove": { args: { spaceId: string }; result: SpaceInfo[] };

  "tabs:list": { args: { spaceId: string }; result: TabInfo[] };
  "tabs:create": {
    args: { spaceId: string; url?: string; pinned?: boolean };
    result: TabInfo;
  };
  "tabs:close": { args: { tabId: string }; result: void };
  "tabs:select": { args: { tabId: string }; result: void };
  "tabs:navigate": { args: { tabId: string; url: string }; result: void };
  "tabs:goBack": { args: { tabId: string }; result: void };
  "tabs:goForward": { args: { tabId: string }; result: void };
  "tabs:reload": { args: { tabId: string }; result: void };
  "tabs:setPinned": { args: { tabId: string; pinned: boolean }; result: void };
  "tabs:reorder": { args: { tabId: string; index: number }; result: void };
  /** Split view (§6): show the tab in a second pane beside the active tab. */
  "tabs:setSplit": { args: { tabId: string; split: boolean }; result: void };
  /**
   * Every cached thumbnail for a space — the preview shelf's pull on open
   * (captures made before it mounted never reached it). Calling this also
   * kicks a fresh capture of the currently VISIBLE tab(s); those frames
   * arrive moments later as `tabs:thumbnail` pushes, so the shelf shows the
   * cache instantly and the live page catches up mid-slide.
   */
  "tabs:thumbnails": { args: { spaceId: string }; result: TabThumbnail[] };

  /** Browsing history (§8.3): local always; synced only when enabled. */
  "history:list": {
    args: { query?: string; limit?: number };
    result: HistoryVisit[];
  };
  "history:clear": { args: void; result: void };

  "sync:status": { args: void; result: SyncStatus };
  "sync:originInfo": { args: { host: string }; result: OriginContinuityInfo };
  "sync:setOriginOverride": {
    args: { host: string; override: "sync" | "never" | null };
    result: OriginContinuityInfo;
  };
  "sync:rollbackOrigin": {
    args: { host: string; spaceId: string };
    result: { restored: number };
  };

  "migration:detectSources": { args: void; result: MigrationSource[] };
  "migration:import": {
    args: { profilePath: string; browser: "chrome" | "arc" };
    result: MigrationResult;
  };
  "migration:signInQueue": { args: void; result: SignInQueueItem[] };
  "migration:markSignedIn": {
    args: { domain: string };
    result: SignInQueueItem[];
  };

  "settings:get": { args: void; result: WorkspaceSettings };
  "settings:update": {
    args: Partial<WorkspaceSettings>;
    result: WorkspaceSettings;
  };

  /**
   * Text-to-speech (`suma://settings/voice`). Synthesis runs in MAIN so the
   * provider API key never reaches the renderer and the chrome page's CSP does
   * not have to allow two third-party API origins — the renderer sends text and
   * gets audio bytes back (see main/audio/tts-service.ts).
   */
  "tts:settings": { args: void; result: TtsSettingsInfo };
  "tts:updateSettings": { args: TtsSettingsPatch; result: TtsSettingsInfo };
  /** This Mac's installed `say` voices, or a provider's static catalog. */
  "tts:voices": { args: { provider: TtsProviderId }; result: TtsVoice[] };
  /** `requestId` is the renderer's correlation id for `tts:cancel`. */
  "tts:speak": {
    args: {
      requestId: string;
      text: string;
      /** One-off overrides, for the settings page's voice preview. */
      provider?: TtsProviderId;
      voice?: string;
    };
    result: TtsClip;
  };
  "tts:cancel": { args: { requestId: string }; result: void };

  /**
   * The AI assistant (ChatSidebar). The agent loop runs in MAIN
   * (main/chat/chat-service.ts) for the same reasons TTS synthesis does: the
   * gateway key never reaches the renderer, and the browser tools need the
   * tab WebContentsViews. `chat:start` resolves when the run ends; the
   * streamed UI message chunks arrive as `chat:chunk` events correlated by
   * the renderer-minted requestId, closed by `chat:end` or `chat:error`.
   */
  "chat:settings": { args: void; result: ChatSettingsInfo };
  "chat:updateSettings": { args: ChatSettingsPatch; result: ChatSettingsInfo };
  "chat:start": { args: ChatStreamRequest; result: void };
  "chat:stop": { args: { requestId: string }; result: void };

  /**
   * The voice assistant (shared/voice.ts). The wake-word engine and the
   * agent session (the chat sidebar's AI SDK loop with transcription in and
   * realtime TTS out) run in MAIN (main/voice/voice-service.ts) — the keys
   * and the browser tools live there. The overlay renderer owns the
   * microphone and the speakers: `voice:audio` carries 16 kHz PCM16 mic
   * frames inward while the assistant is armed or in a session; reply audio
   * comes back as `voice:audioOut` events. Settings calls come from the
   * chrome (settings page); audio and session controls come from the overlay
   * (HUD) — both senders are trusted for the voice:* channels.
   */
  "voice:settings": { args: void; result: VoiceSettingsInfo };
  "voice:updateSettings": {
    args: VoiceSettingsPatch;
    result: VoiceSettingsInfo;
  };
  /** Pull on mount — status pushes sent before a surface existed are gone. */
  "voice:status": { args: void; result: VoiceStatus };
  "voice:audio": { args: VoiceAudioInArgs; result: void };
  /** Start a conversation now (HUD tap — the push-to-talk path sans hotkey). */
  "voice:start": { args: void; result: void };
  /** End the conversation; the assistant returns to armed listening. */
  "voice:stop": { args: void; result: void };

  /**
   * App self-updates (shared/updates.ts). The updater runs in MAIN
   * (main/updates/update-service.ts) against the GitHub releases feed; the
   * About settings page renders the state and can only nudge it — kick off
   * a check, or restart into an already-downloaded version.
   */
  "updates:state": { args: void; result: UpdateState };
  /** Fire-and-forget; progress arrives via `updates:changed`. */
  "updates:check": { args: void; result: UpdateState };
  /** Quit and swap in the staged build. No-op unless phase is `ready`. */
  "updates:install": { args: void; result: void };

  "devices:list": { args: void; result: ConnectedDeviceInfo[] };
  "devices:rename": {
    args: { deviceId: string; name: string };
    result: ConnectedDeviceInfo[];
  };

  "workspaceSync:get": {
    args: void;
    result: WorkspaceSyncStatus;
  };
  "workspaceSync:run": {
    args: { mode: WorkspaceSyncMode; sourceDeviceId?: string };
    result: WorkspaceSyncStatus;
  };

  "ui:setContentBounds": { args: ContentBounds; result: void };
  /** Split-view divider position (§6): fraction of the content hole given to
   *  the left pane. The renderer owns the drag (shared/pane-layout.ts renders
   *  the divider from the same geometry main resolves view bounds with). */
  "ui:setSplitRatio": { args: { ratio: number }; result: void };
  /** A modal overlay opened/closed — main raises/lowers the chrome view so
   *  dialogs are never hidden behind the tab WebContentsViews (§8.1). */
  "ui:setOverlayActive": { args: { active: boolean }; result: void };
  /** The chrome theme flipped light/dark — main mirrors it into Electron's
   *  nativeTheme so every tab reports the matching prefers-color-scheme.
   *  "system" hands the choice back to the Mac's own appearance setting, which
   *  is what the renderer asserts while no theme has been picked; the reply
   *  says which way that resolved, so the caller never has to re-read a
   *  prefers-color-scheme that may still be echoing the override it dropped. */
  "ui:setColorScheme": {
    args: { scheme: "light" | "dark" | "system" };
    result: { dark: boolean };
  };
  /** Translucent chrome on/off — main turns the window's macOS vibrancy layer
   *  on (and clears its opaque fill) so the semi-transparent chrome surfaces
   *  blur whatever is behind the window. No-op off macOS. */
  "ui:setTranslucency": { args: { enabled: boolean }; result: void };
  "health:get": { args: void; result: PlaneHealth };

  "tabs:print": { args: { tabId: string }; result: void };
  "tabs:toggleDevTools": { args: { tabId: string }; result: void };

  "downloads:list": { args: void; result: DownloadItemInfo[] };
  "downloads:open": { args: { id: string }; result: void };
  "downloads:reveal": { args: { id: string }; result: void };
  "downloads:cancel": { args: { id: string }; result: void };

  "auth:status": { args: void; result: EnrollmentStatus };
  "auth:signup": {
    args: {
      email: string;
      displayName?: string;
      controlUrl?: string;
      inviteCode?: string;
      computeMode?: "cloud" | "local";
    };
    result: EnrollmentStatus;
  };
  "auth:enroll": { args: { name: string }; result: EnrollmentStatus };
  /** WebAuthn creation options JSON from the control plane (renderer runs
   *  navigator.credentials); falls back to device-key when unsupported. */
  "auth:passkeyBegin": { args: void; result: { options: unknown } };
  "auth:passkeyFinish": {
    args: { credential: unknown };
    result: EnrollmentStatus;
  };
  "auth:registerDeviceCredential": { args: void; result: EnrollmentStatus };
  /** Recover space keys on a fresh device from the offline recovery code (§8.2). */
  "auth:recoverKeys": {
    args: { recoveryCode: string };
    result: { spacesRecovered: number };
  };
  /** §8.2 second-device flow: an enrolled device mints a short-lived code… */
  "auth:mintEnrollmentCode": {
    args: void;
    result: { code: string; expiresAt: string };
  };
  /** …and the fresh device signs in with it, then enrolls normally. */
  "auth:signinWithCode": {
    args: { code: string; controlUrl?: string };
    result: EnrollmentStatus;
  };
  /** Drop the account on this Mac, erase its local state + cookies, and
   *  relaunch into first run (§8.2). Never resolves — the app restarts. */
  "auth:signOut": { args: void; result: void };
  "devices:revoke": {
    args: { deviceId: string; reason?: string };
    result: RevocationReceipt;
  };

  "credentials:status": { args: void; result: CredentialProviderStatus };
  "credentials:search": { args: { host: string }; result: CredentialItem[] };
  /** Fill username+password into the focused login form of the tab. */
  "credentials:fill": {
    args: { tabId: string; itemId: string };
    result: { ok: boolean };
  };

  "passkeys:status": { args: void; result: PasskeyStatus };
  /** Answer a pending ceremony; credentialId null ⇒ the user cancelled. */
  "passkeys:chooseAccount": {
    args: { requestId: string; credentialId: string | null };
    result: void;
  };

  /* ---- Phase 2: compute + terminal (§8.5) ---- */
  "machine:status": { args: void; result: MachineStatus };
  "machine:wake": { args: void; result: MachineStatus };
  "machine:suspend": { args: void; result: MachineStatus };
  "machine:boost": { args: { memoryMb: number }; result: MachineStatus };
  "terminal:list": { args: void; result: TerminalInfo[] };
  /** Query the agent for sessions this device didn't create (other devices'
   *  shells, cold-boot leftovers) and adopt them so attach works (§8.5). */
  "terminal:discover": { args: void; result: TerminalInfo[] };
  "terminal:create": { args: { cwd?: string }; result: TerminalInfo };
  "terminal:attach": { args: { ptyId: string }; result: TerminalInfo };
  "terminal:input": { args: { ptyId: string; data: string }; result: void };
  "terminal:resize": {
    args: { ptyId: string; cols: number; rows: number };
    result: void;
  };
  "terminal:close": { args: { ptyId: string }; result: void };
  /** Job Mode — "keep running" with a visible cost meter (§8.5). */
  "terminal:setJobMode": {
    args: { ptyId: string; enabled: boolean };
    result: TerminalInfo;
  };
  "ports:list": { args: void; result: PortForwardInfo[] };
  "ports:forward": {
    args: { port: number; enabled: boolean };
    result: PortForwardInfo;
  };
  /* ---- IDE workspace filesystem (suma://terminal) ---- */
  "workspace:tree": { args: void; result: WorkspaceTree };
  "workspace:readFile": { args: { path: string }; result: WorkspaceFile };
  /** Result is an object (not void) so callers can tell success from the
   *  undefined that the store's `call` helper returns on failure. */
  "workspace:writeFile": {
    args: { path: string; contents: string };
    result: { ok: true };
  };
  "workspace:mkdir": { args: { path: string }; result: { ok: true } };
  "workspace:delete": {
    args: { path: string; recursive?: boolean };
    result: { ok: true };
  };
  "workspace:rename": {
    args: { from: string; to: string };
    result: { ok: true };
  };

  /* ---- Phase 2: identity egress (§8.4, §8.7) ---- */
  "egress:status": { args: { spaceId: string }; result: EgressStatus };
  "egress:setPolicy": {
    args: { spaceId: string; policy: "suma-ip" | "direct" };
    result: EgressStatus;
  };
  /** One-click "browse direct for now" after a fail-closed banner. */
  "egress:browseDirectForNow": {
    args: { spaceId: string };
    result: EgressStatus;
  };
  "egress:setSiteBypass": {
    args: { spaceId: string; host: string; bypass: boolean };
    result: EgressStatus;
  };
  "egress:explain": {
    args: { spaceId: string; host: string };
    result: EgressDecisionInfo;
  };

  /* ---- Phase 2: audit trail UI (§8.7) ---- */
  "audit:list": { args: { limit?: number }; result: AuditEntry[] };

  /* ---- Favorite sites (shared/favorites.ts) ---- */
  "favorites:list": { args: void; result: FavoriteSite[] };
  /** Add (or retitle) an address. Every mutation resolves with the full list
   *  in tile order — the same shape `favorites:updated` pushes. */
  "favorites:add": {
    args: { url: string; title?: string };
    result: FavoriteSite[];
  };
  "favorites:remove": { args: { id: string }; result: FavoriteSite[] };

  /* ---- Nostr signer (shared/nostr.ts, NIP-07) ---- */
  /**
   * The signer's renderer-facing state: derived npub, relays, per-site
   * rules — never key material. The nsec crosses IPC exactly once, inward,
   * in `nostr:setKey`; `nostr:generateKey`'s reply carries the new nsec ONCE
   * so the user can back it up (the EnrollmentStatus.recoveryCode pattern).
   */
  "nostr:settings": { args: void; result: NostrSettingsInfo };
  /** Accepts an nsec1… or 64-char hex secret key; throws on anything else. */
  "nostr:setKey": { args: { key: string }; result: NostrSettingsInfo };
  "nostr:generateKey": { args: void; result: NostrSettingsInfo };
  "nostr:removeKey": { args: void; result: NostrSettingsInfo };
  /** What `window.nostr.getRelays()` will answer — edited on the settings page. */
  "nostr:setRelays": {
    args: { relays: NostrRelayPolicy };
    result: NostrSettingsInfo;
  };
  "nostr:setSitePolicy": {
    args: { host: string; patch: NostrSitePolicyPatch };
    result: NostrSettingsInfo;
  };
  "nostr:removeSitePolicy": {
    args: { host: string };
    result: NostrSettingsInfo;
  };
  /** The approval queue, oldest first — pull for a surface that just mounted
   *  (pushes sent before it existed are gone). Preview-overlay trust lane. */
  "nostr:pending": { args: void; result: NostrPendingRequest[] };
  /** One answer, from the overlay card OR the chrome detail panel. */
  "nostr:respond": { args: NostrApprovalResponse; result: void };
  /** A card's expand tap: main relays to the chrome as `nostr:openDetail`
   *  and raises it — the savePreview:activate shape. */
  "nostr:expand": { args: { requestId: string }; result: void };
  /** The key-missing card's "Set up" tap: main relays to the chrome as the
   *  `nostr:openSettings` EVENT, which opens suma://settings/nostr. */
  "nostr:openSettings": { args: void; result: void };
  /** Configure (or clear, with "") the Buzz workspace relay. Accepts what
   *  the user pasted; main normalizes to ws(s):// or throws. Saving kicks
   *  off a roster fetch — results arrive as `nostr:buzzAgentsChanged`. */
  "nostr:setBuzzRelay": { args: { url: string }; result: NostrSettingsInfo };
  /** The Buzz agent roster snapshot. `refresh` forces a refetch; otherwise
   *  a cached ready state is returned as-is and a fetch starts only when
   *  nothing has been fetched yet. */
  "nostr:buzzAgents": { args: { refresh?: boolean }; result: BuzzAgentsState };

  /* ---- Saves: smart bookmarking (shared/saves.ts) ---- */
  "saves:list": { args: void; result: SavedItem[] };
  /**
   * Save the active tab now — the button-shaped twin of the double-Shift
   * gesture (which main triggers itself, without IPC). Resolves with the item
   * as first written (og fallback fields); extraction refines it afterwards
   * via `saves:updated`. Null when there is nothing savable (no tab, or an
   * internal page).
   */
  "saves:capture": { args: void; result: SavedItem | null };
  "saves:update": {
    args: { id: string; patch: SavedItemPatch };
    result: SavedItem;
  };
  "saves:delete": { args: { id: string }; result: void };

  /* ---- Saved videos (shared/videos.ts) ---- */
  "videos:list": { args: void; result: SavedVideo[] };
  /**
   * Save the video behind a YouTube/X URL (the panel's button; the
   * double-Shift gesture and the tab context menu reach the service inside
   * main without IPC). Null when the URL is not a recognized video page.
   */
  "videos:save": { args: { url: string }; result: SavedVideo | null };
  "videos:remove": { args: { id: string }; result: void };
  "videos:retry": { args: { id: string }; result: void };
  /** Open (or move) the floating PIP player onto this saved video. */
  "videos:play": { args: { id: string }; result: void };

  /* ---- Floating video player (its own WebContentsView; see VideoPip) ---- */
  /** PIP pull on (re)load — pushes sent before it mounted are gone. */
  "videoPip:requestState": { args: void; result: VideoPipState };
  /** A control tapped in the player (close / open source / position). */
  "videoPip:control": { args: VideoPipCommand; result: void };
  /**
   * Gesture edges for moving the player. The renderer reports only where the
   * grab started (pointer offset inside the view) and when it ended; main
   * follows the cursor itself, because the view under a fast drag cannot see
   * pointer events that have already left its rect.
   */
  "videoPip:dragStart": { args: { x: number; y: number }; result: void };
  /** Corner-resize begins; the bottom-right corner tracks the cursor. */
  "videoPip:resizeStart": { args: void; result: void };
  /** Ends whichever pointer gesture is active. */
  "videoPip:pointerEnd": { args: void; result: void };

  /* ---- Glance preview (chrome-drawn frame around a floating page view) ---- */
  /**
   * The GlanceOverlay reports the window coordinates of its frame's content
   * hole so main can place the glance WebContentsView exactly inside it —
   * the same renderer-measures/main-positions contract as
   * `ui:setContentBounds`, re-reported on every frame resize.
   */
  "glance:bounds": { args: ContentBounds; result: void };
  /** Dismiss the glance (Esc, click outside, the frame's close button). */
  "glance:close": { args: void; result: void };
  /** Open the glanced page as a real tab — the LIVE view is adopted, so the
   *  page keeps its scroll/form/history state — and close the glance. */
  "glance:promote": { args: void; result: void };
  "glance:goBack": { args: void; result: void };
  "glance:goForward": { args: void; result: void };

  /* ---- Save preview overlay (its own WebContentsView; see SavePreviewOverlay) ---- */
  /**
   * The overlay reports its measured content size so main can size the
   * window to EXACTLY the visible cards — the window sits above the tab views
   * and steals input over its whole rect, so any slack would make a dead
   * corner of the page. Height 0 ⇒ nothing to show ⇒ the window is hidden
   * entirely. Width joined the report with the floating audio player: its
   * collapsed pill is far narrower than a save card, and a full-width window
   * around it would deaden the whole top-right strip of the page. Omitted ⇒
   * the classic full card width.
   */
  "savePreview:bounds": {
    args: { height: number; width?: number };
    result: void;
  };
  /** A card was clicked: open the Saves panel in the chrome on this item. */
  "savePreview:activate": { args: { id: string }; result: void };
  /**
   * "Open" tapped on a download-complete card. Same id space as
   * `downloads:open` — main resolves it to the completed item's savePath, so
   * the overlay never handles (or could invent) a path of its own.
   */
  "downloadOverlay:open": { args: { id: string }; result: void };

  /* ---- Selection toolbar (its own WebContentsView; see SelectionToolbar) ---- */
  /** A button tapped in the floating selection toolbar. Main hides the
   *  toolbar and relays its cached selection to the chrome (which owns both
   *  the audio store and the chat sidebar) as `selection:readAloud` /
   *  `selection:addToChat`. */
  "selectionToolbar:action": {
    args: { action: SelectionToolbarAction };
    result: void;
  };

  /* ---- Floating audio player (lives in the save-preview overlay window) ---- */
  /**
   * The chrome publishes its playback state on every change (the audio
   * element and its store live in the chrome renderer — lib/audio.ts); main
   * relays it to the overlay window as `audioOverlay:state` and caches the
   * last snapshot for `audioOverlay:requestState`.
   */
  "audio:publishState": { args: AudioOverlayState; result: void };
  /** Overlay pull on (re)load — pushes sent before it mounted are gone. */
  "audioOverlay:requestState": { args: void; result: AudioOverlayState | null };
  /** A control tapped in the overlay; main relays it to the chrome as
   *  `audio:control`, where the store applies it to the real element. */
  "audioOverlay:control": { args: AudioOverlayCommand; result: void };

  /* ---- Phase 3: Files (§8.6) ---- */
  /** One directory level of ~/cloud; path defaults to the root. */
  "files:list": { args: { path?: string }; result: DirectoryListing };
  "files:stat": { args: { path: string }; result: FileEntry | null };
  /**
   * The first `maxBytes` of a file, for inline preview only — null when the
   * file is gone. Bounded on purpose and clamped again in main
   * (`MAX_PREVIEW_BYTES`): only the chunks covering the slice are fetched, so
   * previewing the head of a 3 GB archive costs one chunk, not a hydration.
   * `FileBytes` is declared with the bridge types below.
   */
  "files:read": {
    args: { path: string; maxBytes: number };
    result: FileBytes | null;
  };
  /**
   * What the Files page needs to describe itself: this device's id, display
   * names for the devices a cloud fetch can come from, the cloud root, and the
   * V1 encryption posture.
   *
   * Deliberately tiny, because this is the Files page's ONLY window onto
   * device state: ids and labels, nothing else. No email, no platform, no
   * revocation state, and above all no token or key material — a `files:*`
   * channel must never become a way to read identity or credential state
   * (§8.2, §8.6).
   */
  "files:context": { args: void; result: FilesContext };
  /**
   * Chunk + store bytes the page already holds (§7 dedup on the chunk set).
   * `uploadId` is the page's correlation id, echoed back on
   * `files:uploadProgress` so progress can be shown before this resolves.
   *
   * LIMITATION (M-3 Lite): the whole file crosses IPC as one structured-clone
   * copy and is resident in both processes while it is chunked, which is why
   * `MAX_UPLOAD_BYTES` refuses anything larger. Streaming the bytes (or
   * chunking from a path in main) is the follow-up for big-file uploads.
   */
  "files:upload": {
    args: {
      path: string;
      contentType?: string | null;
      data: Uint8Array;
      uploadId?: string;
    };
    result: FileUploadResult;
  };
  /** Hydrate a cloud file to this Mac's Downloads folder. */
  "files:download": { args: { path: string }; result: { savePath: string } };
  "files:delete": { args: { path: string }; result: void };
  "files:quota": { args: void; result: QuotaMeter };
  "transfers:list": { args: void; result: TransfersUpdate };
  "transfers:cancel": { args: { id: string }; result: void };
}

/* ------------------------------------------------------------------ *
 * Event channels (main → renderer, push)
 * ------------------------------------------------------------------ */

export interface SumaEventMap {
  "tabs:updated": { spaceId: string; tabs: TabInfo[] };
  /** A tab's page snapshot landed (page settled, or captured at switch-away). */
  "tabs:thumbnail": TabThumbnail;
  /** One AI SDK UIMessageChunk from the assistant's agent loop in main. */
  "chat:chunk": ChatChunkEvent;
  /** The run's stream ended cleanly (after its final chunk). */
  "chat:end": { requestId: string };
  /** The run failed; `message` is safe to show the user. */
  "chat:error": ChatErrorEvent;
  /** The voice assistant's lifecycle moved (armed/connecting/active/off). */
  "voice:statusChanged": VoiceStatus;
  /** Live captions for the HUD — each line replaces the last for its role. */
  "voice:transcript": VoiceTranscriptEvent;
  /** To the overlay: one chunk of 24 kHz PCM16 reply audio to schedule. */
  "voice:audioOut": VoiceAudioOutEvent;
  /** To the overlay: barge-in — drop every scheduled reply chunk now. */
  "voice:interrupted": void;

  /** The updater moved (checking/downloading/ready/…) — About page repaints. */
  "updates:changed": UpdateState;
  "spaces:updated": SpaceInfo[];
  "sync:statusChanged": SyncStatus;
  "health:changed": PlaneHealth;
  "ui:toggleCommandBar": void;
  "migration:queueChanged": SignInQueueItem[];
  "downloads:updated": DownloadItemInfo[];
  "auth:changed": EnrollmentStatus;
  "devices:updated": ConnectedDeviceInfo[];
  "workspaceSync:changed": WorkspaceSyncStatus;
  /** A blocked TLS failure in a tab (§8.1 certificate-error UI). No override in Phase 1. */
  "security:certError": CertErrorInfo;
  /** A passkey ceremony matched several credentials — show the picker. */
  "passkeys:accountRequest": PasskeyAccountRequest;
  /** The ceremony went away (timeout, navigation) — dismiss the picker. */
  "passkeys:accountRequestCancelled": { requestId: string };
  /** A window request was refused; surfaced as a non-blocking toast. */
  "popups:denied": { reason: string };
  /** The glance preview opened, navigated, or closed (null) — the chrome
   *  renders/updates/drops the GlanceOverlay frame accordingly. */
  "glance:changed": GlanceInfo | null;

  /* ---- Phase 2 ---- */
  "machine:changed": MachineStatus;
  "terminal:data": { ptyId: string; data: string };
  "terminal:updated": TerminalInfo[];
  "ports:updated": PortForwardInfo[];
  /** The machine behind the IDE's filesystem changed (sim⇄VM swap, reconnect,
   *  active-space move) — the explorer refetches, stale buffers drop. */
  "workspace:changed": {
    source: "sim" | "remote";
    connected: boolean;
    activeSpaceId: string | null;
  };
  /** FILES on the current machine changed (a shell wrote, a fetch landed, an
   *  editor saved) — same machine, fresher tree. Debounced in main; the
   *  renderer throttles its refetch on top. */
  "workspace:filesChanged": { paths?: string[] };
  /** Gateway health or per-space egress config changed (§8.4 fail-closed banner). */
  "egress:changed": EgressStatus;
  /** A site challenged us; offer a per-site bypass rather than acting silently. */
  "egress:bypassSuggested": { spaceId: string; host: string; reason: string };
  /** A hosted checkout page was routed direct automatically (§8.4). Applied,
   *  not offered — the page never renders through the proxy — so the user is
   *  told after the fact instead of being asked. */
  "egress:checkoutBypassed": { spaceId: string; host: string; label: string };

  /* ---- Nostr signer ---- */
  /** The approval queue changed — full list, oldest first. Pushed to BOTH
   *  the chrome (detail panel) and the preview overlay (card stack). */
  "nostr:pendingChanged": NostrPendingRequest[];
  /** To the chrome: an overlay card was expanded — open the request panel. */
  "nostr:openDetail": { requestId: string };
  /** Relays/policies/key state changed (an approval's "remember" writes a
   *  rule too, not just the settings page) — the settings UI stays live. */
  "nostr:settingsChanged": NostrSettingsInfo;
  /** To the preview overlay: a site called window.nostr but no key is
   *  configured. The refusal already went to the page; this is the USER's
   *  copy, as a card, because a chrome toast is invisible under a tab view
   *  and "the sign-in button does nothing" would otherwise be silent. */
  "nostr:keyMissing": { host: string };
  /** To the chrome: open suma://settings/nostr (the key-missing card). */
  "nostr:openSettings": void;
  /** The Buzz roster fetch advanced (loading → ready/error). */
  "nostr:buzzAgentsChanged": BuzzAgentsState;

  /* ---- Favorite sites ---- */
  /** The list changed (star toggle, settings edit) — full list, tile order. */
  "favorites:updated": FavoriteSite[];

  /* ---- Saved videos ---- */
  /** The collection changed (save, progress, upload, delete) — full list. */
  "videos:updated": SavedVideo[];
  /** A save was triggered by gesture/menu — the chrome opens the Videos
   *  panel on the item so the download is never invisible. */
  "videos:openPanel": { videoId: string | null };
  /** To the PIP view: load (or clear) the video it should be playing. */
  "videoPip:state": VideoPipState;

  /* ---- Saves ---- */
  /** The collection changed (capture, extraction landing, edit, delete). */
  "saves:updated": SavedItem[];
  /** A preview card was clicked (savePreview:activate) — the chrome opens
   *  the Saves panel on this item. */
  "saves:openDetail": { itemId: string };
  /** To the preview overlay: a capture landed or its extraction settled —
   *  show (or morph) the card for this item. */
  "savePreview:item": SavedItem;
  /** To the preview overlay: nothing was saved, and here is why. */
  "savePreview:error": { message: string };
  /** To the preview overlay: a local download just landed on disk — show the
   *  completion card with its Open action. Only `completed` items are
   *  pushed; a cancelled or interrupted one has no file to open. */
  "downloadOverlay:completed": DownloadItemInfo;
  /** To the preview overlay: the chrome's playback state (relayed
   *  `audio:publishState`) — what the floating player renders. */
  "audioOverlay:state": AudioOverlayState;
  /** To the chrome: a control tapped in the floating player. */
  "audio:control": AudioOverlayCommand;

  /* ---- Selection toolbar ---- */
  /** To the chrome: read this page selection aloud (lib/audio speakText). */
  "selection:readAloud": SelectionActionPayload;
  /** To the chrome: open the chat sidebar and attach this selection to the
   *  next message. */
  "selection:addToChat": SelectionActionPayload;

  /* ---- Phase 3: Files (§8.6) ---- */
  /** Contents of this directory changed (upload, delete, completed transfer). */
  "files:changed": { path: string };
  /** Cloud-fetch progress, plus the latest download that stayed local. */
  "transfers:updated": TransfersUpdate;
  /**
   * Progress for one `files:upload`, correlated by its `uploadId`. Emitted
   * from main because that is where the bytes are chunked and sent — the page
   * cannot see how much of an upload the store actually still needed.
   */
  "files:uploadProgress": UploadProgress;
}

export type InvokeChannel = keyof SumaInvokeMap;
export type EventChannel = keyof SumaEventMap;

/**
 * The API preload exposes as `window.suma`. `on` returns an unsubscribe
 * function.
 */
export interface SumaApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    args: SumaInvokeMap[C]["args"],
  ): Promise<SumaInvokeMap[C]["result"]>;
  on<C extends EventChannel>(
    channel: C,
    listener: (payload: SumaEventMap[C]) => void,
  ): () => void;
}

export const INVOKE_CHANNELS: ReadonlyArray<InvokeChannel> = [
  "spaces:list",
  "spaces:create",
  "spaces:update",
  "spaces:setActive",
  "spaces:remove",
  "tabs:list",
  "tabs:create",
  "tabs:close",
  "tabs:select",
  "tabs:navigate",
  "tabs:goBack",
  "tabs:goForward",
  "tabs:reload",
  "tabs:setPinned",
  "tabs:reorder",
  "tabs:setSplit",
  "tabs:thumbnails",
  "history:list",
  "history:clear",
  "sync:status",
  "sync:originInfo",
  "sync:setOriginOverride",
  "sync:rollbackOrigin",
  "migration:detectSources",
  "migration:import",
  "migration:signInQueue",
  "migration:markSignedIn",
  "settings:get",
  "settings:update",
  "chat:settings",
  "chat:updateSettings",
  "chat:start",
  "chat:stop",
  "voice:settings",
  "voice:updateSettings",
  "voice:status",
  "voice:audio",
  "voice:start",
  "voice:stop",
  "tts:settings",
  "tts:updateSettings",
  "tts:voices",
  "tts:speak",
  "tts:cancel",
  "updates:state",
  "updates:check",
  "updates:install",
  "devices:list",
  "devices:rename",
  "workspaceSync:get",
  "workspaceSync:run",
  "ui:setContentBounds",
  "ui:setSplitRatio",
  "ui:setOverlayActive",
  "ui:setColorScheme",
  "ui:setTranslucency",
  "health:get",
  "tabs:print",
  "tabs:toggleDevTools",
  "downloads:list",
  "downloads:open",
  "downloads:reveal",
  "downloads:cancel",
  "auth:status",
  "auth:signup",
  "auth:enroll",
  "auth:passkeyBegin",
  "auth:passkeyFinish",
  "auth:registerDeviceCredential",
  "auth:recoverKeys",
  "auth:mintEnrollmentCode",
  "auth:signinWithCode",
  "auth:signOut",
  "devices:revoke",
  "credentials:status",
  "credentials:search",
  "credentials:fill",
  "passkeys:status",
  "passkeys:chooseAccount",
  "machine:status",
  "machine:wake",
  "machine:suspend",
  "machine:boost",
  "terminal:list",
  "terminal:discover",
  "terminal:create",
  "terminal:attach",
  "terminal:input",
  "terminal:resize",
  "terminal:close",
  "terminal:setJobMode",
  "ports:list",
  "ports:forward",
  "workspace:tree",
  "workspace:readFile",
  "workspace:writeFile",
  "workspace:mkdir",
  "workspace:delete",
  "workspace:rename",
  "egress:status",
  "egress:setPolicy",
  "egress:browseDirectForNow",
  "egress:setSiteBypass",
  "egress:explain",
  "audit:list",
  "favorites:list",
  "favorites:add",
  "favorites:remove",
  "nostr:settings",
  "nostr:setKey",
  "nostr:generateKey",
  "nostr:removeKey",
  "nostr:setRelays",
  "nostr:setSitePolicy",
  "nostr:removeSitePolicy",
  "nostr:pending",
  "nostr:respond",
  "nostr:expand",
  "nostr:openSettings",
  "nostr:setBuzzRelay",
  "nostr:buzzAgents",
  "saves:list",
  "saves:capture",
  "saves:update",
  "saves:delete",
  "videos:list",
  "videos:save",
  "videos:remove",
  "videos:retry",
  "videos:play",
  "videoPip:requestState",
  "videoPip:control",
  "videoPip:dragStart",
  "videoPip:resizeStart",
  "videoPip:pointerEnd",
  "glance:bounds",
  "glance:close",
  "glance:promote",
  "glance:goBack",
  "glance:goForward",
  "savePreview:bounds",
  "savePreview:activate",
  "downloadOverlay:open",
  "selectionToolbar:action",
  "audio:publishState",
  "audioOverlay:requestState",
  "audioOverlay:control",
  "files:list",
  "files:stat",
  "files:read",
  "files:context",
  "files:upload",
  "files:download",
  "files:delete",
  "files:quota",
  "transfers:list",
  "transfers:cancel",
];

export const EVENT_CHANNELS: ReadonlyArray<EventChannel> = [
  "tabs:updated",
  "tabs:thumbnail",
  "chat:chunk",
  "chat:end",
  "chat:error",
  "voice:statusChanged",
  "voice:transcript",
  "voice:audioOut",
  "voice:interrupted",
  "updates:changed",
  "spaces:updated",
  "sync:statusChanged",
  "health:changed",
  "ui:toggleCommandBar",
  "migration:queueChanged",
  "downloads:updated",
  "auth:changed",
  "devices:updated",
  "workspaceSync:changed",
  "security:certError",
  "passkeys:accountRequest",
  "passkeys:accountRequestCancelled",
  "popups:denied",
  "glance:changed",
  "machine:changed",
  "terminal:data",
  "terminal:updated",
  "ports:updated",
  "workspace:changed",
  "workspace:filesChanged",
  "egress:changed",
  "egress:bypassSuggested",
  "egress:checkoutBypassed",
  "nostr:pendingChanged",
  "nostr:openDetail",
  "nostr:settingsChanged",
  "nostr:keyMissing",
  "nostr:openSettings",
  "nostr:buzzAgentsChanged",
  "favorites:updated",
  "videos:updated",
  "videos:openPanel",
  "videoPip:state",
  "saves:updated",
  "saves:openDetail",
  "savePreview:item",
  "savePreview:error",
  "downloadOverlay:completed",
  "audioOverlay:state",
  "audio:control",
  "selection:readAloud",
  "selection:addToChat",
  "files:changed",
  "transfers:updated",
  "files:uploadProgress",
];

/* ------------------------------------------------------------------ *
 * suma://files bridge (§8.1 privileged page, §8.6 Files app)
 * ------------------------------------------------------------------ */

/**
 * The privileged Files page gets ONLY the Files half of the contract — never
 * the browser-chrome channels. Derived from the maps above so the two can
 * never drift apart.
 */
export type FilesInvokeChannel = Extract<
  InvokeChannel,
  `files:${string}` | `transfers:${string}`
>;
export type FilesEventChannel = Extract<
  EventChannel,
  `files:${string}` | `transfers:${string}`
>;

function isFilesChannel(channel: string): boolean {
  return channel.startsWith("files:") || channel.startsWith("transfers:");
}

export const FILES_INVOKE_CHANNELS: ReadonlyArray<FilesInvokeChannel> =
  INVOKE_CHANNELS.filter((channel): channel is FilesInvokeChannel =>
    isFilesChannel(channel),
  );

export const FILES_EVENT_CHANNELS: ReadonlyArray<FilesEventChannel> =
  EVENT_CHANNELS.filter((channel): channel is FilesEventChannel =>
    isFilesChannel(channel),
  );

/**
 * `window.sumaFiles` — the method-shaped bridge the Files app codes against.
 * This is the desktop side of `apps/files/src/bridge.ts`; the two must stay
 * structurally identical, so any change here belongs in both.
 */

export type Unsubscribe = () => void;

export interface FilesDevice {
  id: string;
  name: string;
}

/** Standing facts the Files UI states out loud (§8.6 honest terminology). */
export interface FilesContext {
  /** This Mac, so a transfer can say "this Mac" instead of an id. */
  thisDeviceId: string | null;
  devices: FilesDevice[];
  /** The one cloud-native root (`~/cloud`, canonical in R2). */
  cloudRoot: string;
  /** V1 truth: `$HOME` and its snapshots are NOT end-to-end encrypted. */
  endToEndEncrypted: boolean;
}

/** A bounded slice of a file, for inline preview only. */
export interface FileBytes {
  data: Uint8Array<ArrayBuffer>;
  truncated: boolean;
  totalBytes: number;
}

export interface UploadInput {
  /** Correlates progress events with the upload before it resolves. */
  uploadId: string;
  path: string;
  contentType: string | null;
  data: Uint8Array<ArrayBuffer>;
}

export type UploadState = "hashing" | "uploading" | "completed" | "failed";

export interface UploadProgress {
  uploadId: string;
  path: string;
  sentBytes: number;
  totalBytes: number;
  state: UploadState;
  error: string | null;
}

export type UploadResult =
  | { ok: true; entry: FileEntry }
  | { ok: false; reason: "quota" | "rejected" | "error"; message: string };

export type DownloadResult =
  | { ok: true; savePath: string }
  | { ok: false; reason: "missing" | "cancelled" | "error"; message: string };

export type DeleteResult = { ok: true } | { ok: false; message: string };

export interface SumaFilesApi {
  context(): Promise<FilesContext>;
  /** Every entry under `prefix` ("/" for all of ~/cloud). */
  list(prefix: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileEntry | null>;
  /** First `maxBytes` of a file, for preview. */
  read(path: string, maxBytes: number): Promise<FileBytes | null>;
  upload(input: UploadInput): Promise<UploadResult>;
  download(path: string): Promise<DownloadResult>;
  remove(path: string): Promise<DeleteResult>;
  quota(): Promise<QuotaState>;
  listTransfers(): Promise<Transfer[]>;
  cancelTransfer(transferId: string): Promise<void>;
  onFilesChanged(handler: () => void): Unsubscribe;
  onTransfersUpdated(handler: (transfers: Transfer[]) => void): Unsubscribe;
  onUploadProgress(handler: (progress: UploadProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    suma: SumaApi;
    /** Present only on the suma://files page (§8.6). */
    sumaFiles?: SumaFilesApi;
  }
}
