/**
 * Device identity and mutation signing (PRD §8.3 "device-signed mutations",
 * §9 threat "rogue/stolen device injects or resurrects cookies").
 *
 * Every enrolled device holds an Ed25519 keypair (in production the private
 * key lives behind the Secure Enclave; the portable representation here is
 * the WebCrypto key). Every published mutation is signed; peers verify
 * against the enrolled-device registry from the control plane.
 */

import { encodeHlc, type Hlc } from "./hlc.js";
import { lengthPrefixed } from "./encoding.js";
import type { Cause } from "./cookie.js";

export interface DeviceKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

export async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "Ed25519", true, ["verify"]);
}

export interface SignableRecordFields {
  spaceId: string;
  recordId: string; // hex
  originId: string; // hex
  sealedRecord: string; // base64
  hlc: Hlc;
  causalParent: string | null;
  cause: Cause;
}

/** Canonical bytes covered by a record's device signature. */
export function recordSigningBytes(r: SignableRecordFields): Uint8Array {
  return lengthPrefixed([
    "suma.recordsig.v1",
    r.spaceId,
    r.recordId,
    r.originId,
    r.sealedRecord,
    encodeHlc(r.hlc),
    r.causalParent ?? "",
    r.cause,
  ]);
}

export async function signRecord(
  privateKey: CryptoKey,
  r: SignableRecordFields,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign("Ed25519", privateKey, recordSigningBytes(r) as BufferSource),
  );
}

export async function verifyRecord(
  publicKey: CryptoKey,
  signature: Uint8Array,
  r: SignableRecordFields,
): Promise<boolean> {
  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signature as BufferSource,
    recordSigningBytes(r) as BufferSource,
  );
}
