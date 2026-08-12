# Spec: `services/control` (@suma/control)

Control plane: Hono + Drizzle + Neon Postgres (PRD §7). Accounts, devices,
spaces, key wrappers, machine lifecycle, audit trail. No session data ever
flows here (I-1); it stores only *wrapped* (encrypted) key material.

## Package setup

name `@suma/control`, type module. Deps: `hono@^4`, `@hono/node-server`,
`@hono/zod-validator`, `drizzle-orm@^0.44`, `postgres@^3` (postgres-js
driver), `zod`, `@suma/protocol`, `@suma/config`. DevDeps:
`drizzle-kit`, `@electric-sql/pglite` (tests run Drizzle on PGlite —
`drizzle-orm/pglite`), vitest, typescript, `@types/node`, `tsx`.
Scripts: `dev` (tsx watch src/server.ts), `build` (tsc --noEmit — the service
runs via tsx; deployment bundling is deferred), `check-types`, `test`,
`lint`, `db:generate` (drizzle-kit generate). tsconfig extends
internal-library. package.json, tsconfig, eslint config already exist — do
not edit them; if you genuinely need another dependency, say so in your
final report instead of editing package.json.

Env: `DATABASE_URL` (Neon), `PORT` (default 8787). `src/db/client.ts` exports
`createDb(url)` (postgres-js) and the app factory takes a `db` so tests
inject PGlite.

## Drizzle schema (`src/db/schema.ts`)

- `users`: id (uuid pk, defaultRandom), email (unique, not null),
  displayName, homeRegion (text, default 'iad'), createdAt.
- `passkeys`: id (text pk = credential id), userId (fk cascade), publicKey
  (text, base64), prfCapable (boolean), label, createdAt, lastUsedAt.
- `devices`: id (uuid pk), userId (fk), name, platform (text),
  devicePublicKey (text, base64 Ed25519, unique), enrolledAt,
  revokedAt (nullable), revocationReason (text nullable), lastSeenAt.
- `spaces`: id (uuid pk), userId (fk), name, color, position (int),
  egressPolicy (text: 'suma-ip'|'direct'), createdAt.
- `keyWrappers`: id (uuid pk), userId, spaceId (fk), kind (text:
  passkey-prf|recovery-code|hardware-key|kms), credentialId (text), salt
  (text), wrapped (text, base64), createdAt. Unique (spaceId, kind,
  credentialId).
- `machines`: id (uuid pk), userId (fk, unique — one VM per account §8.8),
  state (text, MachineState), region, cpuKind, cpus, memoryMb,
  updatedAt, lastTransitionAt.
- `machineEvents`: id (uuid pk), machineId (fk), fromState, toState,
  reconstructed (bool default false), detail, createdAt.
- `auditEvents`: id (uuid pk), userId, actorDeviceId (nullable), type (text),
  payload (jsonb), createdAt. Indexed (userId, createdAt).

## Routes (all under `/v1`, JSON, zod-validated; `src/app.ts` exports `createApp(db)`)

Auth stub for the initial phase: `Authorization: Bearer hbr_dev_<userId>`
middleware → 401 if absent/malformed (documented TODO: passkey-session JWT).
`POST /v1/accounts` is unauthenticated (signup).

- `POST /accounts` {email, displayName?, homeRegion?} → creates user +
  default space ("Personal", direct egress) + machine row (state
  'provisioning') + audit event. 409 on duplicate email.
- `GET /me` → user + spaces + machine + device count.
- `POST /devices/enroll` {name, platform, devicePublicKey (b64),
  attestation?: string} → device row + audit `device.enrolled`; returns
  device + `hubToken` (`hbr_dev_<userId>` stub). Enrolling with a revoked
  device's public key → 409.
- `GET /devices` → devices with revoked status.
- `POST /devices/:id/revoke` {reason?} → sets revokedAt + audit
  `device.revoked`. Response includes the HONEST contract (PRD §8.2):
  `{ device, stoppedFutureAccess: true, purgeOnReconnect: true,
     cannotInvalidateThirdPartySessions: true,
     affectedOrigins: [{domain, label, remoteLogoutUrl?}] }` — affectedOrigins
  from SEED_CORPUS tier-1 origins, with known remote-logout URLs for github,
  google, slack (hardcode a small map).
- `GET /spaces` / `POST /spaces` {name,color,egressPolicy?} /
  `PATCH /spaces/:id` — audit space.updated on egressPolicy change.
- `POST /spaces/:id/wrappers` (upsert KeyWrapper), `GET /spaces/:id/wrappers`
  — storing/serving *wrapped* root secrets for enrolled credentials +
  recovery code. `DELETE /spaces/:id/wrappers/:wrapperId` + audit
  `keys.wrapper_removed` (device revoke flow rotates wrappers client-side).
- `GET /machine` → machine + last 20 events.
- `POST /machine/transition` {to: MachineState, reconstructed?, detail?} →
  validate with `canTransition` from @suma/protocol → 422 on illegal
  transition; update row, insert machineEvent, audit. (Real Fly calls sit
  behind `SandboxProvider` in `src/providers/sandbox.ts`: interface +
  `StubSandboxProvider` that just records calls — the V2 exit hatch, §7.)
- `GET /audit?limit=50` → recent audit events, newest first.
- `GET /healthz` (no auth) → `{ok:true}`.

Every route's failure modes covered by tests (vitest + PGlite +
`createApp(db).request(...)`): signup/duplicate, enroll/revoke honest
contract with affectedOrigins, wrapper upsert/list/delete, all legal machine
transitions + one illegal (running → suspended directly ⇒ 422), audit trail
ordering, auth 401s.

`src/server.ts`: reads env, `createDb`, migrates? No — for the initial phase
`src/db/migrate.ts` exports `ensureSchema(db)` executing CREATE TABLE IF NOT
EXISTS statements matching the schema exactly (tests call it against PGlite;
serve calls it on boot). Keep drizzle-kit config (`drizzle.config.ts`) for
real migrations later.
