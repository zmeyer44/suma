/**
 * Public contract of the session sync engine (PRD §8.3). The desktop main
 * process is coded against these exact shapes — do not rename or reshape.
 */

import type {
  Cause,
  CookiePlain,
  CookieRecordWire,
  Hlc,
  HlcClock,
  OriginPolicy,
} from "@suma/protocol";

export interface StoredRecord {
  recordId: string; // hex
  originId: string; // hex
  plain: CookiePlain; // decrypted (client side always has keys)
  wire: CookieRecordWire; // last accepted sealed+signed form
  cause: Cause;
  hlc: Hlc;
  causalParent: string | null; // VersionToken
  /** local wall-time when a deletion was accepted — for tombstone GC */
  tombstonedAtMs: number | null;
}

export interface SyncTransport {
  publish(records: CookieRecordWire[]): void; // fire-and-forget; transport acks async
  acquireLease(
    spaceId: string,
    originId: string,
    force?: boolean,
    candidate?: Pick<CookieRecordWire, "recordId" | "hlc">,
  ): Promise<boolean>;
  releaseLease(spaceId: string, originId: string): void;
}

export interface CookieApplier {
  /** Fast policy gate checked before the engine registers an expected echo. */
  canApply?(plain: CookiePlain): boolean;
  /** Apply an accepted remote record to the local cookie store (Electron session).
   *  Engine calls this ONLY for records that won conflict resolution. */
  apply(plain: CookiePlain, cause: Cause): Promise<void>;
}

/**
 * Verifies a remote record's device signature against the enrolled-device
 * registry. When configured, records failing verification are rejected before
 * any state is touched.
 */
export interface RecordVerifier {
  verify(record: CookieRecordWire): Promise<boolean>;
}

export interface SyncEngineOptions {
  deviceId: string;
  clock?: HlcClock; // default new HlcClock(deviceId)
  now?: () => number; // default Date.now
  policies?: ReadonlyArray<OriginPolicy>; // default SEED_CORPUS
  tombstoneRetentionMs?: number; // default TOMBSTONE_RETENTION_MS
  /** Server-side origin-lease TTL; cached grants are trusted for half of it. */
  leaseTtlMs?: number; // default ORIGIN_LEASE_TTL_MS
  /** How long an expected cookie-store echo may take to arrive before the
   *  expectation lapses (covers applies that emit no change event at all). */
  echoTtlMs?: number; // default 10_000
  verifier?: RecordVerifier;
}

export type RemoteDisposition =
  | "applied"
  | "stale"
  | "resurrection-blocked"
  | "duplicate"
  /** Failed signature verification, unsealing, or sealed-identity binding. */
  | "rejected";

export type OriginOverride = "sync" | "never";

export interface OriginPolicyView {
  policy: OriginPolicy;
  override: OriginOverride | null;
  synced: boolean;
}

/** Per-origin last-known-good restore point (PRD §8.3 rollback/kill switch). */
export interface OriginSnapshot {
  spaceId: string;
  originId: string;
  capturedAtMs: number;
  records: ReadonlyArray<StoredRecord>;
}
