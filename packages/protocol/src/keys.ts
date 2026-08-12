/**
 * Key hierarchy (PRD §8.2, redesigned):
 *
 *   1. Per-space random ROOT SECRET (the "DEK" in PRD terms). From it we
 *      derive subkeys via HKDF: a sealing key (AES-256-GCM) for session
 *      envelopes and an id key (HMAC-SHA-256) for pseudonymous record/origin
 *      ids. Deriving both from one wrapped secret keeps exactly one thing to
 *      wrap, rotate, and recover per space.
 *   2. The root secret is WRAPPED independently for each enrolled credential:
 *      per-passkey KEKs derived from WebAuthn PRF output, an offline recovery
 *      code, optionally a hardware key or (visibly labeled) KMS.
 *   3. Wrappers rotate on device add/revoke; the root secret itself rotates
 *      after a security event.
 *
 * PRF output is credential-associated and must never be used directly as the
 * permanent data key — it only ever derives a wrapping KEK.
 */

import { concatBytes, fromBase64, lengthPrefixed, toBase64, utf8 } from "./encoding.js";

export interface SpaceKeys {
  spaceId: string;
  /** AES-256-GCM key sealing/opening session record envelopes. */
  sealKey: CryptoKey;
  /** HMAC-SHA-256 key producing pseudonymous record and origin ids. */
  idKey: CryptoKey;
}

export const SPACE_ROOT_SECRET_BYTES = 32;

export function generateSpaceRootSecret(): Uint8Array {
  const secret = new Uint8Array(SPACE_ROOT_SECRET_BYTES);
  crypto.getRandomValues(secret);
  return secret;
}

async function hkdfDerive(
  rootSecret: Uint8Array,
  info: string,
  algorithm: AesKeyGenParams | HmacKeyGenParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", rootSecret as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("suma.space.v1") as BufferSource,
      info: utf8(info) as BufferSource,
    },
    ikm,
    algorithm,
    false,
    usages,
  );
}

export async function deriveSpaceKeys(spaceId: string, rootSecret: Uint8Array): Promise<SpaceKeys> {
  if (rootSecret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("bad root secret length");
  const sealKey = await hkdfDerive(rootSecret, `seal:${spaceId}`, { name: "AES-GCM", length: 256 }, [
    "encrypt",
    "decrypt",
  ]);
  const idKey = await hkdfDerive(
    rootSecret,
    `id:${spaceId}`,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    ["sign"],
  );
  return { spaceId, sealKey, idKey };
}

/* ------------------------------------------------------------------ *
 * Sealing (AES-256-GCM envelopes)
 * ------------------------------------------------------------------ */

const SEALED_VERSION = 0x01;
const GCM_IV_BYTES = 12;

/** Seal plaintext under the space seal key. Output: version || iv || ciphertext+tag. */
export async function seal(
  sealKey: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = new Uint8Array(GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      sealKey,
      plaintext as BufferSource,
    ),
  );
  return concatBytes(new Uint8Array([SEALED_VERSION]), iv, ct);
}

