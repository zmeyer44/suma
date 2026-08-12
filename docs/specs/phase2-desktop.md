# Spec: Phase 2 desktop — terminal, ports, egress UX, audit trail

PRD §8.1 (privileged pages), §8.4, §8.5, §8.7, §10. Extends apps/desktop.
The IPC contract in `apps/desktop/src/shared/ipc.ts` ALREADY declares every
Phase-2 channel (machine:*, terminal:*, ports:*, egress:*, audit:list, and
events machine:changed / terminal:data / terminal:updated / ports:updated /
egress:changed / egress:bypassSuggested) — implement exactly those; do NOT
edit ipc.ts.

Read first: docs/specs/desktop-main.md, phase1-desktop-main.md,
phase1-desktop-renderer.md, the current src/main/** and src/renderer/**, and
these shared modules which are the source of truth (do not reimplement):
- `@suma/protocol`: `agent.ts` (mux + ctl wire shapes, capabilities),
  `lifecycle.ts` (decideSuspend, explainVerdict, hourlyRateUsd,
  accruedCostUsd, formatHourlyRate), `machine.ts` (MachineState, canTransition).
- `@suma/egress-policy`: `decideEgress`, `proxyConfigFor`,
  `defaultSpaceEgress`, `suggestBypassOnChallenge`, `SpaceEgressConfig`,
  `NetworkContext`.

**Off-limits:** popup/permission code in tabs.ts and spaces.ts (owned
elsewhere) — do not touch `setWindowOpenHandler`, `PopupRateLimiter`,
`configureSession`'s permission handler, or `resolvePermission`.

## Main process

- `src/main/compute/machine-service.ts` — talks to the control plane via the
  existing `ControlClient` (extend it with the Phase-2 routes). Owns
  `MachineStatus`: state, spec, reason/explanation from
  `GET /v1/machine/lifecycle`, cost meter via `formatHourlyRate` +
  `accruedCostUsd`, and `reconstructed` from the latest machine event. Emits
  `machine:changed`. Implements machine:status/wake/suspend/boost. With no
  control plane configured (local-only), report a clear "not provisioned"
  state rather than throwing — Phase 1's local-only mode must keep working.
- `src/main/compute/agent-client.ts` — client for suma-agent's mux protocol
  over TCP (see `@suma/protocol` agent.ts for exact frames). Length-prefixed
  frames, channel names, JSON ctl payloads. Handles reconnect with backoff.
  When `SUMA_AGENT_URL` is unset, use an **in-process simulated agent**
  (`src/main/compute/sim-agent.ts`) that spawns a real local PTY via
  node-pty… **node-pty is NOT an installed dependency and you may not add
  deps** — so the simulator must use `child_process.spawn` with a shell and
  pipe stdio, which is enough to drive the UI end-to-end locally. Document
  that this is a local development stand-in for the VM agent, not the product
  path.
- `src/main/compute/terminal-service.ts` — PTY registry surfaced as
  `TerminalInfo[]`: create/attach/input/resize/close, Job Mode toggle
  (forwards to control's job-mode route AND the agent's `job.set`), streams
  output to the renderer via `terminal:data`, tracks `restore`
  (resumed|reconstructed) from `pty.attached`. Scrollback replay on attach.
- `src/main/compute/ports-service.ts` — polls `ports.list`, maps to
  `PortForwardInfo`, implements `ports:forward` (a local TCP listener that
  proxies to the agent's `fwd/<port>` channel; with the simulated agent,
  forward to localhost directly). Emits `ports:updated`.
- `src/main/egress/egress-service.ts` — per-space `SpaceEgressConfig`
  persisted in workspace-store; applies `proxyConfigFor` to each space session
  via `session.setProxy` **and disables QUIC when proxied** (Chromium switch
  `--disable-quic` must be appended at app startup when any space is proxied —
  do it in main/index.ts before app ready, and comment the §8.4 leak reason).
  Tracks gateway health (probe `SUMA_EGRESS_URL` health endpoint; when
  unset, gateway is "down" and every proxied space is fail-closed — which is
  the correct, honest default). Implements egress:status/setPolicy/
  browseDirectForNow/setSiteBypass/explain (the last via `decideEgress`),
  emits `egress:changed`. Watches `webRequest.onCompleted` for challenge
  status codes and emits `egress:bypassSuggested` via
  `suggestBypassOnChallenge` — suggestion only, never auto-apply.
  `browseDirectForNow` must reset when the gateway comes back (§8.4).
- `src/main/audit-service.ts` — `audit:list` proxying the control plane's
  audit API; empty list in local-only mode.
- Wire all of it in `src/main/ipc.ts` and `src/main/index.ts` alongside the
  existing services.

## Privileged page (§8.1)

`suma://terminal` runs in a hardened WebContents: no node integration,
strict CSP, and site content can never navigate into it. The existing
`privileged.ts` already blocks tab navigation to `suma://`; extend it to
serve the terminal page. Simplest correct approach given the current
architecture: render the terminal as a **renderer overlay route** (like
settings) rather than a separate WebContents, and keep `privileged.ts`'s
navigation guard as-is. If you do that, say so in a comment — do not claim a
separate hardened WebContents that does not exist.

## Renderer

xterm.js is NOT an installed dependency and you may not add one. Implement a
**self-contained terminal view** in `src/renderer/src/components/Terminal*.tsx`:
a monospace, virtualized-enough output pane fed by `terminal:data`, with
input capture (keydown → `terminal:input`), a scrollback cap, and
resize→`terminal:resize` driven by a ResizeObserver measuring character cells.
It does not need to be a full VT emulator: handle newline/carriage-return,
backspace, and strip ANSI SGR sequences for display (a small pure
`ansi.ts` + tests). Note in a comment that xterm.js + WebGL is the PRD's
target and this is the dependency-free stand-in.

Components:
- `TerminalPanel.tsx` — tab strip of `TerminalInfo`, the output pane, a
  **Job Mode toggle showing the cost meter** ("Keep running — ~$0.0X/hr while
  awake"), and a banner when `restore === "reconstructed"`: "This shell was
  restored from a cold start — your scrollback and working directory are back,
  but the process that was running is gone." (§8.5, §10 wording).
- `PortChips.tsx` — chips for detected ports with a forward toggle and the
  local URL (click → open in a tab).
- `MachinePill.tsx` — replaces the Phase-1 placeholder VM pill in
  StatusPills: state, reason/explanation, accrued cost, and wake/suspend
  actions.
- `EgressBanner.tsx` — the §8.4 fail-closed banner: "Identity gateway
  unreachable. Suma blocked these requests rather than reveal your real IP."
  with the one-click "Browse direct for now" (calls
  `egress:browseDirectForNow`), plus a toast for `egress:bypassSuggested`
  offering the per-site bypass.
- `EgressControls.tsx` — per-space toggle (identity IP vs direct), media
  bypass, and the site-bypass list; embedded in `suma://settings/privacy/egress`
  and reachable from the origin popover (§8.7).
- `settings/sections/privacy.tsx` `AuditPage` — the audit trail viewer (§8.7):
  newest-first list of `AuditEntry.summary` with timestamps and device
  attribution, at `suma://settings/privacy/audit`.
Wire new command-bar actions (Terminal, Ports, Audit log, Egress settings)
and store slices/subscriptions for every new event channel.

## Tests (pure logic only; keep Electron out of tested modules)

- `ansi.ts` stripping/parsing.
- Terminal state reducer (data → line buffer with cap; CR/LF/backspace).
- Egress service decision plumbing (pure fn mapping config+health→EgressStatus
  and the browseDirectForNow reset-on-reconnect rule).
- Port list → PortForwardInfo mapping.
- Machine status formatting (cost meter string, reconstructed banner text).
Keep all existing desktop tests green.

Verify: `pnpm --filter @suma/desktop exec tsc --noEmit -p tsconfig.node.json`,
`... -p tsconfig.web.json`, and `pnpm --filter @suma/desktop test`. Do not
run electron-vite build (the integrator does).
