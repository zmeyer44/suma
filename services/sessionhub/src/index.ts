/**
 * Session Plane Worker edge: authenticates device tokens and routes each user
 * to their SessionHub Durable Object. No compute-plane calls exist here —
 * session sync never touches the VM (I-1).
 */

import {
  bytesEqual,
  GATEWAY_COOKIES_PATH,
  GATEWAY_FETCH_PATH,
  utf8,
} from "@suma/protocol";
import { authenticate, bearerToken } from "./auth.js";
import { revokeRequestSchema } from "./hub-core.js";
import { DEVICE_HEADER, jsonResponse } from "./http.js";
import { SessionHub } from "./session-hub.js";

export { SessionHub };

export interface Env {
  SESSION_HUB: DurableObjectNamespace;
  /** base64 raw Ed25519 control-plane verify key. Unset ⇒ dev stub tokens
   * are accepted; set ⇒ only signed device JWTs (see src/auth.ts). */
  CONTROL_PUBLIC_KEY?: string;
  /** Shared secret for /v1/admin/revoke. Unset ⇒ admin routes disabled. */
  ADMIN_TOKEN?: string;
  /** Local integration tests only. Production must never enable SSRF to
   * loopback or private networks. */
  GATEWAY_DEV_ALLOW_PRIVATE?: string;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return jsonResponse({ ok: true });
    const authenticatedRoute =
      url.pathname === "/v1/hub/ws" ||
      url.pathname === "/v1/hub/hydrate" ||
      url.pathname === GATEWAY_FETCH_PATH ||
      url.pathname === GATEWAY_COOKIES_PATH;
    if (authenticatedRoute) {
      // A browser WebSocket cannot set request headers, so the client passes
      // its device token as `?access_token=`. Prefer a real Authorization
      // header when present; fall back to the query param for the WS upgrade.
      const headerAuth = request.headers.get("authorization");
      const queryToken = url.searchParams.get("access_token");
      const authorization =
        headerAuth ?? (queryToken !== null ? `Bearer ${queryToken}` : null);
      const auth = await authenticate(authorization, env, Math.floor(Date.now() / 1000));
      if ("error" in auth) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/v1/hub/ws" && request.method !== "GET") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      if (url.pathname === "/v1/hub/hydrate" && request.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      if (
        url.pathname === GATEWAY_COOKIES_PATH &&
        request.method !== "GET" &&
        request.method !== "PUT"
      ) {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName(auth.userId));
      // Strip the credential from the URL before it travels any further (DO
      // request logs, Referer, future tracing) — auth already happened here.
      const forwardedUrl = new URL(request.url);
      forwardedUrl.searchParams.delete("access_token");
      const forwarded = new Request(forwardedUrl, request);
      // The edge credential authenticates Suma, not the destination site.
      // Site Authorization is carried separately in an internal header and
      // restored only by GatewayCore immediately before the upstream fetch.
      forwarded.headers.delete("authorization");
      forwarded.headers.delete(DEVICE_HEADER);
      if (auth.deviceId !== null) forwarded.headers.set(DEVICE_HEADER, auth.deviceId);
      return stub.fetch(forwarded);
    }
    if (url.pathname === "/v1/admin/revoke") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      const presented = bearerToken(request.headers.get("authorization"));
      if (
        env.ADMIN_TOKEN === undefined ||
        env.ADMIN_TOKEN === "" ||
        presented === null ||
        !bytesEqual(utf8(presented), utf8(env.ADMIN_TOKEN))
      ) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "malformed" }, 400);
      }
      const parsed = revokeRequestSchema.safeParse(body);
      if (!parsed.success) return jsonResponse({ error: "malformed" }, 400);
      const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName(parsed.data.userId));
      return stub.fetch(
        new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        }),
      );
    }
    return jsonResponse({ error: "not_found" }, 404);
  },
};

export default worker;