export async function open(
  sealKey: CryptoKey,
  sealed: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (sealed[0] !== SEALED_VERSION) throw new Error(`unknown sealed version ${sealed[0]}`);
  const iv = sealed.subarray(1, 1 + GCM_IV_BYTES);
  const ct = sealed.subarray(1 + GCM_IV_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      sealKey,
      ct as BufferSource,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * KEK wrappers
 * ------------------------------------------------------------------ */

export type KeyWrapperKind = "passkey-prf" | "recovery-code" | "hardware-key" | "kms";

/** Serialized wrapper stored by the control plane (opaque to the server). */
export interface KeyWrapper {
  kind: KeyWrapperKind;
  spaceId: string;
  /** WebAuthn credential id (passkey wrappers) or wrapper label. */
  credentialId: string;
  /** base64: PBKDF2 salt for recovery-code wrappers, "" otherwise. */
  salt: string;
  /** base64: version || iv || ciphertext+tag over the space root secret. */
  wrapped: string;
  createdAtMs: number;
}

/** Derive a wrapping KEK from WebAuthn PRF output (never used as a data key). */
export async function deriveKekFromPrf(
  prfOutput: Uint8Array,
  credentialId: string,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("suma.kek.v1") as BufferSource,
      info: lengthPrefixed(["passkey-prf", credentialId]) as BufferSource,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const RECOVERY_CODE_PBKDF2_ITERATIONS = 600_000;

/** Crockford base32, no ambiguous characters. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = 8;
const RECOVERY_GROUP_LEN = 4;

/** High-entropy offline recovery code (160 bits), shown once, user-stored. */
export function generateRecoveryCode(): string {
  const chars = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  const random = new Uint8Array(chars);
  crypto.getRandomValues(random);
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      group += RECOVERY_ALPHABET[(random[g * RECOVERY_GROUP_LEN + i] as number) % 32];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * Second-device enrollment code (§8.2): shorter than a recovery code because a
 * human types it across the room in a 10-minute window, and single-use. Same
 * unambiguous alphabet, three groups of four (~60 bits) — enough for a
 * short-lived single-use secret, stretched by PBKDF2 before it guards keys.
 */
export function generateEnrollmentCode(): string {
  const groups = 3;
  const random = new Uint8Array(groups * RECOVERY_GROUP_LEN);
  crypto.getRandomValues(random);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      group += RECOVERY_ALPHABET[(random[g * RECOVERY_GROUP_LEN + i] as number) % 32];
    }
    out.push(group);
  }
  return out.join("-");
}

export function normalizeRecoveryCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (cleaned.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LEN) {
    throw new Error("recovery code must contain 32 characters");
  }
  return cleaned;
}

export async function deriveKekFromRecoveryCode(
  code: string,
  salt: Uint8Array,
  iterations: number = RECOVERY_CODE_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  return deriveKekFromPassphrase(normalizeRecoveryCode(code), salt, iterations);
}

/**
 * KEK from an arbitrary secret string (no recovery-code normalization). Used
 * for the second-device enrollment code (§8.2): a shorter, short-lived code
 * that carries the account's space + workspace secrets to a new device
 * end-to-end, so the control plane never sees plaintext key material. The
 * enrollment code has less entropy than a recovery code, but it is single-use
 * and expires in minutes — PBKDF2 stretching over that window is the point.
 */
export async function deriveKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = RECOVERY_CODE_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapRootSecret(
  kek: CryptoKey,
  rootSecret: Uint8Array,
  spaceId: string,
): Promise<Uint8Array> {
  return seal(kek, rootSecret, lengthPrefixed(["suma.wrap.v1", spaceId]));
}

export async function unwrapRootSecret(
  kek: CryptoKey,
  wrapped: Uint8Array,
  spaceId: string,
): Promise<Uint8Array> {
  const secret = await open(kek, wrapped, lengthPrefixed(["suma.wrap.v1", spaceId]));
  if (secret.length !== SPACE_ROOT_SECRET_BYTES) throw new Error("unwrapped secret has bad length");
  return secret;
}

export function serializeWrapper(w: Omit<KeyWrapper, "wrapped" | "salt"> & {
  wrapped: Uint8Array;
  salt?: Uint8Array;
}): KeyWrapper {
  return {
    kind: w.kind,
    spaceId: w.spaceId,
    credentialId: w.credentialId,
    salt: w.salt ? toBase64(w.salt) : "",
    wrapped: toBase64(w.wrapped),
    createdAtMs: w.createdAtMs,
  };
}

export function wrapperBytes(w: KeyWrapper): { wrapped: Uint8Array; salt: Uint8Array | null } {
  return { wrapped: fromBase64(w.wrapped), salt: w.salt ? fromBase64(w.salt) : null };
}
