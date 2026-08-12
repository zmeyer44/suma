# Phase-0 egress spike — runbook

The PRD (§8.4) makes deploying the identity egress gateway an **exit-criterion
spike**, not a build: before committing to "one dedicated IP per user," stand
up the real gateway on Fly with a static egress IP, route a test account
through it from more than one network, and measure whether the corpus origins
actually treat that account as one stable identity. This runbook is the whole
loop — deploy, mint, measure, decide, tear down.

**What already exists** (so this is wiring, not building): the gateway itself
(`services/egressgw`, blind CONNECT, MAC-checked tokens, SSRF/port policy,
content-free metering — 23 tests), a token minter
(`mint-egress-token`), the Fly image and config
(`infra/egressgw-image/`), and the measurement harness
(`infra/egressgw-spike/spike.mjs`).

## What the spike must answer

The two questions the PRD leaves open, restated as pass/fail:

1. **Does a static exit IP hold identity?** Same account, same origins, two or
   three networks (home Wi-Fi, phone hotspot, a café / VPN). If the proxied
   exit IP is constant and the corpus's challenge behavior does **not** change
   with the underlying network, the identity plane is doing its job. If origins
   still challenge when the last-mile network changes, a static IP alone is not
   enough and the design needs more (device signals, warming).
2. **Does the per-user-IP cost model survive contact with Fly?** An app-scoped
   IPv4 is **$3.60/mo**, and machines in a region pick from that region's egress
   IPs **at random** — so "one dedicated IP per user" means one **app** (or one
   pinned machine) per user, not one shared fleet. Confirm the operational shape
   and price before assuming it; the affordable alternative is IP **cohorts**
   (many users behind one IP), which trades the clean identity guarantee for
   shared-reputation risk.

## Prerequisites

- `flyctl` authenticated (`fly auth whoami`), on an org that can allocate IPv4.
- Rust 1.79 toolchain (`rustup show`) if minting tokens locally.
- A recent `curl` with the **HTTPS-proxy** feature (`curl --version | grep
  HTTPS-proxy`) — stock macOS and modern Linux curl have it. The harness needs
  it to speak to an `https://` proxy URL.

## 1 — Deploy the gateway

Build context is the **repo root** (the whole cargo workspace); the config and
Dockerfile live under `infra/egressgw-image/`.

```sh
fly apps create suma-egressgw-spike        # once
# --stage: apply on first deploy rather than restarting machines that don't
# exist yet. 32 bytes = 64 lowercase hex.
fly secrets set SUMA_EGRESS_TOKEN_SECRET=$(openssl rand -hex 32 | tr 'A-F' 'a-f') \
  --app suma-egressgw-spike --stage
# --remote-only builds on Fly's builder (no local Docker daemon needed).
fly deploy . \
  -c infra/egressgw-image/fly.toml \
  --dockerfile infra/egressgw-image/Dockerfile \
  --remote-only
```

The machine refuses to serve without the secret (there is no insecure default
off loopback — `services/egressgw/src/startup.rs`). Fly's edge terminates TLS
via `handlers = ["tls"]`, so the gateway's own cleartext CONNECT listener is
never exposed directly — clients speak CONNECT-over-TLS to
`suma-egressgw-spike.fly.dev:8443`.

**Gotcha — Fly adds a second machine for HA.** Despite `min_machines_running =
1`, the first deploy creates two machines. Two machines behind one egress IP
still share that exit IP, so identity is not broken — but scale to one anyway,
so the spike has exactly one moving part:

```sh
fly scale count 1 --app suma-egressgw-spike --yes
```

## 2 — Allocate the IPs

Two different IPs, doing opposite jobs. **Egress** (outbound) is the exit
identity the spike measures; **ingress** (inbound) is what makes `.fly.dev`
resolve so you can reach the proxy at all.

