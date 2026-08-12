/**
 * Saves core — the pure half of the saves pipeline, split out (like tts-core)
 * so the gesture detector, the og fallback, and the model-output parsing are
 * testable without Electron, the filesystem, or a network.
 *
 * The flow it supports (saves-service.ts + index.ts own the effects):
 *
 *   double-Shift → capture script runs in the page → sanitizeCapturedPage
 *   → fallbackItemFields writes the item immediately (og tags) → the model,
 *   when a gateway key exists, refines type/name/description/author in place.
 *
 * Everything arriving from the page or the model is UNTRUSTED: the capture
 * result is whatever the site's JS handed back, and the model output is
 * whatever the provider streamed. Both are clamped and validated here before
 * they touch the store.
 */

import {
  isSavedItemType,
  MAX_AUTHOR_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_SELECTION_CHARS,
  normalizeTags,
  sanitizeImageUrl,
  type CapturedPage,
  type SavedItem,
  type SavedItemPatch,
  type SavedItemType,
} from "../../shared/saves";

/* ----------------------------- gesture detector ---------------------------- */

/** Two bare Shift taps at most this far apart read as "save this". */
export const DOUBLE_SHIFT_WINDOW_MS = 400;

/** The slice of Electron's `Input` the detector needs — pure and mockable. */
export interface KeyDownInput {
  key: string;
  isAutoRepeat: boolean;
  /** Any of control/meta/alt held — a chord, so never part of the gesture. */
  chorded: boolean;
}

/**
 * Double-Shift, JetBrains-style: two Shift keydowns in quick succession with
 * NO other key between them. Any non-Shift key (or a chorded Shift) resets,
 * which is what keeps Shift-typed capitals — Shift↓ a↓ Shift↓ — from firing.
 * A trigger consumes both taps, so holding a rhythm of taps fires once per
 * pair rather than on every tap after the first.
 */
export class DoubleShiftDetector {
  private lastShiftAtMs: number | null = null;

  keyDown(input: KeyDownInput, atMs: number): boolean {
    if (input.key !== "Shift" || input.chorded) {
      this.lastShiftAtMs = null;
      return false;
    }
    if (input.isAutoRepeat) return false;
    if (
      this.lastShiftAtMs !== null &&
      atMs - this.lastShiftAtMs <= DOUBLE_SHIFT_WINDOW_MS
    ) {
      this.lastShiftAtMs = null;
      return true;
    }
    this.lastShiftAtMs = atMs;
    return false;
  }
}

/* ------------------------------ page capture ------------------------------- */

/** In-page clamps, so a heavy page never ships megabytes across IPC. */
const CAPTURE_MAX_META_ENTRIES = 80;
const CAPTURE_MAX_META_CHARS = 600;
const CAPTURE_MAX_JSONLD_BLOCKS = 4;
const CAPTURE_MAX_JSONLD_CHARS = 4000;
const CAPTURE_MAX_TEXT_CHARS = 6000;

/**
 * Runs inside the tab via `executeJavaScript`. Collects the page's meta tags,
 * JSON-LD blocks, leading visible text, and the current selection — the raw
 * material for both the og fallback and the model prompt. Self-clamping, and
 * synchronous on purpose: the return value is the expression's value.
 */
export const CAPTURE_SCRIPT = `(() => {
  const clamp = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
  const meta = {};
  let metaCount = 0;
  for (const el of Array.from(document.querySelectorAll("meta[content]"))) {
    if (metaCount >= ${String(CAPTURE_MAX_META_ENTRIES)}) break;
    const key = (el.getAttribute("property") || el.getAttribute("name") || "")
      .trim()
      .toLowerCase();
    const content = clamp(el.getAttribute("content"), ${String(CAPTURE_MAX_META_CHARS)}).trim();
    if (key === "" || content === "" || meta[key] !== undefined) continue;
    meta[key] = content;
    metaCount += 1;
  }
  const jsonLd = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  )
    .slice(0, ${String(CAPTURE_MAX_JSONLD_BLOCKS)})
    .map((el) => clamp(el.textContent, ${String(CAPTURE_MAX_JSONLD_CHARS)}).trim())
    .filter((text) => text !== "");
  const selection = clamp(String(window.getSelection() || ""), ${String(MAX_SELECTION_CHARS)}).trim();
  const textExcerpt = clamp(
    document.body ? document.body.innerText : "",
    ${String(CAPTURE_MAX_TEXT_CHARS)},
  );
  return {
    meta,
    jsonLd,
    textExcerpt,
    selection: selection === "" ? null : selection,
  };
})()`;

