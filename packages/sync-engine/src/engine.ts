/**
 * SpaceSyncEngine — client-side session sync engine (PRD §8.3).
 *
 * Conflict semantics:
 *   - LWW+HLC for ordinary cookies.
 *   - Causal resurrection guard: an EXPLICIT deletion beats a later write
 *     whose causal history predates it. Descent is decided by walking the
 *     ancestry edge map (every version token names its parent via the
 *     record's own causalParent, so edges are learned from every record seen
 *     — applied, stale, or blocked — making the verdict a function of the
 *     record SET, not delivery order). Token-embedded HLCs bound the walk: a
 *     chain that drops below the deletion's HLC can never reach it.
 *   - Blocked writes are parked (max-HLC per record) and retried as ancestry
 *     knowledge grows, so a legitimate post-logout chain delivered out of
 *     order converges instead of being dropped.
 *   - Tombstone normalization: when a deletion is accepted, the stored
 *     tombstone is the max-HLC deletion seen for that record, so replicas that
 *     saw concurrent deletions in different orders agree on final (hlc, cause).
 *   - Echo suppression: EVERY applier.apply registers an expected echo keyed
 *     by (recordId, state fingerprint) with a TTL, so cookie-store change
 *     events caused by remote applies are never republished as local
 *     mutations — in steady state as well as during hydration — while
 *     applies that emit no event at all cannot poison future genuine writes.
 *   - Rotating-auth origin leases (client-side conservative expiry at half
 *     the server TTL), policy gating, offline queue with HLC-ordered drain,
 *     tombstone GC with retention, per-origin snapshot/rollback, and
 *     optional device-signature verification of remote records.
 *   - Rotating-auth deletions are writer-scoped: only the device holding the
 *     origin lease may propagate them. On a passive device, cookie deletions
 *     for a rotating-auth origin are overwhelmingly the server killing a
 *     STALE generation (the active device rotated; this copy died), so they
 *     stay local and EXPLICIT_DELETE demotes to EXPIRED — no resurrection
 *     fence — letting the peer's live session win back by plain LWW instead
 *     of being blocked for the tombstone retention window. An explicit-intent
 *     flag (manual "push this Mac's state") bypasses the guard.
 */

import {
  ORIGIN_LEASE_TTL_MS,
  SEED_CORPUS,
  TOMBSTONE_RETENTION_MS,
} from "@suma/config";
import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  decodeCookiePlain,
  DELETION_CAUSES,
  encodeCookiePlain,
  fromBase64,
  HlcClock,
  lengthPrefixed,
  makeVersionToken,
  matchOriginPolicy,
  normalizedHost,
  open,
  parseVersionToken,
  seal,
  signRecord,
  toBase64,
  type Cause,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type Hlc,
  type OriginPolicy,
  type PublishRejection,
  type SignableRecordFields,
  type SpaceKeys,
  type VersionToken,
} from "@suma/protocol";
import { OfflineQueue } from "./queue.js";
import type {
  CookieApplier,
  OriginOverride,
  OriginPolicyView,
  OriginSnapshot,
  RecordVerifier,
  RemoteDisposition,
  StoredRecord,
  SyncEngineOptions,
  SyncTransport,
} from "./types.js";

const SEAL_AAD_DOMAIN = "suma.sync.seal.v1";

/** AAD binding a sealed record to its space and pseudonymous record id. */
export function recordSealAad(
  spaceId: string,
  recordIdHex: string,
): Uint8Array {
  return lengthPrefixed([SEAL_AAD_DOMAIN, spaceId, recordIdHex]);
}

/**
 * Map a Chromium cookies-'changed' cause to a sync Cause. Returns null for the
 * removal half of an overwrite pair — the non-removal half carries the
 * mutation, so the removal must not produce a record of its own.
 */
export function causeForChange(
  chromiumCause: string,
  removed: boolean,
): Cause | null {
  if (!removed) return chromiumCause === "overwrite" ? "OVERWRITE" : "WRITE";
  switch (chromiumCause) {
    case "explicit":
      return "EXPLICIT_DELETE";
    case "expired":
    case "expired-overwrite":
      return "EXPIRED";
    case "evicted":
      return "EVICTED";
    case "overwrite":
      return null;
    default:
      return "EXPLICIT_DELETE";
  }
}

