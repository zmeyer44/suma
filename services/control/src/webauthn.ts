/**
 * Minimal, dependency-free WebAuthn (PRD §8.2): passkey registration and
 * login with `none` attestation. Assertion signatures are verified for real
 * (ES256 and Ed25519) via WebCrypto.
 *
 * The CBOR/COSE parsing below is purpose-built for exactly the subset
 * WebAuthn hands us — attestation objects ({fmt, attStmt, authData}) and
 * EC2/OKP COSE keys. It is NOT a general CBOR decoder: indefinite lengths,
 * tags, floats, and 64-bit lengths are rejected.
 */

import { bytesEqual, concatBytes, fromBase64, fromUtf8, toBase64, utf8 } from "@suma/protocol";

export interface RpConfig {
  id: string;
  origin: string;
  name: string;
}

export function rpConfigFromEnv(env: Record<string, string | undefined>): RpConfig {
  return {
    id: env["RP_ID"] ?? "localhost",
    origin: env["RP_ORIGIN"] ?? "http://localhost",
    name: "Suma",
  };
}

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * One-time challenges, in-memory with a 5-minute TTL. Single-instance by
 * design for this phase; a multi-instance deployment moves this into a
 * `challenges` table.
 */
export class ChallengeStore {
  private readonly entries = new Map<string, { challenge: string; expiresAt: number }>();

  issue(key: string, nowMs: number = Date.now()): string {
    this.sweep(nowMs);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const challenge = toBase64Url(bytes);
    this.entries.set(key, { challenge, expiresAt: nowMs + CHALLENGE_TTL_MS });
    return challenge;
  }

  /** Consume the pending challenge for `key`; null if absent or expired. */
  take(key: string, nowMs: number = Date.now()): string | null {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt < nowMs) return null;
    return entry.challenge;
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < nowMs) this.entries.delete(key);
    }
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/* ------------------------------------------------------------------ *
 * CBOR (decode-only subset)
 * ------------------------------------------------------------------ */

type CborValue = number | string | Uint8Array | CborValue[] | CborMap;
type CborMap = Map<number | string, CborValue>;

class CborReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): CborValue {
    const initial = this.next();
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return this.length(info);
      case 1:
        return -1 - this.length(info);
      case 2:
        return this.take(this.length(info));
      case 3:
        return fromUtf8(this.take(this.length(info)));
      case 4: {
        const n = this.length(info);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.read());
        return out;
      }
      case 5: {
        const n = this.length(info);
        const map: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const key = this.read();
          if (typeof key !== "number" && typeof key !== "string") {
            throw new Error("unsupported CBOR map key");
          }
          map.set(key, this.read());
        }
        return map;
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  }

  private next(): number {
    const byte = this.bytes[this.offset];
    if (byte === undefined) throw new Error("truncated CBOR");
    this.offset += 1;
    return byte;
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error("truncated CBOR");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private length(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.next();
    if (info === 25) return (this.next() << 8) | this.next();
    if (info === 26) {
      return this.next() * 0x1000000 + ((this.next() << 16) | (this.next() << 8) | this.next());
    }
    throw new Error("unsupported CBOR length encoding");
  }
}

/* ------------------------------------------------------------------ *
 * Authenticator data + COSE keys
 * ------------------------------------------------------------------ */

const FLAG_UP = 0x01;
const FLAG_AT = 0x40;

interface ParsedAuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId: Uint8Array | null;
  cosePublicKey: Uint8Array | null;
}

