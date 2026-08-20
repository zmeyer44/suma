# Deployment runbook

What runs where, when each piece needs a redeploy, and the exact commands.
This reflects the staging topology that is live today; secrets are named but
never written down here — they live in Railway variables, Cloudflare Worker
secrets, and the repo-root `.env` (gitignored).

| Component | Where | Live at | Redeploy when |
|---|---|---|---|
| SessionHub (Worker + Durable Object) | Cloudflare Workers | `https://suma-sessionhub.zmmeyer44.workers.dev` | `services/sessionhub/**` or `packages/protocol/**` changes |
| Control plane | Railway (project "Suma", service `control`) | `https://control-production-c40c.up.railway.app` | `services/control/**`, `packages/protocol/**`, or `packages/config/**` changes (control derives the revoke-affected origin list from `SEED_CORPUS`) |
| Postgres | Railway plugin (`Suma DB`) | `postgres.railway.internal` (private) | never manually — schema is applied by control at boot |
| Desktop | Each Mac, from this repo | — | any `apps/desktop/**`, `packages/**` change; rebuild locally |
| Rust planes (`services/egressgw`, `agent`, `sidecar`) | — | not deployed | not needed for session/gateway testing |
| R2 (Files data plane) | Cloudflare R2 | bucket `auto` | only needed for Files tests; control runs `OBJECT_STORE=stub` otherwise |

The Worker origin does double duty: the hub WebSocket (`/v1/hub/ws`) and the
HTTP session gateway (`/v1/gateway/*`) share it. The control plane's `/v1/me`
serves `SUMA_HUB_PUBLIC_URL` to desktops, and the desktop derives the
gateway origin from that URL — production desktops need no gateway env vars.

## Prerequisites

- `pnpm install` at the repo root (wrangler is a `services/sessionhub` dev
  dependency; there is no global install).
- Cloudflare: `cd services/sessionhub && pnpm exec wrangler whoami` must show
  the account. `pnpm exec wrangler login` if not.
- Railway: `railway status` must show project **Suma** with service
  **control** linked (`railway link` if not).

## One-time setup (already done — repeat only for a new environment)

Generate the control-plane token signing keypair and store both halves:

```sh
pnpm --filter @suma/control exec tsx -e '
import { generateTokenKeypair, toBase64 } from "@suma/protocol";
void (async () => {
  const pair = await generateTokenKeypair();
  console.log("CONTROL_TOKEN_SK=" + toBase64(pair.privateKeyPkcs8));
  console.log("CONTROL_TOKEN_PK=" + toBase64(pair.publicKeyRaw));
})();
'
```

`CONTROL_TOKEN_SK` stays secret (Railway only). `CONTROL_TOKEN_PK` is
installed in **both** planes — Railway env and the Worker's
`CONTROL_PUBLIC_KEY` secret. If the Worker secret is unset it accepts
forgeable `hbr_dev_` stub tokens; setting it is what turns real auth on.

Wire revocation propagation (control → hub socket-close within ≤60 s) with a
shared random token:

```sh
TOKEN=$(openssl rand -hex 32)
cd services/sessionhub
printf '%s' "$TOKEN" | pnpm exec wrangler secret put ADMIN_TOKEN
railway variables --service control \
  --set "SESSIONHUB_ADMIN_URL=https://suma-sessionhub.zmmeyer44.workers.dev/v1/admin/revoke" \
  --set "SESSIONHUB_ADMIN_TOKEN=$TOKEN" \
  --skip-deploys
railway redeploy --service control --yes   # variables apply on redeploy
```

Full Railway variable set for the control service (values in Railway):
`DATABASE_URL`, `CONTROL_TOKEN_SK`, `CONTROL_TOKEN_PK`,
`SUMA_HUB_PUBLIC_URL=wss://suma-sessionhub.zmmeyer44.workers.dev/v1/hub/ws`,
`SESSIONHUB_ADMIN_URL`, `SESSIONHUB_ADMIN_TOKEN`, `SUMA_INVITES_REQUIRED=0`,
`RAILWAY_DOCKERFILE_PATH=infra/control-image/Dockerfile`, plus the optional
Fly compute vars (`FLY_API_TOKEN`, `FLY_COMPUTE_IMAGE`, `FLY_ORG_SLUG`,
`FLY_AGENT_PUBLIC`) and R2 vars (`R2_*`) — see `infra/README.md`.

## Deploy: SessionHub Worker

