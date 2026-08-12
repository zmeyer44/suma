# egressgw — identity egress gateway

**Status: Phase 2 implemented. This crate is a member of the root Cargo workspace (`cargo test --workspace`); the blind CONNECT tunnel, MAC-verified bearer tokens, SSRF/port policy, per-connection timeouts, and content-free per-user metrics are real and tested. Not yet deployed — the deploy-and-measure loop that decides the per-user-IP vs. cohort topology is [`docs/egress-spike.md`](../../docs/egress-spike.md), with Fly artifacts in [`infra/egressgw-image/`](../../infra/egressgw-image/) and the measurement harness in [`infra/egressgw-spike/`](../../infra/egressgw-spike/).**

The identity egress plane (PRD §8.4, §7). It exists to protect the one thing the
product sells that no other plane can: a **stable browser network identity**. It
is deliberately its own plane, separate from compute, so that compute abuse (a
malicious npm package, a scraper container) can never burn the browser's IP
reputation (invariant I-3, PRD §9).

## Contract

- **Blind by construction.** CONNECT-only. TLS stays end-to-end between the
  client and the site. No interception, ever. The gateway sees hostnames and
  byte counts, nothing else.
- **Non-programmable.** No user code, no shell, no config surface beyond
  per-space / per-site policy delivered through the control plane. If a feature
  request requires the gateway to understand traffic, the answer is no.
- **Own network identity.** The gateway holds the user's static egress IP. The
  compute VM has a separate egress identity and is not in the browsing path at
  all — there is no traffic path from browser to VM.
- **Region-pinned.** Gateway and compute pin to the user's home region at
  signup; IP stability beats latency-while-traveling in V1 (PRD §7).

## Data path

```
Electron session.setProxy (per space)
  → sumad localhost CONNECT proxy (sidecar/)
  → QUIC tunnel (mTLS, connection migration)
  → egressgw: blind TCP CONNECT
  → internet via the user's static IP
```

## QUIC on proxied spaces

A CONNECT proxy tunnels TCP only — Chromium will otherwise race QUIC over UDP
straight past the proxy and leak the real IP. **V1 disables QUIC/HTTP3 on
proxied spaces** (a documented performance tradeoff). MASQUE-native UDP
proxying is the V2 path (PRD Appendix E).

## Running it — and what the listener does not do

The binary refuses to start unless a token verifier is configured. There is no
default that serves traffic.

| Env var | Meaning |
|---|---|
| `SUMA_EGRESS_TOKEN_SECRET` | 64 lowercase hex characters (32 bytes). Enables `SharedSecretVerifier`: tokens are `sm-egress-v1.<user>.<mac>` with `mac = BLAKE3-keyed(secret, "sm-egress-v1.<user>")`, checked in constant time. |
| `SUMA_EGRESS_DEV_INSECURE=1` | Runs `DevTokenVerifier`, which **authenticates nothing**, and forces a loopback bind. Setting both this and the secret is a startup error. |
| `SUMA_EGRESSGW_LISTEN` | Default `0.0.0.0:8443`; `127.0.0.1:8443` under the dev opt-in, where a non-loopback value is refused. |
| `SUMA_EGRESSGW_EXTRA_PORTS` | Comma-separated extra tunnel ports. Port 25 stays refused regardless. |

Two limits stated plainly, because the gateway sits on the user's browsing
identity and §9 assumes a rooted VM may be on the same network:

- **The listener is cleartext HTTP CONNECT — it terminates no TLS and no
  mTLS.** A deployment must front it with an edge that terminates client
  authentication (or restrict the network so only that edge can reach the
  port). Binding `0.0.0.0` without one publishes a proxy on the static IP.
- **`SharedSecretVerifier` is a symmetric MAC, not the control plane's
  signature.** It authenticates the user id a tunnel is metered against and
  makes tokens unforgeable without the secret, but it carries no expiry and any
  gateway holding the secret can also mint tokens. Asymmetric verification with
  in-token expiry replaces it behind the same `TokenVerifier` trait.

## Timeouts

`server::Timeouts` bounds one connection: `head_read` (10 s) caps how long a
client may take to deliver a CONNECT head, so slowloris cannot hold tasks and
sockets open; `idle` (300 s) closes a spliced tunnel with no bytes in *either*
direction. The idle deadline is shared across directions and resets on any
traffic — a large download is not idle because the client is quiet. There is
no per-token concurrent-tunnel cap yet; abuse controls key on the metered user
id (§9).

## Policy

- **Per-space:** Work → via identity IP; Personal → direct. Per-site bypass
  with a seeded hostile-domain list and auto-suggest on challenge detection.
  Seed lists live in `packages/config/src/corpus.ts`
  (`SEEDED_HOSTILE_DOMAINS`).
- **Media-domain bypass by default** (configurable): video through the gateway
  burns money and adds nothing to identity stability. Seed list:
  `MEDIA_BYPASS_DOMAINS` in `packages/config/src/corpus.ts`.
- **Local/private traffic never proxied:** localhost, RFC1918, and corporate
  VPN routes bypass by rule; an active corporate VPN surfaces a "browsing
  direct on this network" notice.

## Failure mode

Fail-closed. On gateway loss the client shows a banner with a one-click
per-space "browse direct for now" override that resets on reconnect. **Zero
silent fallback to direct is a beta gate** (PRD §13).

## Required tests (Phase 0/2, per PRD §8.4)

- Added page-load and TTFB latency vs. direct
- First request after gateway idle
- DNS resolution through the tunnel
- WebRTC leak check (`disable_non_proxied_udp`)
- QUIC leak verification on proxied spaces
- localhost / RFC1918 / corporate-VPN bypass
- WiFi ↔ hotspot connection migration
- Intercontinental travel behavior
- Media-domain bypass behavior

## Open (Phase 0 spike)

Topology: per-user micro-machine (shared-cpu-1x / 256 MB) with a static IP vs.
a multi-tenant fleet with per-user IP binding. Fly's current guidance favors
app-scoped static egress (~$3.60/mo per IPv4) — the "one dedicated IP per user"
model and price must be revalidated, not assumed (PRD §7, §15.2).

## Layout

`src/server.rs` holds the CONNECT accept loop, the blind splice, and the
per-connection timeouts; `src/startup.rs` resolves the environment into a
serve-able configuration or refuses to start; `src/auth.rs` the `TokenVerifier`
seam (shared-secret MAC now, control-plane signature verification later);
`src/policy.rs` the SSRF/port refusals; `src/metrics.rs`
the content-free per-user counters (bytes/duration only — the type has no
field a hostname could go in). Transport is TCP in this phase; MASQUE/QUIC is
the V2 path per PRD §8.4. No `package.json` — this crate lives in the root
Cargo workspace, outside pnpm/turbo.
