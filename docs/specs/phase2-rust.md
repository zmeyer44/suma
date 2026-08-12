# Spec: Phase 2 Rust planes — egressgw, suma-agent, sumad

PRD §7, §8.4, §8.5, Appendix C. Rust 1.79 is installed and cargo can fetch
crates. Today `agent/`, `sidecar/`, and `services/egressgw/` are README +
~50-line skeletons marked "not wired to CI". Phase 2 makes them real.

## Cargo workspace (do this first)

Create a root `Cargo.toml` workspace at the repo root with members
`agent`, `sidecar`, `services/egressgw`, `resolver = "2"`, and a
`[workspace.dependencies]` block for shared crates (tokio, serde, serde_json,
anyhow, tracing). Each member's Cargo.toml uses `workspace = true` deps.
`cargo test --workspace` and `cargo clippy --workspace` must pass. Add
`target/` to .gitignore (already covered — verify).

Keep dependencies modest and mainstream: tokio, serde/serde_json, anyhow,
tracing, plus `portable-pty` for the agent. Avoid quinn/QUIC — a real QUIC
transport is out of scope for this phase; use TCP + length-prefixed framing
and document that MASQUE/QUIC is the V2 path (PRD §8.4 says exactly this).

## 1. `services/egressgw` — identity egress gateway

PRD §8.4. **Blind by construction: CONNECT-only, TLS end-to-end client↔site,
no interception, ever. Non-programmable: no user code, no shell, no config
surface beyond per-space/per-site policy from the control plane.**

- `src/main.rs` — tokio TCP listener speaking HTTP CONNECT. On `CONNECT
  host:port`, authenticate the tunnel (see below), dial the target, reply
  `200 Connection Established`, then splice bytes bidirectionally with
  `tokio::io::copy_bidirectional`. Anything that is not CONNECT gets 405 —
  the gateway is not an HTTP proxy for plaintext, and must never be one.
- `src/auth.rs` — tunnels present a bearer token in the CONNECT request's
  `Proxy-Authorization` header. Verify the token's shape and extract the user
  id; a missing/invalid token gets `407 Proxy Authentication Required`. Real
  signature verification against the control plane's key is a follow-up —
  structure it so the verification function is one seam (`TokenVerifier`
  trait) with a dev implementation, and say so in a comment.
