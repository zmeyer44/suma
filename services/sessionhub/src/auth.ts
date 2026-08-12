/**
 * Device-token authentication for the Session Plane edge.
 *
 * Two token forms are accepted, switched by `env.CONTROL_PUBLIC_KEY`:
 *
 * - **Signed device JWT** (PRD §8.2): a compact EdDSA JWS minted by the
 *   control plane. Verified with `verifyDeviceToken` against the env-provided
 *   base64 raw Ed25519 public key; yields `{ userId: sub, deviceId: did }`.
 * - **Dev stub** `hbr_dev_<userId>[.<deviceId>]`: accepted ONLY while
 *   `CONTROL_PUBLIC_KEY` is unset. The moment a public key is configured,
 *   stub tokens are rejected so a production deployment can never silently
 *   fall back to unauthenticated routing identities. Stub deviceIds are
 *   unverified, so `deviceId` is null and identity binds at the hello frame.
 */

import { fromBase64, fromUtf8, importTokenVerifyKey, verifyDeviceToken } from "@suma/protocol";

const DEV_TOKEN_PATTERN = /^hbr_dev_([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?$/;
const JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface AuthEnv {
  /** base64 raw Ed25519 verify key for control-plane device tokens. */
  CONTROL_PUBLIC_KEY?: string;
}

export type AuthResult =
  | { userId: string; deviceId: string | null }
  | { error: string };

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  const parts = authorization.split(" ");
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme === undefined || token === undefined) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

/** Extract the userId from an `Authorization: Bearer hbr_dev_<userId>[.<deviceId>]`
 * header; null when absent or malformed. */
export function parseDeviceToken(authorization: string | null): string | null {
  const token = bearerToken(authorization);
  if (token === null) return null;
  const match = DEV_TOKEN_PATTERN.exec(token);
  return match?.[1] ?? null;
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** Three base64url parts whose header decodes to `{alg:"EdDSA",typ:"JWT"}`. */
function isDeviceJws(token: string): boolean {
  if (!JWS_PATTERN.test(token)) return false;
  const header = token.split(".")[0];
  if (header === undefined) return false;
  try {
    const decoded = JSON.parse(fromUtf8(base64urlDecode(header))) as {
      alg?: unknown;
      typ?: unknown;
    };
    return decoded.alg === "EdDSA" && decoded.typ === "JWT";
  } catch {
    return false;
  }
}

/** Imported verify key, cached per isolate and keyed by the env string so a
 * rotated key (new deployment/env) refreshes the cache. */
let cachedVerifyKey: { publicKey: string; key: Promise<CryptoKey> } | null = null;

function controlVerifyKey(publicKey: string): Promise<CryptoKey> {
  if (cachedVerifyKey === null || cachedVerifyKey.publicKey !== publicKey) {
    cachedVerifyKey = { publicKey, key: importTokenVerifyKey(fromBase64(publicKey)) };
  }
  return cachedVerifyKey.key;
}

/**
 * Authenticate a hub request. Signed JWTs verify against CONTROL_PUBLIC_KEY;
 * dev stubs are honored only while that key is unset (see module doc).
 */
export async function authenticate(
  authorization: string | null,
  env: AuthEnv,
  nowSeconds: number,
): Promise<AuthResult> {
  const token = bearerToken(authorization);
  if (token === null) return { error: "unauthorized" };
  const publicKey = env.CONTROL_PUBLIC_KEY === "" ? undefined : env.CONTROL_PUBLIC_KEY;
  if (isDeviceJws(token)) {
    if (publicKey === undefined) return { error: "unauthorized" };
    try {
      const key = await controlVerifyKey(publicKey);
      const result = await verifyDeviceToken(key, token, nowSeconds);
      if (!result.ok) return { error: result.reason };
      return { userId: result.claims.sub, deviceId: result.claims.did };
    } catch {
      // Undecodable/unimportable key material: treat as unauthenticated
      // rather than throwing 500s at every device.
      return { error: "unauthorized" };
    }
  }
  if (publicKey !== undefined) return { error: "unauthorized" };
  const match = DEV_TOKEN_PATTERN.exec(token);
  const userId = match?.[1];
  if (userId === undefined) return { error: "unauthorized" };
  return { userId, deviceId: null };
}
