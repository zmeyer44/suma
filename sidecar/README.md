# sidecar — sumad (client daemon)

**Status: Phase 2 implemented, plus Phase 3 Files hydration. This crate is a member of the root Cargo workspace (`cargo test --workspace`); the local CONNECT proxy with fail-closed egress policy, the agent mux client, the BLAKE3 chunk cache, and manifest-driven hydration are real and tested. The R2-backed chunk source is not written yet — hydration takes one as a trait. Not yet shipped.**

`sumad` is the Rust daemon that runs on the user's Mac under launchd,
alongside Suma.app (PRD §7). It owns everything on the client that is not
UI:

1. **Local CONNECT proxy.** Electron points each proxied space at
   `sumad` via `session.setProxy`; sumad forwards CONNECT requests over a
   QUIC tunnel (mTLS with the enrolled device cert) to the identity egress
   gateway (`services/egressgw/`). Per-space policy decides proxy vs. direct;
   media domains and local/private ranges bypass by rule; failure is
   fail-closed with a client-visible event (PRD §8.4).
2. **QUIC connection migration.** WiFi → hotspot flips survive without
   dropping tunnels — this is why the tunnel is QUIC, not TCP.
3. **Mux to suma-agent.** A second QUIC connection to the compute VM carries
   the `ctl` / `pty/<id>` / `fwd/<port>` / `vfs` / `log` channels (see
   `agent/README.md`), giving the terminal UI its reattach-in-under-2s path
   and powering port-forwarding chips.
4. **Chunk cache and hydration.** A BLAKE3-addressed, LRU local cache for
   Files: downloads land in R2 as FastCDC/BLAKE3 chunks and hydrate locally
   through this cache only when opened (PRD §7, §8.6). `hydrate` rebuilds a
   file from its manifest, taking what the cache holds and asking a
   `ChunkSource` for the rest; every chunk is checked against its own address
   before it is cached, and the assembled file against the manifest's file
   hash before it is renamed into place. Chunk addresses agree with
   `packages/chunking` — the same content produces the same key in both
   languages, or deduplication silently stops working.

## What sumad is not

- It is not in the session-sync path. Cookies and workspace state flow
  Suma.app ↔ SessionHub DO over WSS; sumad never sees session material
  beyond proxying opaque TLS bytes (I-1).
- It is not a general VPN. Only Suma space traffic configured for the
  identity IP goes through it.

## Configuration and logging

- `SUMA_PROXY_LISTEN` (default `127.0.0.1:7890`), `SUMA_GATEWAY_ADDR` +
  `SUMA_GATEWAY_TOKEN` (both required, or the link counts as absent), and
  `SUMA_EGRESS_DIRECT_OVERRIDE=1` for the one-click "browse direct for now"
  override.
- **An unconfigured sumad fails closed.** Only spaces the user asked to route
  through the identity IP are ever pointed at this proxy, so with no gateway
  link the daemon answers `502` — it never falls back to a direct dial from the
  user's real IP (PRD §8.4 beta gate).
- **Logs contain no hostnames.** The routing decision is logged by *reason*
  only, at every level. §9 promises no browsing-content telemetry, and a
  hostname-per-request debug log is a browsing history in a file.

## Layout

`src/proxy.rs` is the local CONNECT proxy (fail-closed: a blocked decision
answers 502 and never dials). `src/policy.rs` mirrors
`packages/egress-policy/src/index.ts` — the source of truth for routing
decisions. `src/agent_client.rs` is the thin mux client; `src/cache.rs` the
BLAKE3-addressed LRU chunk cache and the hydration path built on it.
Transport is TCP in this phase;
the QUIC tunnel (mTLS, connection migration) is the V2 path per PRD §8.4. No
`package.json` — this crate lives in the root Cargo workspace, outside
pnpm/turbo.
