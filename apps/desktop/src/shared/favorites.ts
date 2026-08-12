/**
 * Favorite sites — the contract shared by main (which stores the list) and
 * the renderer (which stars tabs, shows the URL-bar tile row, and edits the
 * list in settings).
 *
 * A favorite is an ADDRESS, not a capture: starring a tab remembers exactly
 * the page it was on, so the star lights up again only on that page. Like the
 * TTS and Saves contracts this file is pure and dependency-free on purpose —
 * both processes import it, so the two sides can never disagree about what a
 * favorite is.
 */

export interface FavoriteSite {
  id: string;
  /** Canonical http(s) address (normalizeFavoriteUrl) — the identity a star
   *  toggle matches against, so it is normalized ONCE, on the way in. */
  url: string;
  title: string;
  addedAtMs: number;
}

export const MAX_FAVORITES = 50;
export const MAX_FAVORITE_TITLE_CHARS = 100;

/**
 * Canonical form of a favorite's address, or null for anything a tab cannot
 * load as a favorite (internal pages, javascript:, empty input). URL's own
 * serialization is the normalizer — lowercased host, resolved default port —
 * so "HTTPS://Example.com" and "https://example.com/" land on one identity.
 */
export function normalizeFavoriteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Trimmed, clamped display title; falls back to the URL's host. */
export function normalizeFavoriteTitle(raw: string, url: string): string {
  const title = raw.trim().slice(0, MAX_FAVORITE_TITLE_CHARS);
  if (title !== "") return title;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The favorite matching a tab's current address, if any — the star's state. */
export function favoriteForUrl(
  favorites: readonly FavoriteSite[],
  url: string,
): FavoriteSite | null {
  const canonical = normalizeFavoriteUrl(url);
  if (canonical === null) return null;
  return favorites.find((f) => f.url === canonical) ?? null;
}

/**
 * Tolerant read of favorites.json: anything that is not a well-formed entry
 * is dropped rather than poisoning the whole list. Order is preserved — the
 * file order IS the tile order under the URL bar.
 */
export function parseFavoritesFile(text: string): FavoriteSite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const favorites: FavoriteSite[] = [];
  const seen = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string" || record["id"] === "") continue;
    if (typeof record["url"] !== "string") continue;
    const url = normalizeFavoriteUrl(record["url"]);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    favorites.push({
      id: record["id"],
      url,
      title: normalizeFavoriteTitle(
        typeof record["title"] === "string" ? record["title"] : "",
        url,
      ),
      addedAtMs:
        typeof record["addedAtMs"] === "number" &&
        Number.isFinite(record["addedAtMs"])
          ? record["addedAtMs"]
          : 0,
    });
    if (favorites.length >= MAX_FAVORITES) break;
  }
  return favorites;
}
