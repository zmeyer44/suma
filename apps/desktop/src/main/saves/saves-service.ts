/**
 * SavesService — the saved-items store and the extraction caller.
 *
 * Lives in MAIN for the same reasons TTS does: the gateway API key never
 * reaches the renderer (the panel is handed finished items), and the capture
 * script has to run against tab WebContentsViews only this process can see.
 *
 * A save is written IMMEDIATELY from the page's own og tags — the model call
 * that follows is a refinement, not a prerequisite. That ordering is the
 * offline story and the latency story at once: the card appears the moment
 * the user double-taps Shift, marked "extracting" while a model call is in
 * flight, and settles in place when it lands or fails.
 *
 * Items persist to `saves.json` beside workspace.json — device-local, atomic
 * tmp+rename writes like tts.json, and erased by sign-out (LOCAL_STATE_FILES).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  MAX_SAVED_ITEMS,
  type CapturedPage,
  type SavedItem,
  type SavedItemPatch,
} from "../../shared/saves";
import {
  applySavedItemPatch,
  buildExtractionRequest,
  DEFAULT_SAVES_MODEL,
  fallbackItemFields,
  parseChatCompletionText,
  parseExtraction,
  parseSavedItemsFile,
  SAVES_FILENAME,
} from "./saves-core";

/** An extractor that has not answered in this long is not coming. */
const EXTRACTION_TIMEOUT_MS = 30_000;

export interface SavesServiceDeps {
  userDataDir: string;
  /** The whole collection, newest first — sent on every change. */
  emitUpdated: (items: SavedItem[]) => void;
  /**
   * One item, to the preview overlay: fired when a capture lands (the card
   * appears, spinner up while extracting) and again when its extraction
   * settles (the card morphs to the extracted fields).
   */
  emitPreview: (item: SavedItem) => void;
  /**
   * The gateway credential, read AT SAVE TIME (not construction) so a key
   * added in settings upgrades the very next save. Null ⇒ og fallback only.
   */
  apiKey: () => string | null;
  /** Gateway model id; null ⇒ DEFAULT_SAVES_MODEL. */
  model?: string | null;
  /** Injected by tests; production uses the process-global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  makeId?: () => string;
}

export class SavesService {
  private readonly filePath: string;
  private readonly emitUpdated: (items: SavedItem[]) => void;
  private readonly emitPreview: (item: SavedItem) => void;
  private readonly apiKey: () => string | null;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly makeId: () => string;
  /** Newest first — the order the panel shows. */
  private items: SavedItem[];
  private readonly inFlight = new Map<string, AbortController>();
  private stopped = false;

  constructor(deps: SavesServiceDeps) {
    this.filePath = path.join(deps.userDataDir, SAVES_FILENAME);
    this.emitUpdated = deps.emitUpdated;
    this.emitPreview = deps.emitPreview;
    this.apiKey = deps.apiKey;
    this.model = deps.model ?? DEFAULT_SAVES_MODEL;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.makeId = deps.makeId ?? randomUUID;
    mkdirSync(deps.userDataDir, { recursive: true });
    this.items = this.read();
  }

  /* ------------------------------ persistence ----------------------------- */

  private read(): SavedItem[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return parseSavedItemsFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2));
    renameSync(tmp, this.filePath);
  }

  private commit(): void {
    this.persist();
    this.emitUpdated(this.list());
  }

  /* -------------------------------- queries ------------------------------- */

  list(): SavedItem[] {
    return this.items.map((item) => ({ ...item, tags: [...item.tags] }));
  }

  /* -------------------------------- capture ------------------------------- */

  /**
   * Turn a captured page into a saved item. Synchronously writes the og
   * fallback version; when a gateway key exists, the refinement happens in
   * the background and lands via `emitUpdated`.
   */
  capture(page: CapturedPage): SavedItem {
    // A second double-Shift while the first save is still extracting is an
    // impatient repeat, not a request for a duplicate. Re-announcing the
    // pending item refreshes its preview card instead of stacking a twin.
    const pending = this.items.find(
      (item) => item.url === page.url && item.status === "extracting",
    );
    if (pending !== undefined) {
      this.emitPreview({ ...pending, tags: [...pending.tags] });
      return { ...pending, tags: [...pending.tags] };
    }

    const fields = fallbackItemFields(page);
    const key = this.apiKey();
    const item: SavedItem = {
      id: this.makeId(),
      type: fields.type,
      name: fields.name,
      description: fields.description,
      imageUrl: fields.imageUrl,
      url: page.url,
      faviconUrl: page.faviconUrl,
      author: fields.author,
      tags: [],
      selection: page.selection,
      source: "metadata",
      status: key === null ? "ready" : "extracting",
      savedAtMs: this.now(),
    };
    this.items = [item, ...this.items].slice(0, MAX_SAVED_ITEMS);
    this.commit();
    this.emitPreview({ ...item, tags: [...item.tags] });
    if (key !== null) void this.refine(item.id, page, key);
    return { ...item, tags: [...item.tags] };
  }

  /**
   * The model pass. Whatever happens, the item ends "ready": on success its
   * extracted fields replace the og guesses; on any failure the og fallback
   * simply stands — a save must never be lost to a model error.
   */
  private async refine(
    itemId: string,
    page: CapturedPage,
    apiKey: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(itemId, controller);
    const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
    let extracted: ReturnType<typeof parseExtraction> = null;
    try {
      const request = buildExtractionRequest({
        capture: page,
        model: this.model,
        apiKey,
      });
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      if (response.ok) {
        const text = parseChatCompletionText(await response.text());
        if (text !== null) extracted = parseExtraction(text);
      }
    } catch {
      // Timeout, network, abort — the fallback fields stand.
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(itemId);
    }
    if (this.stopped) return;

    const current = this.items.find((item) => item.id === itemId);
    if (current === undefined) return; // deleted while extracting
    const settled: SavedItem = {
      ...current,
      ...(extracted ?? {}),
      source: extracted !== null ? "llm" : "metadata",
      status: "ready",
    };
    this.items = this.items.map((item) => (item.id === itemId ? settled : item));
    this.commit();
    this.emitPreview({ ...settled, tags: [...settled.tags] });
  }

  /* --------------------------------- edits -------------------------------- */

  update(id: string, patch: SavedItemPatch): SavedItem {
    const current = this.items.find((item) => item.id === id);
    if (current === undefined) throw new Error(`unknown saved item ${id}`);
    const next = applySavedItemPatch(current, patch);
    this.items = this.items.map((item) => (item.id === id ? next : item));
    this.commit();
    return { ...next, tags: [...next.tags] };
  }

  remove(id: string): void {
    this.inFlight.get(id)?.abort();
    this.inFlight.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.commit();
  }

  /** Teardown (sign-out, quit): nothing may outlive the service graph. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }
}
