# Suma assistant plane

This service is the external communication path for Suma. It is deliberately
split into two trust zones:

```text
BlueBubbles / Slack / Telegram
            |
            v
 public channel gateway -- durable encrypted task queue
            |
            | service-authenticated request
            v
 private runner -- AI loop + per-user browser + VM/computer tools
```

The desktop and remote runner share `@suma/assistant-core`, including the
capability catalog and model-facing browser tool definitions. A transport
adapter only translates messages; it does not own a second agent prompt or a
second tool implementation.

## Implemented vertical slice

- BlueBubbles `new-message` webhook parsing and text replies through
  `/api/v1/message/text`, including direct-message filtering, `/link`,
  `/unlink`, working-state updates, and throttled status edits.
- A Suma-owned webhook secret, constant-time verification, self-message
  filtering, and delivery-id deduplication.
- Control-owned one-time link codes, external-identity resolution on every
  message, immediate revocation, feature-flag kill switches, and an
  independently enforced remote policy for model, tools, step count, and VM
  wake limits.
- Desktop Settings for creating link codes, listing and revoking linked
  channels, explicitly sharing the active space's authenticated browser state,
  and editing every remote permission without changing the local chat
  assistant's permissions.
- An encrypted, crash-recoverable task queue and encrypted conversation
  history. Failed tasks return a user-visible channel reply, and drain/store
  failures are contained instead of becoming unhandled process rejections.
- A bearer-authenticated public-gateway/private-runner boundary.
- An executable private runner with a channel-neutral AI SDK harness and an
  injected, per-task toolset.
- The complete computer tool surface over the VM agent: foreground and
  interactive terminals, background jobs, port inspection, files, and
  durable memory. The same model-facing contracts live in
  `@suma/assistant-core`; the mux client lives in `@suma/agent-client`.
- Control-minted, short-lived Ed25519 capability tokens bound to both the user
  machine and the exact remote tool groups. Every agent mux connection must
  authenticate before any PTY, VFS, forward, or control frame is accepted.
- A persistent Playwright browser with tabs, navigation, back/forward/reload,
  reading, screenshots, selector/text/coordinate clicks, typing, keys, and
  scrolling.
- Authenticated browser state through encrypted cookies/local storage,
  validated desktop session handoff, or exact-origin/path custom auth-header
  integrations. Secret headers never enter model-visible tool arguments or
  results.
- Per-request SSRF filtering, including subresources and redirects. The
  production browser network must enforce the same rule at egress as defense
  in depth against DNS rebinding.

The real-browser suite launches Chrome and proves click/type/screenshot,
HttpOnly cookie and local-storage restart persistence, custom bearer-token
injection, redirect-hop policy enforcement, popup policy enforcement, and an
already-authenticated desktop session handoff. The external-assistant E2E
also launches the real desktop Settings UI, transfers its active space through
a one-use control-authorized ticket, closes the desktop, and exercises
BlueBubbles ingress through the private runner with authenticated browser
actions.

## Local development

`pnpm dev` starts a health-only stub on port 8790. It intentionally does not
invent channel, model, or runner credentials. Run tests with:

```sh
pnpm --filter @suma/assistant check-types
pnpm --filter @suma/assistant test
pnpm --filter @suma/assistant lint
```

The production gateway entry is `pnpm --filter @suma/assistant start` and
fails with the complete list of missing variables:

- `SUMA_ASSISTANT_DATA_DIR`
- `SUMA_ASSISTANT_MASTER_KEY` (base64-encoded 32 bytes)
- `SUMA_ASSISTANT_RUNNER_URL`
- `SUMA_ASSISTANT_RUNNER_TOKEN`
- `SUMA_CONTROL_URL`
- `ASSISTANT_SERVICE_TOKEN`
- `BLUEBUBBLES_SERVER_URL`
- `BLUEBUBBLES_ACCOUNT_ID`
- `BLUEBUBBLES_PASSWORD`
- `BLUEBUBBLES_WEBHOOK_SECRET`

Configure the BlueBubbles webhook as:

```text
POST https://<gateway>/v1/channels/bluebubbles/<account-id>/webhook?secret=<webhook-secret>
```

An `X-Suma-Webhook-Secret` header is preferred when the bridge supports custom
headers. If the query form is used, gateway access logs must redact query
strings.

The private-runner entry is `pnpm --filter @suma/assistant start:runner`. It
uses the same data directory, master key, runner token, control URL, and
assistant service token, plus:

- `AI_GATEWAY_API_KEY`
- optional `SUMA_ASSISTANT_RUNNER_PORT` (default `8791`)
- optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`

Control must receive the same `ASSISTANT_SERVICE_TOKEN`. Production VM images
must receive `SUMA_AGENT_VERIFY_KEY`, which is the control plane's Ed25519
public key; provisioning now migrates existing machines away from the legacy
static `SUMA_AGENT_CLAIMS` environment value.

Control must also receive `SUMA_ASSISTANT_PUBLIC_URL`, the public HTTPS base
URL of the channel gateway. It may include a deployment path prefix. Control
uses it to vend five-minute, one-use browser-session upload tickets; only the
ticket digest is stored, and browser state bypasses control on its way to the
private runner.

## Remaining production integration

The runner and signed VM transport exist, but no hosted gateway/runner
deployment is configured by this repository yet. Before enabling real users:

- Deploy the public gateway and private runner as separate trust zones and
  keep the agent port private even though mux authentication is now required.
- Decide whether selected spaces should opt into automatic browser-session
  refresh after the explicit Settings handoff. V1 intentionally requires a
  user action so the expanded runner trust boundary is visible; the complete
  one-use transfer path is implemented and tested.
- Replace the runner-wide `AI_GATEWAY_API_KEY` with a control-vended,
  per-user inference lease if per-account metering and revocation are required.
- Add cumulative daily wake accounting and the idle auto-suspend reaper. The
  policy is stored and zero wake allowance is enforced today, but nonzero
  minute budgets are not yet metered across tasks.
- Add stored configuration for custom browser-auth integrations. Exact
  origin/path header injection is implemented and tested but is not exposed in
  Settings yet.
- Implement Slack and Telegram adapters on the existing ingress contract, and
  add attachments and approval replies to BlueBubbles.
