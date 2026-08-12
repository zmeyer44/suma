/** Shared product constants pinned to PRD v1.1 budgets and gates. */

/** Tier-1 cookie convergence budget (PRD §8.3): p95 < 2 s. */
export const TIER1_CONVERGENCE_P95_MS = 2_000;

/** Tier-2 localStorage convergence budget: p95 < 5 s. */
export const TIER2_CONVERGENCE_P95_MS = 5_000;

/** Durable tombstone retention (PRD §8.3): ≥ 30 days. */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Origin lease TTL for rotating-auth origins; holders renew while active. */
export const ORIGIN_LEASE_TTL_MS = 60_000;

/** Device revocation propagation contract (PRD §8.2): certs + DO sessions dead within 60 s. */
export const REVOCATION_PROPAGATION_MS = 60_000;

/** M-1 gate: p95 time-to-first authenticated-or-one-touch pageview on a new device. */
export const NEW_DEVICE_READY_P95_MS = 60_000;

/** M-2 gates (PRD §8.5). */
export const PTY_REATTACH_P95_MS = 2_000;
export const VM_WAKE_ON_CONNECT_P95_MS = 2_000;
export const PTY_SCROLLBACK_LINES = 100_000;

/** Files quota (PRD §8.6): Pro 100 GB, soft-block at limit. */
export const PRO_FILES_QUOTA_GB = 100;

/** Cloud-fetch threshold: downloads above this default to the cloud path. */
export const CLOUD_FETCH_MIN_BYTES = 50 * 1024 * 1024;

/** $HOME snapshot recovery-point objective (PRD §8.6): ≤ 5 min. */
export const HOME_SNAPSHOT_RPO_MS = 5 * 60 * 1000;

/** Mass-overwrite rate limit: max cookie mutations per origin per minute
 * accepted from one device before the SessionHub throttles (PRD §9). */
export const MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE = 120;
