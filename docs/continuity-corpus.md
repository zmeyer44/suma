# The continuity corpus (internal product)

The supported-origin corpus (PRD §4) is not a spreadsheet — it is an internal
product: a compatibility pipeline with per-origin restore tests, challenge
detection, and regression alerting, budgeted as ongoing engineering. Suma
never claims a restore it hasn't verified.

**Seed data:** `packages/config/src/corpus.ts` (`SEED_CORPUS`, plus
`MEDIA_BYPASS_DOMAINS` and `SEEDED_HOSTILE_DOMAINS` for the egress plane).
The modes there are *starting assignments for Phase 0 measurement*, not
verified results — the automated pipeline that verifies them is not yet
built.

## Continuity modes

Every origin in a user's workspace carries a mode, surfaced as an indicator in
the sidebar/site controls:

| Mode | User experience | How assigned |
|---|---|---|
| **Portable** | Session restores automatically on a new device; no interaction. | Origin is in the tested corpus and passes automated restore checks. |
| **Assisted** | Tabs and app context restore; Suma invokes a passkey / normal reauth flow. One-touch. | Origin fails silent restore but supports fast reauth, or is untested. |
| **Device-bound** | Workspace restores; Suma explains the site requires a new device session. | DBSC / device-fingerprinting detected, or user/policy exclusion. |

Untested origins default to **Assisted** — Portable is earned by passing
tests, never assumed.

## Per-origin metrics (pipeline outputs)

- Automatic restore rate
- Assisted reauth rate
- Unexpected-challenge rate
- Session-corruption rate

These feed the corpus (mode reassignment, `rotatingAuth` flagging for the
origin-lease path in §8.3) and the success metrics in PRD §13.

## Staged rollout

New origins — and mode changes for existing origins — roll out **one device →
all devices**. An untested origin is never propagated fleet-wide immediately.
Every corpus origin has a per-origin last-known-good restore point, rollback,
and kill switch (PRD §8.3), so a bad rollout is recoverable without nuking
the jar.

## Sensitive-origin exclusions

Banks, corporate SSO, and user-flagged origins default to **Assisted** or
**Device-bound** and are **excluded from sync unless explicitly opted in**.
In the seed data these carry `sensitive: true` and `syncTier: 0`. Banks are
adversarial compatibility tests, not part of the promise (PRD M-1).

## Why this exists at all

Cookie portability is an eroding assumption (Chrome DBSC binds session renewal
to device-held keys). The corpus is the mitigation: the product promise is
per-origin, tested, and labeled — and the pipeline detects when an origin's
binding behavior changes (PRD §14.2).