export interface RecordSigner {
  deviceId: string;
  privateKey: CryptoKey;
}

/** Seal + sign one cookie mutation into its wire form. */
export async function buildCookieRecordWire(
  keys: SpaceKeys,
  signer: RecordSigner,
  plain: CookiePlain,
  hlc: Hlc,
  causalParent: VersionToken | null,
  cause: Cause,
): Promise<CookieRecordWire> {
  const spaceId = plain.identity.spaceId;
  const recordId = await computeRecordIdHex(keys.idKey, plain.identity);
  const originId = await computeOriginIdHex(
    keys.idKey,
    spaceId,
    plain.identity.hostKey,
  );
  const sealed = await seal(
    keys.sealKey,
    encodeCookiePlain(plain),
    recordSealAad(spaceId, recordId),
  );
  const fields: SignableRecordFields = {
    spaceId,
    recordId,
    originId,
    sealedRecord: toBase64(sealed),
    hlc,
    causalParent,
    cause,
  };
  const deviceSig = toBase64(await signRecord(signer.privateKey, fields));
  return { ...fields, deviceSig };
}

interface DeleteFence {
  hlc: Hlc;
  token: VersionToken;
}

interface TombstoneNote {
  wire: CookieRecordWire;
  plain: CookiePlain;
}

interface EchoEntry {
  count: number;
  expiresAtMs: number;
}

const DEFAULT_ECHO_TTL_MS = 10_000;
/** Ancestry edges retained per record; evicted oldest-HLC-first. */
const MAX_ANCESTRY_EDGES = 64;
/** Hard cap on a descent walk (cycle/adversarial-chain protection). */
const MAX_ANCESTRY_WALK = 128;
/** Lazy-prune threshold for the echo ledger. */
const ECHO_SWEEP_THRESHOLD = 256;

type Descent = "descends" | "predates" | "unknown";

