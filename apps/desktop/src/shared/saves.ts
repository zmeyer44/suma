/**
 * Saves — smart bookmarking contract, shared by main (which captures and
 * extracts) and the renderer (which browses and edits the collection).
 *
 * A save is an ITEM, not a page: double-tapping Shift on an Amazon book page
 * saves a `book` with a title and an author, not "amazon.com". Main captures
 * the page (text, og/meta tags, any highlighted selection), asks a model to
 * classify and describe the item, and falls back to the page's own og tags
 * when no model is reachable — so a save always lands, with or without a key.
 *
 * Like the TTS contract this file is pure and dependency-free on purpose:
 * both processes import it, so a type cannot be added to the picker without
 * main knowing how to extract it.
 */

/** What kind of thing the user saved — decided by the model, editable after. */
export type SavedItemType =
  | "website"
  | "article"
  | "video"
  | "podcast"
  | "book"
  | "product"
  | "movie"
  | "other";

export const SAVED_ITEM_TYPES: readonly SavedItemType[] = [
  "website",
  "article",
  "video",
  "podcast",
  "book",
  "product",
  "movie",
  "other",
];

export function isSavedItemType(value: unknown): value is SavedItemType {
  return (
    typeof value === "string" &&
    (SAVED_ITEM_TYPES as readonly string[]).includes(value)
  );
}

/** Where an item's fields came from — shown so the user knows what guessed. */
export type SavedItemSource = "llm" | "metadata";

/**
 * "extracting": the fallback fields are showing while the model call is still
 * in flight; the card updates in place when it lands (or keeps the fallback
 * if it fails). "ready": what you see is the final extraction.
 */
export type SavedItemStatus = "extracting" | "ready";

export interface SavedItem {
  id: string;
  type: SavedItemType;
  name: string;
  /** Short 1–2 line description of the item itself, not of the webpage. */
  description: string;
  imageUrl: string | null;
  /** The webpage the item was saved from. */
  url: string;
  /** The site's favicon at save time (from the TAB's own state, never the
   *  page script) — shown beside the host on cards. Null when the tab had
   *  none by the time the user saved. */
  faviconUrl: string | null;
  /** For authored content — books, films, articles, channels. */
  author: string | null;
  /** User-managed labels ("wishlist", "gift ideas"); never model-invented. */
  tags: string[];
  /** Text the user had highlighted when they saved, kept as provenance. */
  selection: string | null;
  source: SavedItemSource;
  status: SavedItemStatus;
  savedAtMs: number;
}

/** The user-editable half of an item (the detail card's fields). */
export interface SavedItemPatch {
  type?: SavedItemType;
  name?: string;
  description?: string;
  imageUrl?: string | null;
  author?: string | null;
  tags?: string[];
}

/* ---------------------------------- limits --------------------------------- */

export const MAX_SAVED_ITEMS = 2000;
export const MAX_NAME_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 400;
export const MAX_AUTHOR_CHARS = 120;
export const MAX_TAG_CHARS = 40;
export const MAX_TAGS = 20;
export const MAX_SELECTION_CHARS = 2000;

/** Only fetchable images — a javascript: or data: URL is not a thumbnail. */
export function sanitizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Trim, drop empties/dupes (case-insensitive), clamp count and length. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().slice(0, MAX_TAG_CHARS);
    const key = tag.toLowerCase();
    if (tag === "" || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/* --------------------------------- search ---------------------------------- */

/**
 * The panel's search: every whitespace-separated term must match somewhere in
 * the item (name, description, author, url, type, or a tag). Substring, not
 * fuzzy — "wish book" finds tagged books without surprising near-misses.
 */
export function matchesSavesQuery(item: SavedItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return true;
  const haystack = [
    item.name,
    item.description,
    item.author ?? "",
    item.url,
    item.type,
    ...item.tags,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/* ------------------------------ capture payload ---------------------------- */

/**
 * What main lifts out of the page at save time. Everything here is untrusted
 * page output and is clamped by `sanitizeCapturedPage` (main/saves/saves-core)
 * before it reaches the extractor or the fallback mapper.
 */
export interface CapturedPage {
  /** Authoritative URL/title from the tab, not from the page script. */
  url: string;
  title: string;
  /** The tab's current favicon — main's own state, like url/title. */
  faviconUrl: string | null;
  /** `<meta>` name/property → content, lower-cased keys (og:*, twitter:*, …). */
  meta: Record<string, string>;
  /** Raw JSON-LD script bodies, truncated — often the richest structured data. */
  jsonLd: string[];
  /** Leading visible text of the page, truncated. */
  textExcerpt: string;
  /** What the user had highlighted, if anything. */
  selection: string | null;
}