function clampString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Validate whatever the page script returned — a hostile page can hand back
 * any shape it likes. URL and title come from the TAB (main's own state), not
 * from the page, so a page cannot claim to be somewhere it is not.
 */
export function sanitizeCapturedPage(
  raw: unknown,
  url: string,
  title: string,
  faviconUrl: string | null = null,
): CapturedPage {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const meta: Record<string, string> = {};
  if (typeof record["meta"] === "object" && record["meta"] !== null) {
    let count = 0;
    for (const [key, value] of Object.entries(record["meta"])) {
      if (count >= CAPTURE_MAX_META_ENTRIES) break;
      if (typeof value !== "string") continue;
      meta[key.slice(0, 120).toLowerCase()] = value.slice(0, CAPTURE_MAX_META_CHARS);
      count += 1;
    }
  }
  const jsonLd = Array.isArray(record["jsonLd"])
    ? record["jsonLd"]
        .slice(0, CAPTURE_MAX_JSONLD_BLOCKS)
        .flatMap((entry) =>
          typeof entry === "string" && entry.trim() !== ""
            ? [entry.slice(0, CAPTURE_MAX_JSONLD_CHARS)]
            : [],
        )
    : [];
  const selection = clampString(record["selection"], MAX_SELECTION_CHARS).trim();
  return {
    url,
    title: title.slice(0, 300),
    // From the tab like url/title, but still URL-validated — favicons can be
    // data: URLs on some pages, and only fetchable http(s) ones are worth
    // persisting (same rule as thumbnails).
    faviconUrl: sanitizeImageUrl(faviconUrl),
    meta,
    jsonLd,
    textExcerpt: clampString(record["textExcerpt"], CAPTURE_MAX_TEXT_CHARS),
    selection: selection === "" ? null : selection,
  };
}

/* ------------------------------- og fallback ------------------------------- */

/** The extracted half of an item — what the model (or the fallback) decides. */
export interface ExtractedFields {
  type?: SavedItemType;
  name?: string;
  description?: string;
  imageUrl?: string | null;
  author?: string | null;
}

/** Best-effort og:type → item type. The model refines; this only has to land
 *  in the right neighborhood when no model is reachable. */
export function typeFromOgType(ogType: string): SavedItemType {
  const value = ogType.trim().toLowerCase();
  if (value === "article") return "article";
  if (value === "book" || value.startsWith("book")) return "book";
  if (value === "video.movie") return "movie";
  if (value.startsWith("video")) return "video";
  // Spotify/Apple mark podcast episodes with music.* types; actual songs land
  // here too, which the model corrects when it runs.
  if (value.startsWith("music")) return "podcast";
  if (value.includes("product")) return "product";
  return "website";
}

function firstMeta(
  meta: Record<string, string>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = meta[key]?.trim() ?? "";
    if (value !== "") return value;
  }
  return null;
}