- `src/policy.rs` — refuse to tunnel to loopback/private ranges (the gateway
  must never become an SSRF pivot into Suma's own infrastructure) and
  refuse port 25 (§9 spam-egress abuse control). Allowed ports: 443 and 80
  plus a configurable list.
- `src/metrics.rs` — per-user connection-level counters ONLY (bytes,
  duration, connection count). PRD §9 privacy posture: connection-level proxy
  logs retained 7 days, no content, no URLs. The struct must make it
  impossible to record a hostname alongside bytes — keep hostnames out of the
  metrics type entirely and comment why.
- Tests (`#[cfg(test)]` or `tests/`): CONNECT request parsing (valid,
  malformed, missing token, non-CONNECT method); policy refusals for
  loopback/private/port-25; a full loopback integration test that starts the
  gateway on an ephemeral port, points it at a local echo server, and asserts
  bytes flow through the tunnel unmodified (this proves the "blind splice"
  property).

## 2. `agent/` — suma-agent (in the VM)

PRD §8.5, Appendix C. Mux channels `ctl`, `pty/<id>`, `fwd/<port>`, `vfs`,
`log`. The machine credential is near-zero-privilege (I-2): every operation
is authorized by a capability token.

The TypeScript source of truth for the protocol is
`packages/protocol/src/agent.ts` — READ IT FIRST and mirror the JSON wire
shapes exactly (`pty.spawn`, `pty.resize`, `pty.kill`, `pty.attach`,
`job.set`, `ports.list`, `fetch.public`; responses `pty.spawned`,
`pty.attached` with `restore: "resumed" | "reconstructed"`, `pty.exited`,
`job.ack`, `ports`, `fetch.progress`, `fetch.done`, `error`). Serde structs
with `#[serde(tag = "t")]` and the same field names.

- `src/mux.rs` — length-prefixed frames over a TCP connection, each carrying
  a channel name + payload. `parse_channel` mirrors the TS `parseChannel`
  (ctl | pty/<id> | fwd/<port> | vfs | log) including its rejections.
- `src/caps.rs` — capability enum + `check_capability(claims, machine_id,
  cap, now)` mirroring the TS `checkCapability` exactly (wrong machine,
  expired, not granted, ok). This is the I-2 enforcement point: every ctl
  handler calls it and FAILS CLOSED.
- `src/pty.rs` — `portable-pty` sessions keyed by ptyId: spawn, write, resize,
  kill. Each PTY owns a **scrollback ring buffer** (cap by lines per
  `PTY_SCROLLBACK_LINES` = 100_000) persisted to disk (`$HOME/.suma/pty/<id>/`)
  alongside cwd and command history, so a **cold boot loses the process but
  never the context** (§8.5). `attach(ptyId, since_byte)` returns
  `resumed` when the live process is still in the table, `reconstructed`
  when only the persisted context was found — the client shows which.
- `src/ports.rs` — list listening TCP ports with owning process, marking
  loopback-bound ones (parse `lsof -nP -iTCP -sTCP:LISTEN` or /proc; keep it
  behind a trait so tests inject fixture output rather than shelling out).
- `src/jobs.rs` — Job Mode registry per ptyId plus a process-tree snapshot
  (`ProcessTreeInfo` equivalent: ptyId, command, shell_only, suspend_opt_in,
  job_mode) that the control plane reads to make the §8.5 suspend decision.
  Deciding is the control plane's job; the agent only reports truthfully.
- `src/fetch.rs` — `fetch.public`: download a public/presigned URL to a path,
  emitting progress. **Never accepts credentials or headers** (§8.6 — the
  sealed-header fetch was deliberately removed); the type must not have a
  header field, with a comment saying why.
- Tests: channel parsing, capability enforcement (all four outcomes),
  scrollback ring-buffer truncation + persistence round-trip, attach
  resumed-vs-reconstructed, port-list parsing from fixture text, and the ctl
  JSON wire shapes deserializing from the exact strings the TS side emits
  (paste a few literal JSON samples).

## 3. `sidecar/` — sumad (on the Mac)

PRD §7, §8.4. Local CONNECT proxy that Chromium points at, forwarding to the
identity gateway, plus the client end of the agent mux.

- `src/proxy.rs` — localhost CONNECT proxy. For each request, consult the
  egress policy (below) and either (a) tunnel to the gateway, (b) dial direct,
  or (c) **fail closed**: answer `502` with a body identifying Suma, and
  never silently go direct (beta gate).
- `src/policy.rs` — mirror the decision function in
  `packages/egress-policy/src/index.ts` (READ IT): loopback → direct, private
  → direct, VPN route → direct, space policy direct → direct, site bypass →
  direct, media bypass → direct, gateway down + override → direct, gateway
  down → **blocked**, else → gateway. Same order, same outcomes. Port the
  `is_loopback_host` / `is_private_host` classification faithfully **including
  the IPv6 case**: any IPv6 literal that is not fc00::/7 or fe80::/10 is
  PUBLIC. (A bug where the "bare hostname has no dot ⇒ LAN" heuristic
  swallowed IPv6 addresses was already caught and fixed on the TS side; do not
  reintroduce it.)
- `src/agent_client.rs` — connect to suma-agent over the mux, expose a small
  local API the desktop app will use later. Keep it thin.
- `src/cache.rs` — BLAKE3-addressed chunk cache scaffold (LRU by bytes). A
  stub with a real LRU + real hashing is fine; wire-up is Phase 3.
- Tests: the policy table (one test per branch, mirroring the TS test names),
  IPv6 public-vs-private classification, fail-closed returns 502 and NOT a
  direct dial, and a loopback integration test proving a CONNECT to a local
  echo server succeeds while a blocked decision never opens a socket.

## Verification

`cargo test --workspace` green, `cargo clippy --workspace -- -D warnings`
clean (fix warnings rather than allowing them), `cargo fmt --check`. Report
the test counts. Do NOT modify anything outside `agent/`, `sidecar/`,
`services/egressgw/`, and the root `Cargo.toml`/`.gitignore`.
