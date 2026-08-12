/**
 * Canonical browser-network session for gateway-backed browsing.
 *
 * The SessionHub Durable Object already supplies one durable, serialized actor
 * per Suma account. GatewayCore adds a per-space RFC6265-style cookie jar and
 * performs origin requests on that actor's behalf. Only response bytes travel
 * back to the desktop; rendering and JavaScript execution remain local.
 */

import {
  decodeGatewayHeaderValue,
  GATEWAY_CREDENTIALS_HEADER,
  GATEWAY_RESPONSE_HEADER,
  GATEWAY_SPACE_HEADER,
  GATEWAY_TARGET_HEADER,
  GATEWAY_TOP_LEVEL_SITE_HEADER,
  GATEWAY_UPSTREAM_AUTH_HEADER,
  type GatewayCookieMutation,
  type GatewayCookieMutationBatch,
  type GatewayCookieSnapshot,
  type GatewaySameSite,
} from "@suma/protocol";
import { parseSetCookie, type SetCookie } from "cookie";
import { getDomain } from "tldts";
import type { HubStorage } from "./hub-core.js";
import { jsonResponse } from "./http.js";

const COOKIE_PREFIX = "gateway-cookie:";
const INITIALIZED_PREFIX = "gateway-initialized:";
const MAX_COOKIE_BYTES = 4096;
const MAX_COOKIES_PER_SPACE = 3000;
const MAX_COOKIE_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

