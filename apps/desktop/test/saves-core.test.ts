/**
 * Saves — the smart-bookmarking pipeline. The load-bearing claims: the
 * double-Shift gesture never fires from ordinary typing; everything a page or
 * a model hands back is clamped and validated before it is stored; a save
 * always lands even with no model (og fallback) and survives a model failure;
 * and a user edit can never produce a nameless or mis-typed item.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySavedItemPatch,
  buildExtractionRequest,
  DOUBLE_SHIFT_WINDOW_MS,
  DoubleShiftDetector,
  fallbackItemFields,
  parseChatCompletionText,
  parseExtraction,
  parseSavedItemsFile,
  sanitizeCapturedPage,
  typeFromOgType,
} from "../src/main/saves/saves-core";
import { SavesService } from "../src/main/saves/saves-service";
import {
  matchesSavesQuery,
  normalizeTags,
  sanitizeImageUrl,
  type CapturedPage,
  type SavedItem,
} from "../src/shared/saves";

const shift = { key: "Shift", isAutoRepeat: false, chorded: false };

describe("DoubleShiftDetector", () => {
  it("fires on two quick bare Shift taps", () => {
    const d = new DoubleShiftDetector();
    expect(d.keyDown(shift, 1000)).toBe(false);
    expect(d.keyDown(shift, 1200)).toBe(true);
  });

  it("does not fire when the taps are too far apart", () => {
    const d = new DoubleShiftDetector();
    d.keyDown(shift, 1000);
    expect(d.keyDown(shift, 1000 + DOUBLE_SHIFT_WINDOW_MS + 1)).toBe(false);
    // …but that late tap starts a new pair.
    expect(d.keyDown(shift, 1000 + DOUBLE_SHIFT_WINDOW_MS + 100)).toBe(true);
  });

  it("is reset by any other key — Shift-typed capitals never fire it", () => {
    const d = new DoubleShiftDetector();
    d.keyDown(shift, 1000);
    d.keyDown({ key: "a", isAutoRepeat: false, chorded: false }, 1050);
    expect(d.keyDown(shift, 1100)).toBe(false);
  });

  it("ignores chorded Shift (⌘⇧…) and auto-repeat", () => {
    const d = new DoubleShiftDetector();
    d.keyDown(shift, 1000);
    expect(d.keyDown({ ...shift, chorded: true }, 1100)).toBe(false);
    // The chord reset the pair.
    expect(d.keyDown(shift, 1150)).toBe(false);
    expect(d.keyDown({ ...shift, isAutoRepeat: true }, 1200)).toBe(false);
    expect(d.keyDown(shift, 1250)).toBe(true);
  });

  it("consumes both taps on trigger — a third tap starts over", () => {
    const d = new DoubleShiftDetector();
    d.keyDown(shift, 1000);
    expect(d.keyDown(shift, 1100)).toBe(true);
    expect(d.keyDown(shift, 1200)).toBe(false);
    expect(d.keyDown(shift, 1300)).toBe(true);
  });
});

function capture(patch: Partial<CapturedPage> = {}): CapturedPage {
  return {
    url: "https://www.amazon.com/dp/020161622X",
    title: "The Pragmatic Programmer - Amazon.com",
    faviconUrl: null,
    meta: {},
    jsonLd: [],
    textExcerpt: "",
    selection: null,
    ...patch,
  };
}

describe("sanitizeCapturedPage", () => {
  it("takes url/title from the tab, never from the page payload", () => {
    const page = sanitizeCapturedPage(
      { url: "https://evil.example", title: "spoof" },
      "https://real.example/page",
      "Real title",
    );
    expect(page.url).toBe("https://real.example/page");
    expect(page.title).toBe("Real title");
    expect(page.faviconUrl).toBeNull();
  });

  it("keeps a fetchable tab favicon and drops non-http ones", () => {
    const icon = "https://real.example/favicon.ico";
    expect(
      sanitizeCapturedPage(null, "https://real.example", "T", icon).faviconUrl,
    ).toBe(icon);
    expect(
      sanitizeCapturedPage(null, "https://real.example", "T", "data:image/png;base64,x")
        .faviconUrl,
    ).toBeNull();
  });

  it("survives hostile shapes and clamps sizes", () => {
    const page = sanitizeCapturedPage(
      {
        meta: { "og:title": 42, ok: "fine", ["k".repeat(500)]: "x".repeat(9000) },
        jsonLd: [null, 7, "  ", "real"],
        textExcerpt: "t".repeat(100_000),
        selection: "  padded  ",
      },
      "https://a.example",
      "T",
    );
    expect(page.meta["og:title"]).toBeUndefined();
    expect(page.meta["ok"]).toBe("fine");
    for (const key of Object.keys(page.meta)) expect(key.length).toBeLessThanOrEqual(120);
    expect(page.jsonLd).toEqual(["real"]);
    expect(page.textExcerpt.length).toBeLessThanOrEqual(6000);
    expect(page.selection).toBe("padded");
    expect(sanitizeCapturedPage(null, "https://a.example", "T").meta).toEqual({});
  });
});

describe("og fallback", () => {
  it("maps og:type to the closest item type", () => {
    expect(typeFromOgType("article")).toBe("article");
    expect(typeFromOgType("book")).toBe("book");
    expect(typeFromOgType("video.movie")).toBe("movie");
    expect(typeFromOgType("video.episode")).toBe("video");
    expect(typeFromOgType("music.song")).toBe("podcast");
    expect(typeFromOgType("product.item")).toBe("product");
    expect(typeFromOgType("")).toBe("website");
    expect(typeFromOgType("profile")).toBe("website");
  });

  it("builds an item from og tags", () => {
    const fields = fallbackItemFields(
      capture({
        meta: {
          "og:type": "book",
          "og:title": "The Pragmatic Programmer",
          "og:description": "From  journeyman\nto master.",
          "og:image": "https://img.example/cover.jpg",
          author: "Hunt & Thomas",
        },
      }),
    );
    expect(fields.type).toBe("book");
    expect(fields.name).toBe("The Pragmatic Programmer");
    expect(fields.description).toBe("From journeyman to master.");
    expect(fields.imageUrl).toBe("https://img.example/cover.jpg");
    expect(fields.author).toBe("Hunt & Thomas");
  });

  it("falls back name → title → host, and drops URL-shaped authors", () => {
    const noMeta = fallbackItemFields(capture({ title: "  " }));
    expect(noMeta.name).toBe("www.amazon.com");
    const urlAuthor = fallbackItemFields(
      capture({ meta: { "article:author": "https://fb.example/profile" } }),
    );
    expect(urlAuthor.author).toBeNull();
  });

  it("refuses non-http image URLs", () => {
    expect(sanitizeImageUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(sanitizeImageUrl(" https://ok.example/i.png ")).toBe(
      "https://ok.example/i.png",
    );
  });
});

describe("model extraction", () => {
  it("asks the gateway with the key and flags the selection", () => {
    const request = buildExtractionRequest({
      capture: capture({ selection: "the pragmatic programmer" }),
      model: "anthropic/claude-haiku-4.5",
      apiKey: "vg-key",
    });
    expect(request.url).toContain("ai-gateway.vercel.sh");
    expect(request.headers["Authorization"]).toBe("Bearer vg-key");
    const body = JSON.parse(request.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.messages[1]?.content).toContain("highlighted");
    expect(body.messages[1]?.content).toContain("the pragmatic programmer");
  });

  it("reads choices[0].message.content and tolerates junk", () => {
    expect(
      parseChatCompletionText(
        JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
      ),
    ).toBe("hi");
    expect(parseChatCompletionText("not json")).toBeNull();
    expect(parseChatCompletionText(JSON.stringify({ choices: [] }))).toBeNull();
  });

  it("parses fenced or prose-wrapped JSON and re-validates every field", () => {
    const parsed = parseExtraction(
      'Sure! ```json\n{"type":"book","name":"The Pragmatic Programmer","description":"A classic.","author":"Andrew Hunt","imageUrl":"https://img.example/c.jpg","extra":1}\n```',
    );
    expect(parsed).toEqual({
      type: "book",
      name: "The Pragmatic Programmer",
      description: "A classic.",
      author: "Andrew Hunt",
      imageUrl: "https://img.example/c.jpg",
    });
  });

  it("drops invalid values instead of storing them", () => {
    const parsed = parseExtraction(
      '{"type":"tv-show","name":"  ","author":null,"imageUrl":"javascript:x"}',
    );
    // Only the explicit author null survives; bad type/name/image are dropped.
    expect(parsed).toEqual({ author: null });
    expect(parseExtraction("no json here")).toBeNull();
  });
});

function item(patch: Partial<SavedItem> = {}): SavedItem {
  return {
    id: "id-1",
    type: "book",
    name: "A Book",
    description: "About things.",
    imageUrl: null,
    url: "https://shop.example/book",
    faviconUrl: null,
    author: null,
    tags: [],
    selection: null,
    source: "metadata",
    status: "ready",
    savedAtMs: 123,
    ...patch,
  };
}

describe("persistence and edits", () => {
  it("round-trips items and settles mid-extraction ones on load", () => {
    const stored = parseSavedItemsFile(
      JSON.stringify({
        items: [
          item({
            status: "extracting",
            faviconUrl: "https://shop.example/favicon.ico",
          }),
          { junk: true },
        ],
      }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("ready");
    expect(stored[0]?.faviconUrl).toBe("https://shop.example/favicon.ico");
    expect(parseSavedItemsFile("corrupt{{{")).toEqual([]);
  });

  it("applies valid patches and refuses a nameless or mis-typed item", () => {
    const next = applySavedItemPatch(item(), {
      name: "  Renamed  ",
      author: "Someone",
      tags: [" Wishlist ", "wishlist", "", "gift ideas"],
    });
    expect(next.name).toBe("Renamed");
    expect(next.author).toBe("Someone");
    expect(next.tags).toEqual(["Wishlist", "gift ideas"]);
    expect(applySavedItemPatch(item(), { name: "   " }).name).toBe("A Book");
    expect(() =>
      applySavedItemPatch(item(), { type: "tv" as never }),
    ).toThrow();
    expect(applySavedItemPatch(item({ imageUrl: "https://i.example/x" }), {
      imageUrl: null,
    }).imageUrl).toBeNull();
  });

  it("normalizeTags clamps count and length", () => {
    const tags = normalizeTags(Array.from({ length: 40 }, (_, i) => `tag-${String(i)}`));
    expect(tags).toHaveLength(20);
  });
});

describe("matchesSavesQuery", () => {
  const book = item({ name: "Dune", author: "Frank Herbert", tags: ["wishlist"] });
  it("matches every term across fields, case-insensitively", () => {
    expect(matchesSavesQuery(book, "")).toBe(true);
    expect(matchesSavesQuery(book, "dune wish")).toBe(true);
    expect(matchesSavesQuery(book, "herbert book")).toBe(true);
    expect(matchesSavesQuery(book, "dune missing")).toBe(false);
  });
});

describe("SavesService", () => {
  const dir = (): string => path.join(tmpdir(), `suma-saves-${randomUUID()}`);

  const bookPage = (): CapturedPage =>
    capture({
      meta: { "og:type": "book", "og:title": "The Pragmatic Programmer" },
    });

  it("saves from og tags alone when no key exists", () => {
    const updates: SavedItem[][] = [];
    const previews: SavedItem[] = [];
    const service = new SavesService({
      userDataDir: dir(),
      emitUpdated: (items) => updates.push(items),
      emitPreview: (item) => previews.push(item),
      apiKey: () => null,
    });
    const saved = service.capture(bookPage());
    expect(saved.status).toBe("ready");
    expect(saved.source).toBe("metadata");
    expect(saved.type).toBe("book");
    expect(updates).toHaveLength(1);
    // No model coming ⇒ the one preview push is already the settled card.
    expect(previews.map((p) => p.status)).toEqual(["ready"]);
  });

  it("writes the fallback immediately, then refines from the model", async () => {
    const userDataDir = dir();
    const previews: SavedItem[] = [];
    let resolveFetch: (r: Response) => void = () => undefined;
    const service = new SavesService({
      userDataDir,
      emitUpdated: () => undefined,
      emitPreview: (item) => previews.push(item),
      apiKey: () => "vg-key",
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const saved = service.capture(bookPage());
    expect(saved.status).toBe("extracting");
    expect(previews.map((p) => p.status)).toEqual(["extracting"]);

    // A repeat double-Shift while extracting is deduped, not duplicated —
    // but the preview card is re-announced so it refreshes.
    expect(service.capture(bookPage()).id).toBe(saved.id);
    expect(service.list()).toHaveLength(1);
    expect(previews).toHaveLength(2);

    resolveFetch(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"type":"book","name":"The Pragmatic Programmer","description":"Journeyman to master.","author":"Hunt & Thomas","imageUrl":null}',
              },
            },
          ],
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 10));
    const settled = service.list()[0];
    expect(settled?.status).toBe("ready");
    expect(settled?.source).toBe("llm");
    expect(settled?.author).toBe("Hunt & Thomas");
    // The settling is announced to the preview overlay — the card's morph.
    expect(previews.at(-1)?.status).toBe("ready");
    expect(previews.at(-1)?.author).toBe("Hunt & Thomas");

    // Persisted: a new service over the same dir loads the settled item.
    const reloaded = new SavesService({
      userDataDir,
      emitUpdated: () => undefined,
      emitPreview: () => undefined,
      apiKey: () => null,
    });
    expect(reloaded.list()[0]?.author).toBe("Hunt & Thomas");
    expect(
      JSON.parse(readFileSync(path.join(userDataDir, "saves.json"), "utf8")),
    ).toHaveProperty("items");
  });

  it("keeps the fallback when the model fails", async () => {
    const service = new SavesService({
      userDataDir: dir(),
      emitUpdated: () => undefined,
      emitPreview: () => undefined,
      apiKey: () => "vg-key",
      fetchImpl: () => Promise.reject(new Error("gateway down")),
    });
    const saved = service.capture(bookPage());
    await new Promise((r) => setTimeout(r, 10));
    const settled = service.list().find((entry) => entry.id === saved.id);
    expect(settled?.status).toBe("ready");
    expect(settled?.source).toBe("metadata");
    expect(settled?.name).toBe("The Pragmatic Programmer");
  });

  it("updates and deletes through the validated patch path", () => {
    const service = new SavesService({
      userDataDir: dir(),
      emitUpdated: () => undefined,
      emitPreview: () => undefined,
      apiKey: () => null,
    });
    const saved = service.capture(bookPage());
    const updated = service.update(saved.id, { tags: ["wishlist"], author: "PragProg" });
    expect(updated.tags).toEqual(["wishlist"]);
    expect(updated.author).toBe("PragProg");
    expect(() => service.update("nope", {})).toThrow();
    service.remove(saved.id);
    expect(service.list()).toHaveLength(0);
  });
});
