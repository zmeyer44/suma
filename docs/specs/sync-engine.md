# Spec: `packages/sync-engine` (@suma/sync-engine)

Client-side session sync engine implementing PRD §8.3. Pure TypeScript, no
Electron imports — runs in the Electron main process and in Node tests.
Depends only on `@suma/protocol` and `@suma/config`.

> **Revision 2 (post-adversarial-review).** The implementation supersedes this
> spec in four places; `src/` is authoritative:
> 1. The resurrection guard is an **ancestry edge map + HLC-bounded descent
>    walk** (every version token names its parent; verdicts are a function of
>    the record *set*, not delivery order), with blocked writes **parked**
>    (max-HLC per record) and retried as ancestry knowledge grows. An incoming
>    EXPLICIT_DELETE loses to a live write only when that write *provably*
>    descends from it.
> 2. Echo suppression covers **every** `applier.apply` (not just hydration),
>    keyed by (recordId, state fingerprint) with a TTL (`echoTtlMs`, default
>    10 s) so no-event applies cannot poison later genuine writes.
> 3. `RemoteDisposition` gains `'rejected'` (failed signature verification,
>    unsealing, or sealed-identity re-binding). Options gain
>    `verifier?: RecordVerifier` (see `src/verify.ts`,
>    `DeviceRegistryVerifier`) and `leaseTtlMs` — lease grants are cached for
>    half the server TTL, then re-acquired.
> 4. Remote records are unsealed first and their sealed identity re-bound to
>    the wire `recordId`/`originId` before any state is touched.

## Package setup

Mirror `packages/protocol`: `"exports": { ".": "./src/index.ts" }`, scripts
`check-types` (tsc --noEmit), `test` (vitest run), `lint`. Add dev dep
`fast-check@^4` for property tests. tsconfig extends
`@suma/typescript-config/internal-library.json`.

## Core model

The engine owns one **cookie jar view per space**: `Map<recordIdHex, StoredRecord>`.

```ts
interface StoredRecord {
  recordId: string;            // hex
  originId: string;            // hex
  plain: CookiePlain;          // decrypted (client side always has keys)
  wire: CookieRecordWire;      // last accepted sealed+signed form
  cause: Cause;
  hlc: Hlc;
  causalParent: string | null; // VersionToken
  /** local wall-time when a deletion was accepted — for tombstone GC */
  tombstonedAtMs: number | null;
}
```

## Public API (exact — desktop main is coded against this)

```ts
export interface SyncTransport {
  publish(records: CookieRecordWire[]): void;                 // fire-and-forget; transport acks async
  acquireLease(spaceId: string, originId: string, force?: boolean): Promise<boolean>;
  releaseLease(spaceId: string, originId: string): void;
}

export interface CookieApplier {
  /** Apply an accepted remote record to the local cookie store (Electron session).
   *  Engine calls this ONLY for records that won conflict resolution. */
  apply(plain: CookiePlain, cause: Cause): Promise<void>;
}

export interface SyncEngineOptions {
  deviceId: string;
  clock?: HlcClock;                       // default new HlcClock(deviceId)
  now?: () => number;                     // default Date.now
  policies?: ReadonlyArray<OriginPolicy>; // default SEED_CORPUS
  tombstoneRetentionMs?: number;          // default TOMBSTONE_RETENTION_MS
}

export class SpaceSyncEngine {
  constructor(
    spaceId: string,
    keys: SpaceKeys,
    signer: { deviceId: string; privateKey: CryptoKey },
    transport: SyncTransport,
    applier: CookieApplier,
    opts: SyncEngineOptions,
  );

  /** A local cookie mutation observed from the browser (cookies 'changed').
   *  Seals, signs, records causal parent, enqueues for publish.
   *  MUST no-op (record cause HYDRATION_ECHO, never publish) while
   *  `beginHydration()` is active or when the change matches an in-flight
   *  hydration apply. Returns the wire record it queued, or null if suppressed
   *  or not synced (policy tier 0 / sensitive without opt-in / user override). */
  async localChange(identity: CookieIdentity, attrs: CookieAttributes | null, removed: boolean, chromiumCause: string): Promise<CookieRecordWire | null>;

  /** Remote records from the transport (broadcast or hydration stream).
   *  Runs conflict resolution; calls applier for winners. Returns per-record
   *  disposition for tests: 'applied' | 'stale' | 'resurrection-blocked' | 'duplicate'. */
  async applyRemote(records: CookieRecordWire[]): Promise<RemoteDisposition[]>;

  /** Hydration flow: streamed encrypted jar → decrypt → bulk apply before
   *  first WebContentsView attaches. Suppresses echo publishing (§8.3). */
  async beginHydration(): Promise<void>;
  async endHydration(): Promise<void>;

  /** Restore point + rollback (per-origin last-known-good, §8.3). */
  snapshotOrigin(originId: string): OriginSnapshot;
  async rollbackOrigin(originId: string, snapshot: OriginSnapshot): Promise<CookieRecordWire[]>; // republishes restored state

  /** Offline queue: engine enqueues when transport reports disconnected. */
  setOnline(online: boolean): void;             // drains queue (HLC order) on true
  get queueDepth(): number;

  /** Tombstone GC — never collects tombstones younger than retention. */
  gcTombstones(): number;

  /** Test/introspection */
  getRecord(recordIdHex: string): StoredRecord | undefined;
  listLiveCookies(): CookiePlain[];
}
```

