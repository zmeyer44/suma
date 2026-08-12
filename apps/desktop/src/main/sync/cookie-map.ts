/**
 * Pure mapping between Electron's cookies API shapes and the protocol's
 * cookie model (PRD §8.3 "Cookie identity — corrected"). No Electron
 * imports — unit tests exercise this directly; the structural types below
 * mirror Electron.Cookie / Electron.CookiesSetDetails.
 */

import {
  hostKeyIsHostOnly,
  normalizedHost,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type SameSite,
} from "@suma/protocol";

/** Structural mirror of Electron.Cookie (the cookies-'changed' payload). */
export interface ElectronCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number;
  sameSite?: string;
}

export type ChromiumSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/** Structural mirror of Electron.CookiesSetDetails. */
export interface ElectronCookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch; omitted for session cookies. */
  expirationDate?: number;
  sameSite: ChromiumSameSite;
}

export interface ElectronCookieRemoveTarget {
  url: string;
  name: string;
}

const SAME_SITES: ReadonlySet<string> = new Set(["unspecified", "no_restriction", "lax", "strict"]);

export function sameSiteFromChromium(value: string | undefined): SameSite {
  return value !== undefined && SAME_SITES.has(value) ? (value as SameSite) : "unspecified";
}

export function sameSiteToChromium(value: SameSite): ChromiumSameSite {
  return value;
}

/**
 * Identity from an observed Electron cookie. hostKey is Electron's domain
 * as-is — the leading dot marking a domain cookie is preserved (§8.3).
 * partitionKey is "" because Electron's cookies API is unpartitioned in v0
 * (documented limitation); sourceScheme is approximated from `secure`.
 */
export function identityForCookie(spaceId: string, cookie: ElectronCookie): CookieIdentity {
  return {
    spaceId,
    hostKey: cookie.domain ?? "",
    name: cookie.name,
    path: cookie.path ?? "/",
    partitionKey: "",
    sourceScheme: cookie.secure === true ? "secure" : "nonsecure",
  };
}

export function attributesForCookie(cookie: ElectronCookie): CookieAttributes {
  const expiresMs = cookie.expirationDate !== undefined ? Math.round(cookie.expirationDate * 1000) : null;
  return {
    value: cookie.value,
    expiresMs,
    persistent: expiresMs !== null,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: sameSiteFromChromium(cookie.sameSite),
    // Electron's cookies API does not expose Chromium's priority field.
    priority: "medium",
  };
}

/** URL Electron's cookies.set/remove expects, rebuilt from identity scope. */
export function cookieUrlFor(identity: CookieIdentity, secure: boolean): string {
  const scheme = secure || identity.sourceScheme === "secure" ? "https" : "http";
  return `${scheme}://${normalizedHost(identity.hostKey)}${identity.path}`;
}

export function setDetailsForPlain(plain: CookiePlain): ElectronCookieSetDetails {
  const { identity, attributes } = plain;
  if (attributes === null) throw new Error("cannot build set details for a tombstone");
  const details: ElectronCookieSetDetails = {
    url: cookieUrlFor(identity, attributes.secure),
    name: identity.name,
    value: attributes.value,
    path: identity.path,
    secure: attributes.secure,
    httpOnly: attributes.httpOnly,
    sameSite: sameSiteToChromium(attributes.sameSite),
  };
  // Domain omitted for host-only cookies — passing it would widen scope.
  if (!hostKeyIsHostOnly(identity.hostKey)) details.domain = identity.hostKey;
  if (attributes.expiresMs !== null) details.expirationDate = attributes.expiresMs / 1000;
  return details;
}

export function removeTargetFor(identity: CookieIdentity): ElectronCookieRemoveTarget {
  return { url: cookieUrlFor(identity, false), name: identity.name };
}
