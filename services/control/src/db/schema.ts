/**
 * Control-plane schema (PRD §7). Accounts, devices, spaces, wrapped key
 * material, machine lifecycle, audit trail. Invariant I-1: no session data —
 * key_wrappers stores only ciphertext the server cannot open.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProcessTreeInfo } from "@suma/protocol";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  homeRegion: text("home_region").notNull().default("iad"),
  // Account feature flags gating non-terminal capabilities ("files",
  // "cloud-fetch" — §8.6). Empty until billing/entitlements set them.
  features: text("features").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// Beta is invitation-only (PRD §11): signup consumes a single-use invite
// code. Optionally pre-bound to an email; `note` records who it was for.
export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  /** When set, only this email (case-insensitive) may redeem the code. */
  email: text("email"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  redeemedByUserId: uuid("redeemed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true, mode: "date" }),
});

// One-time codes an ENROLLED device mints so a second device can join the
// account (§8.2 second-device path; stepping stone to the §9 approval flow).
// Only the SHA-256 of the code is stored — a database read never yields a
// redeemable credential.
export const enrollmentCodes = pgTable("enrollment_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true, mode: "date" }),
  // Key transfer (§8.2): the account's space + workspace secrets, each sealed
  // under a KEK the minting device derived from the code (which the server
  // never sees — only its hash). Cleared on redemption. Salt is shared by all
  // wrappers of one code. Zero-knowledge: without the code these are opaque.
  wrapSalt: text("wrap_salt"),
  wrappers: jsonb("wrappers").$type<Array<{ credentialId: string; wrapped: string }>>(),
});