function parseAuthData(bytes: Uint8Array): ParsedAuthData {
  if (bytes.length < 37) throw new Error("authData too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32] as number;
  const signCount = view.getUint32(33, false);
  let credentialId: Uint8Array | null = null;
  let cosePublicKey: Uint8Array | null = null;
  if ((flags & FLAG_AT) !== 0) {
    // rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId cose
    if (bytes.length < 55) throw new Error("attested credential data truncated");
    const credentialIdLength = view.getUint16(53, false);
    const credentialIdEnd = 55 + credentialIdLength;
    if (bytes.length < credentialIdEnd) throw new Error("credential id truncated");
    credentialId = bytes.subarray(55, credentialIdEnd);
    // Walk one CBOR item to find where the COSE key ends, then keep the raw
    // bytes — assertion verification re-imports them via WebCrypto.
    const reader = new CborReader(bytes.subarray(credentialIdEnd));
    reader.read();
    cosePublicKey = bytes.subarray(credentialIdEnd, credentialIdEnd + reader.offset);
  }
  return { rpIdHash: bytes.subarray(0, 32), flags, signCount, credentialId, cosePublicKey };
}

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;

interface CredentialKey {
  alg: number;
  key: CryptoKey;
}

async function importCoseKey(coseBytes: Uint8Array): Promise<CredentialKey> {
  const map = new CborReader(coseBytes).read();
  if (!(map instanceof Map)) throw new Error("COSE key is not a map");
  const kty = map.get(COSE_KTY);
  const alg = map.get(COSE_ALG);
  const crv = map.get(COSE_CRV);
  const x = map.get(COSE_X);
  if (alg === COSE_ALG_ES256) {
    const y = map.get(COSE_Y);
    if (kty !== 2 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error("malformed ES256 COSE key");
    }
    const point = concatBytes(new Uint8Array([0x04]), x, y);
    const key = await crypto.subtle.importKey(
      "raw",
      point as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { alg, key };
  }
  if (alg === COSE_ALG_EDDSA) {
    if (kty !== 1 || crv !== 6 || !(x instanceof Uint8Array)) {
      throw new Error("malformed Ed25519 COSE key");
    }
    const key = await crypto.subtle.importKey("raw", x as BufferSource, "Ed25519", false, [
      "verify",
    ]);
    return { alg, key };
  }
  throw new Error(`unsupported COSE alg ${String(alg)}`);
}

/** WebAuthn ES256 signatures are ASN.1 DER; WebCrypto wants fixed r ‖ s. */
function ecdsaDerToRaw(der: Uint8Array): Uint8Array {
  const fail = (): Error => new Error("malformed DER signature");
  if (der[0] !== 0x30 || der.length < 8) throw fail();
  // Content length ≤ 72 for P-256, so only 1-byte long form can appear.
  let offset = (der[1] as number) & 0x80 ? 3 : 2;
  const readInt = (): Uint8Array => {
    if (der[offset] !== 0x02) throw fail();
    const len = der[offset + 1];
    if (len === undefined) throw fail();
    const start = offset + 2;
    offset = start + len;
    if (offset > der.length) throw fail();
    let bytes = der.subarray(start, start + len);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > 32) throw fail();
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concatBytes(r, s);
}

async function verifyCredentialSignature(
  credentialKey: CredentialKey,
  signature: Uint8Array,
  signedBytes: Uint8Array,
): Promise<boolean> {
  if (credentialKey.alg === COSE_ALG_ES256) {
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      credentialKey.key,
      ecdsaDerToRaw(signature) as BufferSource,
      signedBytes as BufferSource,
    );
  }
  return crypto.subtle.verify(
    "Ed25519",
    credentialKey.key,
    signature as BufferSource,
    signedBytes as BufferSource,
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/* ------------------------------------------------------------------ *
 * clientDataJSON
 * ------------------------------------------------------------------ */

type ClientDataFailure = "bad_client_data" | "wrong_type" | "challenge_mismatch" | "origin_mismatch";

function checkClientData(
  clientDataJsonB64u: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallenge: string,
  expectedOrigin: string,
): { ok: true; clientDataJson: Uint8Array } | { ok: false; reason: ClientDataFailure } {
  let bytes: Uint8Array;
  let parsed: unknown;
  try {
    bytes = fromBase64Url(clientDataJsonB64u);
    parsed = JSON.parse(fromUtf8(bytes));
  } catch {
    return { ok: false, reason: "bad_client_data" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "bad_client_data" };
  const data = parsed as { type?: unknown; challenge?: unknown; origin?: unknown };
  if (data.type !== expectedType) return { ok: false, reason: "wrong_type" };
  if (data.challenge !== expectedChallenge) return { ok: false, reason: "challenge_mismatch" };
  if (data.origin !== expectedOrigin) return { ok: false, reason: "origin_mismatch" };
  return { ok: true, clientDataJson: bytes };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function beginRegistration(
  user: { id: string; email: string; displayName: string | null },
  rp: RpConfig,
  challenge: string,
): Record<string, unknown> {
  return {
    challenge,
    rp: { id: rp.id, name: rp.name },
    user: {
      id: toBase64Url(utf8(user.id)),
      name: user.email,
      displayName: user.displayName ?? user.email,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: COSE_ALG_ES256 },
      { type: "public-key", alg: COSE_ALG_EDDSA },
    ],
    timeout: CHALLENGE_TTL_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    extensions: { prf: {} },
  };
}

export interface RegistrationCredential {
  id: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
  };
  clientExtensionResults?: { prf?: { enabled?: boolean | undefined } | undefined } | undefined;
}

export type RegistrationFailure =
  | ClientDataFailure
  | "malformed_attestation"
  | "rp_id_mismatch"
  | "no_credential"
  | "credential_id_mismatch"
  | "unsupported_algorithm";

export type RegistrationResult =
  | { ok: true; credentialId: string; publicKeyCose: string; signCount: number; prfCapable: boolean }
  | { ok: false; reason: RegistrationFailure };

export async function finishRegistration(
  rp: RpConfig,
  expectedChallenge: string,
  credential: RegistrationCredential,
): Promise<RegistrationResult> {
  const clientData = checkClientData(
    credential.response.clientDataJSON,
    "webauthn.create",
    expectedChallenge,
    rp.origin,
  );
  if (!clientData.ok) return clientData;

  let authData: ParsedAuthData;
  try {
    const attestation = new CborReader(fromBase64Url(credential.response.attestationObject)).read();
    if (!(attestation instanceof Map)) throw new Error("attestation is not a map");
    const authDataBytes = attestation.get("authData");
    if (!(authDataBytes instanceof Uint8Array)) throw new Error("missing authData");
    authData = parseAuthData(authDataBytes);
  } catch {
    return { ok: false, reason: "malformed_attestation" };
  }
  if (!bytesEqual(authData.rpIdHash, await sha256(utf8(rp.id)))) {
    return { ok: false, reason: "rp_id_mismatch" };
  }
  if (!authData.credentialId || !authData.cosePublicKey) {
    return { ok: false, reason: "no_credential" };
  }
  const credentialId = toBase64Url(authData.credentialId);
  if (credentialId !== credential.id) return { ok: false, reason: "credential_id_mismatch" };
  try {
    await importCoseKey(authData.cosePublicKey);
  } catch {
    return { ok: false, reason: "unsupported_algorithm" };
  }
  return {
    ok: true,
    credentialId,
    publicKeyCose: toBase64(authData.cosePublicKey),
    signCount: authData.signCount,
    prfCapable: credential.clientExtensionResults?.prf?.enabled === true,
  };
}

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */

export function beginLogin(
  credentialIds: ReadonlyArray<string>,
  rp: RpConfig,
  challenge: string,
): Record<string, unknown> {
  return {
    challenge,
    rpId: rp.id,
    allowCredentials: credentialIds.map((id) => ({ type: "public-key", id })),
    userVerification: "preferred",
    timeout: CHALLENGE_TTL_MS,
  };
}

export interface AssertionCredential {
  id: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  };
}

export type AssertionFailure =
  | ClientDataFailure
  | "malformed_assertion"
  | "rp_id_mismatch"
  | "user_not_present"
  | "sign_count_regression"
  | "unsupported_algorithm"
  | "bad_signature";

export type AssertionResult =
  | { ok: true; signCount: number }
  | { ok: false; reason: AssertionFailure };

/**
 * Verify an assertion: clientData (type/challenge/origin), rpIdHash, user
 * presence, monotonic signCount, and the signature over
 * authenticatorData ‖ SHA-256(clientDataJSON).
 */
export async function finishLogin(
  rp: RpConfig,
  expectedChallenge: string,
  passkey: { publicKey: string; signCount: number },
  credential: AssertionCredential,
): Promise<AssertionResult> {
  const clientData = checkClientData(
    credential.response.clientDataJSON,
    "webauthn.get",
    expectedChallenge,
    rp.origin,
  );
  if (!clientData.ok) return clientData;

  let authDataBytes: Uint8Array;
  let authData: ParsedAuthData;
  let signature: Uint8Array;
  try {
    authDataBytes = fromBase64Url(credential.response.authenticatorData);
    authData = parseAuthData(authDataBytes);
    signature = fromBase64Url(credential.response.signature);
  } catch {
    return { ok: false, reason: "malformed_assertion" };
  }
  if (!bytesEqual(authData.rpIdHash, await sha256(utf8(rp.id)))) {
    return { ok: false, reason: "rp_id_mismatch" };
  }
  if ((authData.flags & FLAG_UP) === 0) return { ok: false, reason: "user_not_present" };
  // 0/0 means the authenticator has no counter; otherwise strictly increasing.
  if (
    (passkey.signCount !== 0 || authData.signCount !== 0) &&
    authData.signCount <= passkey.signCount
  ) {
    return { ok: false, reason: "sign_count_regression" };
  }

  let credentialKey: CredentialKey;
  try {
    credentialKey = await importCoseKey(fromBase64(passkey.publicKey));
  } catch {
    return { ok: false, reason: "unsupported_algorithm" };
  }
  const signedBytes = concatBytes(authDataBytes, await sha256(clientData.clientDataJson));
  let valid: boolean;
  try {
    valid = await verifyCredentialSignature(credentialKey, signature, signedBytes);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, signCount: authData.signCount };
}
