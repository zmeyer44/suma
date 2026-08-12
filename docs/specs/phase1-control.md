# Spec: Phase 1 control plane — auth, device tokens, recovery, revocation

Extends `services/control` (see docs/specs/control.md for the existing base).
PRD §8.2, §12 Phase 1. All new code in services/control/src and test.
Deps already installed; do NOT edit package.json/tsconfig/eslint. Read the
existing src/**, especially auth.ts, app.ts, db/schema.ts, db/migrate.ts,
revocation.ts, and `@suma/protocol`'s token.ts (signDeviceToken /
verifyDeviceToken / generateTokenKeypair) and keys.ts before starting.

## Signing key (src/keys-provider.ts)

The control plane owns the Ed25519 device-token signing key.
`getSigningKeys(env)`:
- If `env.CONTROL_TOKEN_SK` (base64 pkcs8) is set, import it +
  `env.CONTROL_TOKEN_PK` (base64 raw) for the public key.
- Otherwise (dev/tests) call `generateTokenKeypair()` once per process and
  cache. Expose `publicKeyBase64()` — served at `GET /v1/auth/jwks` (raw
  Ed25519 public key, base64; not real JWKS, documented) so sessionhub's
  operator can copy it into `CONTROL_PUBLIC_KEY`.
The app factory `createApp(db, sandbox?, signing?)` takes optional injected
signing keys so tests are deterministic.

## WebAuthn (src/webauthn.ts) — minimal, dependency-free

Passkey register + login with `none` attestation and no bundled library.
- `beginRegistration(user)` → PublicKeyCredentialCreationOptions JSON
  (challenge = base64url 32 random bytes stored server-side keyed by userId
  with a 5-min TTL in a `challenges` table or in-memory map on the app
  instance — in-memory is fine, documented as single-instance; rp.id from
  `env.RP_ID` default "localhost", pubKeyCredParams ES256(-7)+EdDSA(-8),
  authenticatorSelection.residentKey "preferred", userVerification
  "preferred").
- `finishRegistration(userId, credentialJSON)` → parse clientDataJSON
  (verify type "webauthn.create", challenge matches, origin from
  `env.RP_ORIGIN`), decode attestationObject far enough to extract the
  credential public key from authData (COSE key → store the raw COSE bytes
  base64; verification of assertion signatures uses WebCrypto by importing
  the COSE key — implement for ES256 and Ed25519 only). Persist in the
  existing `passkeys` table (publicKey = base64 COSE, prfCapable from the
  extension results if present).
- `beginLogin(userId)` / `finishLogin` (verify assertion signature over
  authenticatorData ‖ SHA-256(clientDataJSON), check challenge + origin +
  type "webauthn.get", bump signCount monotonic — reject regressions).
Keep the CBOR/COSE parsing to exactly the subset needed; comment that it is
purpose-built, not a general decoder. If full WebAuthn assertion crypto
proves too large, it is acceptable to verify clientData + challenge + that
the credential is enrolled and skip the assertion-signature step ONLY with a
loud TODO — but prefer real ES256/EdDSA verification.

## Device-key credential fallback

Not every enrolled device has a platform authenticator (and the desktop app
enrolls headlessly first). `POST /v1/auth/device-credential`
{deviceId, devicePublicKey(b64 Ed25519 raw), signature(b64 over a
server-issued challenge)} registers the device's own Ed25519 identity key
(already in the `devices` table) as a login credential. Login via
`POST /v1/auth/device-login` {deviceId, challenge signature}. This is the
credential path the desktop app uses by default; WebAuthn is offered when the
platform supports it. Record `credentialKind` on the session.

## Sessions & device tokens

- Successful register/login (either method) issues a **device token** via
  `signDeviceToken(signingKey, {sub:userId, did:deviceId, iat, exp:iat+
  DEVICE_TOKEN_TTL_SECONDS, jti})`. Return it as `deviceToken` plus its exp.
- `POST /v1/auth/token/refresh` (auth: a currently-valid device token OR a
  device-login proof) → new short-lived device token, refused if the device
  is revoked. This is how the 10-min token gets silently re-minted.
- The existing bearer middleware stays for the stub `hbr_dev_` tokens
  (bootstrap/tests). Add device-token acceptance: if the bearer value has two
  dots (JWS), verify it with the signing keys' public key + check the device
  isn't revoked; on success set the same context user/device the stub sets.
  Keep BOTH paths; document the stub as dev-only.

## Recovery (src/recovery.ts + routes)

Wrapper storage already exists (`keyWrappers`). Add:
- `POST /v1/spaces/:id/recovery` {saltB64, wrappedB64} stores/updates the
  `recovery-code` wrapper (kind already supported) with audit
  `keys.recovery_set`.
- `GET /v1/spaces/:id/wrappers?kind=recovery-code` already served by the
  existing list route — ensure it filters by kind if the query is present.
The actual KEK derivation/unwrap happens client-side (§8.2) — the control
plane only stores wrapped blobs.

## Revocation propagation to the hub (src/revocation.ts + route)

Extend `POST /v1/devices/:id/revoke` (keep the honest-contract response):
after marking revokedAt, POST to the session plane's admin revoke endpoint so
live sockets die ≤60s (PRD §8.2). `notifyHubRevocation(env, userId, deviceId)`:
if `env.SESSIONHUB_ADMIN_URL` + `env.SESSIONHUB_ADMIN_TOKEN` are set, POST
`{userId, deviceId}` with the admin token; on failure, log + enqueue a retry
row in a new `revocationOutbox` table (id, userId, deviceId, createdAt,
deliveredAt nullable, attempts) and expose `GET /v1/admin/revocation-outbox`
for observability. In tests, inject a fake notifier via createApp so no real
network. The response gains `hubNotified: boolean`.

## Tests

Extend test/app.test.ts (or add test/auth.test.ts, test/webauthn.test.ts):
device-credential register+login issues a verifiable device token (verify it
with the protocol's verifyDeviceToken against the injected public key); token
refresh works and is refused after revoke; revoke calls the injected hub
notifier exactly once with the right ids and sets hubNotified; outbox row
written when the notifier throws; recovery wrapper set + audit; JWKS endpoint
returns the base64 key; bearer middleware accepts a freshly minted device
token and rejects an expired/other-key one. Keep all existing tests green.

Verify: pnpm --filter @suma/control check-types && pnpm --filter @suma/control test.