`OfflineQueue` is its own exported class: append-only with HLC ordering,
pluggable persistence (`QueueStorage` interface + in-memory impl provided;
the desktop app supplies a SQLite-backed one later).

## Conflict resolution (exact semantics — the fidelity harness proves these)

For incoming record `R` vs current record `C` for the same recordId:

1. **No `C`**: accept — EXCEPT incoming `cause === 'HYDRATION_ECHO'`
   (defensive: echoes must never cross the wire; treat as no-op `'duplicate'`).
2. **LWW default**: accept iff `compareHlc(R.hlc, C.hlc) > 0`, else `'stale'`.
3. **Resurrection guard**: if `C.cause === 'EXPLICIT_DELETE'` and `R` is a
   write (`WRITE`/`OVERWRITE`), accept ONLY if `R.causalParent` references
   `C`'s exact version (`makeVersionToken(C.recordId, C.hlc)`) — i.e. the
   writer had seen the logout. Otherwise `'resurrection-blocked'` EVEN IF
   `R.hlc > C.hlc`. (PRD: "an EXPLICIT deletion beats a later write whose
   causal history predates it.")
4. **EXPLICIT_DELETE incoming**: wins over `C` if `R.hlc > C.hlc` OR
   `R.causalParent` references `C`'s version (a delete of what we currently
   have always lands). `EXPIRED`/`EVICTED` deletes follow plain LWW (rule 2).
5. Ties (`compareHlc === 0`) are duplicates → `'duplicate'`.

Local changes always set `causalParent` to the current version token of that
recordId (or null). Deletion causes map from Chromium change causes:
`explicit` → EXPLICIT_DELETE, `expired`/`expired-overwrite` → EXPIRED,
`evicted` → EVICTED, `overwrite` → OVERWRITE (non-removal) / ignore the
removal half of an overwrite pair.

**Rotating-auth origins** (`policy.rotatingAuth`): before publishing a write,
`acquireLease(spaceId, originId)` must resolve true; otherwise queue the
record until granted. Remote applies are unaffected.

**Policy gate**: `matchOriginPolicy` on `normalizedHost(hostKey)`. Tier 0 or
(sensitive && no explicit user opt-in via `setOriginOverride(host, 'sync')`)
⇒ `localChange` returns null (nothing captured). Maintain an override map
(`'sync' | 'never'`) exposed via `setOriginOverride`/`getOriginPolicyFor`.

## Cookie-fidelity harness (Phase 0 exit criterion — this IS the deliverable)

`test/fidelity.property.test.ts` using fast-check:

1. **Convergence**: N∈[2,4] replicas (each its own `SpaceSyncEngine` with an
   in-memory applier + loopback transport harness), random op sequences
   (write/overwrite/explicit-delete/expire on a small identity pool with
   varied hostKey/partitionKey/sourceScheme), random delivery orders &
   interleavings, full eventual delivery ⇒ all replicas' `listLiveCookies()`
   converge to identical sets, and every replica's record map agrees on
   (hlc, cause) per recordId.
2. **No resurrection**: scripted PRD scenario — device A EXPLICIT-deletes;
   device B (offline, never saw the delete) writes the same identity with a
   LATER HLC; deliver B's write to A and to a fresh replica C that got A's
   tombstone first ⇒ cookie stays deleted on A and C
   (`'resurrection-blocked'`); then B receives the tombstone and also
   converges to deleted. Also as a property over random schedules.
3. **Echo suppression**: hydrating a jar of K records publishes zero records.
4. **Tuple fidelity**: two cookies differing ONLY in hostKey dot-scope /
   partitionKey / sourceScheme never collide (distinct recordIds, both live).
5. **Tombstone GC**: tombstones younger than retention are never collected;
   post-GC a stale write with pre-delete ancestry is still blocked while the
   tombstone is retained.
6. **Offline queue ordering**: mutations made offline drain in HLC order and
   arrive exactly once.

Also unit tests for lease gating (rotating-auth write requires lease; queued
until granted) and policy gating (sensitive origin captured only after
opt-in).

The harness needs a `LoopbackHub` test helper (in `test/helpers.ts`):
an in-memory hub connecting engines, with per-link partition/reorder/delay
controls driven by fast-check-generated schedules. Deterministic: use
fc.scheduler or explicit queues — no timers, no Math.random inside the hub.
