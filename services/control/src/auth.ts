/**
 * Bearer auth. Three token forms:
 *
 *   `hbr_dev_<userId>`             user-scoped bootstrap token, issued at
 *                                  signup so the first device can enroll.
 *   `hbr_dev_<userId>.<deviceId>`  device-bound token, issued by
 *                                  POST /devices/enroll. Rejected (401) once
 *                                  the device is revoked, unknown, or owned
 *                                  by a different user.
 *   compact JWS (two dots)         EdDSA device token minted by the
 *                                  /v1/auth routes (@suma/protocol
 *                                  signDeviceToken); verified against the
 *                                  control signing key, then checked against
 *                                  the devices table so revocation bites
 *                                  before the 10-minute expiry does.
 *
 * SECURITY: the `hbr_dev_` stub is DEV-ONLY, not a real security boundary —
 * a bare, guessable identifier with no signature, expiry, or proof of
 * possession, kept so bootstrap and tests can exercise realistic authz
 * shapes. Device JWTs (Phase 1) are the real path.
 */

import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { deviceLoginSigningBytes, verifyDeviceToken, type Capability } from "@suma/protocol";
import type { Db } from "./db/client.js";
import type { SigningKeys } from "./keys-provider.js";
import { devices, users } from "./db/schema.js";

export const HUB_TOKEN_PREFIX = "hbr_dev_";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HubTokenClaims {
  userId: string;
  /** Present on device-bound tokens (`hbr_dev_<userId>.<deviceId>`). */
  deviceId: string | null;
}

export function hubTokenFor(userId: string, deviceId?: string): string {
  return deviceId === undefined
    ? `${HUB_TOKEN_PREFIX}${userId}`
    : `${HUB_TOKEN_PREFIX}${userId}.${deviceId}`;
}

export function parseHubToken(header: string | undefined): HubTokenClaims | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  if (!token.startsWith(HUB_TOKEN_PREFIX)) return null;
  const rest = token.slice(HUB_TOKEN_PREFIX.length);
  // UUIDs contain no dots, so the first dot (if any) splits userId from
  // deviceId; a second dot leaves deviceId failing the UUID check below.
  const dot = rest.indexOf(".");
  const userId = dot === -1 ? rest : rest.slice(0, dot);
  const deviceId = dot === -1 ? null : rest.slice(dot + 1);
  if (!UUID_RE.test(userId)) return null;
  if (deviceId !== null && !UUID_RE.test(deviceId)) return null;
  return { userId, deviceId };
}

/** Re-exported from `@suma/protocol` so control (verifier) and the desktop
 * client (signer) share one definition of the device-login signing bytes. */
export { deviceLoginSigningBytes };

/**
 * Identity established by a verified agent capability token (I-2). Set ONLY
 * by `bearerAgent` on agent-facing routes — never by `bearerAuth`, so a
 * capability token (which lives inside the attacker-reachable VM) can never
 * satisfy a device/user route, and a device token can never drive the agent
 * plane.
 */
export interface AgentContext {
  machineId: string;
  userId: string;
  caps: ReadonlyArray<Capability>;
}

/**
 * Identity established by the shared-secret egress-gateway credential (I-3).
 * Set ONLY by `bearerGateway` (gateway.ts) on the egress-metering route: the
 * gateway is a separate plane running no user code, and it is the only writer
 * the control plane believes about proxied bytes.
 */
export interface GatewayContext {
  source: "gateway";
}

export interface AuthEnv {
  Variables: {
    userId: string;
    /** Null only for the user-scoped dev bootstrap token. */
    deviceId: string | null;
    /** Present only on agent routes authenticated by `bearerAgent`. */
    agent: AgentContext;
    /** Present only on gateway routes authenticated by `bearerGateway`. */
    gateway: GatewayContext;
  };
}

/** The identity a verified bearer token establishes. */
export interface AuthenticatedDevice {
  userId: string;
  /** Null for user-scoped bootstrap tokens (JWS did===sub, or bare stub). */
  deviceId: string | null;
}

/**
 * Verify one bearer token (the raw token, no "Bearer " prefix) against the
 * signing keys and the users/devices tables. This is the WHOLE of bearer
 * verification — `bearerAuth` wraps it for HTTP routes, and the relay's WS
 * upgrade calls it directly (an upgrade has no Hono context).
 */
export async function authenticateToken(
  db: Db,
  token: string | null,
  signing: SigningKeys | undefined,
): Promise<AuthenticatedDevice | null> {
  // Device-JWT path first: a compact JWS has two dots. This covers both
  // device tokens (did = a device id) and signed bootstrap tokens
  // (did = sub, minted at signup so the first device can enroll without the
  // unsigned stub — unforgeable from a known userId).
  if (token !== null && signing !== undefined && token.split(".").length === 3) {
    const result = await verifyDeviceToken(signing.verifyKey, token, Math.floor(Date.now() / 1000));
    if (!result.ok || !UUID_RE.test(result.claims.sub) || !UUID_RE.test(result.claims.did)) {
      return null;
    }
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, result.claims.sub));
    if (!user) return null;
    if (result.claims.did === result.claims.sub) {
      // Bootstrap self-token: no device bound yet.
      return { userId: user.id, deviceId: null };
    }
    const [device] = await db
      .select({ userId: devices.userId, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, result.claims.did));
    if (device && device.userId === user.id && device.revokedAt === null) {
      return { userId: user.id, deviceId: result.claims.did };
    }
    return null;
  }

  // Unsigned dev/bootstrap stub. Rejected outright once real signing keys
  // are configured (envProvided) — a production control plane must never
  // accept a guessable, unsigned credential (mirrors the hub's gate).
  const claims = token === null ? null : parseHubToken(`Bearer ${token}`);
  if (claims) {
    if (signing !== undefined && signing.envProvided) return null;
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, claims.userId));
    if (!user) return null;
    if (claims.deviceId !== null) {
      const [device] = await db
        .select({ userId: devices.userId, revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, claims.deviceId));
      if (!device || device.userId !== user.id || device.revokedAt !== null) {
        return null;
      }
    }
    return { userId: user.id, deviceId: claims.deviceId };
  }
  return null;
}

export function bearerAuth(db: Db, getSigning?: () => Promise<SigningKeys>): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const signing = getSigning === undefined ? undefined : await getSigning();
    const identity = await authenticateToken(db, token, signing);
    if (identity === null) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", identity.userId);
    c.set("deviceId", identity.deviceId);
    return next();
  };
}
