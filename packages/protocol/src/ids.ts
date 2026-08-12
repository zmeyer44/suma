/**
 * Pseudonymous identifiers (PRD §8.3, "Server-visible metadata minimized").
 *
 * The SessionHub stores keyed deterministic record ids (HMAC over the full
 * identity tuple) plus a keyed origin id for lease/rollback scoping. The
 * server sees pseudonymous ids, sizes, and timing — never origins or cookie
 * names. The HMAC key is the per-space id key, which only enrolled devices
 * can derive.
 */

import { canonicalIdentityBytes, normalizedHost, type CookieIdentity } from "./cookie.js";
import { lengthPrefixed, toHex } from "./encoding.js";

export async function hmacSha256(idKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", idKey, data as BufferSource));
}

/** 32-byte pseudonymous id for one cookie identity tuple. */
export async function computeRecordId(
  idKey: CryptoKey,
  identity: CookieIdentity,
): Promise<Uint8Array> {
  return hmacSha256(idKey, canonicalIdentityBytes(identity));
}

/** 32-byte pseudonymous id scoping leases and rollback to an origin. */
export async function computeOriginId(
  idKey: CryptoKey,
  spaceId: string,
  hostKey: string,
): Promise<Uint8Array> {
  return hmacSha256(idKey, lengthPrefixed(["suma.origin.v1", spaceId, normalizedHost(hostKey)]));
}

export async function computeRecordIdHex(
  idKey: CryptoKey,
  identity: CookieIdentity,
): Promise<string> {
  return toHex(await computeRecordId(idKey, identity));
}

export async function computeOriginIdHex(
  idKey: CryptoKey,
  spaceId: string,
  hostKey: string,
): Promise<string> {
  return toHex(await computeOriginId(idKey, spaceId, hostKey));
}
