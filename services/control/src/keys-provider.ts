/**
 * The control plane owns the Ed25519 device-token signing key (PRD §8.2).
 * Production supplies it via CONTROL_TOKEN_SK/CONTROL_TOKEN_PK; dev and tests
 * fall back to a keypair generated once per process. The public key is served
 * at GET /v1/auth/jwks so the session hub's operator can copy it into
 * CONTROL_PUBLIC_KEY.
 */

import {
  fromBase64,
  generateTokenKeypair,
  importTokenSigningKey,
  importTokenVerifyKey,
  toBase64,
} from "@suma/protocol";

/** Reads CONTROL_TOKEN_SK (base64 pkcs8) and CONTROL_TOKEN_PK (base64 raw). */
export type SigningKeyEnv = Record<string, string | undefined>;

export interface SigningKeys {
  signingKey: CryptoKey;
  verifyKey: CryptoKey;
  publicKeyBase64(): string;
  /**
   * True when the keypair came from CONTROL_TOKEN_SK/PK (a real deployment).
   * When true, the unsigned `hbr_dev_` bootstrap/dev stub is rejected — a
   * production control plane must never accept a forgeable, guessable
   * credential (mirrors the session hub's CONTROL_PUBLIC_KEY gate).
   */
  envProvided: boolean;
}

export async function createSigningKeys(
  privateKeyPkcs8: Uint8Array,
  publicKeyRaw: Uint8Array,
  envProvided = false,
): Promise<SigningKeys> {
  const signingKey = await importTokenSigningKey(privateKeyPkcs8);
  const verifyKey = await importTokenVerifyKey(publicKeyRaw);
  const publicKeyBase64 = toBase64(publicKeyRaw);
  return { signingKey, verifyKey, publicKeyBase64: () => publicKeyBase64, envProvided };
}

let generated: Promise<SigningKeys> | null = null;

export function getSigningKeys(env: SigningKeyEnv): Promise<SigningKeys> {
  const sk = env["CONTROL_TOKEN_SK"];
  const pk = env["CONTROL_TOKEN_PK"];
  if (sk && pk) return createSigningKeys(fromBase64(sk), fromBase64(pk), true);
  // Dev/tests: tokens from a restarted process verify only against the fresh
  // JWKS output, which is exactly the ephemerality we want without env keys.
  generated ??= generateTokenKeypair().then((pair) =>
    createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw, false),
  );
  return generated;
}
