# Spec: Phase 2 control plane — compute lifecycle, Job Mode, billing, abuse, audit

Extends `services/control` (base: docs/specs/control.md + phase1-control.md).
PRD §8.5, §9, §11, §12 Phase 2. All new code in services/control/src and test.
Deps preinstalled; do NOT edit package.json/tsconfig/eslint. Read the existing
src/** first, plus `@suma/protocol`'s new `lifecycle.ts` (decideSuspend,
explainVerdict, hourlyRateUsd, accruedCostUsd, ProcessTreeInfo) and `agent.ts`
(capabilities, CapabilityClaims, CAPABILITY_TOKEN_TTL_SECONDS) — those are the
shared source of truth; do not reimplement their logic.

## 1. Process-aware lifecycle (§8.5)

New table `machineActivity` (or extend `machines`): per machine, the agent's
last reported snapshot — `clientsAttached`, `processes` (jsonb array of
ProcessTreeInfo), `activeTransfers`, `lastInteractionAt`, `awakeMsAccrued`,
`lastReportAt`.

Routes:
- `POST /v1/machine/activity` — the agent (authenticated by a capability
  token, see §3) reports its snapshot. Persists it and returns the current
  suspend verdict from `decideSuspend`.
- `GET /v1/machine/lifecycle` — returns `{ verdict, explanation, wouldSuspendAt }`
  using `decideSuspend` + `explainVerdict`. This is what the UI's VM pill and
  the "why is this awake?" affordance read.
- `POST /v1/machine/job-mode` `{ ptyId, enabled }` — sets Job Mode for a PTY
  in the stored snapshot, audits `job.mode_changed`, and returns the new
  verdict. Job Mode pins the machine awake (§8.5).
- Extend the existing `POST /v1/machine/transition`: when transitioning to
  `suspending`, REFUSE with 409 `{ error: "would_interrupt_work", reason }`
  if `decideSuspend` says not to — unless the body sets `force: true` (an
  explicit user action). This is the guard that makes the §8.5 promise real
  rather than advisory. Auto-suspend callers must never pass force.
- `cold_booting → running` already exists; ensure the machineEvent records
  `reconstructed: true` so the client can surface the §8.5 "restored from cold
  start" notice.

## 2. Billing / usage metering (§11)

New table `usageSamples`: id, userId, machineId, periodStart, awakeMs,
proxiedBytes, storageGb, createdAt.
- `POST /v1/usage/sample` (agent/gateway authenticated) — append a sample.
- `GET /v1/usage/summary?days=30` — aggregate into the §11 line items:
  compute hours × `hourlyRateUsd`, egress bytes × $0.02/GB, volume, R2, plus
  a computed total and a `withinPlan: boolean` against a Pro allowance.
  Return the same shape the UI cost meter renders.
Keep the money math in one exported pure function (`estimateMonthlyCost`) in
`src/billing.ts` so it is unit-testable without the DB, and cite §11's table
in a comment. Do NOT invent prices beyond §11's numbers.

## 3. Agent capability tokens (I-2, §8.5)

`src/capabilities.ts`: mint short-lived capability tokens for the agent using
the SAME EdDSA signing keys as device tokens (`keys-provider.ts`), with
claims `{ mid, sub, caps, iat, exp, jti }` and `CAPABILITY_TOKEN_TTL_SECONDS`.
Reuse `signDeviceToken`/`verifyDeviceToken`'s JWS helpers if they generalize;
otherwise add a parallel `signCapabilityToken` in `@suma/protocol`… no —
protocol is frozen for this task, so implement signing here with the same
compact-JWS shape and a claims payload matching `CapabilityClaims`.

- `POST /v1/machine/capability-token` `{ caps }` (device-authenticated) —
  mints a token scoped to the caller's machine and the requested caps,
  REFUSING any cap not in `TERMINAL_CAPABILITIES` unless the request is for
  fetch/fs and the account has the corresponding feature. Audit
  `capability.minted` with the cap list.
- `bearerAgent` middleware verifying a capability token for agent-facing
  routes (`/v1/machine/activity`, `/v1/usage/sample`), checking machine
  binding and expiry. **A capability token must NOT authenticate any
  device/user route** — assert this in tests (I-2: the VM cannot impersonate
  a device).

## 4. Abuse controls (§9)

`src/abuse.ts` (pure + tested): per-user caps — max concurrent machines (1),
max boosts per day, max proxied GB/day, and a `port25Blocked` constant.
`POST /v1/machine/boost` consults it and 429s with a clear reason when
exceeded; audit `abuse.limit_hit`. Egress byte caps are enforced by returning
`{ throttled: true }` from the usage summary so the gateway can act.

## 5. Audit trail API (§8.7)

- `GET /v1/audit?limit=&cursor=&type=` — paginated, newest-first, scoped to
  the user, returning `{ entries, nextCursor }` where each entry has id, type,
  createdAt, actorDeviceId, and a **human summary string** built server-side
  (a `summarize(type, payload)` pure function in `src/audit-format.ts`,
  covering every audit type the codebase emits — grep for `audit(` to
  enumerate them, and add a default branch). The UI renders summaries
  verbatim, so they must read as plain sentences.

## Tests (vitest + PGlite, extend the existing suites)

Lifecycle: activity report → verdict; suspend transition refused while a
non-shell process is alive and allowed with force; Job Mode pins awake and is
audited; cold-boot transition records reconstructed. Billing:
`estimateMonthlyCost` line items and totals against §11's ranges; summary
aggregation across samples. Capabilities: minted token verifies, is machine-
bound, expires, cannot be used on a device route (401), and refuses
ungranted caps. Abuse: boost cap 429 + audit. Audit: pagination, cursor,
type filter, and a summary for every emitted audit type.

Verify: pnpm --filter @suma/control check-types && pnpm --filter @suma/control test.