export class SpaceSyncEngine {
  private readonly records = new Map<string, StoredRecord>();
  private readonly fences = new Map<string, DeleteFence>();
  private readonly latestTombstones = new Map<string, TombstoneNote>();
  /** Per recordId: version token → causal-parent token (null = first write). */
  private readonly ancestry = new Map<
    string,
    Map<VersionToken, VersionToken | null>
  >();
  /** Max-HLC resurrection-blocked write per record, retried as edges grow. */
  private readonly parked = new Map<string, CookieRecordWire>();
  private readonly overrides = new Map<string, OriginOverride>();
  private readonly pendingEchoes = new Map<string, EchoEntry>();
  private readonly grantedLeases = new Map<string, number>();
  private readonly retryingLeaseRejections = new Set<string>();
  private readonly queue = new OfflineQueue();
  private readonly clock: HlcClock;
  private readonly nowFn: () => number;
  private readonly policies: ReadonlyArray<OriginPolicy>;
  private readonly tombstoneRetentionMs: number;
  private readonly leaseTtlMs: number;
  private readonly echoTtlMs: number;
  private readonly verifier: RecordVerifier | null;
  private hydrating = false;
  private online = true;
  private draining = false;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly spaceId: string,
    private readonly keys: SpaceKeys,
    private readonly signer: { deviceId: string; privateKey: CryptoKey },
    private readonly transport: SyncTransport,
    private readonly applier: CookieApplier,
    opts: SyncEngineOptions,
  ) {
    this.nowFn = opts.now ?? ((): number => Date.now());
    this.clock = opts.clock ?? new HlcClock(opts.deviceId, this.nowFn);
    this.policies = opts.policies ?? SEED_CORPUS;
    this.tombstoneRetentionMs =
      opts.tombstoneRetentionMs ?? TOMBSTONE_RETENTION_MS;
    this.leaseTtlMs = opts.leaseTtlMs ?? ORIGIN_LEASE_TTL_MS;
    this.echoTtlMs = opts.echoTtlMs ?? DEFAULT_ECHO_TTL_MS;
    this.verifier = opts.verifier ?? null;
  }

  /** A local cookie mutation observed from the browser (cookies 'changed'). */
  /**
   * Whether this engine already holds a record for a cookie identity (applied
   * from a peer or written locally). Used to seed pre-existing local cookies
   * once after hydration WITHOUT re-publishing — and, crucially, without
   * clobbering: a cookie the peer already sent has a record here, so seeding
   * skips it and can never overwrite the peer's value with a stale local copy.
   */
  async hasRecord(identity: CookieIdentity): Promise<boolean> {
    if (identity.spaceId !== this.spaceId) return false;
    const recordId = await computeRecordIdHex(this.keys.idKey, identity);
    return this.records.has(recordId);
  }

  async localChange(
    identity: CookieIdentity,
    attrs: CookieAttributes | null,
    removed: boolean,
    chromiumCause: string,
    opts: { explicitIntent?: boolean } = {},
  ): Promise<CookieRecordWire | null> {
    if (identity.spaceId !== this.spaceId) {
      throw new Error("cookie identity belongs to another space");
    }
    let cause = causeForChange(chromiumCause, removed);
    if (cause === null) return null;
    if (!removed && attrs === null) {
      throw new Error(
        "cookie attributes are required for a non-removal change",
      );
    }
    const plain: CookiePlain = {
      identity: { ...identity },
      attributes: !removed && attrs ? { ...attrs } : null,
      deleted: removed,
    };
    const recordId = await computeRecordIdHex(this.keys.idKey, identity);
    if (this.consumeEcho(recordId, plain)) return null;
    if (!this.isSynced(identity.hostKey)) return null;
    const policy = matchOriginPolicy(
      this.policies,
      normalizedHost(identity.hostKey),
    );
    // Writer-scoped deletions (see header): on a rotating-auth origin, a
    // deletion observed while this device is NOT the active writer is almost
    // always the server retiring a stale generation, not user intent. It must
    // neither propagate (it would sign the healthy device out) nor leave an
    // EXPLICIT fence (it would resurrection-block the peer's live session for
    // the whole tombstone retention window). Record it locally as EXPIRED so
    // the peer's next rotation wins back by plain LWW.
    let localOnly = false;
    if (
      policy.rotatingAuth &&
      DELETION_CAUSES.has(cause) &&
      opts.explicitIntent !== true
    ) {
      const originId = await computeOriginIdHex(
        this.keys.idKey,
        this.spaceId,
        identity.hostKey,
      );
      const grant = this.grantedLeases.get(originId);
      if (grant === undefined || grant <= this.nowFn()) {
        localOnly = true;
        if (cause === "EXPLICIT_DELETE") cause = "EXPIRED";
      }
    }
    const hlc = this.clock.send();
    const current = this.records.get(recordId);
    const causalParent = current
      ? makeVersionToken(recordId, current.hlc)
      : null;
    const wire = await buildCookieRecordWire(
      this.keys,
      this.signer,
      plain,
      hlc,
      causalParent,
      cause,
    );
    this.noteAncestry(wire);
    this.noteFence(wire);
    if (DELETION_CAUSES.has(cause)) this.noteTombstone(wire, plain);
    this.store(wire, plain);
    if (!localOnly) {
      const needsLease = policy.rotatingAuth && !DELETION_CAUSES.has(cause);
      await this.publishOrQueue(wire, needsLease);
    }
    await this.retryParked(recordId);
    return wire;
  }

  /** Remote records from the transport (broadcast or hydration stream). */
  async applyRemote(records: CookieRecordWire[]): Promise<RemoteDisposition[]> {
    const dispositions: RemoteDisposition[] = [];
    for (const record of records) {
      dispositions.push(await this.applyOne(record));
    }
    return dispositions;
  }

  /** Decrypt and identity-check a staged record without mutating engine/browser state. */
  async inspectRemoteIdentity(
    record: CookieRecordWire,
  ): Promise<CookieIdentity | null> {
    if (record.spaceId !== this.spaceId) return null;
    if (this.verifier && !(await this.verifier.verify(record))) return null;
    try {
      const plain = await this.openRecord(record);
      return (await this.identityBound(record, plain))
        ? structuredClone(plain.identity)
        : null;
    } catch {
      return null;
    }
  }

  async beginHydration(): Promise<void> {
    this.hydrating = true;
  }

  async endHydration(): Promise<void> {
    this.hydrating = false;
  }

  snapshotOrigin(originId: string): OriginSnapshot {
    const records: StoredRecord[] = [];
    for (const record of this.records.values()) {
      if (record.originId === originId) records.push(structuredClone(record));
    }
    return {
      spaceId: this.spaceId,
      originId,
      capturedAtMs: this.nowFn(),
      records,
    };
  }

  /** Restore per-origin last-known-good state and republish it (PRD §8.3). */
  async rollbackOrigin(
    originId: string,
    snapshot: OriginSnapshot,
  ): Promise<CookieRecordWire[]> {
    const republished: CookieRecordWire[] = [];
    const snapshotIds = new Set(
      snapshot.records.map((record) => record.recordId),
    );
    for (const record of [...this.records.values()]) {
      if (
        record.originId !== originId ||
        snapshotIds.has(record.recordId) ||
        record.plain.deleted
      ) {
        continue;
      }
      const plain: CookiePlain = {
        identity: structuredClone(record.plain.identity),
        attributes: null,
        deleted: true,
      };
      republished.push(await this.reissue(plain, "EXPLICIT_DELETE"));
    }
    for (const record of snapshot.records) {
      const cause: Cause = record.plain.deleted ? "EXPLICIT_DELETE" : "WRITE";
      republished.push(
        await this.reissue(structuredClone(record.plain), cause),
      );
    }
    return republished;
  }

  /** Offline queue: engine enqueues when transport reports disconnected. */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      void this.flushPending();
      return;
    }
    for (const originId of this.grantedLeases.keys()) {
      this.transport.releaseLease(this.spaceId, originId);
    }
    this.grantedLeases.clear();
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Flush mutations accumulated while offline. Workspace navigation sync uses
   * this as part of its causal fence: a redirect URL must never overtake the
   * cookies that make that URL authenticated.
   */
  flushPending(): Promise<void> {
    if (!this.online) return Promise.resolve();
    if (this.drainPromise !== null) return this.drainPromise;
    const pending = this.runDrainQueue().finally(() => {
      if (this.drainPromise === pending) this.drainPromise = null;
    });
    this.drainPromise = pending;
    return pending;
  }

  /** The hub transferred this exact origin to another active device. */
  leaseRevoked(originId: string): void {
    this.grantedLeases.delete(originId);
  }

  /**
   * Recover an optimistic publish that raced a forced lease handoff. The ack
   * identifies a cookie, not an exact version, so retry the newest local
   * winner: replaying the rejected older generation could roll the site back.
   */
  async publishRejected(
    recordId: string,
    reason: PublishRejection["reason"],
  ): Promise<void> {
    if (
      reason !== "lease_required" ||
      this.retryingLeaseRejections.has(recordId)
    )
      return;
    const current = this.records.get(recordId);
    if (
      current === undefined ||
      current.hlc.deviceId !== this.signer.deviceId ||
      DELETION_CAUSES.has(current.cause)
    )
      return;

    this.retryingLeaseRejections.add(recordId);
    try {
      this.grantedLeases.delete(current.originId);
      if (!this.online) {
        this.queue.enqueue(current.wire);
        return;
      }
      // Force is reserved for this validated recovery path: the hub rejected
      // a publish and `current` is still the newest local winner. Ordinary
      // capture/drain must respect the existing rotating-auth writer.
      if (
        !(await this.acquireLease(current.originId, true, {
          recordId: current.recordId,
          hlc: current.hlc,
        }))
      ) {
        this.queue.enqueue(current.wire);
        return;
      }
      this.transport.publish([current.wire]);
    } finally {
      this.retryingLeaseRejections.delete(recordId);
    }
  }

  /** Tombstone GC — never collects tombstones younger than retention. */
  gcTombstones(): number {
    const cutoff = this.nowFn() - this.tombstoneRetentionMs;
    let collected = 0;
    for (const [recordId, record] of [...this.records]) {
      if (record.tombstonedAtMs === null || record.tombstonedAtMs >= cutoff)
        continue;
      this.records.delete(recordId);
      this.fences.delete(recordId);
      this.latestTombstones.delete(recordId);
      this.ancestry.delete(recordId);
      this.parked.delete(recordId);
      collected += 1;
    }
    return collected;
  }

  getRecord(recordIdHex: string): StoredRecord | undefined {
    return this.records.get(recordIdHex);
  }

  listLiveCookies(): CookiePlain[] {
    const live: CookiePlain[] = [];
    for (const record of this.records.values()) {
      if (!record.plain.deleted) live.push(record.plain);
    }
    return live;
  }

  /** Re-apply stored winners when an origin moves from structured to native networking. */
  async reapplyOrigin(host: string): Promise<number> {
    const target = normalizedHost(host);
    let applied = 0;
    for (const record of this.records.values()) {
      const cookieHost = normalizedHost(record.plain.identity.hostKey);
      if (cookieHost !== target && !cookieHost.endsWith(`.${target}`)) continue;
      if (
        !this.isSynced(cookieHost) ||
        this.applier.canApply?.(record.plain) === false
      )
        continue;
      this.expectEcho(record.recordId, record.plain);
      await this.applier.apply(record.plain, record.cause);
      applied += 1;
    }
    return applied;
  }

  /** Per-origin user override: explicit opt-in to sync, or never sync. */
  setOriginOverride(host: string, override: OriginOverride | null): void {
    const key = normalizedHost(host);
    if (override === null) this.overrides.delete(key);
    else this.overrides.set(key, override);
  }

  getOriginPolicyFor(host: string): OriginPolicyView {
    const normalized = normalizedHost(host);
    return {
      policy: matchOriginPolicy(this.policies, normalized),
      override: this.lookupOverride(normalized),
      synced: this.isSynced(normalized),
    };
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async applyOne(record: CookieRecordWire): Promise<RemoteDisposition> {
    const disposition = await this.ingest(record, true);
    await this.retryParked(record.recordId);
    return disposition;
  }

  private async ingest(
    record: CookieRecordWire,
    allowPark: boolean,
  ): Promise<RemoteDisposition> {
    // Echoes must never cross the wire — drop defensively whatever our state.
    if (record.cause === "HYDRATION_ECHO") return "duplicate";
    if (record.spaceId !== this.spaceId) return "rejected";
    if (this.verifier && !(await this.verifier.verify(record)))
      return "rejected";
    let plain: CookiePlain;
    try {
      plain = await this.openRecord(record);
    } catch {
      // Almost always a key mismatch: this device holds the wrong space secret
      // (a second device that never received the account's keys). Silently
      // dropping made a mis-keyed device look perfectly converged; a warning
      // makes it diagnosable (§8.2). Not fatal — other records may still open.
      console.warn(
        `suma sync: dropped a record for space ${this.spaceId} it could not unseal — likely a key mismatch on this device`,
      );
      return "rejected";
    }
    if (!(await this.identityBound(record, plain))) return "rejected";
    this.clock.receive(record.hlc);
    this.noteAncestry(record);
    this.noteFence(record);
    if (DELETION_CAUSES.has(record.cause)) this.noteTombstone(record, plain);
    const disposition = this.resolve(this.records.get(record.recordId), record);
    if (disposition === "resurrection-blocked" && allowPark) this.park(record);
    if (disposition !== "applied") return disposition;
    let winner: TombstoneNote;
    if (DELETION_CAUSES.has(record.cause)) {
      winner = this.latestTombstones.get(record.recordId) ?? {
        wire: record,
        plain,
      };
    } else {
      winner = { wire: record, plain };
    }
    if (this.applier.canApply?.(winner.plain) !== false) {
      this.expectEcho(winner.wire.recordId, winner.plain);
      try {
        await this.applier.apply(winner.plain, winner.wire.cause);
      } catch (err) {
        this.cancelExpectedEcho(winner.wire.recordId, winner.plain);
        throw err;
      }
    }
    // Commit only after Chromium accepted the mutation. If cookie-store I/O
    // fails, a repeated hydration record must remain eligible for retry.
    this.store(winner.wire, winner.plain);
    return "applied";
  }

  private resolve(
    current: StoredRecord | undefined,
    record: CookieRecordWire,
  ): RemoteDisposition {
    const thisToken = makeVersionToken(record.recordId, record.hlc);
    if (record.cause === "WRITE" || record.cause === "OVERWRITE") {
      const fence = this.fences.get(record.recordId);
      if (fence && compareHlc(record.hlc, fence.hlc) > 0) {
        // Newer than the newest explicit deletion: allowed only if its causal
        // history provably includes that deletion (PRD §8.3).
        if (
          this.descent(record.recordId, record.causalParent, fence) !==
          "descends"
        ) {
          return "resurrection-blocked";
        }
      }
      if (!current) return "applied";
      const cmp = compareHlc(record.hlc, current.hlc);
      if (cmp === 0) return "duplicate";
      return cmp > 0 ? "applied" : "stale";
    }
    if (record.cause === "EXPLICIT_DELETE") {
      if (!current) return "applied";
      const cmp = compareHlc(record.hlc, current.hlc);
      if (cmp === 0) return "duplicate";
      if (cmp > 0) return "applied";
      if (DELETION_CAUSES.has(current.cause)) return "stale";
      // Current is a live write with a newer HLC. If an even newer explicit
      // deletion is known, current has already been resolved against it and
      // this older deletion is superseded.
      const fence = this.fences.get(record.recordId);
      if (fence && fence.token !== thisToken) return "stale";
      // The deletion wins unless current provably descends from it — an
      // EXPLICIT deletion beats a later write whose history predates it, and
      // unproven history is treated as predating (conservative: a killed
      // session must not survive on ambiguity).
      const currentToken = makeVersionToken(current.recordId, current.hlc);
      const verdict = this.descent(record.recordId, currentToken, {
        hlc: record.hlc,
        token: thisToken,
      });
      return verdict === "descends" ? "stale" : "applied";
    }
    // EXPIRED / EVICTED deletes follow plain LWW.
    if (!current) return "applied";
    const cmp = compareHlc(record.hlc, current.hlc);
    if (cmp === 0) return "duplicate";
    return cmp > 0 ? "applied" : "stale";
  }

  /**
   * Walk ancestry edges from `startToken` toward roots, deciding whether the
   * chain passes through `fence.token`. Token-embedded HLCs give a sound
   * early exit: causal descent implies HLC descent, so a chain whose HLC
   * drops below the fence's can never reach it.
   */
  private descent(
    recordId: string,
    startToken: VersionToken | null,
    fence: DeleteFence,
  ): Descent {
    if (startToken === null) return "predates";
    const edges = this.ancestry.get(recordId);
    let token: VersionToken | null = startToken;
    for (let step = 0; step < MAX_ANCESTRY_WALK && token !== null; step += 1) {
      if (token === fence.token) return "descends";
      let hlc: Hlc;
      try {
        hlc = parseVersionToken(token).hlc;
      } catch {
        return "unknown";
      }
      if (compareHlc(hlc, fence.hlc) < 0) return "predates";
      const parent: VersionToken | null | undefined = edges?.get(token);
      if (parent === undefined) return "unknown";
      token = parent;
    }
    return token === null ? "predates" : "unknown";
  }

  private noteAncestry(
    record: Pick<CookieRecordWire, "recordId" | "hlc" | "causalParent">,
  ): void {
    let edges = this.ancestry.get(record.recordId);
    if (!edges) {
      edges = new Map();
      this.ancestry.set(record.recordId, edges);
    }
    const token = makeVersionToken(record.recordId, record.hlc);
    if (edges.has(token)) return;
    edges.set(token, record.causalParent);
    if (edges.size <= MAX_ANCESTRY_EDGES) return;
    let oldest: VersionToken | null = null;
    let oldestHlc: Hlc | null = null;
    for (const t of edges.keys()) {
      try {
        const h = parseVersionToken(t).hlc;
        if (oldestHlc === null || compareHlc(h, oldestHlc) < 0) {
          oldestHlc = h;
          oldest = t;
        }
      } catch {
        oldest = t;
        break;
      }
    }
    if (oldest !== null) edges.delete(oldest);
  }

  private noteFence(
    record: Pick<CookieRecordWire, "recordId" | "hlc" | "cause">,
  ): void {
    if (record.cause !== "EXPLICIT_DELETE") return;
    const fence = this.fences.get(record.recordId);
    if (!fence || compareHlc(record.hlc, fence.hlc) > 0) {
      this.fences.set(record.recordId, {
        hlc: record.hlc,
        token: makeVersionToken(record.recordId, record.hlc),
      });
    }
  }

  private park(record: CookieRecordWire): void {
    const existing = this.parked.get(record.recordId);
    if (!existing || compareHlc(record.hlc, existing.hlc) > 0) {
      this.parked.set(record.recordId, record);
    }
  }

  /**
   * Re-judge the parked write for a record after new knowledge arrived. A
   * still-blocked record stays parked; a superseded one is dropped; an
   * unblocked one is ingested through the normal path.
   */
  private async retryParked(recordId: string): Promise<void> {
    const parkedRecord = this.parked.get(recordId);
    if (!parkedRecord) return;
    const verdict = this.resolve(this.records.get(recordId), parkedRecord);
    if (verdict === "resurrection-blocked") return;
    this.parked.delete(recordId);
    if (verdict !== "applied") return;
    await this.ingest(parkedRecord, false);
  }

  private noteTombstone(wire: CookieRecordWire, plain: CookiePlain): void {
    const existing = this.latestTombstones.get(wire.recordId);
    if (!existing || compareHlc(wire.hlc, existing.wire.hlc) > 0) {
      this.latestTombstones.set(wire.recordId, { wire, plain });
    }
  }

  private store(wire: CookieRecordWire, plain: CookiePlain): void {
    this.records.set(wire.recordId, {
      recordId: wire.recordId,
      originId: wire.originId,
      plain,
      wire,
      cause: wire.cause,
      hlc: wire.hlc,
      causalParent: wire.causalParent,
      tombstonedAtMs: DELETION_CAUSES.has(wire.cause) ? this.nowFn() : null,
    });
  }

  private async openRecord(record: CookieRecordWire): Promise<CookiePlain> {
    const plainBytes = await open(
      this.keys.sealKey,
      fromBase64(record.sealedRecord),
      recordSealAad(record.spaceId, record.recordId),
    );
    return decodeCookiePlain(plainBytes);
  }

  /**
   * The sealed plaintext must re-derive the wire ids: a writer cannot claim a
   * record/origin id its identity does not hash to, so lease scoping and
   * per-record state can't be confused by a mismatched envelope.
   */
  private async identityBound(
    record: CookieRecordWire,
    plain: CookiePlain,
  ): Promise<boolean> {
    if (plain.identity.spaceId !== record.spaceId) return false;
    const expectedRecordId = await computeRecordIdHex(
      this.keys.idKey,
      plain.identity,
    );
    if (expectedRecordId !== record.recordId) return false;
    const expectedOriginId = await computeOriginIdHex(
      this.keys.idKey,
      record.spaceId,
      plain.identity.hostKey,
    );
    return expectedOriginId === record.originId;
  }

  private async reissue(
    plain: CookiePlain,
    cause: Cause,
  ): Promise<CookieRecordWire> {
    const recordId = await computeRecordIdHex(this.keys.idKey, plain.identity);
    const hlc = this.clock.send();
    const current = this.records.get(recordId);
    const causalParent = current
      ? makeVersionToken(recordId, current.hlc)
      : null;
    const wire = await buildCookieRecordWire(
      this.keys,
      this.signer,
      plain,
      hlc,
      causalParent,
      cause,
    );
    this.noteAncestry(wire);
    this.noteFence(wire);
    if (DELETION_CAUSES.has(cause)) this.noteTombstone(wire, plain);
    this.store(wire, plain);
    if (this.applier.canApply?.(plain) !== false) {
      this.expectEcho(recordId, plain);
      await this.applier.apply(plain, cause);
    }
    await this.publishOrQueue(wire, false);
    return wire;
  }

  /**
   * Fingerprint of the state an applier.apply will leave in the cookie store.
   * Excludes priority (not surfaced by Electron's cookies API) and rounds
   * expiry to seconds (Electron round-trips expirationDate in seconds), so
   * the echo event matches the expectation byte-for-byte.
   */
  private echoKey(recordId: string, plain: CookiePlain): string {
    if (plain.deleted || plain.attributes === null) return `${recordId}|D`;
    const a = plain.attributes;
    return [
      recordId,
      "W",
      a.value,
      a.expiresMs === null ? "session" : String(Math.floor(a.expiresMs / 1000)),
      a.persistent ? "1" : "0",
      a.secure ? "1" : "0",
      a.httpOnly ? "1" : "0",
      a.sameSite,
    ].join(" ");
  }

  private expectEcho(recordId: string, plain: CookiePlain): void {
    const key = this.echoKey(recordId, plain);
    const now = this.nowFn();
    if (this.pendingEchoes.size > ECHO_SWEEP_THRESHOLD) {
      for (const [k, entry] of [...this.pendingEchoes]) {
        if (entry.expiresAtMs <= now) this.pendingEchoes.delete(k);
      }
    }
    const existing = this.pendingEchoes.get(key);
    if (existing && existing.expiresAtMs > now) {
      existing.count += 1;
      existing.expiresAtMs = now + this.echoTtlMs;
    } else {
      this.pendingEchoes.set(key, {
        count: 1,
        expiresAtMs: now + this.echoTtlMs,
      });
    }
  }

  private cancelExpectedEcho(recordId: string, plain: CookiePlain): void {
    const key = this.echoKey(recordId, plain);
    const entry = this.pendingEchoes.get(key);
    if (entry === undefined) return;
    if (entry.count <= 1) this.pendingEchoes.delete(key);
    else entry.count -= 1;
  }

  private consumeEcho(recordId: string, plain: CookiePlain): boolean {
    const key = this.echoKey(recordId, plain);
    const entry = this.pendingEchoes.get(key);
    if (entry) {
      if (entry.expiresAtMs <= this.nowFn()) {
        this.pendingEchoes.delete(key);
      } else {
        if (entry.count <= 1) this.pendingEchoes.delete(key);
        else entry.count -= 1;
        return true;
      }
    }
    // During hydration every store event is a bulk-insert echo by definition.
    return this.hydrating;
  }

  private lookupOverride(host: string): OriginOverride | null {
    let bestDomain: string | null = null;
    let bestOverride: OriginOverride | null = null;
    for (const [domain, override] of this.overrides) {
      const matches = host === domain || host.endsWith(`.${domain}`);
      if (
        matches &&
        (bestDomain === null || domain.length > bestDomain.length)
      ) {
        bestDomain = domain;
        bestOverride = override;
      }
    }
    return bestOverride;
  }

  private isSynced(hostKey: string): boolean {
    const host = normalizedHost(hostKey);
    const override = this.lookupOverride(host);
    if (override === "never") return false;
    if (override === "sync") return true;
    const policy = matchOriginPolicy(this.policies, host);
    return policy.syncTier !== 0 && !policy.sensitive;
  }

  private async publishOrQueue(
    wire: CookieRecordWire,
    needsLease: boolean,
  ): Promise<void> {
    if (!this.online) {
      this.queue.enqueue(wire);
      return;
    }
    if (needsLease && !(await this.ensureLease(wire.originId))) {
      // Publish once without ownership so the hub can reject this exact
      // version. `publishRejected` then verifies it is still our newest local
      // winner before requesting a forced handoff. A silent local queue would
      // otherwise wait for TTL and never reach that validated recovery path.
      this.transport.publish([wire]);
      return;
    }
    this.transport.publish([wire]);
  }

  private async ensureLease(originId: string): Promise<boolean> {
    const expiry = this.grantedLeases.get(originId);
    if (expiry !== undefined && expiry > this.nowFn()) return true;
    return this.acquireLease(originId, false);
  }

  private async acquireLease(
    originId: string,
    force: boolean,
    candidate?: Pick<CookieRecordWire, "recordId" | "hlc">,
  ): Promise<boolean> {
    const granted = force
      ? await this.transport.acquireLease(
          this.spaceId,
          originId,
          true,
          candidate,
        )
      : await this.transport.acquireLease(this.spaceId, originId);
    if (granted) {
      // Trust a grant for half the server TTL so a cached grant can never
      // outlive the server-side lease (§8.3 single-writer handoff).
      this.grantedLeases.set(
        originId,
        this.nowFn() + Math.floor(this.leaseTtlMs / 2),
      );
    } else {
      this.grantedLeases.delete(originId);
    }
    return granted;
  }

  private async runDrainQueue(): Promise<void> {
    this.draining = true;
    try {
      for (const wire of this.queue.drain()) {
        if (!this.online) {
          this.queue.enqueue(wire);
          continue;
        }
        if (
          (await this.wireNeedsLease(wire)) &&
          !(await this.ensureLease(wire.originId))
        ) {
          this.transport.publish([wire]);
          continue;
        }
        this.transport.publish([wire]);
      }
    } finally {
      this.draining = false;
    }
  }

  private async wireNeedsLease(wire: CookieRecordWire): Promise<boolean> {
    if (DELETION_CAUSES.has(wire.cause)) return false;
    const plain = await this.openRecord(wire);
    return matchOriginPolicy(
      this.policies,
      normalizedHost(plain.identity.hostKey),
    ).rotatingAuth;
  }
}
