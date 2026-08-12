# Spec: `apps/desktop` — main process + preload

Electron main process for the minimal daily-driver shell (PRD §8.1). Owns
windows, per-space partitions, tab WebContentsViews, cookie capture/hydration
via `@suma/sync-engine`, migration (M-0), and the typed IPC surface defined
in `src/shared/ipc.ts` (already written — implement EXACTLY that contract;
do not edit ipc.ts except to fix a real inconsistency).

Scaffold (package.json, electron.vite.config.ts, tsconfigs) already exists —
do not change deps. You own `src/main/**`, `src/preload/**`, `test/**`.
Renderer (`src/renderer/**`) is being written concurrently against the same
IPC contract — do not create files there.

## Files

- `src/main/index.ts` — app bootstrap: singleton lock, create
  `ShellWindow`, register `suma://` privileged protocol
  (`privileged.ts`), init `SpaceManager` + `SyncService` + `MigrationService`,
  wire IPC (`ipc.ts`), Cmd+T new tab / Cmd+K command bar accelerators via
  Menu with standard Edit/Window roles (copy/paste must work).
- `src/main/shell-window.ts` — `BaseWindow` (hiddenInset titlebar, dark
  scheme). One `WebContentsView` for the chrome renderer (preload attached,
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`),
  sized to full window. Tab views are attached ABOVE the chrome view and
  positioned from renderer-reported `ui:setContentBounds` (persist last
  bounds; reapply on resize using ratios? No — renderer re-reports on
  resize; also reapply last absolute bounds on window resize immediately to
  avoid flicker).
- `src/main/spaces.ts` — `SpaceManager`: space CRUD backed by
  `workspace-store.ts`; per-space Electron session
  `session.fromPartition('persist:space-<id>')`; on first creation of each
  space session: disable QUIC hint comment (egress plane is Phase 2 — leave
  a TODO referencing §8.4), set permission-request handler DENYING
  camera/mic/screen unless the request comes from a tab in that space and
  the user approved via dialog (use `dialog.showMessageBox`; remember per
  (origin, permission) in workspace store).
- `src/main/tabs.ts` — `TabManager`: create/close/select/navigate per space;
  each tab a `WebContentsView({ webPreferences: { session: space session,
contextIsolation: true, sandbox: true, nodeIntegration: false } })`.
  Track title/favicon/loading/canGoBack via webContents events; push
  `tabs:updated` after every change. `window.open` → new tab in same space
  (`setWindowOpenHandler`); deny `suma://` navigation from web content
  (`will-navigate` + `will-redirect` guard: only http/https allowed in tabs).
  Presence, URL, order, and active/split focus changes remain local while an
  atomic encrypted restore point auto-saves under this device's own key.
  Canonical changes only through explicit Push/Merge. The sync control can
  Pull/Merge canonical or a distinct peer-device restore point; first-link
  hydration inherits canonical tabs automatically after session hydration.
- `src/main/workspace-store.ts` — JSON persistence in
  `app.getPath('userData')/workspace.json`: spaces, live tab field registers, pinned tabs, per-origin
  overrides, settings, sign-in queue state, permission grants. Debounced
  writes; `WorkspaceDoc` LWW records kept alongside for future hub sync with
  HLC from a module-level `HlcClock` (deviceId from `device.ts`).
- `src/main/device.ts` — device identity: on first run generate Ed25519 pair
  (`generateDeviceKeypair`), store JWK-exported private key in
  `userData/device.json` chmod 600 with TODO(keychain: move to
  safeStorage/Secure Enclave). Stable deviceId = uuid. Also generates/loads
  per-space root secrets (`generateSpaceRootSecret`) in the same file with
  the same TODO — Phase 1 wires passkey-PRF wrappers via control plane.
- `src/main/sync/service.ts` — `SyncService`: per space, build
  `SpaceSyncEngine` with:
  - applier: `ElectronCookieApplier` (`cookie-applier.ts`) mapping
    `CookiePlain` → `session.cookies.set/remove` (url reconstructed from
    hostKey/path/secure; domain omitted for host-only cookies; expirationDate
    seconds; sameSite mapping chromium↔protocol).
  - transport: `LoopbackTransport` (`transport.ts`) — in-process stub hub
    implementing `SyncTransport` against an in-memory record store, so the
    engine runs end-to-end today; `WsTransport` skeleton (connect/backoff,
    parseServerMessage, TODO auth) targeting sessionhub for
    `SUMA_HUB_URL`-set environments. Status events → `sync:statusChanged`.
- `src/main/sync/capture.ts` — subscribe `session.cookies.on('changed')` per
  space session; map Electron `cookie`+`cause`+`removed` →
  `engine.localChange(identity, attrs, removed, cause)`. Identity mapping:
  hostKey = cookie.domain as-is (Electron preserves leading dot), path,
  name, partitionKey: '' (Electron cookies API is unpartitioned in v0 —
  documented limitation), sourceScheme from cookie.secure ? 'secure' :
  'nonsecure'. Skip capture entirely while `engine.hydrating` (echo tags).
- `src/main/privileged.ts` — register `suma://` via
  `protocol.handle` in a DEDICATED session (`persist:privileged`), serving
  only known pages from renderer-built HTML? No — `suma://settings` is a
  RENDERER ROUTE: a real tab whose WebContentsView never loads, with the
  chrome view painting the page into that pane of the content hole
  (`src/shared/internal-pages.ts`, `tab-policy.ts#isAllowedTabTarget`).
  `privileged.ts` instead: (a) blocks any SITE-INITIATED tab navigation to
  `suma://` — an internal page is somewhere Suma can send you, never
  somewhere a page can send itself — (b) strict CSP
  header injection for the chrome view via
  `session.defaultSession.webRequest.onHeadersReceived` in dev. Keep small
  and honest with §8.1 comments.
- `src/main/migration.ts` — `MigrationService` (M-0): detect Chrome/Arc
  profiles (`~/Library/Application Support/Google/Chrome/*/Bookmarks`,
  `~/Library/Application Support/Arc/User Data/*/Bookmarks`), parse via pure
  functions in `src/main/migration/parse.ts` (unit-testable: takes JSON,
  returns `{folders, bookmarks}`); import → create one space per top-level
  bookmark-bar folder (max 5) + pinned tabs for its first 10 bookmarks +
  everything else archived; build sign-in queue = corpus origins present in
  bookmarks (ranked by bookmark count), sensitive origins flagged, top 12.
  Session import (cookie copy from Chrome's encrypted store) is a Phase 0
  spike → NOT implemented; `detectSources` works fully.
- `src/main/audio/tts-service.ts` — `TtsService` (§8.1 Voice & audio): text →
  audio bytes for the renderer's player, so a provider API key never leaves
  this process and the chrome page's CSP never has to allow an API origin.
  Five providers, all returning a real audio file: macOS `say(1)` rendered to
  a WAV (offline, free — chosen over the renderer's `speechSynthesis`, which
  has no duration and cannot seek), OpenAI, ElevenLabs, the Vercel AI
  Gateway (`VERCEL_GATEWAY_API_KEY`, or Vercel's own `AI_GATEWAY_API_KEY`) —
  whose speech endpoint is its own shape: the model rides in an `ai-model-id`
  header, the protocol and model-spec versions are negotiated in headers the
  published cURL example omits (without them it refuses outright), and the
  audio comes back base64 inside JSON — and Bland (`BLAND_API_KEY`), on its
  OpenAI-compatible `/v2/audio/speech` rather than the native `/v2/tts`
  because that one answers with mp3 where the native one emits PCM or WAV.
  Bland's voice list is an ACCOUNT's, not a catalog (clones and library voices,
  ~1000 of them on a real key), so it is fetched from `/v1/voices`, cached per
  key, sorted built-ins first, and falls back to the three shipped built-ins on
  any failure. Settings live in
  `tts.json` beside workspace.json, chmod 600, device-local, and listed in
  `LOCAL_STATE_FILES` so sign-out erases them. Pure logic — settings parsing,
  key resolution (env beats stored), `say` argv, `say -v ?` parsing, request
  shapes, error-message extraction — is in `src/main/audio/tts-core.ts`
  (unit-tested; the same split as credentials-core.ts).
- `src/main/ipc.ts` — `registerIpc(deps)`: every `SumaInvokeMap` channel
  with zod-free structural validation (trust preload allowlist), thin
  delegation to managers. Push events via `chromeView.webContents.send`.
- `src/preload/index.ts` — `contextBridge.exposeInMainWorld('suma', api)`:
  `invoke` allowlisted against `INVOKE_CHANNELS`, `on` allowlisted against
  `EVENT_CHANNELS` returning unsubscribe. Nothing else exposed.

## Tests (vitest, pure logic only — no Electron in tests)

- `test/migration-parse.test.ts` — Chrome Bookmarks JSON fixture → folders/
  bookmarks; malformed input; sign-in queue ranking with corpus overlap +
  sensitive flagging.
- `test/cookie-mapping.test.ts` — Electron cookie event ⇄ CookieIdentity/
  CookieAttributes mapping: leading-dot domain preserved, host-only when no
  dot, session vs persistent (expirationDate absence), sameSite mapping
  both directions, url reconstruction for set/remove.
- `test/tab-policy.test.ts` — navigation guard pure fn: http/https allowed,
  suma://, file://, chrome:// blocked for tabs.
- `test/tts-core.test.ts` — settings round trip (a stored key is written to a
  chmod-600 file and never reported back), env key outranking a stored one,
  `say -v ?` parsing (names with spaces and suffixes), `say` argv (text via a
  file, never argv), both providers' request shapes, and provider error
  messages relayed verbatim.

Electron APIs must be imported only in files not imported by tests (keep
mapping/parse/guard functions in pure modules).
