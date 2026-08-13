# Spec: Phase 1 desktop renderer — onboarding, downloads, security, devices

Extends apps/desktop chrome renderer. PRD §8.1, §8.2, §8.7, §12 Phase 1. You
own src/renderer/** ONLY. Code against `window.suma` as typed in
src/shared/ipc.ts (Phase-1 channels already added). Do NOT touch main/preload/
shared. Read the current renderer (src/renderer/src/**, esp. store.ts,
App.tsx, components/\*, StatusPills.tsx, SettingsPanel.tsx, CommandBar.tsx) and
the existing design tokens in styles.css. Match the existing dark aesthetic.

The main process is being extended concurrently; render sanely on empty/
default data and never assume a Phase-1 backend is present (local-only mode is
valid — auth status "unenrolled", no downloads, etc.).

## Store (src/renderer/src/store.ts)

Add slices + subscriptions for the new event channels: downloads
(`downloads:updated`), auth (`auth:changed`), certError (`security:certError`,
keep a short-lived list), and named device presence (`devices:updated`). Add actions
wrapping the new invokes. Hydrate auth status, downloads, credential status on
mount.

## Components (src/renderer/src/components/)

- `OnboardingWizard.tsx` — first-run/enrollment flow shown when auth status is
  "unenrolled" or "signed-up" (and dismissible to try local-only). Steps:
  1. Account: email (+ optional display name) → `auth:signup`; if
     no control plane is configured (dev run with SUMA_CONTROL_URL unset),
     show "Running locally — sync is on this Mac only", hide the "Link this
     Mac" path, and let them continue.
  2. Device credential: `auth:enroll` then
     `auth:registerDeviceCredential` (default). Offer "Use a passkey instead"
     → `auth:passkeyBegin`, run `navigator.credentials.create(options)` in the
     renderer (this is the ONLY place WebAuthn runs), then
     `auth:passkeyFinish`. If passkey fails/unsupported, fall back to device
     credential with a clear message.
  3. Recovery code: if the enroll response carries `recoveryCode`, show it
     ONCE, big, copyable, with "I've saved this" required to proceed (§8.2
     shown-once). Never allow re-display.
     Progress persists across steps via auth status.
- `RecoveryPanel.tsx` (in settings) — "Recover on a new device" enter-code
  field → `auth:recoverKeys` → shows spacesRecovered.
- `DownloadsPanel.tsx` — command-bar action + a toolbar button; list
  DownloadItemInfo with progress bars (received/total), open/reveal/cancel.
  Live-updates from the store. Empty state.
- `CertErrorBanner.tsx` — when a `security:certError` arrives for the active
  tab's host, show a fail-closed banner ("Suma blocked <host>: the site's
  certificate isn't valid. For your safety there's no way to continue.").
  No override button (Phase 1 fails closed by design).
- `DevicesPanel.tsx` (in settings, replaces the stubbed device list) — list
  devices from `devices:list`, show friendly name/platform/live presence with
  only a short copyable diagnostic id, inline rename, and a Revoke action →
  `devices:revoke` → show the RevocationReceipt honestly: the affected
  third-party origins, "we stopped future Suma access but cannot end
  sessions already on that Mac," with the remote-logout links (§8.2).
- `TabStrip.tsx` — directly after Settings, show the workspace sync control.
  It is disabled while local and remote state match, and opens a
  source-aware dialog when staged workspace or session changes exist. Show
  canonical Push/Pull/Merge and Pull/Merge for distinct named-device restore
  points. Suppress a device source when its saved state matches canonical or
  this Mac, and never offer Push to another device's lane.
- `CredentialFill.tsx` — integrate into CommandBar: a "Fill password" action
  visible when `credentials:status` is available; searches
  `credentials:search(activeHost)` and on pick calls
  `credentials:fill(tabId,itemId)`. If provider is none, show the guidance
  from status.

## Wiring

- Add Downloads + Devices + Recovery entries to CommandBar and/or
  SettingsPanel. Add a downloads button and (if any cert errors) the
  banners into App.tsx's overlay layer. Keep the transparent content-hole
  layout intact — new chrome lives in the sidebar/overlays, never over the
  content hole except modal overlays (command bar already does this).
- Key-mode badge already exists; ensure it reflects auth status (E2EE when
  enrolled with device/passkey wrappers; the "Suma-managed" state is not
  used in Phase 1).

## Quality

No `any`; works with the Phase-1 backend absent (local-only). Add one or two
pure util tests only if trivially runnable in vitest node env (e.g. a
download-progress formatter in src/renderer/src/lib/). Verify:
pnpm --filter @suma/desktop exec tsc --noEmit -p tsconfig.web.json.
Do NOT run electron-vite build (main may be mid-change); the integrator does.
