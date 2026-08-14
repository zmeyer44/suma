/**
 * Suma desktop main process bootstrap (PRD §8.1): singleton lock, shell
 * window, per-space sessions, tab views, cookie sync, M-0 migration, typed
 * IPC, and menu accelerators.
 */

import path from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import {
  app,
  globalShortcut,
  Menu,
  nativeTheme,
  safeStorage,
  session,
  systemPreferences,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";
import type { EventChannel, SumaEventMap } from "../shared/ipc";
import { settingsUrl } from "../shared/internal-pages";
import type { SavedItem } from "../shared/saves";
import { applyDevDockIcon } from "./app-icon";
import { AuditService } from "./audit-service";
import { TtsService } from "./audio/tts-service";
import { AuthService } from "./auth-service";
import { PROD_CONTROL_URL } from "./control-client";
import { ChatService } from "./chat/chat-service";
import { loadDotEnv } from "./env";
import { TcpAgentClient } from "./compute/agent-client";
import { SwitchableAgentLink } from "./compute/agent-link-switch";
import { MachineService } from "./compute/machine-service";
import { PortsService } from "./compute/ports-service";
import { SimAgent } from "./compute/sim-agent";
import { TerminalService } from "./compute/terminal-service";
import { CredentialsService } from "./credentials";
import { DeviceStore } from "./device";
import { DeviceCollaborationService } from "./device-collaboration";
import { suggestedDeviceName } from "./device-name";
import { DownloadManager } from "./downloads";
import { EgressService } from "./egress/egress-service";
import { workspaceHasProxiedSpace } from "./egress/egress-state";
import { FavoritesService } from "./favorites";
import { filesBundleCandidates, resolveFilesBundle } from "./files/bundle";
import { DownloadRouter } from "./files/download-router";
import { FilesClient } from "./files/files-client";
import { FilesService } from "./files/files-service";
import { FilesWindow } from "./files/files-window";
import { browserNativeFetch } from "./gateway/native-fetch";
import { NativeRequestHeaderBridge } from "./gateway/native-request-headers";
import { GatewayBackedService } from "./gateway/service";
import { createDownloadPolicyReader } from "./files/prefs";
import { HistoryService } from "./history";
import { planeHealthFor, presentSpaces, registerIpc } from "./ipc";
import { MigrationService } from "./migration";
import { BuzzService } from "./nostr/buzz-service";
import { registerNostrGuestPreload } from "./nostr/guest-preload";
import { NostrService } from "./nostr/nostr-service";
import { GlanceManager } from "./glance";
import { PopupManager } from "./popups";
import {
  installChromeCsp,
  installFilesProtocol,
  registerSumaScheme,
} from "./privileged";
import {
  CAPTURE_SCRIPT,
  DoubleShiftDetector,
  sanitizeCapturedPage,
} from "./saves/saves-core";
import { SavesService } from "./saves/saves-service";
import { canonicalVideoUrl } from "../shared/videos";
import { VIDEOS_DIRNAME } from "./videos/videos-core";
import { installVideoProtocol } from "./videos/video-protocol";
import { VideosService } from "./videos/videos-service";
import { registerCertificateErrorHandler } from "./security";
import { ShellWindow } from "./shell-window";
import { performSignOut } from "./sign-out";
import { SpaceManager } from "./spaces";
import { SyncService } from "./sync/service";
import { isAllowedTabUrl, NEW_TAB_URL } from "./tab-policy";
import { TabManager } from "./tabs";
import { UpdateService } from "./updates/update-service";
import { VoiceService } from "./voice/voice-service";
import { WebAuthnService } from "./webauthn";
import { resolveWorkspaceRoot, WorkspaceFsService } from "./workspace-fs";
import { resetWorkspaceHlc, WorkspaceStore } from "./workspace-store";

/**
 * The account's live service graph. Replaced wholesale by a sign-out reset
 * (§8.2), so the process-wide listeners registered in `bootstrap` reach the
 * services through this binding rather than closing over one graph.
 */
interface AppInstance {
  emit: <C extends EventChannel>(
    channel: C,
    payload: SumaEventMap[C],
  ) => void;
  teardown: (opts: { leavingAccount: boolean }) => void;
  noteClientCertificate: (url: string) => void;
  newTab: () => void;
  openFiles: () => void;
  /** Open suma://settings/about — the menu's Check for Updates… lands there. */
  openAboutSettings: () => void;
  /** Every webContents' before-input-event — the double-Shift save gesture. */
  noteKeyInput: (input: Input) => void;
}

let shell: ShellWindow | null = null;
let live: AppInstance | null = null;
/**
 * App self-updates — APP-level like the window and the menu, never rebuilt
 * with the account graph: electron-updater's autoUpdater is a process
 * singleton, and a per-account service would stack duplicate listeners on it
 * across sign-outs. Graphs subscribe in `startServices`, unsubscribe in
 * their teardown.
 */
const updates = new UpdateService();
/** Whether --disable-quic was appended before app ready — gates proxying (§8.4). */
let quicDisabledAtStartup = false;

// Packaged builds get their own userData ("Suma"); dev runs keep Electron's
// default derived from package.json name ("@suma/desktop"). Without this the
// two share one directory — and one single-instance lock, so an installed
// Suma and `pnpm dev` silently refuse to start while the other runs. Must
// precede the singleton lock AND the first getPath("userData") read below.
if (app.isPackaged) {
  app.setName("Suma");
  app.setPath("userData", path.join(app.getPath("appData"), "Suma"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerSumaScheme();
  // §8.4 QUIC leak guard: the identity path is a CONNECT proxy, which tunnels
  // TCP only — Chromium would otherwise race HTTP/3 over UDP straight past
  // the proxy and expose the real IP. Command-line switches only apply before
  // app ready, so this keys off the persisted workspace: if any space is
  // proxied, QUIC is off for the whole run. A space switched to suma-ip
  // mid-session picks the switch up at next launch.
  if (
    workspaceHasProxiedSpace(
      path.join(app.getPath("userData"), "workspace.json"),
    )
  ) {
    app.commandLine.appendSwitch("disable-quic");
    quicDisabledAtStartup = true;
  }
  // Follow the Mac's own light/dark setting until the renderer says otherwise.
  // This is load-bearing, not just a default: while the source is "system" the
  // chrome renderer's prefers-color-scheme reports the REAL OS preference, which
  // is how lib/theme.ts picks its default palette at boot. Forcing a scheme here
  // would make every renderer echo the force back instead. The renderer asserts
  // the true source at boot (ui:setColorScheme) once it reads the stored theme.
  nativeTheme.themeSource = "system";
  // While following, the OS flipping appearance has to move the window's own
  // fill too — the renderer repaints its surfaces, but the ground behind them
  // (shown mid-resize and before first paint) belongs to main.
  nativeTheme.on("updated", () => {
    if (nativeTheme.themeSource === "system") {
      shell?.setBackgroundScheme(nativeTheme.shouldUseDarkColors);
    }
  });
  app.on("second-instance", () => shell?.focus());
  app.on("window-all-closed", () => app.quit());
  // §8.4 WebRTC leak guard, the UDP sibling of the QUIC switch above. WebRTC
  // enumerates local interfaces and reaches STUN servers over UDP, which a
  // CONNECT proxy does not carry — so a page in a proxied space could read
  // the real IP even while every TCP request is tunnelled.
  // `disable_non_proxied_udp` confines WebRTC to the proxy.
  //
  // Coarse on purpose: this is decided once per run from the same signal as
  // --disable-quic, so a mixed workspace applies it to direct spaces too,
  // costing them WebRTC UDP. Both switches are process-wide in Chromium's
  // model; narrowing to per-space is a follow-up, and over-restricting is the
  // safe direction.
  app.on("web-contents-created", (_event, contents) => {
    // The double-Shift save gesture is watched on EVERY webContents — tabs,
    // the chrome renderer, popups — so a save lands wherever focus is. Pages
    // see their key events untouched; this observes, never preventDefaults.
    contents.on("before-input-event", (_e, input) => live?.noteKeyInput(input));
    if (!quicDisabledAtStartup) return;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
  void app
    .whenReady()
    .then(bootstrap)
    .catch((err: unknown) => {
      console.error("suma: fatal bootstrap error", err);
      app.quit();
    });
}

/**
 * One-time process setup: the window, the app-level listeners, and the
 * privileged protocol — everything that must be registered exactly once for
 * the life of the process. The account's service graph is built by
 * `startServices` and can be torn down and rebuilt on top of this (sign-out,
 * §8.2), which is why the listeners here delegate through `live` rather than
 * closing over any one graph.
 */
async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");

  // Dev .env files (repo root and up from the app dir) — nothing else loads
  // them into this process, and keys like AI_GATEWAY_API_KEY live there. The
  // real environment always wins; packaged builds find nothing and move on.
  loadDotEnv(app.getAppPath());

  // Before the window: the dock slot appears the moment the app activates, and
  // setting the icon after that shows Electron's default for a beat first.
  applyDevDockIcon(app, path.dirname(fileURLToPath(import.meta.url)));

  installChromeCsp(session.defaultSession);
  // Saved-video playback: suma-video:// streams the media cache into the PIP
  // and chrome views (both on the default session). Once per process — the
  // cache DIRECTORY is stable across sign-outs even though its contents are
  // wiped with the account.
  installVideoProtocol(
    session.defaultSession,
    path.join(userData, VIDEOS_DIRNAME),
  );
  const win = new ShellWindow();
  shell = win;

  // The Files page is a real privileged page: its own ephemeral session (no
  // site cookies, no site storage) and the only session that can resolve
  // suma://files at all. Registered once — a second protocol.handle for the
  // same scheme on the same session throws.
  const filesSession = session.fromPartition("suma-files");
  installFilesProtocol(
    filesSession,
    resolveFilesBundle(
      filesBundleCandidates(
        path.dirname(fileURLToPath(import.meta.url)),
        process.resourcesPath,
      ),
    ),
  );

  // §8.1 certificate errors fail closed — banner only, no override channel.
  registerCertificateErrorHandler((info) =>
    live?.emit("security:certError", info),
  );
  // Passive observation only — NOT calling preventDefault leaves Electron's
  // default certificate selection exactly as it was, while telling the router
  // that this origin authenticates with a client certificate (§8.6: such a
  // download can never be handed to the cloud).
  app.on("select-client-certificate", (_event, _webContents, url) => {
    live?.noteClientCertificate(url);
  });
  app.on("before-quit", () => {
    updates.stop();
    live?.teardown({ leavingAccount: false });
  });

  buildMenu({
    newTab: () => {
      live?.newTab();
      win.focusChrome();
    },
    toggleCommandBar: () => {
      live?.emit("ui:toggleCommandBar", undefined);
      win.focusChrome();
    },
    // The Files page has no IPC channel of its own to open it (the Phase-3
    // contract is files/transfers only), so the menu is how it opens.
    openFiles: () => live?.openFiles(),
    // The menu answer to "am I on the latest?": kick a check and land on the
    // About page, where the state (and the restart button) lives.
    checkForUpdates: () => {
      updates.check();
      live?.openAboutSettings();
      win.focusChrome();
    },
  });

  // Packaged builds start the check cadence; dev builds stay `unsupported`.
  updates.start();

  live = await startServices({ userData, win, filesSession });
}

/**
 * Everything that belongs to the signed-in account. Built at startup and
 * rebuilt from scratch after a sign-out wipe — the stores, keys, spaces, and
 * services are all new objects, on the same window.
 */
async function startServices(ctx: {
  userData: string;
  win: ShellWindow;
  filesSession: Session;
}): Promise<AppInstance> {
  const { userData, win, filesSession } = ctx;
  const device = await DeviceStore.load(userData);
  let computerName: string | null = null;
  if (process.platform === "darwin") {
    try {
      const value = systemPreferences.getUserDefault("ComputerName", "string");
      if (typeof value === "string") computerName = value;
    } catch {
      // Some unsigned/test Electron builds cannot read this preference.
    }
  }
  const defaultDeviceName = suggestedDeviceName({
    computerName,
    hostname: hostname(),
    platform: process.platform,
  });
  const store = new WorkspaceStore(
    path.join(userData, "workspace.json"),
    device.deviceId,
  );
  const spaces = new SpaceManager(store);
  // FIRST hook on the space sessions, before TabManager can build a view and
  // materialize one: the window.nostr guest preload only applies to documents
  // created AFTER it is registered, so a session must never exist without it —
  // a page that loads in the gap has no provider until the next navigation,
  // which reads as "Nostr sign-in is missing until I restart the app".
  spaces.onSessionCreated((ses) => registerNostrGuestPreload(ses));

  const chrome = win.chromeWebContents;
  const emit = <C extends EventChannel>(
    channel: C,
    payload: SumaEventMap[C],
  ): void => {
    if (!chrome.isDestroyed()) chrome.send(channel, payload);
  };

  // The floating overlay is its own WebContentsView (shell-window.ts) — the
  // card stack lives there, not in the chrome, so it stays visible above the
  // page without raising the chrome.
  const emitPreview = <C extends EventChannel>(
    channel: C,
    payload: SumaEventMap[C],
  ): void => {
    const wc = win.savePreviewWebContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };

  // The app-level updater, reaching this account graph's chrome. The
  // unsubscribe belongs to teardown — a sign-out must not leave the old
  // graph's emitter attached.
  const offUpdates = updates.onChanged((state) =>
    emit("updates:changed", state),
  );

  const popups = new PopupManager(win);
  // The Glance preview (shift-click / pinned-tab links). Its tab-opener is
  // wired right after TabManager exists — the two call each other only
  // through these late bindings.
  const glance = new GlanceManager(
    win,
    spaces,
    popups,
    (state) => emit("glance:changed", state),
    (reason) => emit("popups:denied", { reason }),
  );
  let deviceCollaboration: DeviceCollaborationService | null = null;
  const pushDevices = (): void => {
    const collaboration = deviceCollaboration;
    if (collaboration === null) return;
    void collaboration
      .list(false)
      .then((devices) => emit("devices:updated", devices))
      .catch(() => undefined);
  };
  const tabs: TabManager = new TabManager(
    win,
    spaces,
    store,
    (spaceId) => {
      emit("tabs:updated", { spaceId, tabs: tabs.list(spaceId) });
      emit("spaces:updated", presentSpaces(spaces, tabs));
      deviceCollaboration?.capture();
    },
    popups,
    (reason) => emit("popups:denied", { reason }),
  );
  tabs.setGlanceOpener((spaceId, url) => glance.open(spaceId, url));
  tabs.setThumbnailListener((thumb) => emit("tabs:thumbnail", thumb));
  glance.setTabOpener(({ spaceId, url, adoptView, faviconUrl }) => {
    try {
      tabs.create({
        spaceId,
        url,
        ...(adoptView !== undefined ? { adoptView } : {}),
        ...(faviconUrl !== undefined ? { faviconUrl } : {}),
      });
    } catch (err) {
      // Space at its tab cap — surface it, never crash the opener.
      emit("popups:denied", {
        reason: err instanceof Error ? err.message : "could not open a tab",
      });
    }
  });
  spaces.setTabMembershipResolver((webContentsId, spaceId) =>
    tabs.isTabInSpace(webContentsId, spaceId),
  );
  spaces.setPopupMembershipResolver((webContentsId, spaceId) =>
    popups.isPopupInSpace(webContentsId, spaceId),
  );

  // §8.3 browsing history: captured locally from tab navigations; published
  // (sealed) through the workspace-doc stream only while the settings toggle
  // is on — the store decides per visit.
  const history = new HistoryService(store);
  tabs.setHistoryRecorder(history);

  const webauthn = new WebAuthnService({
    emitRequest: (request) => emit("passkeys:accountRequest", request),
    emitCancelled: (requestId) =>
      emit("passkeys:accountRequestCancelled", { requestId }),
    focusShell: () => win.focus(),
  });
  // Every space session gets the passkey account picker, including sessions
  // created later by space creation or migration.
  spaces.onSessionCreated((ses) => webauthn.attachToSession(ses));

  const downloads = new DownloadManager({
    store,
    emit: (items) => emit("downloads:updated", items),
    downloadsDir: () => app.getPath("downloads"),
    // The completion card goes to the floating overlay, NOT the chrome: a
    // download finishes while the user is on a page, and the chrome renders
    // below the tab views, so a card drawn there would be invisible exactly
    // when it matters.
    onCompleted: (item) => emitPreview("downloadOverlay:completed", item),
  });
  spaces.onSessionCreated((ses, spaceId) => downloads.attachTo(ses, spaceId));

  // Auth and sync reference each other only through late-bound
  // closures; every callback fires after bootstrap completes, well after the
  // `sync` binding below is initialized.
  const auth = new AuthService({
    device,
    store,
    // Packaged builds get the hosted plane by default — they never see a
    // shell env. Dev runs stay null (local-only) unless SUMA_CONTROL_URL is
    // exported, which also overrides the packaged default.
    controlUrl:
      process.env["SUMA_CONTROL_URL"] ??
      (app.isPackaged ? PROD_CONTROL_URL : null),
    emitChanged: (status) => emit("auth:changed", status),
    onTokenChanged: () => {
      sync.refreshAuth();
      gateway.refreshAuth();
      deviceCollaboration?.capture();
      // A fresh token is the moment cloud files (and so the cross-device
      // video library) become reachable — pull what other devices saved.
      // Late-bound like sync/gateway above; fires only post-bootstrap.
      void videos.reconcileWithCloud().catch(() => undefined);
    },
    // Resolves over the network, so `sync` (declared below) exists by the
    // time this fires — same late-binding contract as onTokenChanged.
    onHubUrl: (url) => {
      sync.setHubUrl(url);
      gateway.setHubUrl(url);
    },
    suggestedDeviceName: defaultDeviceName,
    passkeySupport: () => webauthn.status(),
  });

  // One structured network handler per persisted space. It is installed even
  // before discovery so a later /v1/me hub URL switches existing sessions to
  // gateway authority without recreating tabs; until then it forwards through
  // Chromium's built-in handlers unchanged.
  const nativeRequestHeaders = new NativeRequestHeaderBridge();
  spaces.onSessionCreated((ses, spaceId) =>
    nativeRequestHeaders.attachTo(ses, spaceId),
  );
  const gateway = new GatewayBackedService({
    getToken: () => auth.getToken(),
    gatewayUrl: process.env["SUMA_SESSION_GATEWAY_URL"] ?? null,
    devToken: process.env["SUMA_SESSION_GATEWAY_DEV_TOKEN"] ?? null,
    initialNativeDomains: store.nativeTransportDomains(),
    onNativePromoted: (domain) => {
      store.addNativeTransportDomain(domain);
      sync.promoteNativeOrigin(domain);
    },
    nativeFetchImpl: (ses, request) =>
      browserNativeFetch(ses, request, nativeRequestHeaders),
  });
  spaces.onSessionCreated((ses, spaceId) => gateway.attachTo(ses, spaceId));

  const refreshWorkspace = (): void => {
    // Drop this device's throwaway default once the account's real spaces have
    // synced in, so devices don't accumulate empty "Personal" duplicates that
    // strand carried-over cookies in a space the user isn't browsing (§8.8).
    spaces.reconcileAfterSync();
    tabs.reconcileSyncedTabs();
    deviceCollaboration?.applySharedFocus();
    tabs.syncVisibility();
    for (const space of spaces.list()) {
      void sync
        .addSpace(space.id)
        .catch((err: unknown) => console.error("suma sync:", err));
    }
    emit("spaces:updated", presentSpaces(spaces, tabs));
    pushDevices();
  };

  /**
   * Collapse empty duplicate spaces (§8.8). Repeated fresh launches each
   * minted a throwaway "Personal", fragmenting the account into look-alike
   * spaces where only one holds the synced cookies — so a user could be
   * browsing an empty duplicate and appear logged out. Runs only after a
   * space has HYDRATED (so "no cookies" is trustworthy, not just "records
   * haven't arrived yet"): a space with zero cookies, zero pins, and zero
   * tabs has nothing in it on any device (cookies sync, so emptiness is a
   * cross-device signal) and is removed. The richest space is made active
   * first, so the user lands where their carried-over sessions actually live.
   */
  let consolidateTimer: NodeJS.Timeout | null = null;
  const consolidateSpaces = async (): Promise<void> => {
    const scored = await Promise.all(
      spaces.list().map(async (s) => {
        // Un-hydrated ⇒ treat as non-empty so it is never removed mid-sync.
        const cookies = sync.isHydrated(s.id)
          ? (await spaces.sessionFor(s.id).cookies.get({})).length
          : 1;
        const content =
          cookies + store.pinsFor(s.id).length + tabs.countFor(s.id);
        return { id: s.id, content, hydrated: sync.isHydrated(s.id) };
      }),
    );
    const richest = scored.reduce((a, b) => (b.content > a.content ? b : a));
    const active = spaces.activeSpaceId;
    const activeScore =
      active === null ? undefined : scored.find((s) => s.id === active);
    if (
      richest.content > 0 &&
      (activeScore === undefined || activeScore.content === 0)
    ) {
      spaces.setActive(richest.id);
    }
    for (const s of scored) {
      if (spaces.list().length <= 1) break;
      if (s.id === spaces.activeSpaceId || !s.hydrated || s.content > 0)
        continue;
      spaces.remove(s.id);
    }
  };
  const scheduleConsolidation = (): void => {
    if (consolidateTimer !== null) clearTimeout(consolidateTimer);
    consolidateTimer = setTimeout(() => {
      consolidateTimer = null;
      void consolidateSpaces().catch((err: unknown) =>
        console.error("suma consolidate:", err),
      );
    }, 1_500);
    consolidateTimer.unref();
  };

  const sync = new SyncService({
    device,
    store,
    sessionFor: (spaceId) => spaces.sessionFor(spaceId),
    // pushHealth is declared below but only ever runs post-bootstrap, like
    // the other late-bound closures in this file.
    emitStatus: (status) => {
      emit("sync:statusChanged", status);
      pushHealth();
    },
    getToken: () => auth.getToken(),
    onWorkspaceApplied: refreshWorkspace,
    onWorkspaceSyncChanged: (status) => emit("workspaceSync:changed", status),
    onPresenceChanged: pushDevices,
    onConverged: scheduleConsolidation,
    onSessionHydrating: (spaceId) => tabs.markSessionHydrating(spaceId),
    onSessionReady: (spaceId) => tabs.markSessionReady(spaceId),
    onSessionSynchronized: (spaceId) => tabs.reloadSpace(spaceId),
    gatewayOwnsHost: (host) => gateway.ownsHost(host),
    beforeGatewaySessionFence: () => gateway.flushSessionState(),
  });

  const migration = new MigrationService({
    spaces,
    store,
    onQueueChanged: (queue) => emit("migration:queueChanged", queue),
  });

  const credentials = new CredentialsService(tabs);

  // Reading text aloud (§8.1 Voice & audio). Owns the provider keys, so it is
  // built with the rest of this account's graph and torn down with it.
  const tts = new TtsService({ userDataDir: userData });

  // The chat sidebar's agent loop (§8.1). Credential order: environment key,
  // then the TTS service's stored Vercel key (same account-sharing the saves
  // extractor does), then — with neither — inference vended through the
  // signed-in control plane's /v1/ai/gateway proxy, keyless on this machine.
  const chat = new ChatService({
    userDataDir: userData,
    storedApiKey: () => tts.apiKeyFor("vercel"),
    vendedGatewayAvailable: () => auth.controlClient() !== null,
    vendedGatewayCredentials: async () => {
      const client = auth.controlClient();
      if (client === null) return null;
      const token = await client.getToken();
      return token === null ? null : { baseUrl: client.url, token };
    },
    browser: { spaces, tabs },
  });

  /* ------------------- Saves: smart bookmarking (double-Shift) ------------ */

  /* --------------------------- Voice assistant ---------------------------- */

  // "Suma, …" — wake word + Gemini Live session in main; the overlay
  // renderer (the same view that hosts the floating audio player, always
  // alive and layered above the pages) owns the microphone, the speakers,
  // and the HUD. Browser-tool permissions are the chat sidebar's own
  // Assistant-page toggles, read per session. Credential order mirrors the
  // chat assistant's: environment key, then a key stored on this Mac, then —
  // with neither — a single-use Live token vended by the signed-in control
  // plane, keyless on this machine.
  const voice = new VoiceService({
    userDataDir: userData,
    browser: { spaces, tabs },
    chatToolSettings: () => {
      const info = chat.settings();
      return { model: info.model, tools: info.tools };
    },
    vendedTokenAvailable: () => auth.controlClient() !== null,
    vendedToken: async () => {
      const client = auth.controlClient();
      if (client === null) return null;
      try {
        const { token } = await client.mintVoiceToken(voice.settings().model);
        return { token };
      } catch (err) {
        // Offline, an expired device token, or an operator with no Gemini
        // key configured — all mean "no vended session right now", which the
        // service reports as a recoverable error rather than a crash.
        console.error("suma voice: could not mint a vended token:", err);
        return null;
      }
    },
    emit: {
      status: (status) => {
        // Both surfaces: the overlay renders the HUD, the chrome's settings
        // page shows a live status line.
        emit("voice:statusChanged", status);
        emitPreview("voice:statusChanged", status);
      },
      transcript: (event) => emitPreview("voice:transcript", event),
      audioOut: (data) => emitPreview("voice:audioOut", { data }),
      interrupted: () => emitPreview("voice:interrupted", undefined),
    },
  });

  // Push-to-talk from anywhere on the Mac — the hands-free promise includes
  // "without focusing Suma first". Inert while the assistant is disabled.
  const VOICE_SHORTCUT = "Alt+Space";
  try {
    globalShortcut.register(VOICE_SHORTCUT, () => voice.toggleSession());
  } catch (err) {
    console.error("suma voice: could not register the shortcut:", err);
  }

  // Rides the TTS service's Vercel gateway key (read per save, so adding one
  // in settings upgrades the next save); with no key, saves still land from
  // the page's own og tags.
  const saves = new SavesService({
    userDataDir: userData,
    emitUpdated: (items) => emit("saves:updated", items),
    emitPreview: (item) => emitPreview("savePreview:item", item),
    apiKey: () => tts.apiKeyFor("vercel"),
    model: process.env["SUMA_SAVES_MODEL"] ?? null,
  });

  // Favorite sites (shared/favorites.ts) — the star in the tab and the tile
  // row under the URL bar. Plain persisted state, erased with the account.
  const favorites = new FavoritesService({
    userDataDir: userData,
    emitUpdated: (items) => emit("favorites:updated", items),
  });

  /* ------------- Saved videos: YouTube/X → cloud + PIP player ------------- */

  // Downloads with yt-dlp on this Mac (YouTube/X media URLs are credentialed,
  // so the §8.6 cloud fetcher can never take them), keeps the playback cache
  // in userData/videos, and uploads finished files into the account's cloud
  // files (R2) via the FilesService below — the `files` binding is late-bound
  // like sync/gateway above; uploads only ever run post-bootstrap.
  const videos = new VideosService({
    userDataDir: userData,
    emitUpdated: (items) => emit("videos:updated", items),
    uploadToCloud: async (args) => {
      await files.upload({
        path: args.path,
        contentType: args.contentType,
        data: args.data,
        uploadId: args.uploadId,
      });
    },
    // The cross-device paths ride the same Files plumbing: the /Videos tree
    // listing for reconcile, the manifest read-back assembly for hydration,
    // and deletion so a removed video cannot resurrect on another device.
    listCloudPaths: (prefix) => files.listPaths(prefix),
    downloadFromCloud: (cloudPath) => files.downloadBytes(cloudPath),
    removeFromCloud: (cloudPath) => files.remove(cloudPath),
  });

  /**
   * Save the active tab's video — shared by the double-Shift route and the
   * tab context menu. Opening the panel is the feedback: a gesture-triggered
   * download must never be invisible.
   */
  const saveVideoFromUrl = (url: string): void => {
    const item = videos.save(url);
    if (item !== null) emit("videos:openPanel", { videoId: item.id });
  };
  tabs.setVideoSaveHandler(saveVideoFromUrl);

  /* --------------------- Nostr signer (NIP-07, shared/nostr.ts) ----------- */

  // The signer holds the nsec (safeStorage-encrypted in nostr.json) and the
  // per-site permission rules. Its approval queue is drawn twice: cards in
  // the preview overlay, full detail in the chrome panel — so queue changes
  // fan out to both.
  const nostr = new NostrService({
    userDataDir: userData,
    emitPending: (pending) => {
      emit("nostr:pendingChanged", pending);
      emitPreview("nostr:pendingChanged", pending);
    },
    emitSettings: (info) => emit("nostr:settingsChanged", info),
    emitOpenDetail: (requestId) => emit("nostr:openDetail", { requestId }),
    // To the overlay, not the chrome: a toast in the chrome renders BELOW
    // the tab views, so over an open page nobody would ever see it.
    emitKeyMissing: (host) => emitPreview("nostr:keyMissing", { host }),
    encryptString: (plain) => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.encryptString(plain).toString("base64");
      } catch {
        return null;
      }
    },
    decryptString: (cipher) => {
      try {
        return safeStorage.decryptString(Buffer.from(cipher, "base64"));
      } catch {
        return null;
      }
    },
  });
  // (The window.nostr guest preload is registered at the top of this
  // function, before any session can exist — see the SpaceManager hook.)

  // The Buzz workspace roster (github.com/block/buzz): a snapshot fetcher
  // over the relay the settings page configures, authenticating as the
  // user's nostr key (their buzz owner identity).
  const buzz = new BuzzService({
    relayUrl: () => nostr.buzzRelayUrl(),
    signAuth: (relayUrl, challenge) => nostr.signRelayAuth(relayUrl, challenge),
    signMediaAuth: (sha256, serverHost) => nostr.signMediaAuth(sha256, serverHost),
    emitChanged: (state) => emit("nostr:buzzAgentsChanged", state),
  });

  /**
   * Save what the active tab is showing. Shared verbatim by the double-Shift
   * gesture and the panel's/IPC's explicit capture, so the two can never
   * drift. The outcome lands in the preview overlay either way — a card for
   * the item (via the service's emitPreview), or the reason nothing saved.
   */
  const captureActiveSave = async (): Promise<SavedItem | null> => {
    const failure = (error: string): null => {
      emitPreview("savePreview:error", { message: error });
      return null;
    };
    const spaceId = spaces.activeSpaceId;
    const tab =
      spaceId === null
        ? undefined
        : tabs.list(spaceId).find((entry) => entry.active);
    if (tab === undefined) return failure("Nothing to save — open a page first.");
    if (tab.url === NEW_TAB_URL || !isAllowedTabUrl(tab.url)) {
      return failure("This page can't be saved — only web pages can.");
    }
    const wc = tabs.webContentsFor(tab.id);
    if (wc === null) {
      return failure("This tab isn't loaded — reload it and save again.");
    }
    let raw: unknown = null;
    try {
      raw = await wc.executeJavaScript(CAPTURE_SCRIPT, true);
    } catch {
      // A page that refuses evaluation still saves from its URL and title.
    }
    return saves.capture(
      sanitizeCapturedPage(raw, tab.url, tab.title, tab.faviconUrl),
    );
  };

  const shiftDetector = new DoubleShiftDetector();

  /**
   * What a double-Shift means depends on the page: on a YouTube/X video page
   * with a video present it saves THE VIDEO (download → cloud), anywhere else
   * it captures the page as a saved item. One gesture, the obvious meaning.
   */
  const captureActiveTarget = async (): Promise<void> => {
    const spaceId = spaces.activeSpaceId;
    const tab =
      spaceId === null
        ? undefined
        : tabs.list(spaceId).find((entry) => entry.active);
    const info = tab === undefined ? null : canonicalVideoUrl(tab.url);
    if (tab !== undefined && info !== null) {
      // A YouTube watch page always has its video; an X status may be plain
      // text — probe for a <video> so a text post still saves as a bookmark.
      let hasVideo = true;
      if (info.source === "x") {
        const wc = tabs.webContentsFor(tab.id);
        if (wc !== null) {
          try {
            hasVideo =
              (await wc.executeJavaScript(
                "document.querySelector('video') !== null",
                true,
              )) === true;
          } catch {
            // A page that refuses evaluation still gets the video treatment —
            // the user double-Shifted on a video URL.
          }
        }
      }
      if (hasVideo) {
        saveVideoFromUrl(tab.url);
        return;
      }
    }
    await captureActiveSave();
  };

  const devices = new DeviceCollaborationService({
    device,
    store,
    spaces,
    tabs,
    suggestedName: defaultDeviceName,
    presence: () => sync.devices(),
    listRegistry: async () => (await auth.controlClient()?.listDevices()) ?? [],
    renameRegisteredDevice: (deviceId, name) =>
      auth.renameDevice(deviceId, name),
    controlAvailable: () => auth.controlClient() !== null,
  });
  deviceCollaboration = devices;

  spaces.onChanged(refreshWorkspace);

  /* ---------------- Phase 2: compute, egress, audit (§8.4, §8.5) ---------- */

  // §10: every plane-state change re-derives the health banner. Runs only
  // after bootstrap completes, so the late `sync` binding is safe here.
  function pushHealth(): void {
    emit(
      "health:changed",
      planeHealthFor(
        sync.status().state,
        egress.planeState(),
        machines.planeState(),
      ),
    );
  }

  // SUMA_AGENT_URL pins the link to a specific suma-agent (dev override,
  // e.g. `fly proxy`). Unset ⇒ start on the in-process simulator and switch
  // to the real VM the moment the control plane reports its agent address
  // (machines row → /v1/machine → onAgentAddress below).
  const agentUrl = process.env["SUMA_AGENT_URL"] ?? null;
  const link = new SwitchableAgentLink(
    agentUrl === null ? new SimAgent() : new TcpAgentClient(agentUrl),
    agentUrl,
    agentUrl !== null,
  );

  const machines = new MachineService({
    control: () => auth.controlClient(),
    emit: (status) => {
      emit("machine:changed", status);
      pushHealth();
    },
    onAgentAddress: (address) => link.setTarget(`tcp://${address}`),
  });
  const terminals = new TerminalService({
    link,
    control: () => auth.controlClient(),
    emitData: (payload) => emit("terminal:data", payload),
    emitUpdated: (list) => emit("terminal:updated", list),
  });
  const ports = new PortsService({
    link,
    emit: (list) => emit("ports:updated", list),
  });
  // The IDE half of suma://terminal (§8.5): explorer + editor over the same
  // filesystem the (sim) shells run in.
  const workspaceFs = new WorkspaceFsService(
    resolveWorkspaceRoot(app.isPackaged),
  );
  const egress = new EgressService({
    spaces,
    store,
    egressUrl: process.env["SUMA_EGRESS_URL"] ?? null,
    quicDisabledAtStartup,
    emitChanged: (status) => {
      emit("egress:changed", status);
      pushHealth();
    },
    emitBypassSuggested: (suggestion) =>
      emit("egress:bypassSuggested", suggestion),
    emitCheckoutBypassed: (event) => emit("egress:checkoutBypassed", event),
  });
  spaces.onSessionCreated((ses, spaceId) => egress.attachTo(ses, spaceId));
  const audit = new AuditService(() => auth.controlClient());

  /* ------------------------ Phase 3: Files (§8.6) ------------------------- */

  // The session and its suma://files handler are process-wide (bootstrap);
  // the window wrapper is per-account, since it carries the device id.
  const filesWindow = new FilesWindow(filesSession, device.deviceId);

  const emitFiles = <C extends EventChannel>(
    channel: C,
    payload: SumaEventMap[C],
  ): void => {
    emit(channel, payload);
    filesWindow.send(channel, payload);
  };

  const files = new FilesService({
    client: new FilesClient({
      baseUrl: () => auth.controlClient()?.url ?? null,
      token: () => auth.getToken(),
    }),
    emitTransfers: (update) => emitFiles("transfers:updated", update),
    emitChanged: (payload) => emitFiles("files:changed", payload),
    emitUploadProgress: (progress) => {
      emitFiles("files:uploadProgress", progress);
      // Video uploads ride the same chunk path; their progress feeds the
      // saved-video labels too (uploadId prefix "video:").
      videos.noteUploadProgress(progress);
    },
    downloadsDir: () => app.getPath("downloads"),
    deviceId: device.deviceId,
    identity: () => {
      const enrollment = device.enrollment();
      return {
        cloudDeviceId: enrollment.controlDeviceId,
        name: enrollment.deviceName,
      };
    },
    // Names only. The Files page gets labels for the transfers list and
    // nothing else from the device record — no platform, no revocation state,
    // no token (§8.2, §8.6).
    listDevices: async () => {
      const control = auth.controlClient();
      if (control === null) return [];
      const devices = await control.listDevices();
      return devices.map((entry) => ({ id: entry.id, name: entry.name }));
    },
  });

  // §8.6 download routing. Attaches to every space session next to the Phase-1
  // DownloadManager: the router only ever CANCELS a local download when the
  // frozen eligibility check says the URL carries no credential; everything
  // else is left to the local manager untouched.
  const alwaysLocal = createDownloadPolicyReader(userData);
  const downloadRouter = new DownloadRouter({
    cloudAvailable: () => files.cloudAvailable(),
    alwaysLocal,
    startCloudFetch: (args) =>
      files.startCloudFetch(args).catch((err: unknown) => {
        console.error("suma files:", err);
        return false; // the local download keeps going
      }),
    onDeclined: (declined) => files.noteDeclined(declined),
    requestHeaders: nativeRequestHeaders,
  });
  spaces.onSessionCreated((ses, spaceId) =>
    downloadRouter.attachTo(ses, spaceId),
  );

  /**
   * Stop this account's half of the app. `leavingAccount` distinguishes the
   * two callers: quitting leaves globally-synced tabs recorded for restore,
   * while signing out takes every tab view off the window on its way out.
   */
  const teardown = (opts: { leavingAccount: boolean }): void => {
    // Answer any pending ceremony before tearing down — an unanswered
    // select-webauthn-account leaves the page hanging.
    webauthn.cancelAll();
    offUpdates();
    glance.close();
    popups.closeAll();
    filesWindow.close();
    files.stop();
    buzz.stop();
    nostr.stop();
    saves.stop();
    videos.stop();
    chat.stopAll();
    voice.stop();
    globalShortcut.unregister(VOICE_SHORTCUT);
    tts.stop();
    ports.stop();
    machines.stop();
    egress.stop();
    gateway.stop();
    link.stop();
    sync.stop();
    // Flush to cancel the debounced write, so nothing lands after the file is
    // unlinked; on the sign-out path the file is deleted moments later.
    store.flushSync();
    if (opts.leavingAccount) tabs.destroyAll();
    // The per-space Session objects Chromium caches by partition name outlive
    // this graph, still carrying the old services' handlers. They are inert:
    // their on-disk partitions are deleted and the next account's spaces get
    // new ids, so nothing ever loads into them again.
  };

  /**
   * §8.2 sign-out: stop this account's services, wipe its local state, and
   * build a first-run graph back up on the same window. See sign-out.ts for
   * why this resets in-process instead of relaunching the app.
   */
  const signOut = (): Promise<void> =>
    performSignOut({
      userDataDir: userData,
      stopServices: () => teardown({ leavingAccount: true }),
      sessions: () => [
        ...spaces.list().map((space) => spaces.sessionFor(space.id)),
        filesSession,
        // The chrome renderer's own session — its localStorage holds the
        // theme and the split-view ratios.
        session.defaultSession,
      ],
      restart: async () => {
        // The HLC clock is module-level and still keyed to the device id that
        // was just erased; the fresh store must stamp under its own.
        resetWorkspaceHlc();
        live = await startServices(ctx);
        // Last, so the reloaded page hydrates against the new graph.
        await win.resetToChrome();
      },
    });

  registerIpc({
    chrome,
    shell: win,
    spaces,
    tabs,
    glance,
    sync,
    migration,
    webauthn,
    store,
    history,
    downloads,
    auth,
    signOut,
    credentials,
    tts,
    chat,
    voice,
    updates,
    devices,
    machines,
    terminals,
    ports,
    workspaceFs,
    egress,
    audit,
    favorites,
    nostr,
    buzz,
    saves,
    videos,
    captureActiveSave,
    files,
    filesWindow,
  });

  await sync.start(spaces.list().map((space) => space.id));
  tabs.syncVisibility();
  tabs.startDiscardPolicy();
  devices.capture();
  egress.start();
  machines.start();
  ports.start();
  files.start();
  // Videos saved on other devices: reconcile once the graph is up (and again
  // on every token refresh — see AuthService.onTokenChanged above).
  void videos.reconcileWithCloud().catch(() => undefined);

  return {
    emit,
    teardown,
    noteClientCertificate: (url) => downloadRouter.noteClientCertificate(url),
    newTab: () => {
      const active = spaces.activeSpaceId;
      if (active !== null) tabs.create({ spaceId: active });
    },
    openFiles: () => filesWindow.open(),
    openAboutSettings: () => {
      const active = spaces.activeSpaceId;
      if (active !== null)
        tabs.create({ spaceId: active, url: settingsUrl("about") });
    },
    noteKeyInput: (input) => {
      // Chromium hands the browser-side pre-handler a RawKeyDown for physical
      // presses — "keyDown" alone would miss every real keystroke.
      if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
      const triggered = shiftDetector.keyDown(
        {
          key: input.key,
          isAutoRepeat: input.isAutoRepeat === true,
          chorded:
            input.control === true ||
            input.meta === true ||
            input.alt === true,
        },
        Date.now(),
      );
      if (triggered) void captureActiveTarget();
    },
  };
}

interface MenuActions {
  newTab: () => void;
  toggleCommandBar: () => void;
  openFiles: () => void;
  checkForUpdates: () => void;
}

/** Cmd+T / Cmd+K plus standard Edit/Window roles — copy/paste must work (§8.1). */
function buildMenu(actions: MenuActions): void {
  const template: MenuItemConstructorOptions[] = [
    // The stock appMenu role, re-spelled only to slot Check for Updates…
    // where every Mac app keeps it, under About.
    ...(process.platform === "darwin"
      ? [
          {
            role: "appMenu",
            submenu: [
              { role: "about" },
              {
                label: "Check for Updates…",
                click: () => actions.checkForUpdates(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => actions.newTab(),
        },
      ],
    },
    { role: "editMenu" },
    {
      label: "Go",
      submenu: [
        {
          label: "Command Bar",
          accelerator: "CmdOrCtrl+K",
          click: () => actions.toggleCommandBar(),
        },
        {
          label: "Files",
          accelerator: "CmdOrCtrl+Shift+F",
          click: () => actions.openFiles(),
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
