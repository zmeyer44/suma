# Spec: `services/sessionhub` (@suma/sessionhub)

> **Revision 2 (post-adversarial-review).** The implementation supersedes this
> spec in four places; `src/` is authoritative:
> 1. **Rollback deletes, no markers**: `rollback` removes stored versions of
>    the origin with `hlc > toHlc` (promoting an older retained version back
>    to latest when one survives) and requires the space to have been declared
>    in `hello`. The `rb:` marker and its hydration filter are gone — records
>    written after a rollback hydrate normally.
> 2. **Record history**: up to 8 most recent versions per (spaceId, recordId)
>    are retained (`hist:` keys, pruned oldest-first); hydration streams all
>    retained versions HLC-ascending so clients can prove causal descent for
>    the resurrection guard. Broadcast still carries only the newly accepted
>    record.
> 3. **Connection state**: the WS hibernation attachment holds only
>    `{ deviceId }`; declared spaces persist under `conn:<deviceId>` in DO
>    storage (cap 64, error frame `too_many_spaces` beyond).
> 4. **Presence**: closing a stale duplicate socket does not broadcast the
>    device offline while another socket for it remains open.
> Auth additionally accepts the device-bound enrollment token form
> `hbr_dev_<userId>.<deviceId>` minted by services/control.

Cloudflare Worker + Durable Object implementing the Session Plane (PRD §7,
§8.3). Stores sealed records, an HLC registry, origin leases, and device
presence. **The server never sees plaintext**: records are sealed client-side;
ids are keyed HMACs. Session sync never touches the VM (I-1) — this service
has no compute-plane calls at all.

## Package setup

`services/sessionhub/package.json`: name `@suma/sessionhub`, type module,
deps `@suma/protocol`, `@suma/config`, `zod`; devDeps `wrangler@^4`,
`@cloudflare/workers-types@^4`, typescript, vitest. Scripts: `dev` (wrangler
dev), `build` (wrangler deploy --dry-run --outdir dist), `check-types`,
`test` (vitest run), `lint`.

`wrangler.toml`: DO binding `SESSION_HUB` → class `SessionHub`, migration tag
v1, `compatibility_date = "2025-06-01"`. tsconfig: extends internal-library,
`"types": ["@cloudflare/workers-types"]`.

**Structure logic for unit-testability WITHOUT running workerd**: all
decision logic lives in `src/hub-core.ts` as a pure class `HubCore` operating
on an injected `HubStorage` interface (get/put/delete/list) + injected
`now()`. `src/session-hub.ts` (the DO class) is a thin adapter binding
`HubCore` to `DurableObjectState.storage` and hibernatable WebSockets. Vitest
tests cover `HubCore` with an in-memory `HubStorage` — no miniflare needed.

## Worker routing (`src/index.ts`)

- `GET /v1/hub/ws` — upgrade to WebSocket. Auth: `Authorization: Bearer <token>`
  where token is the device token minted by the control plane. For the
  initial phase, accept `hbr_dev_<userId>` tokens (documented stub) — verify
  structure, extract userId; TODO marker for control-plane-signed JWT.
  Device id comes from the `hello` frame. Route to DO id
  `idFromName(userId)` — one SessionHub DO per user.
- `POST /v1/hub/hydrate` — same auth, JSON `HydrateRequest`-shaped body, for
  non-WS hydration (first-device-enrollment fast path). Forwards to DO.
- `GET /healthz` → `{ ok: true }`.

## SessionHub DO behavior

Uses the **hibernatable WebSocket API** (`state.acceptWebSocket(ws, [deviceId])`,
`webSocketMessage`/`webSocketClose` handlers, `ws.serializeAttachment` for
per-socket `{ deviceId, spaceIds }`).

Message handling (frames validated with `parseClientMessage`; invalid frames
get `{t:'error', code:'malformed'}` and the socket stays open):

- `hello` → record presence (`presence:<deviceId>` → lastSeenMs), reply
  `hello.ack` with all known devices' presence, broadcast `presence` to
  others.
- `publish` → for each record:
  - drop records whose `spaceId` is not in the sender's hello-declared spaces → reject `malformed`.
  - **lease check**: if a lease exists for (spaceId, originId) held by a
    DIFFERENT device and unexpired → reject `lease_required`.
  - **HLC registry / staleness**: existing stored record with
    `compareHlc(stored.hlc, incoming.hlc) >= 0` → reject `stale`.
  - **rate limit**: per (deviceId, originId) sliding minute counter; over
    `MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE` → reject `stale`-class rejection
    with reason `malformed`? No — add reason value `rate_limited` is NOT in
    the protocol enum; use `stale` with an `error` frame alongside. Keep the
    protocol enum authoritative: reject reason `stale` and send an `error`
    frame `code:'rate_limited'`.
  - accept: store under `rec:<spaceId>:<recordId>`, update per-space HLC
    watermark `wm:<spaceId>` (max HLC), append accepted id to ack, and
    broadcast `{t:'records', spaceId, records:[...]}` to every OTHER socket
    that declared that space.
  - reply `publish.ack` with accepted/rejected.
  - The server does NOT verify device signatures (it can't know the key
    registry authoritatively in v0 and the records are opaque; devices verify
    on receipt) — but it DOES echo `deviceSig` through untouched.
- `hydrate` → stream stored records for the space with `hlc > sinceHlc`
  (chunk ≤ 256/frame as `records` frames), honor per-origin rollback marker
  (`rb:<spaceId>:<originId>` → exclude records with `hlc > marker` for that
  origin), then `hydrate.done` with count + watermark.
- `lease.acquire` → grant if free/expired/held-by-requester (TTL
  `ORIGIN_LEASE_TTL_MS`, cap requested ttlMs at 5× default); if held and
  `force` → transfer, notify previous holder with `lease.revoked`; else
  `lease.denied`. Persist leases (`lease:<spaceId>:<originId>`).
- `lease.release` → delete if held by requester.
- `rollback` → store rollback marker, broadcast `rollback.applied` to all
  sockets of that user (including sender).
- `workspace.publish` → LWW upsert per key (`ws:<key>` stores
  `WorkspaceRecordWire`; keep only if incoming hlc newer), broadcast winners
  as `workspace.records` to other sockets.
- `workspace.hydrate` → all workspace records with hlc > sinceHlc →
  `workspace.records` frames + `workspace.hydrate.done`.
- `ping` → `pong`.

`webSocketClose` → update presence, broadcast. All storage ops via `HubCore`.

## Tests (vitest, in-memory storage)

- publish/ack + staleness rejection + broadcast fan-out (fake sockets).
- lease lifecycle: grant → deny other device → expire (fake now) → grant;
  force takeover notifies previous holder; publish blocked by foreign lease.
- hydrate since watermark; chunking >256 records; rollback marker filters
  hydration and is broadcast.
- workspace LWW: older write loses, newer wins, broadcast only winners.
- rate limiting kicks in past the per-origin-minute cap.
- presence on hello/close.
- auth: bad token → 401; space not declared in hello → publish rejected.
