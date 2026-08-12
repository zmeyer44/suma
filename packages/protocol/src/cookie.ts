/**
 * Cookie identity and payload model (PRD §8.3, "Cookie identity — corrected").
 *
 * A cookie record's identity is the FULL Chromium tuple:
 *   space · host key (exact domain vs. host-only scope) · name · path ·
 *   partition key (CHIPS) · source scheme.
 *
 * v1.0 keyed by (space, eTLD+1, name, path) and merged cookies Chromium treats
 * as distinct; that model is dead. Host-only vs. domain scope is preserved via
 * Chromium's own convention: domain cookies carry a leading dot in the host
 * key ('.github.com'), host-only cookies do not ('github.com').
 */

import { lengthPrefixed, utf8 } from "./encoding.js";

export type SourceScheme = "unset" | "nonsecure" | "secure";

export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export type CookiePriority = "low" | "medium" | "high";

/**
 * Why a mutation happened (Appendix B `Cause`). Deletion cause is recorded on
 * every mutation — LWW alone resurrects logged-out sessions (§8.3).
 */
export const CAUSES = [
  "WRITE",
  "EXPLICIT_DELETE",
  "EXPIRED",
  "OVERWRITE",
  "EVICTED",
  "HYDRATION_ECHO",
] as const;
export type Cause = (typeof CAUSES)[number];

/** Causes that represent a deletion (record becomes a tombstone). */
export const DELETION_CAUSES: ReadonlySet<Cause> = new Set([
  "EXPLICIT_DELETE",
  "EXPIRED",
  "EVICTED",
]);

export interface CookieIdentity {
  spaceId: string;
  /** Chromium host key; leading dot ⇒ domain cookie, none ⇒ host-only. */
  hostKey: string;
  name: string;
  path: string;
  /** CHIPS partition key (top-level site), "" when unpartitioned. */
  partitionKey: string;
  sourceScheme: SourceScheme;
}

/** Everything about a cookie beyond its identity. Sealed client-side; the server never sees it. */
export interface CookieAttributes {
  value: string;
  /** null ⇒ session cookie. */
  expiresMs: number | null;
  persistent: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  priority: CookiePriority;
}

/**
 * The full plaintext of a sealed record: identity + attributes + deleted flag.
 * Tombstones seal the identity with `deleted: true` so the server cannot
 * learn origin/name even for deletions.
 */
export interface CookiePlain {
  identity: CookieIdentity;
  attributes: CookieAttributes | null;
  deleted: boolean;
}

export function hostKeyIsHostOnly(hostKey: string): boolean {
  return !hostKey.startsWith(".");
}

/** Host with any leading dot stripped, lowercased — used for origin-id scoping. */
export function normalizedHost(hostKey: string): string {
  const h = hostKey.toLowerCase();
  return h.startsWith(".") ? h.slice(1) : h;
}

const IDENTITY_DOMAIN = "suma.cookie.identity.v1";

/**
 * Canonical bytes for the identity tuple. Feeds the keyed record-id HMAC.
 * Length-prefixed so distinct tuples can never collide.
 */
export function canonicalIdentityBytes(id: CookieIdentity): Uint8Array {
  return lengthPrefixed([
    IDENTITY_DOMAIN,
    id.spaceId,
    id.hostKey,
    id.name,
    id.path,
    id.partitionKey,
    id.sourceScheme,
  ]);
}

const PLAIN_VERSION = 0x01;

/** Versioned plaintext codec for sealed records. v1 = JSON; protobuf later. */
export function encodeCookiePlain(plain: CookiePlain): Uint8Array {
  const body = utf8(JSON.stringify(plain));
  const out = new Uint8Array(1 + body.length);
  out[0] = PLAIN_VERSION;
  out.set(body, 1);
  return out;
}

export function decodeCookiePlain(bytes: Uint8Array): CookiePlain {
  if (bytes[0] !== PLAIN_VERSION) throw new Error(`unknown CookiePlain version ${bytes[0]}`);
  const json = new TextDecoder().decode(bytes.subarray(1));
  const parsed = JSON.parse(json) as CookiePlain;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.deleted !== "boolean") {
    throw new Error("malformed CookiePlain");
  }
  return parsed;
}
