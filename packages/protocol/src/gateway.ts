/**
 * Gateway-backed browsing wire constants and cookie snapshot shapes.
 *
 * The desktop intercepts each space session's HTTP(S) URL loads and forwards
 * them to the account's SessionHub Durable Object. The DO performs the origin
 * request with its canonical cookie jar and streams response bytes back; Blink,
 * V8, layout, input, and painting all stay on the Mac.
 */

export const GATEWAY_FETCH_PATH = "/v1/gateway/fetch";
export const GATEWAY_COOKIES_PATH = "/v1/gateway/cookies";

export const GATEWAY_SPACE_HEADER = "x-suma-space";
export const GATEWAY_TARGET_HEADER = "x-suma-target";
export const GATEWAY_TOP_LEVEL_SITE_HEADER = "x-suma-top-level-site";
export const GATEWAY_CREDENTIALS_HEADER = "x-suma-credentials";
export const GATEWAY_UPSTREAM_AUTH_HEADER = "x-suma-upstream-authorization";
export const GATEWAY_RESPONSE_HEADER = "x-suma-gateway";

export type GatewaySameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/** Browser-observable cookie material used to hydrate document.cookie and
 * Electron's cookie inspector. The gateway remains authoritative for outbound
 * Cookie headers, including HttpOnly cookies. */
export interface GatewayCookieSnapshot {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite: GatewaySameSite;
  partitionKey: string | null;
}

export interface GatewayCookieMutation {
  cookie: GatewayCookieSnapshot;
  removed: boolean;
}

export interface GatewayCookieMutationBatch {
  mutations: GatewayCookieMutation[];
}

/** Encode a URL for a byte-safe HTTP header without leaking it into request
 * query strings, access logs, Referer, or tracing URL fields. */
export function encodeGatewayHeaderValue(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeGatewayHeaderValue(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