const CONTROL_REQUEST_HEADERS = new Set([
  "authorization",
  GATEWAY_CREDENTIALS_HEADER,
  GATEWAY_SPACE_HEADER,
  GATEWAY_TARGET_HEADER,
  GATEWAY_TOP_LEVEL_SITE_HEADER,
  GATEWAY_UPSTREAM_AUTH_HEADER,
  "x-suma-device",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface StoredGatewayCookie extends GatewayCookieSnapshot {
  createdAtMs: number;
  expiresAtMs: number | null;
}

export interface GatewayCoreOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Development-only escape hatch for local integration origins. */
  allowPrivateTargets?: boolean;
}

function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) return false;
  const [a = 0, b = 0] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function mappedIpv4(v6: string): string | null {
  if (!v6.startsWith("::ffff:")) return null;
  const tail = v6.slice("::ffff:".length);
  if (isIpv4(tail)) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const high = Number.parseInt(words[0] ?? "", 16);
  const low = Number.parseInt(words[1] ?? "", 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPrivateTarget(url: URL): boolean {
  const host = canonicalHostname(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost") || isPrivateIpv4(host)) return true;
  const v6 = host.replace(/^\[/, "").replace(/\]$/, "");
  const mapped = mappedIpv4(v6);
  return (
    (mapped !== null && isPrivateIpv4(mapped)) ||
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    /^fe[89ab]/.test(v6)
  );
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isPublicSuffix(domain: string): boolean {
  if (domain === "localhost" || isIpv4(domain) || domain.includes(":")) return false;
  return getDomain(domain, { allowPrivateDomains: true }) === null;
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function schemefulSite(url: URL): string {
  const host = canonicalHostname(url.hostname);
  const registrable = getDomain(host, { allowPrivateDomains: true }) ?? host;
  return `${url.protocol}//${registrable}`;
}

function sameSiteFor(setCookie: SetCookie): GatewaySameSite {
  switch (setCookie.sameSite) {
    case "none":
      return "no_restriction";
    case "lax":
      return "lax";
    case "strict":
    case true:
      return "strict";
    default:
      return "unspecified";
  }
}

function allowsSameSiteCookie(
  cookie: StoredGatewayCookie,
  request: Request,
  target: URL,
): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  const sameSite = fetchSite === null || fetchSite === "none" || fetchSite === "same-origin" || fetchSite === "same-site";
  if (cookie.sameSite === "strict") return sameSite;
  if (cookie.sameSite === "lax" || cookie.sameSite === "unspecified") {
    if (sameSite) return true;
    return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate";
  }
  // SameSite=None cookies are accepted only when Secure at write time.
  return target.protocol === "https:" && cookie.secure;
}

function cookiePrefix(spaceId: string): string {
  return `${COOKIE_PREFIX}${spaceId}:`;
}

function initializedKey(spaceId: string): string {
  return `${INITIALIZED_PREFIX}${spaceId}`;
}

async function cookieIdentityHash(cookie: Pick<StoredGatewayCookie, "name" | "domain" | "path" | "partitionKey">): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cookieKey(spaceId: string, cookie: Pick<StoredGatewayCookie, "name" | "domain" | "path" | "partitionKey">): Promise<string> {
  return `${cookiePrefix(spaceId)}${await cookieIdentityHash(cookie)}`;
}

function snapshot(cookie: StoredGatewayCookie): GatewayCookieSnapshot {
  const out: GatewayCookieSnapshot = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    sameSite: cookie.sameSite,
    partitionKey: cookie.partitionKey,
  };
  if (cookie.expiresAtMs !== null) out.expirationDate = cookie.expiresAtMs / 1000;
  return out;
}

function validCookiePrefix(cookie: Pick<StoredGatewayCookie, "name" | "secure" | "hostOnly" | "path">): boolean {
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return false;
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || !cookie.hostOnly || cookie.path !== "/")) {
    return false;
  }
  return true;
}

function encodedCookieBytes(name: string, value: string): number {
  return new TextEncoder().encode(`${name}=${value}`).length;
}

function serializeCookie(cookie: StoredGatewayCookie): string {
  const attributes = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`];
  if (!cookie.hostOnly) attributes.push(`Domain=${cookie.domain}`);
  if (cookie.expiresAtMs !== null) attributes.push(`Expires=${new Date(cookie.expiresAtMs).toUTCString()}`);
  if (cookie.secure) attributes.push("Secure");
  if (cookie.httpOnly) attributes.push("HttpOnly");
  if (cookie.sameSite === "no_restriction") attributes.push("SameSite=None");
  else if (cookie.sameSite === "lax") attributes.push("SameSite=Lax");
  else if (cookie.sameSite === "strict") attributes.push("SameSite=Strict");
  if (cookie.partitionKey !== null) attributes.push("Partitioned");
  return attributes.join("; ");
}

export class GatewayCore {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowPrivateTargets: boolean;

  constructor(
    private readonly storage: HubStorage,
    opts: GatewayCoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    // Workerd's built-in fetch is receiver-sensitive. Storing it directly and
    // later calling `this.fetchImpl(...)` supplies GatewayCore as `this`, which
    // workerd rejects as an illegal invocation; the wrapper preserves a bare
    // platform call while still allowing tests to inject a spy.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.allowPrivateTargets = opts.allowPrivateTargets === true;
  }

  async handleFetch(request: Request): Promise<Response> {
    const decoded = this.decodeTarget(request);
    if ("error" in decoded) return jsonResponse({ error: decoded.error }, decoded.status);
    const { spaceId, target, topLevelSite } = decoded;

    const upstreamHeaders = new Headers();
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (CONTROL_REQUEST_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower) || lower === "cookie") {
        continue;
      }
      upstreamHeaders.append(name, value);
    }
    const upstreamAuthorization = request.headers.get(GATEWAY_UPSTREAM_AUTH_HEADER);
    if (upstreamAuthorization !== null) upstreamHeaders.set("authorization", upstreamAuthorization);

    const credentials = request.headers.get(GATEWAY_CREDENTIALS_HEADER) ?? "include";
    const shouldAttachCookies =
      request.headers.get("sec-fetch-mode") === "navigate" ||
      credentials === "include" ||
      (credentials === "same-origin" && this.requestIsSameOrigin(request, target));
    let matchingCookies: StoredGatewayCookie[] = [];
    if (shouldAttachCookies) {
      matchingCookies = await this.matchingCookies(spaceId, target, topLevelSite, request);
      const cookieHeader = matchingCookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      if (cookieHeader !== "") upstreamHeaders.set("cookie", cookieHeader);
    }

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(target, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "manual",
      });
    } catch (err) {
      return jsonResponse({ error: "upstream_unreachable", detail: String(err) }, 502);
    }

    const setCookies = upstream.headers.getSetCookie();
    if (shouldAttachCookies) {
      for (const header of setCookies) {
        await this.acceptSetCookie(spaceId, target, topLevelSite, header);
      }
      if (setCookies.length > 0) {
        matchingCookies = await this.matchingCookies(spaceId, target, topLevelSite, request);
      }
    }

    const responseHeaders = new Headers(upstream.headers);
    if (!shouldAttachCookies) responseHeaders.delete("set-cookie");
    // Replaying the canonical cookies on the original response hydrates the
    // local Chromium mirror before page JavaScript runs. Outbound Cookie still
    // comes exclusively from this jar; the mirror exists for document.cookie,
    // WebSocket handshakes, DevTools, and native browser behavior.
    for (const cookie of matchingCookies) responseHeaders.append("set-cookie", serializeCookie(cookie));
    responseHeaders.set(GATEWAY_RESPONSE_HEADER, "authoritative");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  async handleCookies(request: Request): Promise<Response> {
    const spaceId = request.headers.get(GATEWAY_SPACE_HEADER);
    if (spaceId === null || spaceId.length === 0) {
      return jsonResponse({ error: "missing_space" }, 400);
    }
    if (request.method === "GET") {
      const cookies = await this.liveCookies(spaceId);
      const initialized =
        cookies.length > 0 || (await this.storage.get<boolean>(initializedKey(spaceId))) === true;
      return jsonResponse({ cookies: cookies.map(snapshot), initialized });
    }
    if (request.method !== "PUT") return jsonResponse({ error: "method_not_allowed" }, 405);
    let body: GatewayCookieMutation | GatewayCookieMutationBatch;
    try {
      body = (await request.json()) as GatewayCookieMutation | GatewayCookieMutationBatch;
    } catch {
      return jsonResponse({ error: "malformed" }, 400);
    }
    const mutations =
      typeof body === "object" && body !== null && "mutations" in body
        ? body.mutations
        : [body as GatewayCookieMutation];
    if (
      !Array.isArray(mutations) ||
      mutations.length > MAX_COOKIES_PER_SPACE ||
      !mutations.every((mutation) => this.validMutation(mutation))
    ) {
      return jsonResponse({ error: "malformed" }, 400);
    }
    for (const mutation of mutations) await this.applyMutation(spaceId, mutation);
    return jsonResponse({ ok: true });
  }

  private decodeTarget(
    request: Request,
  ):
    | { spaceId: string; target: URL; topLevelSite: string | null }
    | { error: string; status: number } {
    const spaceId = request.headers.get(GATEWAY_SPACE_HEADER);
    const encodedTarget = request.headers.get(GATEWAY_TARGET_HEADER);
    if (spaceId === null || spaceId.length === 0 || encodedTarget === null) {
      return { error: "missing_gateway_metadata", status: 400 };
    }
    let target: URL;
    try {
      target = new URL(decodeGatewayHeaderValue(encodedTarget));
    } catch {
      return { error: "invalid_target", status: 400 };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { error: "invalid_target", status: 400 };
    }
    if (target.username !== "" || target.password !== "") {
      return { error: "url_credentials_forbidden", status: 400 };
    }
    if (!this.allowPrivateTargets && isPrivateTarget(target)) {
      return { error: "private_target_forbidden", status: 403 };
    }
    if (request.method === "CONNECT" || request.method === "TRACE") {
      return { error: "method_forbidden", status: 405 };
    }
    let topLevelSite: string | null = null;
    const encodedTopLevel = request.headers.get(GATEWAY_TOP_LEVEL_SITE_HEADER);
    if (encodedTopLevel !== null) {
      try {
        topLevelSite = schemefulSite(new URL(decodeGatewayHeaderValue(encodedTopLevel)));
      } catch {
        return { error: "invalid_top_level_site", status: 400 };
      }
    }
    return { spaceId, target, topLevelSite };
  }

  private requestIsSameOrigin(request: Request, target: URL): boolean {
    const origin = request.headers.get("origin");
    if (origin !== null) return origin === target.origin;
    const referrer = request.headers.get("referer");
    if (referrer === null) return true;
    try {
      return new URL(referrer).origin === target.origin;
    } catch {
      return false;
    }
  }

  private async liveCookies(spaceId: string): Promise<StoredGatewayCookie[]> {
    const now = this.now();
    const stored = await this.storage.list<StoredGatewayCookie>({ prefix: cookiePrefix(spaceId) });
    const live: StoredGatewayCookie[] = [];
    for (const [key, cookie] of stored) {
      if (cookie.expiresAtMs !== null && cookie.expiresAtMs <= now) {
        await this.storage.delete(key);
      } else {
        live.push(cookie);
      }
    }
    return live;
  }

  private async matchingCookies(
    spaceId: string,
    target: URL,
    topLevelSite: string | null,
    request: Request,
  ): Promise<StoredGatewayCookie[]> {
    const host = canonicalHostname(target.hostname);
    const path = target.pathname === "" ? "/" : target.pathname;
    return (await this.liveCookies(spaceId))
      .filter((cookie) => {
        if (cookie.secure && target.protocol !== "https:") return false;
        if (cookie.hostOnly ? cookie.domain !== host : !domainMatches(host, cookie.domain)) return false;
        if (!pathMatches(path, cookie.path)) return false;
        if (cookie.partitionKey !== null && cookie.partitionKey !== topLevelSite) return false;
        return allowsSameSiteCookie(cookie, request, target);
      })
      .sort((a, b) => b.path.length - a.path.length || a.createdAtMs - b.createdAtMs);
  }

  private async acceptSetCookie(
    spaceId: string,
    target: URL,
    topLevelSite: string | null,
    header: string,
  ): Promise<void> {
    let parsed: SetCookie;
    try {
      parsed = parseSetCookie(header, { decode: (value) => value });
    } catch {
      return;
    }
    if (parsed.value === undefined || encodedCookieBytes(parsed.name, parsed.value) > MAX_COOKIE_BYTES) {
      return;
    }
    const requestHost = canonicalHostname(target.hostname);
    const hostOnly = parsed.domain === undefined;
    const domain = hostOnly ? requestHost : canonicalHostname(parsed.domain as string);
    if (!hostOnly && (!domainMatches(requestHost, domain) || isPublicSuffix(domain))) return;
    const path = parsed.path?.startsWith("/") ? parsed.path : defaultCookiePath(target.pathname);
    const secure = parsed.secure === true;
    const sameSite = sameSiteFor(parsed);
    if ((sameSite === "no_restriction" || parsed.partitioned === true) && !secure) return;
    if (secure && target.protocol !== "https:" && !this.allowPrivateTargets) return;
    if (parsed.partitioned === true && topLevelSite === null) return;
    const now = this.now();
    let expiresAtMs: number | null = parsed.expires?.getTime() ?? null;
    if (parsed.maxAge !== undefined) expiresAtMs = now + parsed.maxAge * 1000;
    if (expiresAtMs !== null) expiresAtMs = Math.min(expiresAtMs, now + MAX_COOKIE_LIFETIME_MS);
    const cookie: StoredGatewayCookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      hostOnly,
      path,
      secure,
      httpOnly: parsed.httpOnly === true,
      session: expiresAtMs === null,
      sameSite,
      partitionKey: parsed.partitioned === true ? topLevelSite : null,
      createdAtMs: now,
      expiresAtMs,
    };
    if (!validCookiePrefix(cookie)) return;
    await this.storeOrDelete(spaceId, cookie, parsed.maxAge !== undefined && parsed.maxAge <= 0);
  }

  private validMutation(value: unknown): value is GatewayCookieMutation {
    if (typeof value !== "object" || value === null) return false;
    const mutation = value as Partial<GatewayCookieMutation>;
    const cookie = mutation.cookie as Partial<GatewayCookieSnapshot> | undefined;
    return (
      typeof mutation.removed === "boolean" &&
      typeof cookie === "object" &&
      cookie !== null &&
      typeof cookie.name === "string" &&
      typeof cookie.value === "string" &&
      typeof cookie.domain === "string" &&
      typeof cookie.hostOnly === "boolean" &&
      typeof cookie.path === "string" &&
      typeof cookie.secure === "boolean" &&
      typeof cookie.httpOnly === "boolean" &&
      typeof cookie.session === "boolean" &&
      (cookie.sameSite === "unspecified" ||
        cookie.sameSite === "no_restriction" ||
        cookie.sameSite === "lax" ||
        cookie.sameSite === "strict") &&
      (cookie.partitionKey === null || typeof cookie.partitionKey === "string") &&
      (cookie.expirationDate === undefined ||
        (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)))
    );
  }

  private async applyMutation(spaceId: string, mutation: GatewayCookieMutation): Promise<void> {
    const input = mutation.cookie;
    const domain = canonicalHostname(input.domain);
    if (domain === "" || (!input.hostOnly && isPublicSuffix(domain))) return;
    const now = this.now();
    const expiresAtMs = input.expirationDate === undefined ? null : input.expirationDate * 1000;
    const cookie: StoredGatewayCookie = {
      ...input,
      domain,
      path: input.path.startsWith("/") ? input.path : "/",
      partitionKey: input.partitionKey ?? null,
      createdAtMs: now,
      expiresAtMs,
    };
    if (!validCookiePrefix(cookie) || encodedCookieBytes(cookie.name, cookie.value) > MAX_COOKIE_BYTES) {
      return;
    }
    await this.storeOrDelete(
      spaceId,
      cookie,
      mutation.removed || (expiresAtMs !== null && expiresAtMs <= now),
    );
  }

  private async storeOrDelete(
    spaceId: string,
    cookie: StoredGatewayCookie,
    remove: boolean,
  ): Promise<void> {
    await this.storage.put(initializedKey(spaceId), true);
    const key = await cookieKey(spaceId, cookie);
    if (remove) {
      await this.storage.delete(key);
      return;
    }
    const current = await this.storage.get<StoredGatewayCookie>(key);
    if (current !== undefined) cookie.createdAtMs = current.createdAtMs;
    if (current === undefined) {
      const count = (await this.storage.list({ prefix: cookiePrefix(spaceId) })).size;
      if (count >= MAX_COOKIES_PER_SPACE) return;
    }
    await this.storage.put(key, cookie);
  }
}
