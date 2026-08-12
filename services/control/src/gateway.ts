/**
 * Egress-gateway credential (I-3, PRD §9).
 *
 * The identity egress gateway is a SEPARATE PLANE from compute: it runs no
 * user code and has its own network identity, which is exactly why it — and
 * never the agent inside the user's VM — is the source of truth for proxied
 * egress bytes. Those bytes drive the §9 throttle and the §11 cost meter, so
 * a VM-resident credential that could report them would let compute abuse
 * contaminate the browser's egress (the I-3 violation this guards).
 *
 * Auth is a shared secret supplied by the operator, matching the existing
 * plane-to-plane pattern (SESSIONHUB_ADMIN_TOKEN in revocation.ts). It is
 * deliberately NOT a capability token: capability tokens live inside the VM.
 */

import type { MiddlewareHandler } from "hono";
import { utf8 } from "@suma/protocol";
import type { AuthEnv } from "./auth.js";

/** Reads EGRESS_GATEWAY_TOKEN. */
export type GatewayEnv = Record<string, string | undefined>;

export const GATEWAY_TOKEN_ENV = "EGRESS_GATEWAY_TOKEN";

/** Constant-time compare; length is allowed to leak, the bytes are not. */
export function secretEquals(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/**
 * Bearer auth for gateway-facing routes. The env is read per request (not
 * captured at boot) so rotating the secret does not need a restart.
 *
 * With no secret configured the route is CLOSED, not open: egress metering
 * is refused with 503 rather than accepting anonymous byte counts, because an
 * unauthenticated writer here can throttle a user's browser traffic.
 */
export function bearerGateway(env: GatewayEnv): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const secret = env[GATEWAY_TOKEN_ENV];
    if (!secret) {
      return c.json({ error: "unavailable", reason: "gateway_auth_unconfigured" }, 503);
    }
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token || !secretEquals(token, secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("gateway", { source: "gateway" });
    return next();
  };
}
