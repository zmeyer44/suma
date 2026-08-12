/**
 * Sync wire protocol (PRD Appendix B, JSON encoding v0 over hibernatable
 * WebSockets; the protobuf sketch in proto/suma.proto is the v1 target).
 *
 * Zod schemas are the source of truth; both SessionHub (server) and the
 * desktop client validate every frame with them.
 */

import { z } from "zod";
import { CAUSES } from "./cookie.js";
import { compareHlc, type Hlc } from "./hlc.js";

/* ------------------------------------------------------------------ *
 * Core wire shapes
 * ------------------------------------------------------------------ */

export const hlcSchema = z.object({
  physicalMs: z.number().int().nonnegative(),
  logical: z.number().int().nonnegative(),
  deviceId: z.string().min(1),
});

export const causeSchema = z.enum(CAUSES);

/**
 * Reference to the exact version a mutation supersedes:
 * `${recordIdHex}@${physicalMs.toString(16)}-${logical.toString(16)}-${deviceId}`.
 */
export const versionTokenSchema = z.string().min(1);
export type VersionToken = z.infer<typeof versionTokenSchema>;

export function makeVersionToken(recordIdHex: string, hlc: Hlc): VersionToken {
  return `${recordIdHex}@${hlc.physicalMs.toString(16)}-${hlc.logical.toString(16)}-${hlc.deviceId}`;
}

export function parseVersionToken(token: VersionToken): {
  recordId: string;
  hlc: Hlc;
} {
  const at = token.indexOf("@");
  if (at < 0) throw new Error("malformed version token");
  const recordId = token.slice(0, at);
  const rest = token.slice(at + 1);
  const first = rest.indexOf("-");
  const second = rest.indexOf("-", first + 1);
  if (first < 0 || second < 0) throw new Error("malformed version token");
  const physicalMs = Number.parseInt(rest.slice(0, first), 16);
  const logical = Number.parseInt(rest.slice(first + 1, second), 16);
  const deviceId = rest.slice(second + 1);
  if (Number.isNaN(physicalMs) || Number.isNaN(logical) || !deviceId) {
    throw new Error("malformed version token");
  }
  return { recordId, hlc: { physicalMs, logical, deviceId } };
}

/** Appendix B `CookieRecord` — the sealed, signed unit of cookie sync. */
export const cookieRecordWireSchema = z.object({
  spaceId: z.string().min(1),
  /** HMAC(identity tuple), hex — server-visible, pseudonymous. */
  recordId: z.string().regex(/^[0-9a-f]{64}$/),
  /** HMAC(host key), hex — lease/rollback scoping. */
  originId: z.string().regex(/^[0-9a-f]{64}$/),
  /** base64 sealed CookiePlain (identity + attributes + deleted flag). */
  sealedRecord: z.string().min(1),
  hlc: hlcSchema,
  /** Version this mutation supersedes; null for first-ever write. */
  causalParent: versionTokenSchema.nullable(),
  /** base64 Ed25519 signature over recordSigningBytes(). */
  deviceSig: z.string().min(1),
  cause: causeSchema,
});
export type CookieRecordWire = z.infer<typeof cookieRecordWireSchema>;

/** Workspace metadata document (spaces/pins/archives/settings), LWW+HLC (§8.3). */
export const workspaceRecordWireSchema = z.object({
  /** Pseudonymous key, e.g. `space:<uuid>` | `pin:<uuid>` | `archive:<uuid>` | `settings`. */
  key: z.string().min(1),
  /** base64 sealed JSON value; null ⇒ deleted. */
  sealedValue: z.string().nullable(),
  hlc: hlcSchema,
  deviceSig: z.string().min(1),
});
export type WorkspaceRecordWire = z.infer<typeof workspaceRecordWireSchema>;

export const devicePresenceSchema = z.object({
  deviceId: z.string().min(1),
  online: z.boolean(),
  lastSeenMs: z.number().int().nonnegative(),
});
export type DevicePresence = z.infer<typeof devicePresenceSchema>;

/* ------------------------------------------------------------------ *
 * Client → server
 * ------------------------------------------------------------------ */

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    deviceId: z.string().min(1),
    spaceIds: z.array(z.string().min(1)),
  }),
  z.object({
    t: z.literal("publish"),
    records: z.array(cookieRecordWireSchema).min(1),
  }),
  z.object({
    t: z.literal("hydrate"),
    spaceId: z.string().min(1),
    sinceHlc: hlcSchema.nullable(),
  }),
  z.object({
    t: z.literal("lease.acquire"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    force: z.boolean().optional(),
    /** Required for a forced handoff; hub verifies it beats the stored winner. */
    recordId: z.string().min(1).optional(),
    candidateHlc: hlcSchema.optional(),
    ttlMs: z.number().int().positive().optional(),
  }),
  z.object({
    t: z.literal("lease.release"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
  }),
  z.object({
    t: z.literal("rollback"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    toHlc: hlcSchema,
  }),
  z.object({
    t: z.literal("workspace.publish"),
    docs: z.array(workspaceRecordWireSchema).min(1),
  }),
  z.object({
    t: z.literal("workspace.hydrate"),
    sinceHlc: hlcSchema.nullable(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ------------------------------------------------------------------ *
 * Server → client
 * ------------------------------------------------------------------ */

export const publishRejectionSchema = z.object({
  recordId: z.string(),
  reason: z.enum(["lease_required", "bad_signature", "stale", "malformed"]),
});
export type PublishRejection = z.infer<typeof publishRejectionSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello.ack"),
    serverTimeMs: z.number().int().nonnegative(),
    presence: z.array(devicePresenceSchema),
  }),
  z.object({
    t: z.literal("publish.ack"),
    accepted: z.array(z.string()),
    rejected: z.array(publishRejectionSchema),
  }),
  z.object({
    t: z.literal("records"),
    spaceId: z.string().min(1),
    records: z.array(cookieRecordWireSchema),
  }),
  z.object({
    t: z.literal("hydrate.done"),
    spaceId: z.string().min(1),
    count: z.number().int().nonnegative(),
    watermark: hlcSchema.nullable(),
  }),
  z.object({
    t: z.literal("lease.granted"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    holderDeviceId: z.string().min(1),
    expiresAtMs: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("lease.denied"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    holderDeviceId: z.string().min(1),
    expiresAtMs: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("lease.revoked"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    newHolderDeviceId: z.string().min(1),
  }),
  z.object({
    t: z.literal("rollback.applied"),
    spaceId: z.string().min(1),
    originId: z.string().min(1),
    toHlc: hlcSchema,
  }),
  z.object({
    t: z.literal("workspace.records"),
    docs: z.array(workspaceRecordWireSchema),
  }),
  z.object({
    t: z.literal("workspace.hydrate.done"),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("presence"),
    devices: z.array(devicePresenceSchema),
  }),
  z.object({ t: z.literal("pong") }),
  z.object({
    t: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(raw));
}

export function parseServerMessage(raw: string): ServerMessage {
  return serverMessageSchema.parse(JSON.parse(raw));
}

/** Sort records oldest-first by HLC — hydration and queue-drain order. */
export function sortByHlc<T extends { hlc: Hlc }>(records: T[]): T[] {
  return [...records].sort((a, b) => compareHlc(a.hlc, b.hlc));
}