```sh
# Outbound: the static exit identity. --yes is required non-interactively.
fly ips allocate-egress --app suma-egressgw-spike -r iad --yes

# Inbound: a deploy with a [[services]] block does NOT always auto-assign a
# public ingress IP. Without one, suma-egressgw-spike.fly.dev fails to resolve
# and every probe dies at DNS (curl "Could not resolve proxy"), which looks
# like an auth failure but isn't. A shared v4 is free.
fly ips allocate-v4 --shared --app suma-egressgw-spike --yes

fly ips list --app suma-egressgw-spike       # egress v4 = the exit IP
```

One egress IP, one region, one always-on machine (`min_machines_running = 1`,
`auto_stop_machines = "off"`) is deliberate: with several egress IPs in a
region the machine picks one at random per destination, which is exactly the
ambiguity the identity spike must not have. A newly-allocated egress IP takes
5–10 minutes to bind; `fly machines restart <id>` makes it take effect sooner.

## 3 — Mint a token

The gateway keys metering on the user id inside the token. Mint one with the
same secret Fly holds:

```sh
export SUMA_EGRESS_TOKEN_SECRET=<the 64-hex secret from step 1>
cargo run -p suma-egressgw --bin mint-egress-token -- spike-user-1
# → sm-egress-v1.spike-user-1.<mac>
```

