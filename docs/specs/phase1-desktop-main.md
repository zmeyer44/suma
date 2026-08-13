# Spec: Phase 1 desktop main — WS sync, workspace metadata, daily-driver baseline

Extends apps/desktop main process. PRD §8.1 (daily-driver baseline), §8.2
(enrollment/recovery/revocation), §8.3 (workspace-state sync), §12 Phase 1.

Read first: docs/specs/desktop-main.md, the current src/main/\*\* (esp.
sync/service.ts, sync/transport.ts, workspace-store.ts, device.ts, ipc.ts,
tabs.ts, shell-window.ts), apps/desktop/src/shared/ipc.ts (Phase-1 channels
already added — implement them), and `@suma/protocol` (token.ts,
workspace.ts WorkspaceDoc/workspaceKeyFor/mergeLww, messages.ts
workspace.publish/hydrate frames), `@suma/sync-engine`.

**COORDINATION — off-limits:** a parallel effort owns OAuth popup handling,
`setWindowOpenHandler`, and permission-request handlers. Do NOT modify
tabs.ts's window-open/popup code or spaces.ts permission handlers. If you need
a hook there, add a separate method and leave existing popup/permission code
untouched. You own new files + the areas below.

Allowed files: everything under src/main/** EXCEPT the popup/permission code
noted above, plus src/preload/index.ts (only if a new channel needs it — the
preload is allowlist-driven and already generic, so likely no change), and
test/**.

## 1. WsTransport: finish auth + workspace frames (src/main/sync/transport.ts)

- Auth: accept an async `getToken(): Promise<string | null>` in the events/
  options. On connect, if a token is available, send it — the hub reads the
  token at the edge (HTTP upgrade), so pass it as a `Sec-WebSocket-Protocol`
  or `?token=` query param on the URL (query param is simplest and what the
  hub edge should read; coordinate: hub reads Authorization on the upgrade
  request — Node ws can't set arbitrary headers cross-impl, so use
  `?access_token=` and have consumers know the edge accepts it. Document the
  choice.). Remove the TODO(auth).
- Workspace sync frames: add `publishWorkspace(docs)`, and handle
  `workspace.records` / `workspace.hydrate.done` server frames by surfacing
  them through new events `onWorkspaceRecords` / `onWorkspaceHydrated`. On
  hello.ack also send `{t:"workspace.hydrate", sinceHlc:null}`.
- `addSpace` currently notes a reconnect is needed to redeclare spaces to the
  hub; that's acceptable — keep it, but when a token/space set changes,
  reconnect cleanly.

## 2. WorkspaceSyncService (src/main/sync/workspace-sync.ts) — NEW

Globally-synced workspace metadata (spaces, every live tab, archives, settings)
per §8.3 ownership table. Sealed like cookies (per-space? No — workspace docs
are account-global; seal under a dedicated **account workspace key** derived
from a stable per-account secret). Add to device.ts a
`workspaceSecret()` (32 random bytes persisted like space secrets) and derive
`deriveSpaceKeys("__workspace__", secret)` reuse for seal/id, OR add a small
`deriveWorkspaceKey`. Keep it simple: reuse deriveSpaceKeys with a fixed
pseudo-space id "**workspace**".

- Maps WorkspaceStore state → `WorkspaceDoc`s (workspaceKeyFor for keys),
  seals each doc value, stamps HLC from a module HlcClock (deviceId), signs
  with the device key, and calls transport.publishWorkspace on local change
  (debounced). Live tab presence, URL, and order are independent registers so
  concurrent field edits merge during an explicit Merge. Active focus and
  split focus remain local between sync operations.
- Device activity carries encrypted friendly identity metadata. Tab/focus
  writes stay local and automatically publish one atomic sealed snapshot under
  `device-workspace:<deviceId>`. Canonical tab keys are written only by an
  explicit Push/Merge (plus one-time empty-account bootstrap). Pull/Merge may
  target canonical or a peer snapshot; peers never write another device lane.
- A newly linked account automatically replaces local tabs/focus with the
  canonical snapshot. Accounts predating canonical records fall back once to
  the newest peer snapshot and promote it to canonical. The initialization
  marker is account-scoped so pre-link loopback startup cannot suppress this.
- On `onWorkspaceRecords`: open sealed values, mergeLww against local, and
  apply winners into WorkspaceStore (spaces/pins/archives/settings). Emit
  `spaces:updated` so the renderer refreshes. Guard against echo: applying a
  remote workspace change must not immediately republish it (tag like the
  cookie engine — a simple "applying" flag + value-equality check is fine).
- Conflict: LWW+HLC (mergeLww from protocol). Ownership rules enforced by
  only ever auto-publishing global categories and the current device snapshot.

Wire it into SyncService.start/stop and the existing IPC that mutates spaces/
pins/settings so those changes publish.

## 3. Device collaboration (src/main/device-collaboration.ts)

Join the control-plane device registry (friendly name/platform/revocation)
with SessionHub's live presence (online/last-seen). Publish encrypted friendly
identity metadata per device. The retired `handoff:*` snapshot records are
ignored during hydration; tab/focus collaboration is governed by the
workspace attachment state instead.

## 4. Downloads (src/main/downloads.ts) — NEW

§8.1 downloads/uploads baseline (local; the cloud-fetch fast path is Files/
Phase 3 — keep local only here). Attach `session.on('will-download')` per
space session in SpaceManager's session setup (add a hook method to
SpaceManager that downloads.ts registers — do not touch permission code).
Track DownloadItemInfo, push `downloads:updated`, implement list/open/reveal/
cancel via shell.openPath / shell.showItemInFolder / item.cancel. Persist
completed-download metadata in workspace-store (new list) so the panel
survives restart.

## 5. Certificate errors (src/main/security.ts) — NEW

§8.1 certificate-error UI. Listen to `app.on('certificate-error')` (and/or
`ses.setCertificateVerifyProc`) — in Phase 1 Suma FAILS CLOSED (no
click-through): keep the default reject, and emit `security:certError`
{host,url,error} so the renderer shows a banner. No override channel exists
by design (documented).

## 6. Crash recovery + tab discard + session restore (src/main/tabs.ts additions)

§8.1 crash recovery & tab discard, and "restore where you left off":

- Listen to each tab webContents `render-process-gone` → mark TabInfo.crashed,
  push tabs:updated; on `tabs:select`/`tabs:reload` of a crashed tab, recreate
  the WebContentsView at the same URL and clear crashed.
- Tab discard: a method `discardTab(tabId)` that destroys a background tab's
  WebContentsView but keeps its URL/title (TabInfo.discarded=true); reviving
  on select recreates it. Provide a simple policy hook (e.g. discard tabs not
  touched in 30 min) but keep it conservative/off by default with a constant.
- Session restore: materialize every live tab from its encrypted presence,
  URL, and order winners. One-time migration promotes legacy pinned and
  device-local Today state into those registers.
- Add IPC `tabs:print` (webContents.print) and `tabs:toggleDevTools`
  (webContents.openDevTools/closeDevTools) — trivial.
  This section must not touch setWindowOpenHandler / popup logic.

## 7. Auth + enrollment (src/main/auth-service.ts + control-client.ts) — NEW

- `ControlClient` (control-client.ts): typed fetch wrapper over
  `SUMA_CONTROL_URL` (default http://localhost:8787). Methods for signup,
  device-credential register/login, token refresh, spaces wrappers, recovery,
  device revoke. Holds the current device token, refreshes it proactively
  before exp (schedule at exp - 60s) and on 401. Exposes `getToken()` for the
  WsTransport.
- `AuthService` (auth-service.ts): implements the `auth:*` IPC. Default flow
  uses the **device-key credential** path (the device already has an Ed25519
  identity in device.ts) — signup, then registerDeviceCredential, then it's
  enrolled and the WsTransport gets a real token. `auth:passkeyBegin/Finish`
  forward WebAuthn options to the renderer (renderer calls
  navigator.credentials) — but since main can't run WebAuthn, these just
  proxy control's begin/finish; if WebAuthn isn't wired end-to-end, return a
  clear "not available on this device, using device key" status and keep the
  device-key path authoritative. `auth:recoverKeys` fetches recovery wrapper
  - unwraps space secrets client-side (uses protocol deriveKekFromRecoveryCode
  - unwrapRootSecret) and stores them via device.ts. `devices:revoke` calls
    control and returns the RevocationReceipt.
- Enrollment status persisted in workspace-store/device.ts; emit
  `auth:changed`.
- If `SUMA_CONTROL_URL` is unset **in a dev run**, AuthService runs in
  "local-only" mode (packaged builds fall back to `PROD_CONTROL_URL`,
  https://api.sumabrowser.com, since a `.app` inherits no shell env):
  status unenrolled, sync uses LoopbackTransport (current default). Everything
  must still work offline/local with no control plane — Phase 1 must not break
  the local dev experience.

## 8. Credentials — 1Password CLI bridge (src/main/credentials.ts) — NEW

PRD §8.1 ship-blocker: one password path. Implement the **1Password CLI**
(`op`) bridge (option 1 in §8.1): `credentials:status` checks `op --version`
(spawn, no auth prompt) → available/detail. `credentials:search` runs
`op item list --format json` filtered by host (guard: only when signed in;
never store the vault). `credentials:fill` injects username+password into the
focused login form of the tab via `webContents.executeJavaScript` on the
active tab (find password input + its form's text/email input, set values +
dispatch input events). If `op` is absent, status = none with guidance; the
feature degrades gracefully. This is best-effort automation, clearly scoped —
comment that native-messaging/SDK is the eventual path.

## Tests (vitest, pure logic only — no Electron/network in tests)

Keep Electron/`op`/fetch out of tested modules (put pure logic in helpers):

- workspace-sync: WorkspaceStore state ⇄ WorkspaceDoc mapping + LWW merge
  decision (pure function taking local+remote docs → winners) — echo
  suppression (applying a remote doc yields no outbound doc).
- device collaboration: registry/presence/activity merging, alias handling,
  and readable Computer Name fallbacks.
- downloads: DownloadItemInfo state-machine reducer (events → item list).
- token refresh scheduling: pure "should refresh now?" given exp/now.
- credentials: host→op-filter query building and the fill-script generation
  (pure string), not execution.
  Keep existing desktop tests (61) green. Verify:
  pnpm --filter @suma/desktop exec tsc --noEmit -p tsconfig.node.json &&
  pnpm --filter @suma/desktop test. Do NOT run electron-vite build if the
  renderer is mid-change; the integrator runs the full build.
