---
name: run-desktop
description: Build, run, and drive the Suma Electron desktop app. Use when asked to start the desktop app, take a screenshot of it, validate a UI change live, or interact with its windows, tabs, overlays, or onboarding.
---

Suma's desktop shell is an Electron app (electron-vite, stock Electron in
dev). For agent/automated use, drive it via the Playwright REPL at
`.claude/skills/run-desktop/driver.mjs`. The UI is NOT one web page: a
BaseWindow hosts a chrome WebContentsView with tab WebContentsViews layered
ABOVE it — the driver's commands are built around that.

All paths are relative to `apps/desktop/`.

## Build

```bash
pnpm build        # electron-vite build → out/ (the driver launches out/main/index.js)
```

Rebuild after every main/renderer change — the driver runs the built output,
not the dev server.

## Run (agent path)

Wrap in tmux; macOS has no `timeout` command, so poll with a shell loop:

```bash
tmux new-session -d -s suma -x 210 -y 50
tmux send-keys -t suma 'cd apps/desktop && SUMA_CONTROL_URL=http://127.0.0.1:8790 node .claude/skills/run-desktop/driver.mjs' Enter
i=0; while ! tmux capture-pane -t suma -p | grep -q "driver>"; do sleep 0.5; i=$((i+1)); [ $i -ge 30 ] && break; done
tmux send-keys -t suma 'launch' Enter
i=0; while ! tmux capture-pane -t suma -p | grep -q "launched\."; do sleep 0.5; i=$((i+1)); [ $i -ge 120 ] && break; done
tmux send-keys -t suma 'sscomp first-look' Enter
tmux capture-pane -t suma -p | tail -5
```

Screenshots land in `/tmp/suma-shots/` (override: `SCREENSHOT_DIR`). The
window appears headed on the user's screen — that is expected.

Omit `SUMA_CONTROL_URL` for local-only mode. For control-plane flows, start
one first: `cd services/control && DATABASE_URL=pglite OBJECT_STORE=stub
SUMA_INVITES_REQUIRED=0 PORT=8790 pnpm exec tsx src/server.ts` (set
`SUMA_INVITES_REQUIRED=1 INVITE_ADMIN_TOKEN=<secret>` to exercise the §11
invite gate; mint codes via `POST /v1/admin/invites`).

### Commands

| command | what it does |
|---|---|
| `launch` | launch the built app, wait for the chrome page |
| `ss [name]` | CDP screenshot of the chrome renderer only |
| `sscomp [name]` | **composited window** (chrome + tab views + overlays) — use this for anything visual |
| `click <css-sel>` | DOM click (never coordinates — see Gotchas) |
| `click-text <text>` | click button/link by visible text |
| `hover <css-sel>` | real pointer move to the element — the only way to trigger CSS `:hover` (chrome/strip only, see Gotchas) |
| `fill <sel> <text>` | focus element, type real key events |
| `setval <sel> <text>` | set a React input via native setter + input event |
| `type <text>` / `press <key>` | raw keyboard to the chrome page |
| `text [sel]` | innerText of the chrome page / element |
| `eval <js>` | evaluate in the chrome page, print JSON |
| `windows` | list every page + webContents (find tabs, suma://files) |
| `sleep <ms>` | wait |
| `quit` | close app, exit REPL |

## Run (human path)

```bash
pnpm dev   # electron-vite dev with HMR; opens the window. Ctrl-C to quit.
```

## Gotchas

- **The driver uses a scratch profile — by accident, and usefully.** The raw
  Electron binary keeps the default app name "Electron", so userData is
  `~/Library/Application Support/Electron`, NOT the developer's real profile
  (`pnpm dev` runs under electron-vite, which applies the name and uses
  `.../@suma/desktop`). Driver flows that sign up, enroll, or open tabs
  never touch real dev state. `$HOME` cannot move userData (Electron resolves
  `~/Library` via the OS user record). To reset driver state between flows,
  delete `device.json` + `workspace.json` from the Electron scratch dir —
  never from `@suma/desktop`.
- **The driver shows the REAL appearance setting.** Playwright emulates
  `prefers-color-scheme: light` by default, which would pin the chrome to a
  light palette regardless of this Mac or of `nativeTheme` — the renderer picks
  its default theme from that query (lib/theme.ts). `launch` passes
  `colorScheme: null` to turn the emulation off. To exercise the other scheme
  without touching System Settings, `eval
  window.suma.invoke("ui:setColorScheme",{scheme:"dark"})` — the chrome
  repaints exactly as it would on an OS flip — then `{scheme:"system"}` to
  hand it back.
- **Coordinates lie; the DOM doesn't.** Tab content and chrome are separate
  WebContentsViews; Playwright's `locator.click()` computes window
  coordinates that hit the wrong layer. `click`/`click-text` use DOM
  `.click()` instead. Works on hover-only controls too (e.g. the sidebar
  split/close buttons) — a JS `.click()` ignores `pointer-events: none`, so it
  reaches a control a real user would have to reveal first.
- **`hover` is the exception, and it does use coordinates.** CSS `:hover`
  ignores synthetic events, so nothing DOM-based can test a hover-revealed
  affordance; `hover` moves the real mouse to the element's center. That is
  only trustworthy over the CHROME (tab strip, sidebars, modals) — the part no
  tab view covers. Over page content the coordinates hit the wrong layer, per
  the rule above.
- **`ss` shows only the chrome.** Site content, split view, and the layered
  result live in other views — use `sscomp`, which captures each view via
  Chromium's compositor and reassembles them (no macOS screen-recording
  permission needed; `screencapture -l` fails without it).
- **React inputs may ignore `type`.** If keyboard focus isn't where you
  expect, `fill` types into the void. `setval` (native value setter +
  `input` event) always lands.
- **Command bar shows top 10 matches.** `click-text` on an action that isn't
  ranked visible will NOT_FOUND — `setval input[aria-label^=Command] <query>`
  first to filter, then click.
- **No spaces in selectors.** `fill`/`setval` split selector from text at the
  FIRST space, so `input[placeholder^="Search tabs"]` silently truncates and
  the text lands in whatever was focused. Use prefix matches on space-free
  values: `input[aria-label^=Command]`, `input[aria-label^=Address]`.
- **The address field is a modal, not part of the tab.** The active tab shows
  its URL as a button (`button[aria-label^=Edit]`, visible on hover); clicking
  it or `press Meta+l` opens the URL bar, and only then does
  `input[aria-label^=Address]` exist.
- **Single-instance lock / leaked instances.** If `launch` hangs or state
  looks stale, check `pgrep -fl out/main/index.js` for an Electron left over
  from a previous driver run and kill it.
- **Quit before relaunching.** Killing the tmux session kills the driver
  without flushing the app's debounced state writes; send `quit` first.
- **Two instances at once (relay testing).** Dev builds honor `SUMA_USER_DATA`
  (ignored when packaged): give each instance its own profile dir and
  screenshot dir, e.g. session A `SUMA_USER_DATA=/tmp/suma-home
  SCREENSHOT_DIR=/tmp/suma-shots-home`, session B `SUMA_USER_DATA=/tmp/suma-away
  SCREENSHOT_DIR=/tmp/suma-shots-away`, both with the same `SUMA_CONTROL_URL`.
  The single-instance lock lives under userData, so distinct dirs coexist.
  Onboard A as local-mode (home), enroll B via an enrollment code — B becomes
  the "away" device reaching A through the control plane relay.
