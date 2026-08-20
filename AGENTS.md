# Agent guide: running this stack

The product is Suma (packages are `@suma/*`); the repo dir is `harbor` for
historical reasons. Full architecture: `README.md`; deploy runbook:
`docs/deployment.md`.

## Pick the right way to start the desktop app

| Mode | Command | Use when |
| --- | --- | --- |
| Local-only | `pnpm --filter @suma/desktop dev` | UI/feature work. No cloud: control URL is null, sync is in-memory (LoopbackTransport), compute is the in-process SimAgent. |
| Full local stack | `pnpm dev` (repo root) | Work that spans desktop + control + sessionhub. Control :8787 (pglite + stubbed object store), sessionhub :8788, www :3000. |
| Cloud preview | `pnpm --filter @suma/desktop dev:cloud` | Verifying the real production experience. Dev build against the hosted planes; needs **zero** env vars (everything discovers from the control plane). Uses its own profile (`~/Library/Application Support/Suma Dev Cloud`), strips AI/TTS keys and plane-pinning vars, sets `SUMA_NO_DOTENV=1`. |
| Driver (automated) | `apps/desktop/.claude/skills/run-desktop` | Screenshots, clicking through flows, e2e-style checks. Runs the built app, scratch profile. |
| Packaged | `pnpm --filter @suma/desktop dist:mac` | Only way to preview auto-update behavior and Finder-launch env (`/bin/sh` SHELL, minimal PATH). Passkeys and Widevine additionally need the signed/castLabs release path (`docs/release-macos.md`). |

Cloud-preview cautions:

- **Enrollment in `dev:cloud` creates a real production account**, and machine
  provisioning creates a real `sm-c-*` Fly app. Ask the user before signing up,
  enrolling, or provisioning there.
- Never set `SUMA_HUB_URL`, `SUMA_SESSION_GATEWAY_URL`,
  `SUMA_SESSION_GATEWAY_DEV_TOKEN`, or `SUMA_AGENT_URL` against the hosted
  stack — each pins its plane and bypasses the `/v1/me` + `/v1/machine`
  discovery that production relies on.

## Env vars: alert the user, don't improvise

The repo-root `.env` (gitignored, holds live credentials) is loaded only in
dev: the desktop main process absorbs all of it (`apps/desktop/src/main/env.ts`,
disabled by `SUMA_NO_DOTENV=1`), and the control dev server adopts only the
five `FLY_*` keys (`services/control/src/dev-env.ts`).

**If a task needs a var that is missing, stop and tell the user exactly which
vars are missing and what will not work.** Do not invent values, hardcode
secrets, copy credentials between services, or silently fall back to a stub
and report the task as done. Stubs are fine only when the user asked for
local-only work.

| Task | Needs | Without it |
| --- | --- | --- |
| Chat/voice/TTS in plain local dev | `AI_GATEWAY_API_KEY` (root `.env`) | AI features report key "unset". In `dev:cloud` no key is needed — the vended path is the point. |
| Voice assistant vending (local control) | `GEMINI_API_KEY` on the control process | `/v1/ai/voice/token` 404s |
| Local control provisioning real VMs | `FLY_API_TOKEN` + `FLY_COMPUTE_IMAGE` | StubSandboxProvider, no VMs — which is the safe default |
| Real R2 in local control | `R2_ACCOUNT_ID/ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` exported to the control process | in-memory stub store |
| `apps/www` fonts | `FONTS_BASE_URL` | fetch-fonts fails / fallback faces |
| `apps/www` waitlist | `WAITLIST_DATABASE_URL` | signups 500 |

Hazards to warn about even when the vars ARE present:

- A local control plane with the root `.env` visible **adopts the production
  Fly token and the production `sm-c` app prefix** — it will create and mutate
  real Fly machines in the production namespace. Set
  `FLY_COMPUTE_APP_PREFIX` to a dev prefix first, and never delete `sm-c-*` /
  `hbr-c-*` Fly apps by prefix.
- Exporting `R2_*` to a local control process writes into the production
  bucket; `apps/www` dev writes waitlist rows into the production Postgres.
  There is no staging environment — one live instance of every plane.

## Verify before claiming success

- Rebuild before driving: the run-desktop driver launches `out/main`, not the
  dev server — `pnpm --filter @suma/desktop build` after any main/preload
  change.
- `pnpm --filter @suma/desktop test && pnpm --filter @suma/desktop lint &&
  pnpm --filter @suma/desktop check-types` for desktop changes;
  `pnpm test:rust` for agent/sidecar/egressgw.
- A profile that once enrolled keeps its `controlUrl` forever
  (`enrollment.controlUrl` beats `SUMA_CONTROL_URL`). If the app is talking to
  the wrong plane, suspect the profile, not the env.
