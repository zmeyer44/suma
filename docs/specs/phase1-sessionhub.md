# Spec: Phase 1 sessionhub — device-token verification + revocation enforcement

Extends `services/sessionhub` (base: docs/specs/sessionhub.md, plus its
Revision-2 header). PRD §8.2, §9 (I-1 unchanged), §12. All new code in
services/sessionhub/src and test. Do NOT edit package.json/tsconfig/
wrangler.toml. Read src/auth.ts, src/index.ts, src/session-hub.ts,
src/hub-core.ts and `@suma/protocol` token.ts first.

## Token verification (src/auth.ts)

Today `parseDeviceToken` accepts `hbr_dev_<userId>[.<deviceId>]` stubs. Add
real device-token verification while keeping the stub as a dev fallback:

- New `authenticate(authorization, env, nowSeconds)` →
  `{ userId, deviceId } | { error }`:
  - Bearer value that looks like a JWS (three dot-separated base64url parts,
    header decodes to `{alg:"EdDSA",typ:"JWT"}`): if `env.CONTROL_PUBLIC_KEY`
    (base64 raw Ed25519) is set, `verifyDeviceToken` with an imported key;
    map ok→{userId:claims.sub, deviceId:claims.did}, expired/bad→401. Cache
    the imported CryptoKey on a module singleton keyed by the env string.
  - Otherwise the `hbr_dev_` stub path (ONLY when `env.CONTROL_PUBLIC_KEY` is
    unset — once a public key is configured, stub tokens are rejected so prod
    can't silently accept them). Document this switch.
- The worker (src/index.ts) uses `authenticate` for `/v1/hub/ws` and
  `/v1/hub/hydrate`, routing to the user's DO by userId as before, and passes
  the resolved deviceId to the DO (query param or header) so the DO no longer
  trusts the hello frame's deviceId blindly — the DO should prefer the
  edge-verified deviceId when present and fall back to the hello deviceId only
  in stub mode. (Keep changes minimal; a header `x-suma-device` set by the
  edge is fine.)

## Revocation enforcement (I-1 preserved; no session data touched)

New admin route `POST /v1/admin/revoke` (src/index.ts), authenticated by
`env.ADMIN_TOKEN` (constant-time compare; 401 otherwise). Body
`{ userId, deviceId }`. Routes to the user's DO which:
- persists the revoked deviceId under `revoked:<deviceId>` (durable),
- closes any live WebSocket for that device (`ws.close(4003, "revoked")`),
  clears its presence/`conn:` state and broadcasts offline.
Add `HubCore.revokeDevice(deviceId)` doing the storage + returning the socket
ids to close; the DO adapter closes them. On new connections, reject
(`4003`) if the deviceId is in the revoked set. This closes the ≤60s
propagation contract from the control side.

`GET /healthz` unchanged. Never inspect sealed record contents (I-1).

## Tests

test/auth.test.ts (extend): a real device token minted with a test keypair
(protocol signDeviceToken) verifies and yields {userId,deviceId} when
CONTROL_PUBLIC_KEY is set; expired/wrong-key → error; stub tokens rejected
when a public key is configured, accepted when not. New test/revocation.test.ts
(HubCore + fake connections): revokeDevice persists + returns the device's
open socket ids; a revoked device's reconnect is refused; broadcasts offline;
an unrelated device is untouched. Worker-level: /v1/admin/revoke with a bad
admin token → 401; with a good one routes to the DO. Keep all existing tests
green (37) and the wrangler dry-run building.

Verify: pnpm --filter @suma/sessionhub check-types && test && build.
