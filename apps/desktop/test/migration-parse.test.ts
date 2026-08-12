import { describe, expect, it } from "vitest";
import { SEED_CORPUS } from "@suma/config";
import {
  buildSignInQueue,
  parseBookmarksJson,
  type ParsedBookmark,
} from "../src/main/migration/parse";

function url(name: string, href: string): { type: string; name: string; url: string } {
  return { type: "url", name, url: href };
}

const fixture = {
  checksum: "abc",
  roots: {
    bookmark_bar: {
      children: [
        {
          type: "folder",
          name: "Work",
          children: [
            url("GitHub PRs", "https://github.com/pulls"),
            url("Linear", "https://linear.app/suma"),
            {
              type: "folder",
              name: "Nested",
              children: [url("CI", "https://github.com/suma/ci")],
            },
          ],
        },
        {
          type: "folder",
          name: "Personal",
          children: [url("Chase", "https://www.chase.com/")],
        },
        url("Loose", "https://news.ycombinator.com/"),
        url("Settings", "chrome://settings"),
      ],
    },
    other: { children: [url("Figma file", "https://www.figma.com/file/x")] },
    synced: { children: [] },
  },
  version: 1,
};

describe("parseBookmarksJson", () => {
  it("extracts top-level bookmark-bar folders with nested bookmarks flattened", () => {
    const tree = parseBookmarksJson(fixture);
    expect(tree.folders.map((f) => f.name)).toEqual(["Work", "Personal"]);
    expect(tree.folders[0]?.bookmarks.map((b) => b.url)).toEqual([
      "https://github.com/pulls",
      "https://linear.app/suma",
      "https://github.com/suma/ci",
    ]);
    expect(tree.folders[1]?.bookmarks).toHaveLength(1);
  });

  it("flattens every http(s) bookmark and drops non-web schemes", () => {
    const tree = parseBookmarksJson(fixture);
    expect(tree.bookmarks).toHaveLength(6);
    expect(tree.bookmarks.some((b) => b.url.startsWith("chrome://"))).toBe(false);
    expect(tree.bookmarks.some((b) => b.url === "https://www.figma.com/file/x")).toBe(true);
    expect(tree.bookmarks.some((b) => b.url === "https://news.ycombinator.com/")).toBe(true);
  });

  it("falls back to the url when a bookmark has no name", () => {
    const tree = parseBookmarksJson({
      roots: { bookmark_bar: { children: [{ type: "url", url: "https://example.com/" }] } },
    });
    expect(tree.bookmarks[0]?.title).toBe("https://example.com/");
  });

  it("returns an empty tree for malformed input instead of throwing", () => {
    const empty = { folders: [], bookmarks: [] };
    expect(parseBookmarksJson(null)).toEqual(empty);
    expect(parseBookmarksJson("not json shaped")).toEqual(empty);
    expect(parseBookmarksJson({})).toEqual(empty);
    expect(parseBookmarksJson({ roots: "nope" })).toEqual(empty);
    expect(parseBookmarksJson({ roots: { bookmark_bar: { children: "x" } } })).toEqual(empty);
    expect(
      parseBookmarksJson({ roots: { bookmark_bar: { children: [42, null, { type: "url" }] } } }),
    ).toEqual(empty);
  });
});

describe("buildSignInQueue", () => {
  function bm(href: string): ParsedBookmark {
    return { title: href, url: href };
  }

  it("ranks corpus origins by bookmark count, most-used first", () => {
    const queue = buildSignInQueue(
      [
        bm("https://github.com/a"),
        bm("https://github.com/b"),
        bm("https://gist.github.com/c"),
        bm("https://linear.app/x"),
        bm("https://unknown-origin.example/"),
      ],
      SEED_CORPUS,
    );
    expect(queue.map((item) => item.domain)).toEqual(["github.com", "linear.app"]);
    expect(queue[0]).toMatchObject({ domain: "github.com", label: "GitHub", rank: 1, done: false });
    expect(queue[1]?.rank).toBe(2);
  });

  it("matches subdomains against corpus domains", () => {
    const queue = buildSignInQueue([bm("https://app.linear.app/team")], SEED_CORPUS);
    expect(queue.map((item) => item.domain)).toEqual(["linear.app"]);
  });

  it("excludes non-corpus origins entirely", () => {
    const queue = buildSignInQueue([bm("https://totally-untested.example/")], SEED_CORPUS);
    expect(queue).toEqual([]);
  });

  it("flags sensitive origins but keeps them in the queue", () => {
    const queue = buildSignInQueue(
      [bm("https://www.chase.com/"), bm("https://github.com/")],
      SEED_CORPUS,
    );
    const chase = queue.find((item) => item.domain === "chase.com");
    expect(chase?.sensitive).toBe(true);
    expect(queue.find((item) => item.domain === "github.com")?.sensitive).toBe(false);
  });

  it("caps the queue at the limit", () => {
    const domains = [
      "github.com",
      "gitlab.com",
      "linear.app",
      "vercel.com",
      "netlify.com",
      "fly.io",
      "npmjs.com",
      "pypi.org",
      "crates.io",
      "stackoverflow.com",
      "figma.com",
      "notion.so",
      "x.com",
      "asana.com",
    ];
    const bookmarks: ParsedBookmark[] = [];
    for (const [index, domain] of domains.entries()) {
      // Distinct counts keep the ranking deterministic.
      for (let i = 0; i <= domains.length - index; i++) {
        bookmarks.push(bm(`https://${domain}/${i}`));
      }
    }
    const queue = buildSignInQueue(bookmarks, SEED_CORPUS, 12);
    expect(queue).toHaveLength(12);
    expect(queue[0]?.domain).toBe("github.com");
    expect(queue.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(queue.some((item) => item.domain === "x.com")).toBe(false);
    expect(queue.some((item) => item.domain === "asana.com")).toBe(false);
  });
});
