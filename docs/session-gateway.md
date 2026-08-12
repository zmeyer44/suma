# Gateway-backed browser sessions

Suma can make the SessionHub the canonical browser-network session while
keeping the website itself entirely local. Blink, V8, DOM/storage APIs, input,
layout, paint, media decode, and GPU compositing remain inside the tab's local
`WebContentsView`. Only HTTP(S) requests and response bytes cross the gateway.

## Request path

1. Every persisted Space session installs handlers for the existing `http` and
   `https` schemes. There is no origin allowlist.
2. The desktop removes the local `Cookie` header, authenticates to SessionHub,
   and carries the original URL and fetch context in reserved headers. A site
   `Authorization` value is carried separately from the Suma credential.
3. The Worker verifies the device token, strips it, and routes the request to
   the user's Durable Object.
4. The Durable Object attaches cookies from its per-Space canonical jar,
   performs the origin fetch, applies `Set-Cookie`, and streams the response.
5. Canonical matching cookies are replayed on the original response so the
   local cookie store is ready before page JavaScript runs. The local mirror is
   used by `document.cookie`, DevTools, and non-HTTP handshakes; it is never
   trusted for an outbound gateway request.

The first device to enable an empty gateway jar also adopts its existing local
cookies. Once initialized, the remote jar always wins; this prevents a stale
offline device from resurrecting a session after logout.

## Configuration

Production normally needs no desktop-specific setting. The control plane's
`/v1/me` response already supplies the SessionHub WebSocket URL, and the desktop
uses the same origin for the HTTP gateway.

Development can pin it explicitly:

```sh
SUMA_SESSION_GATEWAY_URL=http://127.0.0.1:8788 \
SUMA_SESSION_GATEWAY_DEV_TOKEN=hbr_dev_alice.mac-a \
pnpm --filter @suma/desktop dev
```

Private and loopback destinations are rejected by default. Local integration
tests start Wrangler with `GATEWAY_DEV_ALLOW_PRIVATE=1`; that binding must not
be enabled in production.

## Security and compatibility boundaries

- The gateway stores origin session cookies in server-readable Durable Object
  storage. This mode deliberately trades cookie E2EE for server-side session
  authority and must be presented as such to users.
- Suma's bearer token is removed at the Worker edge and can never become an
  origin `Authorization` header. Destination authorization is transported in a
  separate reserved header.
- Redirects are manual at the gateway, so each hop returns to Chromium and is
  re-evaluated under the original browser navigation rules.
- HTTP(S), redirects, forms, fetch/XHR, service-worker network requests, and
  ordinary cookie-backed OAuth sessions use this path. WebSocket handshakes use
  the hydrated local mirror.
- This is not a universal implementation of “any authentication pattern.” A
  site whose sole credential lives in IndexedDB/localStorage, an unexportable
  client certificate, a platform passkey, Device Bound Session Credentials,
  DPoP, or another device-bound key still requires site cooperation or a
  separate state/key synchronization design. No generic browser can transfer
  those credentials without changing the site's security contract.

The integration journey is `pnpm test:e2e:gateway`. It launches a real local
SessionHub Durable Object, two unrelated origin hostnames, and two Electron
processes with separate user-data directories. Mac A signs in once with an
HttpOnly cookie; Mac B opens both account pages directly, checks that the local
cookie mirror exists, and verifies a local JavaScript heartbeat advances.
