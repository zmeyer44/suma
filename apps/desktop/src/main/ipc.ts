/**
 * registerIpc — every SumaInvokeMap channel, with zod-free structural
 * validation (the preload allowlist is trusted; these checks only catch
 * shape bugs early) and thin delegation to the managers. Push events go out
 * through the chrome view's webContents.
 */

import { ipcMain, nativeTheme, type WebContents } from "electron";
import type {
  AudioOverlayCommand,
  AudioOverlayState,
  ContentBounds,
  SumaInvokeMap,
  InvokeChannel,
  PlaneHealth,
  SpaceInfo,
  SyncConnectionState,
} from "../shared/ipc";
import {
  isNostrPermissionChoice,
  normalizeBuzzRelayUrl,
  NOSTR_GUEST_CHANNEL,
  type NostrApprovalResponse,
  type NostrSitePolicyPatch,
} from "../shared/nostr";
import { isSavedItemType, type SavedItem, type SavedItemPatch } from "../shared/saves";
import { EMPTY_PIP_STATE, type VideoPipState } from "../shared/videos";
import { isTtsProviderId, TTS_KEY_PROVIDERS } from "../shared/tts";
import type {
  TtsKeyProvider,
  TtsProviderId,
  TtsSettingsPatch,
} from "../shared/tts";
import {
  isChatToolGroupId,
  type ChatSettingsPatch,
  type ChatToolGroupId,
} from "../shared/chat";
import type { VoiceSettingsPatch } from "../shared/voice";
import type { AuditService } from "./audit-service";
import type { SpeakRequest, TtsService } from "./audio/tts-service";
import type { ChatRunEmitter, ChatService } from "./chat/chat-service";
import type { VoiceService } from "./voice/voice-service";
import type { UpdateService } from "./updates/update-service";
import type { AuthService } from "./auth-service";
import type { MachineService } from "./compute/machine-service";
import type { PortsService } from "./compute/ports-service";
import type { TerminalService } from "./compute/terminal-service";
import type { CredentialsService } from "./credentials";
import type { DownloadManager } from "./downloads";
import type { DeviceCollaborationService } from "./device-collaboration";
import type { EgressService } from "./egress/egress-service";
import type { FavoritesService } from "./favorites";
import type { FilesService } from "./files/files-service";
import type { FilesWindow } from "./files/files-window";
import type { GlanceManager } from "./glance";
import type { HistoryService } from "./history";
import type { MigrationService } from "./migration";
import type { BuzzService } from "./nostr/buzz-service";
import type { NostrService } from "./nostr/nostr-service";
import type { SavesService } from "./saves/saves-service";
import type { VideosService } from "./videos/videos-service";
import { mediaUrlFor } from "./videos/video-protocol";
import type { ShellWindow } from "./shell-window";
import type { SpaceManager, SpaceMetaPatch } from "./spaces";
import { isValidNewTabUrl } from "./tab-policy";
import type { SyncService } from "./sync/service";
import type { TabManager } from "./tabs";
import type { WebAuthnService } from "./webauthn";
import type { WorkspaceFsService } from "./workspace-fs";
import type { WorkspaceStore } from "./workspace-store";

export interface IpcDeps {
  chrome: WebContents;
  shell: ShellWindow;
  spaces: SpaceManager;
  tabs: TabManager;
  /** The Glance preview (shift-click / pinned-tab links) — main/glance.ts. */
  glance: GlanceManager;
  sync: SyncService;
  migration: MigrationService;
  webauthn: WebAuthnService;
  store: WorkspaceStore;
  history: HistoryService;
  downloads: DownloadManager;
  auth: AuthService;
  /** Sign out + local reset (§8.2) — owned by bootstrap, which is the only
   *  place that can stop every service and relaunch the app. */
  signOut: () => Promise<void>;
  credentials: CredentialsService;
  /** Text → audio bytes, so no API key ever reaches the renderer (§8.1). */
  tts: TtsService;
  /** The assistant's agent loop — model calls and browser tools in main. */
  chat: ChatService;
  /** The voice assistant — wake word + Gemini Live session in main. */
  voice: VoiceService;
  /** App self-updates — app-level singleton, outlives sign-out (§8.2). */
  updates: UpdateService;
  devices: DeviceCollaborationService;
  machines: MachineService;
  terminals: TerminalService;
  ports: PortsService;
  /** The IDE's filesystem on suma://terminal — local paths, root-guarded. */
  workspaceFs: WorkspaceFsService;
  egress: EgressService;
  audit: AuditService;
  /* ---- Favorite sites (shared/favorites.ts) ---- */
  favorites: FavoritesService;
  /* ---- Nostr signer (shared/nostr.ts, NIP-07) ---- */
  nostr: NostrService;
  /** The Buzz workspace roster fetcher (github.com/block/buzz). */
  buzz: BuzzService;
  /* ---- Saves (shared/saves.ts) ---- */
  saves: SavesService;
  /* ---- Saved videos (shared/videos.ts) ---- */
  videos: VideosService;
  /** Capture the active tab — owned by bootstrap, which holds the tab graph
   *  and the double-Shift path that shares this exact code. */
  captureActiveSave: () => Promise<SavedItem | null>;
  /* ---- Phase 3 (§8.6) ---- */
  files: FilesService;
  /** The suma://files page, so its invokes are recognized as trusted. */
  filesWindow: FilesWindow;
}

export function presentSpaces(
  spaces: SpaceManager,
  tabs: TabManager,
): SpaceInfo[] {
  const activeId = spaces.activeSpaceId;
  return spaces.list().map((meta) => ({
    ...meta,
    active: meta.id === activeId,
    tabCount: tabs.countFor(meta.id),
  }));
}

/**
 * §10 failure-mode matrix. The session plane derives from the sync state;
 * egress and compute are reported by their Phase-2 services (defaulting to
 * "ok" for callers that predate them).
 */
