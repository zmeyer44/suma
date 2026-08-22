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
  `/api/v1/message/text`.
- A Suma-owned webhook secret, constant-time verification, self-message
  filtering, and delivery-id deduplication.
- An encrypted, crash-recoverable task queue and encrypted conversation
  history.
- A bearer-authenticated public-gateway/private-runner boundary.
- A channel-neutral AI SDK harness with an injected per-task toolset.
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
injection, and an already-authenticated desktop session handoff.

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

## Remaining production integration

The code does not yet deploy or enroll a runner. Before enabling real users,
the runner must be wired to the user's compute VM through an authenticated
private agent transport, and the desktop/SessionHub continuity path must call
the validated browser-session handoff on account-state changes. Slack and
Telegram remain adapters on the same ingress contract. Attachments and
approval replies also remain to be added to the BlueBubbles adapter.

Do not expose the VM's current TCP agent port publicly: the current mux wire
has no connection authentication. The runner should reach it over the private
network only until signed mux authentication is implemented.