/** One or two lines, single-spaced — a card blurb, not a page dump. */
function asBlurb(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/**
 * The no-model save (and the placeholder the model refines): the page's own
 * og/twitter/meta tags. Always yields at least a name (falling back to the
 * tab title, then the URL host), so a save never lands blank.
 */
export function fallbackItemFields(capture: CapturedPage): Required<ExtractedFields> {
  const { meta } = capture;
  const name =
    firstMeta(meta, ["og:title", "twitter:title"]) ?? capture.title.trim();
  const description =
    firstMeta(meta, ["og:description", "description", "twitter:description"]) ??
    "";
  // article:author is often a profile URL rather than a name — drop those.
  const authorRaw = firstMeta(meta, ["author", "article:author", "book:author"]);
  const author =
    authorRaw !== null && !/^https?:\/\//i.test(authorRaw)
      ? asBlurb(authorRaw, MAX_AUTHOR_CHARS)
      : null;
  let host = "";
  try {
    host = new URL(capture.url).hostname;
  } catch {
    // Keep "" — the URL itself is still shown on the card.
  }
  return {
    type: typeFromOgType(meta["og:type"] ?? ""),
    name: asBlurb(name === "" ? host || capture.url : name, MAX_NAME_CHARS),
    description: asBlurb(description, MAX_DESCRIPTION_CHARS),
    imageUrl: sanitizeImageUrl(
      firstMeta(meta, ["og:image", "og:image:url", "twitter:image"]),
    ),
    author,
  };
}

/* ------------------------------ model contract ----------------------------- */

/**
 * Vercel AI Gateway's OpenAI-compatible surface — the same gateway (and the
 * same key) the TTS provider uses, on its chat endpoint. One credential buys
 * both features; see shared/tts.ts on why the gateway is worth speaking.
 */
export const SAVES_GATEWAY_CHAT_URL =
  "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Small and fast — extraction is a classification, not an essay. Override
 *  with SUMA_SAVES_MODEL (any gateway model id). */
export const DEFAULT_SAVES_MODEL = "anthropic/claude-haiku-4.5";

export const EXTRACTION_SYSTEM_PROMPT = [
  "You identify the single ITEM a webpage is about, for a bookmarking tool that saves things rather than pages.",
  "Classify it as exactly one of: website, article, video, podcast, book, product, movie, other.",
  'Use "website" when the user is saving the site/page itself (a homepage, a tool, a reference); use a specific type when the page is ABOUT one thing (a product listing, a book, an episode).',
  "If text the user highlighted is provided, it signals what they mean to save — e.g. a book title highlighted in an article means the book, not the article.",
  "Respond with ONLY a JSON object, no prose, no code fences:",
  '{"type": "...", "name": "...", "description": "...", "author": "..." | null, "imageUrl": "..." | null}',
  "name: the item's own name (book title, product name, episode title), not the site's.",
  "description: one or two short sentences describing the item itself.",
  "author: the creator when the type has one (author, director, artist, channel, journalist), else null.",
  "imageUrl: choose from the image URLs given in the page data, or null. Never invent a URL.",
].join("\n");

/** The user-message payload: everything captured, selection first. */
export function extractionPrompt(capture: CapturedPage): string {
  const lines: string[] = [`URL: ${capture.url}`, `Page title: ${capture.title}`];
  if (capture.selection !== null) {
    lines.push(
      "",
      "Text the user highlighted before saving (strong hint about the item they mean):",
      capture.selection,
    );
  }
  const metaEntries = Object.entries(capture.meta);
  if (metaEntries.length > 0) {
    lines.push("", "Meta tags:");
    for (const [key, value] of metaEntries) lines.push(`${key}: ${value}`);
  }
  if (capture.jsonLd.length > 0) {
    lines.push("", "JSON-LD structured data:");
    lines.push(...capture.jsonLd);
  }
  if (capture.textExcerpt.trim() !== "") {
    lines.push("", "Beginning of the page text:", capture.textExcerpt);
  }
  return lines.join("\n");
}

export interface ExtractionRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export function buildExtractionRequest(args: {
  capture: CapturedPage;
  model: string;
  apiKey: string;
}): ExtractionRequest {
  return {
    url: SAVES_GATEWAY_CHAT_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 600,
      temperature: 0,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: extractionPrompt(args.capture) },
      ],
    }),
  };
}