export function planeHealthFor(
  state: SyncConnectionState,
  egressPlane: PlaneHealth["egressPlane"] = "ok",
  computePlane: PlaneHealth["computePlane"] = "ok",
): PlaneHealth {
  const sessionPlane =
    state === "connected" ? "ok" : state === "connecting" ? "degraded" : "down";
  return { sessionPlane, egressPlane, computePlane };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** For payloads whose every field is optional — a missing object is fine. */
function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

/** The floating player's controls, re-validated here because they arrive
 *  from the overlay window — a narrower trust than the chrome. */
const AUDIO_SIMPLE_COMMANDS = [
  "toggle",
  "next",
  "previous",
  "stop",
  "openVoiceSettings",
] as const;

function requireAudioCommand(value: unknown): AudioOverlayCommand {
  const record = requireRecord(value, "audioOverlay:control");
  const command = record["command"];
  if (command === "seek" || command === "setRate") {
    return { command, value: requireFinite(record["value"], "value") };
  }
  if (command === "setMuted") return { command, value: record["value"] === true };
  if (
    typeof command === "string" &&
    (AUDIO_SIMPLE_COMMANDS as readonly string[]).includes(command)
  ) {
    return { command } as AudioOverlayCommand;
  }
  throw new Error("audioOverlay:control: unknown command");
}

/**
 * A settings-page policy edit. Unknown methods/kinds and malformed choices
 * are structural bugs, so they throw like every other requireX here; null
 * survives — it is the "clear this rule" value.
 */
function requireNostrPatch(value: unknown): NostrSitePolicyPatch {
  const record = requireRecord(value, "nostr:setSitePolicy patch");
  const patch: NostrSitePolicyPatch = {};
  const signDefault = record["signDefault"];
  if (signDefault !== undefined) {
    if (!isNostrPermissionChoice(signDefault)) {
      throw new Error("signDefault must be allow/ask/deny");
    }
    patch.signDefault = signDefault;
  }
  const methods = record["methods"];
  if (methods !== undefined) {
    const clean: NonNullable<NostrSitePolicyPatch["methods"]> = {};
    for (const [method, choice] of Object.entries(requireRecord(methods, "methods"))) {
      if (
        method !== "getPublicKey" &&
        method !== "getRelays" &&
        method !== "nip04.encrypt" &&
        method !== "nip04.decrypt" &&
        method !== "nip44.encrypt" &&
        method !== "nip44.decrypt"
      ) {
        throw new Error(`unknown nostr method rule "${method}"`);
      }
      if (choice !== null && !isNostrPermissionChoice(choice)) {
        throw new Error("method rule must be allow/ask/deny or null");
      }
      clean[method] = choice;
    }
    patch.methods = clean;
  }
  const kinds = record["kinds"];
  if (kinds !== undefined) {
    const clean: NonNullable<NostrSitePolicyPatch["kinds"]> = {};
    for (const [kind, choice] of Object.entries(requireRecord(kinds, "kinds"))) {
      if (!/^\d+$/.test(kind)) throw new Error("kind rules are keyed by kind number");
      if (choice !== null && !isNostrPermissionChoice(choice)) {
        throw new Error("kind rule must be allow/ask/deny or null");
      }
      clean[kind] = choice;
    }
    patch.kinds = clean;
  }
  return patch;
}

const OVERRIDES: ReadonlyArray<"sync" | "never"> = ["sync", "never"];

function requireOverride(value: unknown): "sync" | "never" | null {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    (OVERRIDES as readonly string[]).includes(value)
  ) {
    return value as "sync" | "never";
  }
  throw new Error("override must be 'sync', 'never', or null");
}

type InvokeHandler<C extends InvokeChannel> = (
  args: SumaInvokeMap[C]["args"],
) => SumaInvokeMap[C]["result"] | Promise<SumaInvokeMap[C]["result"]>;

/**
 * Wire every channel to `deps`. Safe to call again for a NEW service graph —
 * a sign-out reset rebuilds all of it (§8.2) — because each channel drops its
 * previous handler first; `ipcMain.handle` alone would throw on the second
 * registration, and removeHandler is a no-op the first time through.
 */
