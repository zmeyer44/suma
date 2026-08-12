/**
 * Navigation policy for tab WebContents (PRD §8.1: site content can never
 * navigate into, embed, or overlay privileged UI). Pure — imported by unit
 * tests; no Electron here.
 */

import { isInternalPageUrl } from "../shared/internal-pages";

/** The blank page a fresh tab shows before its first real navigation. */
export const NEW_TAB_URL = "about:blank";

const ALLOWED_TAB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Only http/https may load in tabs. suma://, chrome://, file:// and
 * anything unparseable are refused — enforced at will-navigate/will-redirect
 * and again on main-initiated loads.
 */
export function isAllowedTabUrl(url: string): boolean {
  if (url === NEW_TAB_URL) return true;
  try {
    return ALLOWED_TAB_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * What Suma ITSELF may put in a tab: the web, plus its own internal pages
 * (`suma://settings`). Deliberately a second function rather than a widening
 * of `isAllowedTabUrl` — that one guards will-navigate/will-redirect, where
 * the caller is site content and suma:// must stay refused. The distinction
 * is the whole security property: an internal page is somewhere Suma can
 * send you, never somewhere a page can send itself.
 */
export function isAllowedTabTarget(url: string): boolean {
  return isAllowedTabUrl(url) || isInternalPageUrl(url);
}

/**
 * A settable new-tab page: empty (blank tab) or a real http/https address.
 * `about:blank` is spelled as empty here, so the setting has one canonical
 * form for "blank" rather than two.
 */
export function isValidNewTabUrl(url: string): boolean {
  if (url === "") return true;
  try {
    return ALLOWED_TAB_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The page a fresh tab should load. The stored setting is re-validated on
 * every use rather than trusted: it syncs between devices, so a value written
 * by another (possibly newer, possibly buggy) build must never be able to
 * point a tab at a non-web scheme.
 */
export function newTabUrlFor(settings: { newTabUrl?: string }): string {
  const configured = settings.newTabUrl?.trim() ?? "";
  return isValidNewTabUrl(configured) && configured !== "" ? configured : NEW_TAB_URL;
}