```sh
pnpm --filter @suma/sessionhub test          # 65 tests must pass
cd services/sessionhub
pnpm exec wrangler deploy
```

Durable Object storage survives deploys; only a new `[[migrations]]` entry in
`wrangler.toml` changes DO classes. Never set `GATEWAY_DEV_ALLOW_PRIVATE` on
the deployed Worker — it exists so local integration tests can target
loopback origins, and in production it is an SSRF hole.

Verify (allow ~10 s for edge propagation before trusting a probe):

```sh
curl https://suma-sessionhub.zmmeyer44.workers.dev/healthz
# → {"ok":true}

curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-suma-space: s1' \
  https://suma-sessionhub.zmmeyer44.workers.dev/v1/gateway/cookies
# → 401 (route exists, auth required; 404 means an old version is serving)

curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'authorization: Bearer hbr_dev_alice.mac-a' -H 'x-suma-space: s1' \
  https://suma-sessionhub.zmmeyer44.workers.dev/v1/gateway/cookies
# → 401 (stub tokens rejected ⇒ CONTROL_PUBLIC_KEY is enforced)
```

## Deploy: control plane

The image is `infra/control-image/Dockerfile`, built with the **repo root**
as context (`RAILWAY_DOCKERFILE_PATH` points Railway at it). Deploys upload
the local working tree, gitignore-filtered — so `.env` and `node_modules`
never ship, but uncommitted source does; deploy from a clean tree unless you
mean otherwise.

```sh
railway up --service control --detach
```

Watch the printed build-log URL. **Gotcha:** a failed build keeps serving
the previous image with no visible error at the public URL — confirm the
`deployment ID` from `railway status` matches the new upload before trusting
a probe.

For an env-var-only change, `railway redeploy --service control --yes`
re-deploys the existing build with the new variables (no upload).

Verify:

```sh
railway status                       # deployment ID should be the new one
curl https://control-production-c40c.up.railway.app/healthz
# → {"ok":true}
curl https://control-production-c40c.up.railway.app/v1/auth/jwks
# → publicKey must equal the Worker's CONTROL_PUBLIC_KEY secret
```

## Deploy: desktop (each Mac)

There is no hosted artifact — each Mac builds from the repo at the same
revision (commit and push first; the other Mac pulls):

```sh
git pull
pnpm install
pnpm --filter @suma/desktop build
SUMA_CONTROL_URL=https://api.sumabrowser.com \
  pnpm --filter @suma/desktop start
```

A packaged build (`dist:mac:prod` / `release:mac`) needs no env var: it
defaults to `https://api.sumabrowser.com` (`PROD_CONTROL_URL` in
`src/main/control-client.ts`). `SUMA_CONTROL_URL` still overrides it when set.

Do **not** set `SUMA_SESSION_GATEWAY_URL` / `SUMA_SESSION_GATEWAY_DEV_TOKEN`
against the deployed stack — those pin a dev gateway and bypass discovery.
A signed/entitled build is required only for the Touch ID passkey ceremony;
the device-key enrollment path works in an unsigned dev build.

For day-to-day development against the hosted planes, use the wrapper
instead of exporting vars by hand:

```sh
pnpm --filter @suma/desktop dev:cloud
```

It builds `@suma/files`, launches `electron-vite dev` with
`SUMA_CONTROL_URL=https://api.sumabrowser.com`, a dedicated profile
(`~/Library/Application Support/Suma Dev Cloud` — a profile keeps the
control URL it first enrolled against, so the cloud profile stays separate
from local-only dev profiles), and strips the plane-pinning vars and
AI/TTS env keys, with `SUMA_NO_DOTENV=1` so the repo-root `.env` cannot
reintroduce them — chat/voice/TTS then exercise the same stored/vended
credential paths a shipped build uses. What dev mode still cannot preview:
Touch ID passkeys, Widevine, and auto-update (use `dist:mac` for those).

## Pre-flight before a two-Mac session test

```sh
pnpm test:e2e:gateway
```

This is fully local (builds the desktop, then launches a real Wrangler
SessionHub DO, two origin hostnames, and two Electron profiles) and proves
the exact revision the Macs will run. It does not touch the deployed stack.

Expectations while testing against real sites: structured-gateway fetches
egress from Cloudflare data centers, so some public sites will bot-challenge
even when session logic is correct — the desktop's origin router keeps
assisted/device-bound origins (Google, Gmail, Claude, …) on native Chromium
networking and auto-promotes any origin that answers with a challenge, but
the cleanest signal is a cookie-backed site you control.