export function registerIpc(deps: IpcDeps): void {
  const handle = <C extends InvokeChannel>(
    channel: C,
    handler: InvokeHandler<C>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args: unknown) => {
      if (event.sender.id !== deps.chrome.id) {
        throw new Error(`${channel}: rejected invoke from non-chrome sender`);
      }
      return handler(args as SumaInvokeMap[C]["args"]);
    });
  };

  /**
   * The save-preview overlay view may call ONLY the savePreview:* and
   * audioOverlay:* channels — same narrow-trust shape as the Files page
   * below. Everything else still fails the chrome-sender check above.
   */
  const handlePreview = <C extends InvokeChannel>(
    channel: C,
    handler: InvokeHandler<C>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args: unknown) => {
      const senderId = event.sender.id;
      if (senderId !== deps.chrome.id && !deps.shell.ownsSavePreview(senderId)) {
        throw new Error(`${channel}: rejected invoke from untrusted sender`);
      }
      return handler(args as SumaInvokeMap[C]["args"]);
    });
  };

  /**
   * The selection toolbar view may call ONLY the selectionToolbar:* channels
   * — the same narrow-trust shape as the preview overlay above.
   */
  const handleToolbar = <C extends InvokeChannel>(
    channel: C,
    handler: InvokeHandler<C>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args: unknown) => {
      const senderId = event.sender.id;
      if (
        senderId !== deps.chrome.id &&
        !deps.shell.ownsSelectionToolbar(senderId)
      ) {
        throw new Error(`${channel}: rejected invoke from untrusted sender`);
      }
      return handler(args as SumaInvokeMap[C]["args"]);
    });
  };

  /**
   * The floating video player may call ONLY the videoPip:* channels — the
   * same narrow-trust shape as the preview overlay above.
   */
  const handleVideoPip = <C extends InvokeChannel>(
    channel: C,
    handler: InvokeHandler<C>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args: unknown) => {
      const senderId = event.sender.id;
      if (senderId !== deps.chrome.id && !deps.shell.ownsVideoPip(senderId)) {
        throw new Error(`${channel}: rejected invoke from untrusted sender`);
      }
      return handler(args as SumaInvokeMap[C]["args"]);
    });
  };

  /**
   * Files channels are the only ones the suma://files page may call — it is
   * a second trusted sender, and only for this slice of the contract (§8.1).
   * Everything else still fails the chrome-sender check above.
   */
  const handleFiles = <C extends InvokeChannel>(
    channel: C,
    handler: InvokeHandler<C>,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args: unknown) => {
      const senderId = event.sender.id;
      if (
        senderId !== deps.chrome.id &&
        !deps.filesWindow.ownsWebContents(senderId)
      ) {
        throw new Error(`${channel}: rejected invoke from untrusted sender`);
      }
      return handler(args as SumaInvokeMap[C]["args"]);
    });
  };

  /* -------------------------------- spaces ------------------------------- */

  handle("spaces:list", () => presentSpaces(deps.spaces, deps.tabs));

  handle("spaces:create", async (args) => {
    const a = requireRecord(args, "spaces:create");
    const meta = deps.spaces.create(
      requireString(a["name"], "name"),
      requireString(a["color"], "color"),
    );
    await deps.sync.addSpace(meta.id);
    const info = presentSpaces(deps.spaces, deps.tabs).find(
      (space) => space.id === meta.id,
    );
    if (info === undefined) throw new Error("space creation failed");
    return info;
  });

  handle("spaces:update", (args) => {
    const a = requireRecord(args, "spaces:update");
    const spaceId = requireString(a["spaceId"], "spaceId");
    const patch = requireRecord(a["patch"], "patch");
    const clean: SpaceMetaPatch = {};
    if (typeof patch["name"] === "string") clean.name = patch["name"];
    if (typeof patch["color"] === "string") clean.color = patch["color"];
    if (typeof patch["position"] === "number")
      clean.position = patch["position"];
    if (
      patch["egressPolicy"] === "suma-ip" ||
      patch["egressPolicy"] === "direct"
    ) {
      clean.egressPolicy = patch["egressPolicy"];
    }
    const meta = deps.spaces.update(spaceId, clean);
    const info = presentSpaces(deps.spaces, deps.tabs).find(
      (space) => space.id === meta.id,
    );
    if (info === undefined) throw new Error(`unknown space ${spaceId}`);
    return info;
  });

  handle("spaces:setActive", (args) => {
    const a = requireRecord(args, "spaces:setActive");
    // A glance previews a page from the OUTGOING space — its session is the
    // wrong cookie jar for the next one, so it goes with the switch.
    deps.glance.close();
    deps.spaces.setActive(requireString(a["spaceId"], "spaceId"));
  });

  handle("spaces:remove", (args) => {
    const a = requireRecord(args, "spaces:remove");
    deps.spaces.remove(requireString(a["spaceId"], "spaceId"));
    return presentSpaces(deps.spaces, deps.tabs);
  });

  /* --------------------------------- tabs -------------------------------- */

  handle("tabs:list", (args) => {
    const a = requireRecord(args, "tabs:list");
    return deps.tabs.list(requireString(a["spaceId"], "spaceId"));
  });

  handle("tabs:create", (args) => {
    const a = requireRecord(args, "tabs:create");
    const create: { spaceId: string; url?: string; pinned?: boolean } = {
      spaceId: requireString(a["spaceId"], "spaceId"),
    };
    if (typeof a["url"] === "string") create.url = a["url"];
    if (typeof a["pinned"] === "boolean") create.pinned = a["pinned"];
    return deps.tabs.create(create);
  });

  handle("tabs:close", (args) => {
    deps.tabs.close(
      requireString(requireRecord(args, "tabs:close")["tabId"], "tabId"),
    );
  });

  handle("tabs:select", (args) => {
    deps.tabs.select(
      requireString(requireRecord(args, "tabs:select")["tabId"], "tabId"),
    );
  });

  handle("tabs:navigate", (args) => {
    const a = requireRecord(args, "tabs:navigate");
    deps.tabs.navigate(
      requireString(a["tabId"], "tabId"),
      requireString(a["url"], "url"),
    );
  });

  handle("tabs:goBack", (args) => {
    deps.tabs.goBack(
      requireString(requireRecord(args, "tabs:goBack")["tabId"], "tabId"),
    );
  });

  handle("tabs:goForward", (args) => {
    deps.tabs.goForward(
      requireString(requireRecord(args, "tabs:goForward")["tabId"], "tabId"),
    );
  });

  handle("tabs:reload", (args) => {
    deps.tabs.reload(
      requireString(requireRecord(args, "tabs:reload")["tabId"], "tabId"),
    );
  });

  handle("tabs:setPinned", (args) => {
    const a = requireRecord(args, "tabs:setPinned");
    const pinned = a["pinned"];
    if (typeof pinned !== "boolean")
      throw new Error("pinned must be a boolean");
    deps.tabs.setPinned(requireString(a["tabId"], "tabId"), pinned);
  });

  handle("tabs:reorder", (args) => {
    const a = requireRecord(args, "tabs:reorder");
    const index = a["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error("index must be a non-negative integer");
    }
    deps.tabs.reorder(requireString(a["tabId"], "tabId"), index);
  });

  handle("tabs:setSplit", (args) => {
    const a = requireRecord(args, "tabs:setSplit");
    const split = a["split"];
    if (typeof split !== "boolean") throw new Error("split must be a boolean");
    deps.tabs.setSplit(requireString(a["tabId"], "tabId"), split);
  });

  /* ------------------------- browsing history (§8.3) ---------------------- */

  handle("history:list", (args) => {
    const a = optionalRecord(args);
    const query = typeof a["query"] === "string" ? a["query"] : "";
    const limit =
      typeof a["limit"] === "number" ? requireFinite(a["limit"], "limit") : 50;
    return deps.history.list(query, Math.min(limit, 200));
  });

  handle("history:clear", () => {
    deps.history.clear();
  });

  /* --------------------------------- sync -------------------------------- */

  handle("sync:status", () => deps.sync.status());

  handle("sync:originInfo", (args) => {
    const a = requireRecord(args, "sync:originInfo");
    return deps.sync.originInfo(requireString(a["host"], "host"));
  });

  handle("sync:setOriginOverride", (args) => {
    const a = requireRecord(args, "sync:setOriginOverride");
    return deps.sync.setOriginOverride(
      requireString(a["host"], "host"),
      requireOverride(a["override"]),
    );
  });

  handle("sync:rollbackOrigin", (args) => {
    const a = requireRecord(args, "sync:rollbackOrigin");
    return deps.sync.rollbackOrigin(
      requireString(a["host"], "host"),
      requireString(a["spaceId"], "spaceId"),
    );
  });

  /* ------------------------------ migration ------------------------------ */

  handle("migration:detectSources", () => deps.migration.detectSources());

  handle("migration:import", (args) => {
    const a = requireRecord(args, "migration:import");
    const browser = a["browser"];
    if (browser !== "chrome" && browser !== "arc") {
      throw new Error("browser must be 'chrome' or 'arc'");
    }
    return deps.migration.import({
      profilePath: requireString(a["profilePath"], "profilePath"),
      browser,
    });
  });

  handle("migration:signInQueue", () => deps.migration.signInQueue());

  handle("migration:markSignedIn", (args) => {
    const a = requireRecord(args, "migration:markSignedIn");
    return deps.migration.markSignedIn(requireString(a["domain"], "domain"));
  });

  /* ------------------------------- settings ------------------------------ */

  handle("settings:get", () => deps.store.settings());

  handle("settings:update", (args) => {
    const patch = requireRecord(args, "settings:update");
    const clean: Partial<SumaInvokeMap["settings:update"]["args"]> = {};
    if (typeof patch["historySyncEnabled"] === "boolean") {
      clean.historySyncEnabled = patch["historySyncEnabled"];
    }
    if (typeof patch["autoArchiveAfterHours"] === "number") {
      clean.autoArchiveAfterHours = patch["autoArchiveAfterHours"];
    }
    if (patch["keyMode"] === "e2ee" || patch["keyMode"] === "suma-managed") {
      clean.keyMode = patch["keyMode"];
    }
    // The new-tab page must be something a tab can actually load. A rejected
    // value is simply not applied — settings:update returns the stored
    // settings, so the renderer sees what it really got.
    const newTabUrl = patch["newTabUrl"];
    if (typeof newTabUrl === "string" && isValidNewTabUrl(newTabUrl.trim())) {
      clean.newTabUrl = newTabUrl.trim();
    }
    const settings = deps.store.updateSettings(clean);
    // keyMode is part of SyncStatus — a visible security state, never a
    // silent downgrade (§8.2).
    deps.sync.pushStatus();
    return settings;
  });

  /* -------------------------- text-to-speech ---------------------------- */

  handle("tts:settings", () => deps.tts.settings());

  handle("tts:updateSettings", (args) => {
    const a = optionalRecord(args);
    const patch: TtsSettingsPatch = {};
    if (isTtsProviderId(a["provider"])) patch.provider = a["provider"];
    const voices = optionalRecord(a["voices"]);
    const models = optionalRecord(a["models"]);
    const voicePatch: Partial<Record<TtsProviderId, string>> = {};
    const modelPatch: Partial<Record<TtsProviderId, string>> = {};
    for (const [id, value] of Object.entries(voices)) {
      if (isTtsProviderId(id) && typeof value === "string") {
        voicePatch[id] = value;
      }
    }
    for (const [id, value] of Object.entries(models)) {
      if (isTtsProviderId(id) && typeof value === "string") {
        modelPatch[id] = value;
      }
    }
    if (Object.keys(voicePatch).length > 0) patch.voices = voicePatch;
    if (Object.keys(modelPatch).length > 0) patch.models = modelPatch;
    // A key crosses IPC exactly once, in this direction, and is never read
    // back out (`tts:settings` reports only whether one exists).
    const keys = optionalRecord(a["apiKeys"]);
    const keyPatch: Partial<Record<TtsKeyProvider, string>> = {};
    for (const id of TTS_KEY_PROVIDERS) {
      const value = keys[id];
      if (typeof value === "string") keyPatch[id] = value;
    }
    if (Object.keys(keyPatch).length > 0) patch.apiKeys = keyPatch;
    return deps.tts.updateSettings(patch);
  });

  handle("tts:voices", (args) => {
    const provider = optionalRecord(args)["provider"];
    if (!isTtsProviderId(provider)) throw new Error("unknown TTS provider");
    return deps.tts.voices(provider);
  });

  handle("tts:speak", (args) => {
    const a = requireRecord(args, "tts:speak");
    const request: SpeakRequest = {
      requestId: requireString(a["requestId"], "requestId"),
      text: requireString(a["text"], "text"),
    };
    if (isTtsProviderId(a["provider"])) request.provider = a["provider"];
    if (typeof a["voice"] === "string") request.voice = a["voice"];
    return deps.tts.speak(request);
  });

  handle("tts:cancel", (args) => {
    deps.tts.cancel(
      requireString(requireRecord(args, "tts:cancel")["requestId"], "requestId"),
    );
  });

  /* ----------------------------- AI assistant ---------------------------- */

  handle("chat:settings", () => deps.chat.settings());

  handle("chat:updateSettings", (args) => {
    const a = optionalRecord(args);
    const patch: ChatSettingsPatch = {};
    if (typeof a["model"] === "string") patch.model = a["model"];
    const tools = optionalRecord(a["tools"]);
    const toolPatch: Partial<Record<ChatToolGroupId, boolean>> = {};
    for (const [id, value] of Object.entries(tools)) {
      if (isChatToolGroupId(id) && typeof value === "boolean") {
        toolPatch[id] = value;
      }
    }
    if (Object.keys(toolPatch).length > 0) patch.tools = toolPatch;
    return deps.chat.updateSettings(patch);
  });

  // Chunks push through the same chrome webContents the invoke came from —
  // the sender check above already established it as the trusted chrome.
  const chatEmitter: ChatRunEmitter = {
    chunk: (requestId, chunk) => {
      if (!deps.chrome.isDestroyed())
        deps.chrome.send("chat:chunk", { requestId, chunk });
    },
    end: (requestId) => {
      if (!deps.chrome.isDestroyed())
        deps.chrome.send("chat:end", { requestId });
    },
    error: (requestId, message) => {
      if (!deps.chrome.isDestroyed())
        deps.chrome.send("chat:error", { requestId, message });
    },
  };

  handle("chat:start", (args) => {
    const a = requireRecord(args, "chat:start");
    const messages = a["messages"];
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
    const rawContext = a["context"];
    const contextRecord =
      typeof rawContext === "object" && rawContext !== null
        ? (rawContext as Record<string, unknown>)
        : null;
    const context =
      contextRecord !== null &&
      typeof contextRecord["url"] === "string" &&
      typeof contextRecord["title"] === "string"
        ? { url: contextRecord["url"], title: contextRecord["title"] }
        : null;
    return deps.chat.start(
      {
        requestId: requireString(a["requestId"], "requestId"),
        messages,
        context,
      },
      chatEmitter,
    );
  });

  handle("chat:stop", (args) => {
    deps.chat.stop(
      requireString(requireRecord(args, "chat:stop")["requestId"], "requestId"),
    );
  });

  /* ----------------------------- voice assistant ------------------------- */

  // Settings come from the chrome (settings page); mic frames and session
  // controls come from the overlay view (the HUD owns the microphone) — the
  // same two-sender trust as the audioOverlay:* channels, so handlePreview.
  handlePreview("voice:settings", () => deps.voice.settings());

  handlePreview("voice:updateSettings", (args) => {
    const a = optionalRecord(args);
    const patch: VoiceSettingsPatch = {};
    if (typeof a["enabled"] === "boolean") patch.enabled = a["enabled"];
    if (typeof a["wakeWordEnabled"] === "boolean") {
      patch.wakeWordEnabled = a["wakeWordEnabled"];
    }
    if (typeof a["wakeWord"] === "string") patch.wakeWord = a["wakeWord"];
    if (typeof a["model"] === "string") patch.model = a["model"];
    if (typeof a["voice"] === "string") patch.voice = a["voice"];
    // The key crosses IPC exactly once, inward; voice:settings reports only
    // whether one exists (the tts:updateSettings contract).
    if (typeof a["apiKey"] === "string") patch.apiKey = a["apiKey"];
    return deps.voice.updateSettings(patch);
  });

  handlePreview("voice:status", () => deps.voice.status());

  handlePreview("voice:audio", (args) => {
    const data = requireRecord(args, "voice:audio")["data"];
    if (!(data instanceof Uint8Array)) {
      throw new Error("voice:audio data must be a Uint8Array");
    }
    deps.voice.acceptAudio(data);
  });

  handlePreview("voice:start", () => deps.voice.startSession());

  handlePreview("voice:stop", () => deps.voice.stopSession());

  /* ------------------------------- devices ------------------------------ */

  /* ------------------------------ app updates ---------------------------- */

  handle("updates:state", () => deps.updates.state());
  // Kick the check and answer with the state as of the kick; the transitions
  // stream back as updates:changed events.
  handle("updates:check", () => {
    deps.updates.check();
    return deps.updates.state();
  });
  handle("updates:install", () => {
    deps.updates.install();
  });

  handle("devices:list", () => deps.devices.list(true));

  handle("devices:rename", async (args) => {
    const a = requireRecord(args, "devices:rename");
    await deps.devices.rename(
      requireString(a["deviceId"], "deviceId"),
      requireString(a["name"], "name"),
    );
    return deps.devices.list(true);
  });

  /* ------------------------- manual workspace sync ---------------------- */

  handle("workspaceSync:get", () => deps.sync.workspaceSyncStatus());

  handle("workspaceSync:run", async (args) => {
    const request = requireRecord(args, "workspaceSync:run");
    const mode = requireString(request["mode"], "mode");
    if (mode !== "push" && mode !== "pull" && mode !== "merge") {
      throw new Error("mode must be push, pull, or merge");
    }
    const sourceDeviceId = request["sourceDeviceId"];
    if (sourceDeviceId !== undefined && typeof sourceDeviceId !== "string") {
      throw new Error("sourceDeviceId must be a string");
    }
    if (mode === "push" && sourceDeviceId !== undefined) {
      throw new Error("Push always targets the canonical workspace");
    }
    return deps.sync.synchronizeWorkspace(mode, sourceDeviceId);
  });

  /* ------------------------------ ui / health ---------------------------- */

  handle("ui:setContentBounds", (args) => {
    const a = requireRecord(args, "ui:setContentBounds");
    const bounds: ContentBounds = {
      x: Math.max(0, Math.round(requireFinite(a["x"], "x"))),
      y: Math.max(0, Math.round(requireFinite(a["y"], "y"))),
      width: Math.max(0, Math.round(requireFinite(a["width"], "width"))),
      height: Math.max(0, Math.round(requireFinite(a["height"], "height"))),
    };
    deps.shell.setContentBounds(bounds);
  });

  handle("ui:setSplitRatio", (args) => {
    const a = requireRecord(args, "ui:setSplitRatio");
    // Clamped to sane fractions here; the pane-minimum clamp lives in the
    // shared geometry (clampSplitRatio), applied identically on both sides.
    const ratio = requireFinite(a["ratio"], "ratio");
    deps.shell.setSplitRatio(Math.min(Math.max(ratio, 0), 1));
  });

  handle("ui:setOverlayActive", (args) => {
    const a = requireRecord(args, "ui:setOverlayActive");
    if (typeof a["active"] !== "boolean")
      throw new Error("active must be a boolean");
    // Raise the chrome above the tab views while a modal is open — and keep
    // it there across tab re-attaches; on close, syncVisibility re-tops the
    // visible tabs above the chrome.
    deps.shell.setOverlayActive(a["active"]);
    if (!a["active"]) deps.tabs.syncVisibility();
  });

  handle("ui:setColorScheme", (args) => {
    const a = requireRecord(args, "ui:setColorScheme");
    const scheme = a["scheme"];
    if (scheme !== "light" && scheme !== "dark" && scheme !== "system") {
      throw new Error("scheme must be 'light', 'dark', or 'system'");
    }
    // nativeTheme is what every WebContents derives prefers-color-scheme
    // from, so sites in the tabs render their UI to match the chrome.
    nativeTheme.themeSource = scheme;
    // Read AFTER the assignment: on "system" this is the first honest answer
    // about the Mac's own setting since the last override, and the renderer
    // picks its default palette from it.
    const dark = nativeTheme.shouldUseDarkColors;
    deps.shell.setBackgroundScheme(dark);
    return { dark };
  });

  handle("ui:setTranslucency", (args) => {
    const a = requireRecord(args, "ui:setTranslucency");
    if (typeof a["enabled"] !== "boolean")
      throw new Error("enabled must be a boolean");
    deps.shell.setTranslucent(a["enabled"]);
  });

  handle("health:get", () =>
    planeHealthFor(
      deps.sync.status().state,
      deps.egress.planeState(),
      deps.machines.planeState(),
    ),
  );

  /* ---------------------- tabs: print / devtools (§8.1) ------------------ */

  handle("tabs:print", (args) => {
    deps.tabs.print(
      requireString(requireRecord(args, "tabs:print")["tabId"], "tabId"),
    );
  });

  handle("tabs:toggleDevTools", (args) => {
    deps.tabs.toggleDevTools(
      requireString(
        requireRecord(args, "tabs:toggleDevTools")["tabId"],
        "tabId",
      ),
    );
  });

  /* ------------------------------ downloads ------------------------------ */

  handle("downloads:list", () => deps.downloads.list());

  handle("downloads:open", (args) => {
    deps.downloads.open(
      requireString(requireRecord(args, "downloads:open")["id"], "id"),
    );
  });

  handle("downloads:reveal", (args) => {
    deps.downloads.reveal(
      requireString(requireRecord(args, "downloads:reveal")["id"], "id"),
    );
  });

  handle("downloads:cancel", (args) => {
    deps.downloads.cancel(
      requireString(requireRecord(args, "downloads:cancel")["id"], "id"),
    );
  });

  /* --------------------------- auth / enrollment ------------------------- */

  handle("auth:status", () => deps.auth.status());

  handle("auth:signup", (args) => {
    const a = requireRecord(args, "auth:signup");
    const signup: {
      email: string;
      displayName?: string;
      controlUrl?: string;
      inviteCode?: string;
    } = {
      email: requireString(a["email"], "email"),
    };
    if (typeof a["displayName"] === "string")
      signup.displayName = a["displayName"];
    if (typeof a["controlUrl"] === "string")
      signup.controlUrl = a["controlUrl"];
    if (typeof a["inviteCode"] === "string")
      signup.inviteCode = a["inviteCode"];
    return deps.auth.signup(signup);
  });

  handle("auth:enroll", (args) => {
    return deps.auth.enroll(
      requireString(requireRecord(args, "auth:enroll")["name"], "name"),
    );
  });

  handle("auth:passkeyBegin", () => deps.auth.passkeyBegin());

  handle("auth:passkeyFinish", (args) => {
    const a = requireRecord(args, "auth:passkeyFinish");
    return deps.auth.passkeyFinish(a["credential"]);
  });

  handle("auth:registerDeviceCredential", () =>
    deps.auth.registerDeviceCredential(),
  );

  handle("auth:recoverKeys", (args) => {
    return deps.auth.recoverKeys(
      requireString(
        requireRecord(args, "auth:recoverKeys")["recoveryCode"],
        "recoveryCode",
      ),
    );
  });

  handle("auth:mintEnrollmentCode", () => deps.auth.mintEnrollmentCode());

  handle("auth:signinWithCode", (args) => {
    const a = requireRecord(args, "auth:signinWithCode");
    return deps.auth.signinWithCode({
      code: requireString(a["code"], "code"),
      ...(typeof a["controlUrl"] === "string"
        ? { controlUrl: a["controlUrl"] }
        : {}),
    });
  });

  handle("auth:signOut", () => deps.signOut());

  handle("devices:revoke", (args) => {
    const a = requireRecord(args, "devices:revoke");
    const result = deps.auth.revoke(
      requireString(a["deviceId"], "deviceId"),
      typeof a["reason"] === "string" ? a["reason"] : undefined,
    );
    deps.devices.invalidateRegistry();
    return result;
  });

  /* ---------------------- credentials (1Password CLI) --------------------- */

  handle("credentials:status", () => deps.credentials.status());

  handle("credentials:search", (args) => {
    return deps.credentials.search(
      requireString(requireRecord(args, "credentials:search")["host"], "host"),
    );
  });

  handle("credentials:fill", (args) => {
    const a = requireRecord(args, "credentials:fill");
    return deps.credentials.fill(
      requireString(a["tabId"], "tabId"),
      requireString(a["itemId"], "itemId"),
    );
  });

  /* ------------------------------- passkeys ------------------------------ */

  handle("passkeys:status", () => deps.webauthn.status());

  handle("passkeys:chooseAccount", (args) => {
    const a = requireRecord(args, "passkeys:chooseAccount");
    const credentialId = a["credentialId"];
    if (credentialId !== null && typeof credentialId !== "string") {
      throw new Error("credentialId must be a string or null");
    }
    deps.webauthn.chooseAccount(
      requireString(a["requestId"], "requestId"),
      credentialId,
    );
  });

  /* --------------------- machine + terminal (§8.5) ----------------------- */

  handle("machine:status", () => deps.machines.refresh());

  handle("machine:wake", () => deps.machines.wake());

  handle("machine:suspend", () => deps.machines.suspend());

  handle("machine:boost", (args) => {
    const a = requireRecord(args, "machine:boost");
    return deps.machines.boost(
      Math.round(requireFinite(a["memoryMb"], "memoryMb")),
    );
  });

  handle("terminal:list", () => deps.terminals.list());

  handle("terminal:discover", () => deps.terminals.discover());

  handle("terminal:create", (args) => {
    const a = requireRecord(args, "terminal:create");
    return deps.terminals.create(
      typeof a["cwd"] === "string" ? a["cwd"] : undefined,
    );
  });

  handle("terminal:attach", (args) => {
    return deps.terminals.attach(
      requireString(requireRecord(args, "terminal:attach")["ptyId"], "ptyId"),
    );
  });

  handle("terminal:input", (args) => {
    const a = requireRecord(args, "terminal:input");
    const data = a["data"];
    if (typeof data !== "string") throw new Error("data must be a string");
    deps.terminals.input(requireString(a["ptyId"], "ptyId"), data);
  });

  handle("terminal:resize", (args) => {
    const a = requireRecord(args, "terminal:resize");
    const clampDim = (value: number): number =>
      Math.max(1, Math.min(1000, Math.round(value)));
    return deps.terminals.resize(
      requireString(a["ptyId"], "ptyId"),
      clampDim(requireFinite(a["cols"], "cols")),
      clampDim(requireFinite(a["rows"], "rows")),
    );
  });

  handle("terminal:close", (args) => {
    return deps.terminals.close(
      requireString(requireRecord(args, "terminal:close")["ptyId"], "ptyId"),
    );
  });

  handle("terminal:setJobMode", (args) => {
    const a = requireRecord(args, "terminal:setJobMode");
    const enabled = a["enabled"];
    if (typeof enabled !== "boolean")
      throw new Error("enabled must be a boolean");
    return deps.terminals.setJobMode(
      requireString(a["ptyId"], "ptyId"),
      enabled,
    );
  });

  handle("ports:list", () => deps.ports.list());

  handle("ports:forward", (args) => {
    const a = requireRecord(args, "ports:forward");
    const port = Math.round(requireFinite(a["port"], "port"));
    if (port < 1 || port > 65535) throw new Error("port must be 1..65535");
    const enabled = a["enabled"];
    if (typeof enabled !== "boolean")
      throw new Error("enabled must be a boolean");
    return deps.ports.setForward(port, enabled);
  });

  /* ------------------- IDE workspace (suma://terminal) ------------------- */

  handle("workspace:tree", () => deps.workspaceFs.tree());

  handle("workspace:readFile", (args) => {
    return deps.workspaceFs.read(
      requireString(requireRecord(args, "workspace:readFile")["path"], "path"),
    );
  });

  handle("workspace:writeFile", (args) => {
    const a = requireRecord(args, "workspace:writeFile");
    const contents = a["contents"];
    // Not requireString: an emptied-out file is a legitimate save.
    if (typeof contents !== "string")
      throw new Error("contents must be a string");
    return deps.workspaceFs.write(requireString(a["path"], "path"), contents);
  });

  /* ----------------------- identity egress (§8.4) ------------------------ */

  handle("egress:status", (args) => {
    return deps.egress.status(
      requireString(requireRecord(args, "egress:status")["spaceId"], "spaceId"),
    );
  });

  handle("egress:setPolicy", (args) => {
    const a = requireRecord(args, "egress:setPolicy");
    const policy = a["policy"];
    if (policy !== "suma-ip" && policy !== "direct") {
      throw new Error("policy must be 'suma-ip' or 'direct'");
    }
    return deps.egress.setPolicy(
      requireString(a["spaceId"], "spaceId"),
      policy,
    );
  });

  handle("egress:browseDirectForNow", (args) => {
    return deps.egress.browseDirectForNow(
      requireString(
        requireRecord(args, "egress:browseDirectForNow")["spaceId"],
        "spaceId",
      ),
    );
  });

  handle("egress:setSiteBypass", (args) => {
    const a = requireRecord(args, "egress:setSiteBypass");
    const bypass = a["bypass"];
    if (typeof bypass !== "boolean")
      throw new Error("bypass must be a boolean");
    return deps.egress.setSiteBypass(
      requireString(a["spaceId"], "spaceId"),
      requireString(a["host"], "host"),
      bypass,
    );
  });

  handle("egress:explain", (args) => {
    const a = requireRecord(args, "egress:explain");
    return deps.egress.explain(
      requireString(a["spaceId"], "spaceId"),
      requireString(a["host"], "host"),
    );
  });

  /* ------------------------- audit trail (§8.7) --------------------------- */

  handle("audit:list", (args) => {
    // Both fields of the payload are optional — tolerate a missing object.
    const a =
      typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)
        : {};
    return deps.audit.list(
      typeof a["limit"] === "number" && Number.isFinite(a["limit"])
        ? a["limit"]
        : undefined,
    );
  });

  /* ---------------------------- favorite sites ---------------------------- */

  handle("favorites:list", () => deps.favorites.list());

  handle("favorites:add", (args) => {
    const a = requireRecord(args, "favorites:add");
    return deps.favorites.add(
      requireString(a["url"], "url"),
      typeof a["title"] === "string" ? a["title"] : "",
    );
  });

  handle("favorites:remove", (args) => {
    return deps.favorites.remove(
      requireString(requireRecord(args, "favorites:remove")["id"], "id"),
    );
  });

  /* -------------------------------- saves --------------------------------- */

  handle("saves:list", () => deps.saves.list());

  handle("saves:capture", () => deps.captureActiveSave());

  handle("saves:update", (args) => {
    const a = requireRecord(args, "saves:update");
    const id = requireString(a["id"], "id");
    const patch = requireRecord(a["patch"], "patch");
    const clean: SavedItemPatch = {};
    if (patch["type"] !== undefined) {
      if (!isSavedItemType(patch["type"])) {
        throw new Error("type must be a saved-item type");
      }
      clean.type = patch["type"];
    }
    if (typeof patch["name"] === "string") clean.name = patch["name"];
    if (typeof patch["description"] === "string") {
      clean.description = patch["description"];
    }
    if (patch["author"] === null || typeof patch["author"] === "string") {
      clean.author = patch["author"];
    }
    if (patch["imageUrl"] === null || typeof patch["imageUrl"] === "string") {
      clean.imageUrl = patch["imageUrl"];
    }
    if (Array.isArray(patch["tags"])) {
      clean.tags = patch["tags"].filter(
        (tag): tag is string => typeof tag === "string",
      );
    }
    return deps.saves.update(id, clean);
  });

  handle("saves:delete", (args) => {
    deps.saves.remove(
      requireString(requireRecord(args, "saves:delete")["id"], "id"),
    );
  });

  /* ---------------------------- saved videos ------------------------------ */

  /**
   * The PIP relay state — what the player view is currently showing. Held
   * here like lastAudioState: a reloading PIP view pulls it, and a sign-out
   * re-registration starts it empty.
   */
  let pipState: VideoPipState = EMPTY_PIP_STATE;

  const sendPipState = (): void => {
    const wc = deps.shell.videoPipWebContents;
    if (!wc.isDestroyed()) wc.send("videoPip:state", pipState);
  };

  const closePip = (): void => {
    pipState = EMPTY_PIP_STATE;
    sendPipState(); // unloads the <video> — hiding the view alone would keep audio running
    deps.shell.hideVideoPip();
  };

  handle("videos:list", () => deps.videos.list());

  handle("videos:save", (args) => {
    const url = requireString(requireRecord(args, "videos:save")["url"], "url");
    return deps.videos.save(url);
  });

  handle("videos:remove", (args) => {
    const id = requireString(requireRecord(args, "videos:remove")["id"], "id");
    if (pipState.videoId === id) closePip();
    deps.videos.remove(id);
  });

  handle("videos:retry", (args) => {
    deps.videos.retry(
      requireString(requireRecord(args, "videos:retry")["id"], "id"),
    );
  });

  handle("videos:play", async (args) => {
    const id = requireString(requireRecord(args, "videos:play")["id"], "id");
    const item = deps.videos.get(id);
    if (item === null) throw new Error("This video is no longer saved.");
    if (item.state !== "ready" && item.state !== "uploading") {
      throw new Error("This video hasn't finished downloading yet.");
    }
    // First play on this device hydrates the media cache from the cloud copy
    // (manifest read-back → verified chunks); already-cached videos return
    // instantly. Throws a user-facing message when neither copy is reachable.
    await deps.videos.ensureLocalMedia(id);
    // Resume where the user last was on ANY device: adopt a newer cloud
    // position record if one exists (bounded wait; local point otherwise).
    await deps.videos.refreshPositionFromCloud(id);
    const fresh = deps.videos.get(id) ?? item;
    pipState = {
      videoId: id,
      title: fresh.title,
      author: fresh.author,
      mediaUrl: mediaUrlFor(id),
      position: fresh.playbackPosition,
    };
    deps.shell.showVideoPip();
    sendPipState();
  });

  /* --------------- floating video player (PIP view ⇄ main) ---------------- */

  handleVideoPip("videoPip:requestState", () => pipState);

  handleVideoPip("videoPip:control", (args) => {
    const record = requireRecord(args, "videoPip:control");
    const command = record["command"];
    if (command === "close") {
      const videoId = pipState.videoId;
      if (videoId !== null) {
        // Finished cleanly ⇒ next play starts over — on every device, which
        // is why the reset publishes too. An ordinary close publishes the
        // resume point so another Mac can pick up right here.
        if (record["ended"] === true) deps.videos.updatePlaybackPosition(videoId, 0);
        deps.videos.publishPosition(videoId, { force: true });
      }
      closePip();
      return;
    }
    if (command === "openSource") {
      const videoId = pipState.videoId;
      const item = videoId === null ? null : deps.videos.get(videoId);
      // Leaving for the full page is a close too — the resume point travels.
      if (videoId !== null) deps.videos.publishPosition(videoId, { force: true });
      closePip();
      if (item === null) return;
      const spaceId = deps.spaces.activeSpaceId;
      if (spaceId !== null) deps.tabs.create({ spaceId, url: item.url });
      deps.shell.focusChrome();
      return;
    }
    if (command === "position") {
      const value = requireFinite(record["value"], "value");
      const videoId = pipState.videoId;
      if (videoId !== null) {
        pipState = { ...pipState, position: value };
        deps.videos.updatePlaybackPosition(videoId, value);
        // Streamed updates ride the throttle; only close/ended force.
        deps.videos.publishPosition(videoId);
      }
      return;
    }
    throw new Error("videoPip:control: unknown command");
  });

  handleVideoPip("videoPip:dragStart", (args) => {
    const a = requireRecord(args, "videoPip:dragStart");
    deps.shell.beginVideoPipDrag({
      x: requireFinite(a["x"], "x"),
      y: requireFinite(a["y"], "y"),
    });
  });

  handleVideoPip("videoPip:resizeStart", () => {
    deps.shell.beginVideoPipResize();
  });

  handleVideoPip("videoPip:pointerEnd", () => {
    deps.shell.endVideoPipPointer();
  });

  /* ------------- glance preview (chrome frame ⇄ floating page) ------------ */

  handle("glance:bounds", (args) => {
    const a = requireRecord(args, "glance:bounds");
    deps.glance.setBounds({
      x: Math.max(0, Math.round(requireFinite(a["x"], "x"))),
      y: Math.max(0, Math.round(requireFinite(a["y"], "y"))),
      width: Math.max(0, Math.round(requireFinite(a["width"], "width"))),
      height: Math.max(0, Math.round(requireFinite(a["height"], "height"))),
    });
  });

  handle("glance:close", () => {
    deps.glance.close();
  });

  handle("glance:promote", () => {
    deps.glance.promote();
  });

  handle("glance:goBack", () => {
    deps.glance.goBack();
  });

  handle("glance:goForward", () => {
    deps.glance.goForward();
  });

  handlePreview("savePreview:bounds", (args) => {
    const a = requireRecord(args, "savePreview:bounds");
    deps.shell.setSavePreviewSize(
      requireFinite(a["height"], "height"),
      a["width"] === undefined ? undefined : requireFinite(a["width"], "width"),
    );
  });

  handlePreview("savePreview:activate", (args) => {
    const itemId = requireString(
      requireRecord(args, "savePreview:activate")["id"],
      "id",
    );
    // The card was clicked: the CHROME opens the panel on the item. Focus
    // follows — the user's next interaction is editing, which lives there.
    deps.chrome.send("saves:openDetail", { itemId });
    deps.shell.focusChrome();
  });

  // "Open" on a download-complete card. The overlay is the only surface that
  // can show one over a page, so it needs this channel; it stays id-based, so
  // the reachable set is exactly the completed downloads main already knows
  // about — no caller-supplied path (downloads.ts). No focusChrome: the file
  // opens in another app, and stealing focus first would fight it.
  handlePreview("downloadOverlay:open", (args) => {
    deps.downloads.open(
      requireString(requireRecord(args, "downloadOverlay:open")["id"], "id"),
    );
  });

  /* ------------------- Nostr signer (NIP-07, shared/nostr.ts) ------------- */

  handle("nostr:settings", () => deps.nostr.settings());

  handle("nostr:setKey", (args) => {
    const key = requireString(requireRecord(args, "nostr:setKey")["key"], "key");
    return deps.nostr.setKey(key);
  });

  handle("nostr:generateKey", () => deps.nostr.generateKey());

  handle("nostr:removeKey", () => deps.nostr.removeKey());

  handle("nostr:setRelays", (args) => {
    // The shape is sanitized in the service (sanitizeRelays) — bad entries
    // are dropped, not fatal, because this is a settings-page edit.
    const relays = requireRecord(
      requireRecord(args, "nostr:setRelays")["relays"],
      "relays",
    );
    return deps.nostr.setRelays(relays);
  });

  handle("nostr:setSitePolicy", (args) => {
    const a = requireRecord(args, "nostr:setSitePolicy");
    return deps.nostr.setSitePolicy(
      requireString(a["host"], "host"),
      requireNostrPatch(a["patch"]),
    );
  });

  handle("nostr:removeSitePolicy", (args) => {
    const host = requireString(
      requireRecord(args, "nostr:removeSitePolicy")["host"],
      "host",
    );
    return deps.nostr.removeSitePolicy(host);
  });

  handle("nostr:setBuzzRelay", (args) => {
    const raw = requireRecord(args, "nostr:setBuzzRelay")["url"];
    if (typeof raw !== "string") throw new Error("url must be a string");
    // "" clears the relay; anything else must normalize to ws(s)://.
    const url = raw.trim() === "" ? null : normalizeBuzzRelayUrl(raw);
    if (url === null && raw.trim() !== "") {
      throw new Error("That doesn't look like a relay URL — try wss://your-relay.example");
    }
    const info = deps.nostr.setBuzzRelay(url);
    // Kick the roster fetch; results land as nostr:buzzAgentsChanged.
    if (url !== null) void deps.buzz.refresh();
    return info;
  });

  handle("nostr:buzzAgents", (args) => {
    const refresh = optionalRecord(args)["refresh"] === true;
    const state = deps.buzz.state();
    const neverFetched = state.status === "idle" && deps.nostr.buzzRelayUrl() !== null;
    if (refresh || neverFetched) void deps.buzz.refresh();
    return deps.buzz.state();
  });

  // The approval surfaces: the overlay's card stack AND the chrome's detail
  // panel both pull and answer, so these ride the preview trust lane (which
  // admits both senders).
  handlePreview("nostr:pending", () => deps.nostr.pending());

  handlePreview("nostr:respond", (args) => {
    const a = requireRecord(args, "nostr:respond");
    const response: NostrApprovalResponse = {
      requestId: requireString(a["requestId"], "requestId"),
      approved: a["approved"] === true,
      remember: a["remember"] === true,
    };
    deps.nostr.respond(response);
  });

  handlePreview("nostr:openSettings", () => {
    // The key-missing card's "Set up" tap: the CHROME opens
    // suma://settings/nostr, and focus follows — the user's next act is
    // pasting or generating a key, which lives there.
    deps.chrome.send("nostr:openSettings", undefined);
    deps.shell.focusChrome();
  });

  handlePreview("nostr:expand", (args) => {
    const requestId = requireString(
      requireRecord(args, "nostr:expand")["requestId"],
      "requestId",
    );
    // The card was expanded: the CHROME opens the detail panel on the
    // request (savePreview:activate shape). The request stays pending —
    // expanding is looking, not answering.
    deps.nostr.expand(requestId);
    deps.shell.focusChrome();
  });

  /**
   * The GUEST lane — the one channel site pages reach (via the nostr guest
   * preload), and the only handler here whose sender is untrusted web
   * content. Trust is established two ways before the service sees the
   * call: the sender's session must be one of the space sessions (so the
   * chrome/overlay/files surfaces and any stray webContents are refused),
   * and the host/origin are resolved from the SENDER FRAME's committed URL
   * — never from the page's arguments. Errors travel as values; a thrown
   * error would reach the page wrapped in Electron's invoke noise.
   */
  ipcMain.removeHandler(NOSTR_GUEST_CHANNEL);
  ipcMain.handle(NOSTR_GUEST_CHANNEL, (event, args: unknown) => {
    const fromSpaceSession = deps.spaces
      .list()
      .some((space) => deps.spaces.sessionFor(space.id) === event.sender.session);
    if (!fromSpaceSession) {
      return { ok: false, reason: "denied", error: "window.nostr: unauthorized sender" };
    }
    let parsed: URL;
    try {
      parsed = new URL(event.senderFrame?.url ?? event.sender.getURL());
    } catch {
      return { ok: false, reason: "denied", error: "window.nostr: unresolvable origin" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        ok: false,
        reason: "denied",
        error: "window.nostr: only web pages can use the signer",
      };
    }
    return deps.nostr.handleGuest(
      { host: parsed.hostname, origin: parsed.origin, sender: event.sender },
      args,
    );
  });

  /* --------------- selection toolbar (overlay → chrome) ------------------- */

  /**
   * A toolbar button was tapped. The selection itself was cached by
   * TabManager when the toolbar was shown — the toolbar renderer never
   * carries page text, only the tap. The chrome owns both actions: the
   * audio store for read-aloud, the chat sidebar for add-to-chat.
   */
  handleToolbar("selectionToolbar:action", (args) => {
    const action = requireRecord(args, "selectionToolbar:action")["action"];
    if (action !== "readAloud" && action !== "addToChat") {
      throw new Error("selectionToolbar:action: unknown action");
    }
    const selection = deps.tabs.currentSelection();
    deps.tabs.clearSelection();
    if (selection === null) return;
    deps.chrome.send(
      action === "readAloud" ? "selection:readAloud" : "selection:addToChat",
      selection,
    );
    // Adding to chat moves the interaction into the sidebar's composer;
    // read-aloud deliberately does NOT steal focus from the page.
    if (action === "addToChat") deps.shell.focusChrome();
  });

  /* --------------- floating audio player (overlay ⇄ chrome) --------------- */

  /**
   * Pure relay, both directions: the chrome owns the audio element and its
   * store; the overlay window owns the pixels. Main holds only the last
   * snapshot, so an overlay that (re)loads mid-playback can pull the state
   * it missed. Scoped to this registration on purpose — a sign-out rebuilds
   * the graph, reloads both renderers, and playback with them.
   */
  let lastAudioState: AudioOverlayState | null = null;

  handle("audio:publishState", (args) => {
    // From the chrome (trusted sender), for the overlay's eyes: relayed as
    // an opaque snapshot, not interpreted here.
    requireRecord(args, "audio:publishState");
    lastAudioState = args;
    const wc = deps.shell.savePreviewWebContents;
    if (!wc.isDestroyed()) wc.send("audioOverlay:state", args);
  });

  handlePreview("audioOverlay:requestState", () => lastAudioState);

  handlePreview("audioOverlay:control", (args) => {
    const command = requireAudioCommand(args);
    deps.chrome.send("audio:control", command);
    // Opening settings is a chrome interaction; the keyboard follows it. The
    // transport taps deliberately do NOT focus — pausing must not yank the
    // user off the page they are reading.
    if (command.command === "openVoiceSettings") deps.shell.focusChrome();
  });

  /* ---------------------------- files (§8.6) ------------------------------ */

  handleFiles("files:list", (args) => {
    const a = optionalRecord(args);
    return deps.files.list(
      typeof a["path"] === "string" ? a["path"] : undefined,
    );
  });

  handleFiles("files:stat", (args) => {
    return deps.files.stat(
      requireString(requireRecord(args, "files:stat")["path"], "path"),
    );
  });

  handleFiles("files:read", (args) => {
    const a = requireRecord(args, "files:read");
    return deps.files.read(
      requireString(a["path"], "path"),
      requireFinite(a["maxBytes"], "maxBytes"),
    );
  });

  handleFiles("files:context", () => deps.files.context());

  handleFiles("files:upload", (args) => {
    const a = requireRecord(args, "files:upload");
    const data = a["data"];
    if (!(data instanceof Uint8Array))
      throw new Error("data must be a Uint8Array");
    const uploadId = a["uploadId"];
    return deps.files.upload({
      path: requireString(a["path"], "path"),
      contentType:
        typeof a["contentType"] === "string" ? a["contentType"] : null,
      data,
      uploadId:
        typeof uploadId === "string" && uploadId.length > 0
          ? uploadId
          : undefined,
    });
  });

  handleFiles("files:download", (args) => {
    return deps.files.download(
      requireString(requireRecord(args, "files:download")["path"], "path"),
    );
  });

  handleFiles("files:delete", (args) => {
    return deps.files.remove(
      requireString(requireRecord(args, "files:delete")["path"], "path"),
    );
  });

  handleFiles("files:quota", () => deps.files.quota());

  handleFiles("transfers:list", async () => deps.files.refreshTransfers());

  handleFiles("transfers:cancel", (args) => {
    return deps.files.cancelTransfer(
      requireString(requireRecord(args, "transfers:cancel")["id"], "id"),
    );
  });
}