export const passkeys = pgTable("passkeys", {
  // WebAuthn credential id (base64url).
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Raw COSE key bytes, base64 (ES256 or Ed25519 — see src/webauthn.ts).
  publicKey: text("public_key").notNull(),
  prfCapable: boolean("prf_capable").notNull().default(false),
  // Authenticator signature counter; assertions must be monotonic (0 = the
  // authenticator does not implement a counter).
  signCount: integer("sign_count").notNull().default(0),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  devicePublicKey: text("device_public_key").notNull().unique(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  revocationReason: text("revocation_reason"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
});

export const spaces = pgTable("spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  position: integer("position").notNull().default(0),
  egressPolicy: text("egress_policy").notNull().default("direct"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const keyWrappers = pgTable(
  "key_wrappers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    credentialId: text("credential_id").notNull(),
    salt: text("salt").notNull().default(""),
    wrapped: text("wrapped").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("key_wrappers_space_kind_credential_idx").on(t.spaceId, t.kind, t.credentialId)],
);

export const machines = pgTable("machines", {
  id: uuid("id").primaryKey().defaultRandom(),
  // One VM and one $HOME per account (PRD §8.8).
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  region: text("region").notNull(),
  cpuKind: text("cpu_kind").notNull(),
  cpus: integer("cpus").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  // host:port of the in-VM agent, set by the sandbox provider at provision
  // time; null until a real provider reports one (the stub never does).
  agentAddress: text("agent_address"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastTransitionAt: timestamp("last_transition_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const machineEvents = pgTable("machine_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  machineId: uuid("machine_id")
    .notNull()
    .references(() => machines.id, { onDelete: "cascade" }),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  reconstructed: boolean("reconstructed").notNull().default(false),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// The agent's last-reported activity snapshot, one row per machine (§8.5).
// decideSuspend reads this — it is the ground truth for "is real work alive?"
export const machineActivity = pgTable("machine_activity", {
  machineId: uuid("machine_id")
    .primaryKey()
    .references(() => machines.id, { onDelete: "cascade" }),
  clientsAttached: integer("clients_attached").notNull().default(0),
  processes: jsonb("processes").$type<ProcessTreeInfo[]>().notNull().default([]),
  activeTransfers: integer("active_transfers").notNull().default(0),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true, mode: "date" }).notNull(),
  awakeMsAccrued: bigint("awake_ms_accrued", { mode: "number" }).notNull().default(0),
  lastReportAt: timestamp("last_report_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// Usage metering samples appended by the agent/gateway (§11).
export const usageSamples = pgTable(
  "usage_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    awakeMs: bigint("awake_ms", { mode: "number" }).notNull().default(0),
    proxiedBytes: bigint("proxied_bytes", { mode: "number" }).notNull().default(0),
    storageGb: doublePrecision("storage_gb").notNull().default(0),
    // Which PLANE reported this row: "agent" (inside the user's VM, compute
    // and storage figures only) or "gateway" (I-3, the only believable source
    // of proxied egress). Set by the route, never by the request body; the
    // summary trusts it when deciding which rows may move egress numbers.
    // Rows written before the split default to "agent", so their egress
    // figures — the ones the VM could have forged — stop counting.
    source: text("source").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("usage_samples_user_period_idx").on(t.userId, t.periodStart)],
);

// One row per request proxied to the AI gateway (vended inference — see
// src/inference.ts). The daily cap is a COUNT over (user_id, created_at);
// token columns are best-effort (null on streamed responses) and exist for
// cost accounting, not enforcement.
export const inferenceUsage = pgTable(
  "inference_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id"),
    path: text("path").notNull(),
    model: text("model"),
    status: integer("status").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("inference_usage_user_created_idx").on(t.userId, t.createdAt)],
);

// Failed hub-revocation notifications awaiting redelivery (PRD §8.2: live
// sockets must die ≤ 60 s). Plain ids, not FKs — this is a delivery queue
// whose rows must outlive whatever happens to the referenced rows.
export const revocationOutbox = pgTable("revocation_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  deviceId: uuid("device_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  attempts: integer("attempts").notNull().default(0),
});

/* ------------------------------------------------------------------ *
 * Files (PRD §8.6, M-3 Lite)
 *
 * Only `~/cloud` is cloud-native; these rows describe THAT namespace, not the
 * whole `$HOME` volume (§8.6 terminology). The bytes live in the object store
 * as content-addressed chunks and are NOT end-to-end encrypted in V1 — §8.6
 * says so plainly, and so does this comment.
 * ------------------------------------------------------------------ */

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Normalized, root-relative (`normalizeFilePath`); unique per user. */
    path: text("path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /** BLAKE3 of the whole file, hex — identity and integrity check. */
    fileHash: text("file_hash").notNull(),
    contentType: text("content_type"),
    /**
     * Null until every chunk's bytes are confirmed in the object store. A
     * manifest is a promise; this is the receipt, and the two must not be
     * conflated — a listing that showed unbacked files as complete would
     * report data that cannot be downloaded.
     */
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("files_user_path_idx").on(t.userId, t.path)],
);

/** The ordered chunk list of one file — the manifest, as rows. */
export const fileChunks = pgTable(
  "file_chunks",
  {
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    hash: text("hash").notNull(),
    offset: bigint("offset", { mode: "number" }).notNull(),
    length: integer("length").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.idx] }), index("file_chunks_hash_idx").on(t.hash)],
);

/**
 * Dedup accounting, keyed PER USER rather than globally.
 *
 * A global content-addressed table would deduplicate across accounts, which
 * turns a chunk hash into an existence oracle and a claim ticket: anyone who
 * learns the BLAKE3 of a chunk could assert a manifest naming it, be told it
 * is already stored, and then read bytes they never had. Namespacing by user
 * costs cross-account dedup (which V1 does not need) and buys the property
 * that a hash proves nothing about anyone else's files.
 *
 * `refCount` counts the user's FILES referencing the chunk, so deleting one
 * file cannot orphan or prematurely delete a chunk another file shares.
 */
export const chunks = pgTable(
  "chunks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    refCount: integer("ref_count").notNull().default(0),
    /** Set once the bytes are confirmed in the object store. */
    storedAt: timestamp("stored_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hash] })],
);

/**
 * Cloud fetches (§8.6). The control plane records the intent; the AGENT does
 * the fetching. There is deliberately no column for a header, a cookie, or a
 * credential of any kind: §8.6 deleted the sealed one-shot request, and a
 * transfer row that could carry one would put it straight back.
 */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    destPath: text("dest_path").notNull(),
    state: text("state").notNull(),
    receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    /** Which device asked, so a second Mac knows where the transfer came from. */
    originDeviceId: uuid("origin_device_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("transfers_user_started_idx").on(t.userId, t.startedAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorDeviceId: uuid("actor_device_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("audit_events_user_created_idx").on(t.userId, t.createdAt)],
);
