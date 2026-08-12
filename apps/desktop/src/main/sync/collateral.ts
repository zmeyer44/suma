/**
 * Pure collateral-damage logic for tombstone removal (PRD §8.3).
 *
 * Electron's cookies.remove(url, name) cannot disambiguate cookies that share
 * a name across host-only vs domain scope or across paths, so applying one
 * tombstone can delete siblings. These helpers decide, given the tombstone's
 * target identity and the cookies observed in the session, which cookies are
 * collateral and how to reconstruct any that disappear. Identity comparison
 * and reconstruction go through the exact same mapping cookie-map.ts uses.
 * No Electron imports — unit tests exercise this directly.
 */

import type { CookieIdentity } from "@suma/protocol";
import {
  attributesForCookie,
  identityForCookie,
  setDetailsForPlain,
  type ElectronCookie,
  type ElectronCookieSetDetails,
} from "./cookie-map";

/**
 * Scope key over the identity fields Electron can observe: host key (domain
 * dot-scope preserved), name, path. spaceId/partitionKey/sourceScheme are
 * uniform within one session's store, so they cannot disambiguate here.
 */
function scopeKey(hostKey: string, name: string, path: string): string {
  return JSON.stringify([hostKey, name, path]);
}

function scopeKeyForCookie(cookie: ElectronCookie): string {
  const identity = identityForCookie("", cookie);
  return scopeKey(identity.hostKey, identity.name, identity.path);
}

/** True when the observed cookie IS the tombstone's target. */
export function matchesTarget(target: CookieIdentity, cookie: ElectronCookie): boolean {
  return scopeKeyForCookie(cookie) === scopeKey(target.hostKey, target.name, target.path);
}

/**
 * Cookies that share the target's name but are NOT the target — the ones
 * cookies.remove(url, name) may take out alongside it.
 */
export function collateralFor(
  target: CookieIdentity,
  cookies: readonly ElectronCookie[],
): ElectronCookie[] {
  return cookies.filter((c) => c.name === target.name && !matchesTarget(target, c));
}

/** Collateral cookies whose identity no longer appears after the removal. */
export function lostCollateral(
  collateral: readonly ElectronCookie[],
  after: readonly ElectronCookie[],
): ElectronCookie[] {
  const surviving = new Set(after.map(scopeKeyForCookie));
  return collateral.filter((c) => !surviving.has(scopeKeyForCookie(c)));
}

/** Set details that reconstruct an observed cookie via the exact set mapping. */
export function restoreDetailsFor(
  spaceId: string,
  cookie: ElectronCookie,
): ElectronCookieSetDetails {
  return setDetailsForPlain({
    identity: identityForCookie(spaceId, cookie),
    attributes: attributesForCookie(cookie),
    deleted: false,
  });
}