(This shared-secret minter is interim — the end state is the control plane
issuing asymmetric, expiring tokens behind the same `TokenVerifier` trait. The
spike doesn't need that; it needs one token that verifies.)

## 4 — Measure, from each network

Run this on the **same laptop** on each network in turn, changing only
`--label`. `--direct` adds an unproxied probe of every origin so each run
carries its own baseline.

```sh
node infra/egressgw-spike/spike.mjs \
  --proxy https://suma-egressgw-spike.fly.dev:8443 \
  --token "$(cargo run -q -p suma-egressgw --bin mint-egress-token -- spike-user-1)" \
  --label home-wifi --direct
```

Each run prints a per-origin table and writes
`infra/egressgw-spike/results/<label>-<timestamp>.json` (gitignored). The
harness aborts before the corpus if the proxied exit-IP probe fails (a
gateway/token problem), and flags loudly if the proxied exit IP equals the
direct one — meaning the tunnel isn't exiting where you think.

Repeat on hotspot, café/VPN, etc. Then compare across networks:

```sh
node infra/egressgw-spike/spike.mjs report infra/egressgw-spike/results/*.json
```

**Read the result this way.** The absolute challenge count is noisy — the
harness uses curl's TLS fingerprint, not Chromium's, so it under- or
over-counts what the real browser would see (recorded as a `caveat` in every
JSON file). The **signal is the deltas**: the proxied exit IP must be identical
across every run, and a given origin's proxied status should not swing as the
underlying network changes. The `report` view surfaces exactly those two
things — IP stability and per-origin divergence across networks.

### Optional: browser-fidelity confirmation

The harness closes the IP question but not the fingerprint one. To see how
Chromium (not curl) is treated on a few high-value origins (Google,
Cloudflare-fronted sites), route a real proxied Space through the gateway and
watch for challenges by hand. This is **more than one env var**, and one gap
makes it fiddly today — know it before you start:

- **`sumad`** (the sidecar's local CONNECT proxy) needs BOTH `SUMA_GATEWAY_ADDR`
  and `SUMA_GATEWAY_TOKEN`. It is deliberately fail-closed: an address with no
  token is treated as no gateway, and proxied requests get a 502 rather than
  being dialed direct.
- **The desktop** needs `SUMA_EGRESS_URL` (the health probe) pointed at the
  gateway, and the target Space flipped to `suma-ip`.

**The TLS gap.** `sumad`'s dev wiring speaks *cleartext* CONNECT to
`SUMA_GATEWAY_ADDR`, but the Fly deployment is CONNECT-*over-TLS* (Fly's edge
terminates TLS — that is what lets the gateway's own listener stay cleartext
and unexposed). `curl --proxy https://…` works because curl speaks
proxy-over-TLS natively; `sumad` does not, so pointing `SUMA_GATEWAY_ADDR` at
`suma-egressgw-spike.fly.dev:8443` will not connect. Two ways across it for the
spike:

1. **Local TLS shim** — run `stunnel` (or `socat OPENSSL`) on the laptop that
   accepts cleartext on `127.0.0.1:8443` and forwards TLS to the Fly edge, then
   set `SUMA_GATEWAY_ADDR=127.0.0.1:8443`.
2. **A dedicated cleartext port on the app** — add a second `[[services.ports]]`
   with no `handlers` and point `sumad` straight at it. Simpler to wire, but it
   publishes the unauthenticated-at-the-edge CONNECT listener on the public
   internet (token auth still applies, but the anti-SSRF edge does not), so use
   it only for a throwaway spike app and tear it down after.

Neither is needed for the curl harness. This gap closes for real once the
control plane mints and delivers egress tokens to the desktop (the "who mints
the tokens" decision) — at which point the client speaks the deployed
transport directly and no shim exists.

## 5 — Decide

- **Per-user IP, as designed** — if identity holds and $3.60/mo/user clears the
  §11 unit economics (compare against the ~$13–17 active-Pro total in
  `billing.ts`). One app per user, or a pinned machine per user.
- **IP cohorts** — if per-user IPs are too costly, put N users behind one IP.
  Cheaper, but one abusive neighbor burns the shared reputation, and the
  gateway is blind by construction, so the only abuse signal is per-user byte
  volume from the metrics. Needs cohort throttles and a rebind path (and a
  rebind is itself an identity break — the thing the product sells).
- **Not enough** — if origins still challenge when the network changes, a
  static IP alone doesn't carry identity; fold in device-integrity signals
  before committing to the plane.

Record the exit IP, the per-network challenge counts, and the decision in the
PRD §8.4 Phase-0 section.

### Runs so far

| Date | Network | Exit IP | Challenged | Divergence vs direct | Notes |
|---|---|---|---|---|---|
| 2026-08-11 | local (curl) | 209.71.102.218 (iad) | 2/20 | 0 | openai.com, claude.ai — both `cf-mitigated=challenge` on direct too, so not IP-driven. curl fingerprint; one network only. |

The zero divergence is the early signal: the two challenged origins push back on
the residential direct path identically, so their Cloudflare check is firing on
the client fingerprint, not the datacenter IP's reputation. Not conclusive —
the spike needs the same run from a hotspot and a café/VPN before the IP's
identity behavior can be judged.

## 6 — Tear down

The egress IPv4 (~$3.60/mo) and the always-on machine (~$2/mo) bill whether or
not traffic flows. `apps destroy` removes the machine and the shared ingress
IP; the egress IP must be released explicitly.

```sh
fly ips release-egress <egress-ip> --app suma-egressgw-spike
fly apps destroy suma-egressgw-spike --yes
```

## Verifying the harness without Fly

The whole pipeline runs against a loopback gateway — useful for changing the
harness itself without spending money:

```sh
SECRET=$(openssl rand -hex 32)
SUMA_EGRESS_TOKEN_SECRET=$SECRET SUMA_EGRESSGW_LISTEN=127.0.0.1:8443 \
  cargo run -p suma-egressgw &                       # loopback gateway
TOKEN=$(SUMA_EGRESS_TOKEN_SECRET=$SECRET \
  cargo run -q -p suma-egressgw --bin mint-egress-token -- spike-local)
node infra/egressgw-spike/spike.mjs \
  --proxy http://127.0.0.1:8443 --token "$TOKEN" \
  --label local-loopback --direct --limit 6
```

Loopback exits from your own IP, so the "proxied == direct" warning fires by
design — that path exercises the auth (407 on a bad MAC), tunnel, probing, and
report code, not identity. Real identity only shows up once the exit IP is
Fly's.
