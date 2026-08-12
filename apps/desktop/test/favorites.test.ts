/**
 * Favorite sites. The load-bearing claims: a favorite's identity is its
 * NORMALIZED address (so the tab star matches the page it was pressed on, in
 * any spelling); nothing un-loadable can enter the list; the file read is
 * tolerant of damage; and the service never duplicates an address or exceeds
 * the cap.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FavoritesService } from "../src/main/favorites";
import {
  favoriteForUrl,
  MAX_FAVORITES,
  normalizeFavoriteTitle,
  normalizeFavoriteUrl,
  parseFavoritesFile,
  type FavoriteSite,
} from "../src/shared/favorites";

function makeService(dir: string): {
  service: FavoritesService;
  updates: FavoriteSite[][];
} {
  const updates: FavoriteSite[][] = [];
  const service = new FavoritesService({
    userDataDir: dir,
    emitUpdated: (items) => updates.push(items),
    now: () => 1000,
    makeId: () => randomUUID(),
  });
  return { service, updates };
}

describe("normalizeFavoriteUrl", () => {
  it("canonicalizes scheme, host case, and default port", () => {
    expect(normalizeFavoriteUrl("HTTPS://Example.com")).toBe(
      "https://example.com/",
    );
    expect(normalizeFavoriteUrl("https://example.com:443/a")).toBe(
      "https://example.com/a",
    );
  });

  it("refuses anything a tab could not load as a favorite", () => {
    expect(normalizeFavoriteUrl("suma://settings")).toBeNull();
    expect(normalizeFavoriteUrl("about:blank")).toBeNull();
    expect(normalizeFavoriteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeFavoriteUrl("not a url")).toBeNull();
    expect(normalizeFavoriteUrl("")).toBeNull();
  });
});

describe("normalizeFavoriteTitle", () => {
  it("trims and clamps, falling back to the host", () => {
    expect(normalizeFavoriteTitle("  GitHub  ", "https://github.com/")).toBe(
      "GitHub",
    );
    expect(normalizeFavoriteTitle("", "https://www.github.com/")).toBe(
      "github.com",
    );
    expect(
      normalizeFavoriteTitle("x".repeat(300), "https://github.com/"),
    ).toHaveLength(100);
  });
});

describe("favoriteForUrl", () => {
  const favorites: FavoriteSite[] = [
    { id: "1", url: "https://github.com/", title: "GitHub", addedAtMs: 0 },
  ];

  it("matches any spelling of the same address", () => {
    expect(favoriteForUrl(favorites, "HTTPS://GitHub.com")?.id).toBe("1");
    expect(favoriteForUrl(favorites, "https://github.com/pulls")).toBeNull();
    expect(favoriteForUrl(favorites, "suma://settings")).toBeNull();
  });
});

describe("parseFavoritesFile", () => {
  it("keeps well-formed entries in order and drops damage", () => {
    const parsed = parseFavoritesFile(
      JSON.stringify({
        items: [
          { id: "a", url: "https://a.com", title: "A", addedAtMs: 5 },
          { id: "", url: "https://missing-id.com" },
          { id: "b", url: "suma://settings", title: "internal" },
          { id: "c", url: "https://a.com/", title: "duplicate of a" },
          { id: "d", url: "https://d.com", title: "", addedAtMs: "soon" },
        ],
      }),
    );
    expect(parsed.map((f) => f.id)).toEqual(["a", "d"]);
    expect(parsed[1]).toEqual({
      id: "d",
      url: "https://d.com/",
      title: "d.com",
      addedAtMs: 0,
    });
  });

  it("returns empty for garbage", () => {
    expect(parseFavoritesFile("not json")).toEqual([]);
    expect(parseFavoritesFile('{"items": 4}')).toEqual([]);
    expect(parseFavoritesFile("null")).toEqual([]);
  });
});

describe("FavoritesService", () => {
  it("adds, persists, reloads, and removes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "suma-favorites-"));
    const { service, updates } = makeService(dir);

    const afterAdd = service.add("https://GitHub.com", "  GitHub  ");
    expect(afterAdd).toEqual([
      {
        id: afterAdd[0]?.id,
        url: "https://github.com/",
        title: "GitHub",
        addedAtMs: 1000,
      },
    ]);
    expect(updates).toHaveLength(1);

    // Survives a restart via the file it wrote.
    const reloaded = makeService(dir).service.list();
    expect(reloaded).toEqual(afterAdd);
    expect(
      JSON.parse(readFileSync(path.join(dir, "favorites.json"), "utf8")).items,
    ).toHaveLength(1);

    const id = afterAdd[0]?.id ?? "";
    expect(service.remove(id)).toEqual([]);
    expect(makeService(dir).service.list()).toEqual([]);
  });

  it("re-adding an address retitles instead of duplicating", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "suma-favorites-"));
    const { service } = makeService(dir);
    service.add("https://github.com", "GitHub");
    const after = service.add("HTTPS://github.com/", "Work");
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe("Work");
  });

  it("refuses bad addresses and enforces the cap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "suma-favorites-"));
    const { service } = makeService(dir);
    expect(() => service.add("suma://settings", "x")).toThrow(/web address/);
    for (let i = 0; i < MAX_FAVORITES; i++) {
      service.add(`https://site-${i}.com`, `Site ${i}`);
    }
    expect(() => service.add("https://one-too-many.com", "x")).toThrow(
      /limited/,
    );
  });

  it("tolerates a corrupt file on startup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "suma-favorites-"));
    writeFileSync(path.join(dir, "favorites.json"), "{corrupt");
    expect(makeService(dir).service.list()).toEqual([]);
  });
});
