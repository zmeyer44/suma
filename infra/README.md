# infra — deployment topology

**Status: compute provisioning is implemented (`FlySandboxProvider`,
`compute-image/`); everything else remains documentation, and the other
planes are still deployed manually.**

Suma deploys as five deliberately decoupled planes (PRD §7) so each can
fail, scale, and bill independently.

| Plane | Where | What runs |
|---|---|---|
| Session | Cloudflare Workers + Durable Objects | SessionHub DO (`services/sessionhub`): sealed records, HLC registry, origin leases, device presence; hibernatable WSS |
| Identity egress | Fly Machines (per user) | `services/egressgw`: blind CONNECT-only gateway holding the user's static egress IP; no user code |
| Compute | Fly Machines (Firecracker, per user) | user env (Ubuntu 24.04, `$HOME` on NVMe volume, docker, toolchains) + `suma-agent`; separate egress identity from the browser |
| Data | Cloudflare R2 | FastCDC + BLAKE3 chunks for Files and `$HOME` snapshots; chosen for $0 egress — VFS economics die on S3 egress pricing |
| Control | Neon Postgres (via `services/control`, Hono + Drizzle) | accounts, devices, billing, machine lifecycle ops |

## Region pinning

Both the egress gateway and the compute machine pin to the user's **home
region at signup** — IP stability beats latency-while-traveling. "Gateway
stays home while compute follows the traveler" is a V2 idea; V1 keeps one
region (PRD §7).

## Gateway topology (Phase 0 spike, unresolved)

Per-user micro-machine (shared-cpu-1x / 256 MB, static IP) vs. multi-tenant
fleet with per-user IP binding. Fly's guidance currently favors app-scoped
static egress at ~$3.60/mo per IPv4; the per-user-IP operational model and
price must be revalidated before this document grows IaC (PRD §7, §15.2).

## SandboxProvider exit hatch

All compute-plane calls sit behind a `SandboxProvider` interface (PRD §7) so a
V2 migration to self-hosted Firecracker is a provider swap, not a rewrite.
Fly is used for raw Firecracker suspend/resume + volumes; DO logic is kept
portable; R2 is S3-compatible. This is the mitigation for vendor
concentration (PRD §14.9).

## Fly compute provisioning

`services/control/src/providers/fly.ts` implements the provider against the
Fly Machines API: one Fly **app per Suma machine** (`sm-c-<machineId>`),
one `home` volume mounted at `/root`, one machine booting the image built by
`compute-image/build.sh`. Deleting the app is the whole per-user teardown.

Control-plane environment:

| Variable | Meaning |
|---|---|
| `FLY_API_TOKEN` | Activates the provider; unset ⇒ recording stub, no VMs |
| `FLY_COMPUTE_IMAGE` | Image ref from `compute-image/build.sh` (required with token) |
| `FLY_ORG_SLUG` | Org owning the per-user apps (default `personal`) |
| `FLY_COMPUTE_APP_PREFIX` | App-name prefix (default `sm-c`) |
| `FLY_AGENT_PORT` | Agent listen/service port (default `2222`) |
| `FLY_VOLUME_SIZE_GB` | `$HOME` volume size (default `10`) |
| `FLY_AGENT_PUBLIC` | `1` ⇒ dedicated IPs + public `<app>.fly.dev:<port>` route |

**`FLY_AGENT_PUBLIC` is off for a reason.** The agent performs no wire
authentication yet (agent/src/main.rs module docs: the port is the trust
boundary), so the default provisions no public IP and the agent is reachable
only on the Fly private network — `fly proxy <port> -a <app>` for dev, the
sidecar tunnel later. Turning it on exposes an unauthenticated
shell-spawning daemon to the internet; do that only for a controlled test,
and expect a dedicated IPv4 to bill ~$2/mo per user.

The machine's `agent_address` is persisted on the `machines` row at
provision time and surfaced to clients via `/v1/me`.

## Unit economics

Per-user cost model (compute, gateway, static IP, volume, R2, Workers/DO,
proxied bandwidth — ≈ $13–17/mo active, ≈ $9–12 idle floor) lives in **PRD
§11** and is to be re-derived from Phase 0 data before pricing is fixed.
