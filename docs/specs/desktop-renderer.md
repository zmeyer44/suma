# Spec: `apps/desktop` — chrome renderer (React UI)

The browser chrome: sidebar, spaces, command bar, continuity indicators,
trust controls, migration wizard (PRD §8.1, §8.7, M-0). React 19 +
Tailwind v4 + zustand. You own `src/renderer/**` ONLY. The IPC contract in
`src/shared/ipc.ts` already exists — code against `window.suma` exactly;
do not edit shared or main files. The main process implements every channel
concurrently; the UI must render sanely on empty/default data.

Design bar: this is a product demo shell, not a wireframe — dark, dense,
Arc-adjacent. Sidebar left (240px), content area right is a TRANSPARENT hole
where main overlays the tab WebContentsView: on mount and on every
resize/layout change, measure the content area (ref + ResizeObserver) and
`invoke('ui:setContentBounds', rect)`. Root background must be opaque ONLY
outside the content hole.

## Files (`src/renderer/`)

- `index.html` — root div + `/src/main.tsx` module script, CSP meta
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob: data:`
  (`media-src blob:` is what lets the audio player load a synthesized clip;
  the bytes come from main over IPC, so no third-party origin is opened up).
- `src/main.tsx`, `src/App.tsx` — layout: `Sidebar` | content hole +
  overlays (`CommandBar`, `MigrationWizard`, banners) — settings is a page
  in the content hole, not an overlay.
- `src/store.ts` — zustand store: spaces, tabs (per active space), sync
  status, health, queue, settings, overlay state. Hydrates via invokes on
  mount; subscribes to every `SumaEventMap` channel; exposes actions that
  wrap invokes (`createTab`, `selectTab`, `closeTab`, `navigate`,
  `setActiveSpace`, `togglePin`, …).
- `src/components/Sidebar.tsx` — space switcher rail (color dot + initial,
  reorderable later; click = `spaces:setActive`), new-space button; for the
  active space: URL/search field (Enter → navigate active tab or create
  one), nav back/forward/reload; **Pinned** section then **Today** section
  (both realtime-synced; pinning is presentation); each tab row: favicon,
  title, close on hover, `ContinuityDot`.
- `src/components/ContinuityDot.tsx` — per-tab origin indicator (§4): fetch
  `sync:originInfo` for the tab's host (cache per host). Green =
  portable ("Session syncs across your Macs"), amber = assisted ("One-touch
  sign-in on new devices"), gray = device_bound ("This site binds sessions
  to a device"), shield = sensitive/excluded. Tooltip includes sync tier +
  override state; click opens `OriginControls`.
- `src/components/OriginControls.tsx` — trust controls popover (§8.7):
  continuity mode, "Sync across devices / Never sync / Default" radio →
  `sync:setOriginOverride`; "Roll back this site's session" →
  `sync:rollbackOrigin` with confirm; copy explains rotating-auth origins
  use single-writer handoff.
- `src/components/CommandBar.tsx` — Cmd+K overlay (also `ui:toggleCommandBar`
  event): fuzzy list over open tabs (switch), spaces (switch), actions
  (New tab, New space, Pin/unpin, Open settings, Start migration); URL-ish
  input → navigate. Keyboard: arrows + Enter,
  Esc closes.
- `src/components/StatusPills.tsx` — bottom of sidebar: sync pill
  (connected/connecting/offline/paused + queue depth, from `SyncStatus`),
  key-mode badge ("E2EE" green / "Suma-managed keys" amber — §8.2 visible
  mode), VM pill placeholder reading `health:get` (compute plane is
  Phase 2 — show "Terminal: coming in beta" tooltip), degraded-mode banner
  strip when any plane in `health:changed` is not ok (§10 wording:
  "Sync paused — browsing continues with local state").
- `src/components/settings/` — the `suma://settings` PAGE (not an overlay;
  see `src/shared/internal-pages.ts`). `SettingsPage.tsx` is the shell,
  `SettingsNav.tsx` the drill-down sidebar (menus push, address decides which
  is open), `nav-config.tsx` the tree, `parts.tsx` the Page/Group/Row
  primitives, and `sections/*` the pages themselves: General, Appearance,
  Voice & audio, Privacy & security (sign-in, history, identity IP, audit
  trail), Account (identity, devices, sync, recovery), and Import. It replaced
  the `SettingsPanel`/`AppearancePanel`/`AuditPanel` modal stack; the store's
  `openSettings(section?)` is how every entry point reaches it.
- `src/lib/audio.ts` + `src/components/AudioDock.tsx` — the app-level audio
  player (§8.1 Voice & audio). The `HTMLAudioElement` and the playback queue
  live in the MODULE, never in the React tree, so no remount, tab switch, or
  navigation can interrupt a clip; the dock is a band in the chrome's layout
  (like the banners, so the content hole shrinks and main resizes the tab
  views) and is only a view of that module. TTS text goes to main over
  `tts:speak` and comes back as bytes — the renderer never holds an API key.
  A resolved clip's blob URL is cached on its queue entry so a replay never
  re-synthesizes. `speakText()` is the one-line entry point; the chat's
  read-aloud footer button is its first caller.
- `src/components/MigrationWizard.tsx` — M-0 flow, 3 steps:
  1. `migration:detectSources` → pick Chrome/Arc profile (bookmark counts);
  2. run `migration:import` with progress state → summary (spaces/pins/
     archives created);
  3. guided sign-in queue: ranked `SignInQueueItem` list, each with favicon
     (google s2 favicons are fine: `https://www.google.com/s2/favicons?domain=`),
     continuity badge, "Open sign-in" (creates a tab to `https://<domain>`)
     and "Done" (`migration:markSignedIn`); sensitive items carry an
     "excluded from sync" shield note. Empty state if no sources → skip.
- `src/styles.css` — Tailwind v4 (`@import "tailwindcss";` + `@theme` tokens:
  bg #0f1115, panel #161a21, accent #5b8cff, text #e6e9ef, muted #8b93a7).

## Quality bar

- No `any`, no dead props; every invoke error → non-blocking toast strip.
- Works on empty data (fresh profile): one default space, zero tabs, empty
  Today section with hint text.
- `pnpm --filter @suma/desktop check-types` and `build` must pass; add
  ONE renderer unit test only if trivially runnable in vitest node env (e.g.
  a pure fuzzy-match util `src/lib/fuzzy.ts` + test) — no jsdom setup.