/** choices[0].message.content out of an OpenAI-compatible completion body. */
export function parseChatCompletionText(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const choices = (parsed as Record<string, unknown>)["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (typeof first !== "object" || first === null) return null;
    const message = (first as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) return null;
    const content = (message as Record<string, unknown>)["content"];
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

/**
 * Tolerant read of the model's JSON: fences stripped, the first {...} span
 * taken, unknown fields ignored, every kept field re-validated. Null when
 * nothing usable came back — the caller keeps the og fallback in that case.
 */
export function parseExtraction(text: string): ExtractedFields | null {
  const stripped = text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const fields: ExtractedFields = {};
  if (isSavedItemType(record["type"])) fields.type = record["type"];
  if (typeof record["name"] === "string" && record["name"].trim() !== "") {
    fields.name = asBlurb(record["name"], MAX_NAME_CHARS);
  }
  if (typeof record["description"] === "string") {
    const description = asBlurb(record["description"], MAX_DESCRIPTION_CHARS);
    if (description !== "") fields.description = description;
  }
  if (record["author"] === null) fields.author = null;
  else if (typeof record["author"] === "string") {
    const author = asBlurb(record["author"], MAX_AUTHOR_CHARS);
    fields.author = author === "" ? null : author;
  }
  if (record["imageUrl"] === null) fields.imageUrl = null;
  else if (typeof record["imageUrl"] === "string") {
    // An invalid or non-http URL is dropped entirely (keep the fallback's
    // image) rather than clearing the field.
    const image = sanitizeImageUrl(record["imageUrl"]);
    if (image !== null) fields.imageUrl = image;
  }
  return Object.keys(fields).length === 0 ? null : fields;
}

/* ------------------------------- persistence ------------------------------- */

export const SAVES_FILENAME = "saves.json";

/** One stored item, re-validated on load — the file is user-editable disk. */
export function sanitizeSavedItem(raw: unknown): SavedItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const url = record["url"];
  const name = record["name"];
  if (typeof id !== "string" || id === "") return null;
  if (typeof url !== "string" || url === "") return null;
  if (typeof name !== "string" || name === "") return null;
  const selection = clampString(record["selection"], MAX_SELECTION_CHARS);
  return {
    id,
    type: isSavedItemType(record["type"]) ? record["type"] : "other",
    name: name.slice(0, MAX_NAME_CHARS),
    description: clampString(record["description"], MAX_DESCRIPTION_CHARS),
    imageUrl: sanitizeImageUrl(record["imageUrl"]),
    url,
    faviconUrl: sanitizeImageUrl(record["faviconUrl"]),
    author:
      typeof record["author"] === "string" && record["author"].trim() !== ""
        ? record["author"].slice(0, MAX_AUTHOR_CHARS)
        : null,
    tags: normalizeTags(record["tags"]),
    selection: selection === "" ? null : selection,
    source: record["source"] === "llm" ? "llm" : "metadata",
    // An item persisted mid-extraction has no extraction coming after a
    // restart — load it as settled.
    status: "ready",
    savedAtMs:
      typeof record["savedAtMs"] === "number" &&
      Number.isFinite(record["savedAtMs"])
        ? record["savedAtMs"]
        : 0,
  };
}

export function parseSavedItemsFile(json: string): SavedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>)["items"])
      ? ((parsed as Record<string, unknown>)["items"] as unknown[])
      : [];
  return list.flatMap((entry) => {
    const item = sanitizeSavedItem(entry);
    return item === null ? [] : [item];
  });
}

/**
 * A user edit, validated field by field. Unknown/invalid values are rejected
 * loudly (the edit came from our own UI, so a bad shape is a bug), except
 * that an empty name keeps the old one — a card must never go nameless.
 */
export function applySavedItemPatch(
  item: SavedItem,
  patch: SavedItemPatch,
): SavedItem {
  const next: SavedItem = { ...item, tags: [...item.tags] };
  if (patch.type !== undefined) {
    if (!isSavedItemType(patch.type)) throw new Error("invalid item type");
    next.type = patch.type;
  }
  if (patch.name !== undefined) {
    const name = asBlurb(patch.name, MAX_NAME_CHARS);
    if (name !== "") next.name = name;
  }
  if (patch.description !== undefined) {
    next.description = asBlurb(patch.description, MAX_DESCRIPTION_CHARS);
  }
  if (patch.author !== undefined) {
    const author = patch.author === null ? "" : asBlurb(patch.author, MAX_AUTHOR_CHARS);
    next.author = author === "" ? null : author;
  }
  if (patch.imageUrl !== undefined) {
    next.imageUrl = patch.imageUrl === null ? null : sanitizeImageUrl(patch.imageUrl);
  }
  if (patch.tags !== undefined) {
    next.tags = normalizeTags(patch.tags);
  }
  return next;
}
