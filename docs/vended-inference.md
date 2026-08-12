# Vended inference: default model access without shipping a key

How the desktop assistant gets to work on a fresh account with no API key on
the machine, what stands between a device token and the operator's gateway
bill, and what is deliberately deferred. Implementation:
`services/control/src/inference.ts` (server), `apps/desktop/src/main/chat/
chat-service.ts` (client), `services/control/test/inference.test.ts`.

## The problem

All desktop AI features (assistant loop, saves extractor, TTS) speak to the
Vercel AI Gateway with a key that today comes from either the environment or
a key the user pastes into settings. "Default API keys in production" cannot
mean shipping a shared key in the app: anything inside the Electron bundle or
its config files is extractable in minutes, and one leaked key is the whole
fleet's key — unrevocable without breaking every user at once.

## The design: proxy, don't distribute

The control plane owns the one real gateway key (`AI_GATEWAY_API_KEY`, env
only) and exposes a **metered passthrough proxy**:

    ALL /v1/ai/gateway/*   →  ${AI_GATEWAY_UPSTREAM_URL}/*      (default
                              https://ai-gateway.vercel.sh)
    GET /v1/ai/status      →  { vending, enabled, available,
                                dailyRequestCap, requestsToday }

A request must clear three gates, in order:

1. **Device auth** — the standard bearer middleware: a signed, short-lived
   (10 min), revocable device token. Revoking a device revokes its inference.
2. **Entitlement** — the account must carry the `inference` feature.
   New signups get it via `DEFAULT_ACCOUNT_FEATURES`; stripping it from
   `users.features` cuts one account off without touching devices or keys.
3. **Rate** — a per-user daily request cap (`AI_DAILY_REQUEST_CAP`,
   default 500/day, counted per UTC day from `inference_usage` rows).

The proxy then rebuilds the request: identity and addressing headers
(`authorization`, `cookie`, `host`, forwarding headers) are stripped, the
operator key is substituted, everything else — including the AI SDK's own
protocol headers — passes through. Responses stream back untouched (SSE
passthrough); plain-JSON responses are buffered long enough to read a
`usage` block. With no `AI_GATEWAY_API_KEY` configured the routes answer
404 — closed, never open, same posture as the invite-admin route.

Why passthrough rather than minting per-user upstream keys: the gateway has
no API for scoped sub-keys, and even if it did, a key on the client is a key
that leaks. Why passthrough rather than a bespoke chat endpoint: the desktop
already speaks the gateway protocol through the AI SDK — mimicking the
upstream's surface means the client change is a base-URL swap, and every
model/modality the gateway adds works through the proxy on day one.

## Metering

One `inference_usage` row per proxied request: user, device, upstream path,
model (parsed from the request body), upstream status, and token counts when
the response was plain JSON with a recognizable usage block (OpenAI- and
Anthropic-shaped keys). Streamed responses record null tokens — the request
count is what the daily cap enforces today. The table is the raw material for
folding inference into `billing.ts` cost estimates later.

## Client behavior (desktop)

Credential precedence in `ChatService.keyState()`:

    env key  >  stored (pasted) key  >  vended  >  unset

"Vended" activates when no local key exists but the app is signed in to a
control plane: the SDK's gateway provider is constructed per run with
`baseURL = ${controlUrl}/v1/ai/gateway/v4/ai` and the current device token as
its API key. Per run matters: device tokens live ~10 minutes, and
`ControlClient.getToken()` re-mints through refresh/reauth, so each message
starts with a live token. Users who bring their own key skip the proxy (and
its cap) entirely — the override path is also the escape hatch if the proxy
is ever down.

## Operational notes

- **Rotation** is a Railway env change + redeploy. No client is involved.
- **Local dev**: `pnpm dev` in `services/control` with `AI_GATEWAY_API_KEY`
  set vends against the real gateway; unset, the desktop falls back to
  env/stored keys exactly as before this feature.
- **Blast radius**: the upstream host is fixed by the operator, so the proxy
  cannot be aimed elsewhere; methods are limited to GET/POST.

## Deferred, deliberately

- **Streamed token accounting** — parse usage out of the SSE tail (the
  gateway emits it in the final chunks) so caps can move from requests/day to
  tokens/day. The `inference_usage` columns already exist for it.
- **Dollar allowances** — join token counts with per-model pricing and fold
  into `billing.ts` / `PRO_ALLOWANCE_USD` like compute and egress.
- **Other AI callers** — the saves extractor and TTS still use only
  env/stored keys; moving them onto the proxy is the same base-URL swap the
  chat made.
- **Per-model policy** — the proxy forwards any model id today; an allowlist
  (or per-tier model menus) is a straightforward gate at the proxy.
