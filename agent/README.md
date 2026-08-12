# agent — suma-agent (in-VM daemon)

**Status: Phase 2 implemented, plus the Phase 3 Files work. This crate is a member of the root Cargo workspace (`cargo test --workspace`); mux framing, capability-gated ctl dispatch, durable PTYs, port listing, Job Mode, public fetch, the FastCDC/BLAKE3 chunker, and the `vfs` channel are real and tested. Not yet deployed.**

`suma-agent` runs inside the user's Fly Machine (Firecracker microVM) on the
compute plane (PRD §8.5, §7). It multiplexes terminal, port-forwarding, VFS,
and control traffic over one QUIC connection to `sumad` on the client
(`sidecar/`).

## Mux channels (PRD Appendix C)

| Channel | Purpose |
|---|---|
| `ctl` | spawn/resize/kill PTY, list ports, `fetch(public_or_presigned_url)`, fs ops — every operation under a narrowly scoped capability token |
| `pty/<id>` | interactive PTY byte streams |
| `fwd/<port>` | forwarded port streams |
| `vfs` | Suma Files / `~/cloud` operations — list/stat/read/write/delete/mkdir under `fs.read`/`fs.write` |
| `log` | agent + lifecycle events |

Both channels that can reach a PTY are gated on capabilities, per frame:
`ctl` requests through the authorization table in `src/caps.rs`, and `pty/<id>`
bytes — input and any output subscription — on `pty.io`. Gating only `ctl`
would leave keystrokes ungated, since PTY bytes never pass through it.

The sealed-header fetch from PRD v1.0 is removed: `fetch` accepts public and
presigned URLs only. Authenticated downloads stay local (PRD §8.6). `fetch.public`
additionally refuses URLs containing control characters (a literal CRLF would
inject headers into its own request line, which is how a `Cookie:` header gets
back into a type that has no header field), refuses private/loopback/link-local
targets both before and after DNS (169.254.169.254 included), and caps one
download at `fetch::MAX_FETCH_BYTES`. What lands is chunked in place and the
manifest rides back on `fetch.done`, so the control plane can record the file's
chunks without the bytes leaving the VM twice.

## Files: chunking and the `vfs` channel (PRD §8.6)

`src/chunker.rs` is a port of `packages/chunking` — the FROZEN TypeScript
implementation is the source of truth. Both sides derive the same 256-entry
gear table from BLAKE3 of `suma.fastcdc.gear.v1` (rather than shipping
literals two languages could copy differently), use the same 22/18-bit masks
and 256 KiB / 1 MiB / 4 MiB bounds, and therefore cut at the same bytes. Tests
pin the gear-table fingerprint, the first table entries, and boundary offsets
read out of the TS implementation: if either side drifts, deduplication stops
working silently, so it is made to fail loudly instead.

`src/vfs.rs` serves the `vfs` channel, rooted at `~/cloud` — the one
cloud-native tree (canonical in R2). `$HOME` is a Fly volume with snapshots,
is **not** end-to-end encrypted in V1, and is not reachable through this
channel. Paths are normalized exactly as `normalizeVfsPath` does, so a `..`
that walks off the root is refused rather than clamped, and every resolved
target is re-checked against the canonical root so a symlink cannot carry a
lexically clean path outside it.

## Security posture (invariants I-1 and I-2, PRD §9)

The VM is not trusted with sessions, and V1 makes VM compromise worthless
beyond the VM:

- The **machine credential is near-zero-privilege**: it cannot enroll or
  impersonate devices, cannot write to the session plane (no path exists —
  I-1), cannot touch the identity gateway (separate plane, separate identity —
  I-3), and authorizes only its own PTY/VFS/port/fetch operations via
  capability tokens.
- **No device certs, user keys, or session material ever exist in the VM.**
- Docker stays available, with the honest consequence: root in your own dev VM
  means you can tamper with the in-guest agent — and gain nothing you don't
  already own. Rootless-container isolation is a Phase 0 spike, adopted only
  if it doesn't wreck Docker DX.

## Lifecycle — process-aware (PRD §8.5, Appendix D)

The contract is *"a terminal that survives device disconnects and ordinary
handoffs"* — not "never dies." Fly suspend applies only ≤ 2 GB with no swap,
and a suspended machine may cold-boot if its snapshot can't restore, so a
cold-start recovery path is mandatory and the UI says whether a PTY was
*resumed* or *reconstructed*.

- **Never auto-suspend while a non-shell user process tree is alive**, unless
  the user opted that workload into suspend. Silence is not idleness.
- **Job Mode:** explicit "keep running" per command/tab with a visible cost
  meter — the only supported story for long unattended jobs.
- Idle shells suspend freely; wake-on-connect p95 < 2 s.
- **Scrollback (100k lines/PTY), working directory, command history, and
  terminal metadata persist outside the memory snapshot** — cold boot loses
  the process, never the context.

The lifecycle state machine (`provisioning → running → suspending → suspended
→ resuming | cold_booting → running`, plus boost) is defined in TypeScript in
`packages/protocol/src/machine.ts` and is the source of truth the agent's Rust
port must mirror.

## Internals

portable-pty for PTYs and a port watcher for forwarding chips, per PRD §8.5.
The mux rides TCP with length-prefixed frames in this phase; the QUIC (quinn)
transport is the V2 path per PRD §8.4. Wire shapes on `ctl` mirror
`packages/protocol/src/agent.ts` — that module is the source of truth. See
`src/mux.rs`, `src/caps.rs`, `src/proto.rs`, `src/pty.rs`, `src/ports.rs`,
`src/jobs.rs`, `src/fetch.rs`, `src/chunker.rs`, `src/vfs.rs`,
`src/dispatch.rs`.
