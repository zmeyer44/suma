import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/renderer/src/lib/fuzzy";
import { hostOf, isProbablyUrl, normalizeUrlInput, prettyUrl } from "../src/renderer/src/lib/url";

describe("fuzzyMatch", () => {
  it("matches an empty query against anything with score 0", () => {
    expect(fuzzyMatch("", "GitHub")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("matches subsequences case-insensitively and records positions", () => {
    const m = fuzzyMatch("git", "GitHub");
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([0, 1, 2]);
    expect(fuzzyMatch("GTH", "github")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "GitHub")).toBeNull();
    expect(fuzzyMatch("gitz", "GitHub")).toBeNull();
  });

  it("scores word-start hits above buried hits", () => {
    const wordStart = fuzzyMatch("nt", "New tab");
    const buried = fuzzyMatch("nt", "continent");
    expect(wordStart).not.toBeNull();
    expect(buried).not.toBeNull();
    expect(wordStart!.score).toBeGreaterThan(buried!.score);
  });

  it("skips spaces in the query", () => {
    expect(fuzzyMatch("new tab", "New tab")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  const items = ["New tab", "New space", "Files", "continent"];

  it("filters out non-matches and ranks best first", () => {
    const out = fuzzyFilter(items, "nt", (s) => s);
    expect(out[0]).toBe("New tab");
    expect(out).toContain("continent");
    expect(out).not.toContain("Files");
  });

  it("keeps original order for equal scores and returns all on empty query", () => {
    expect(fuzzyFilter(items, "", (s) => s)).toEqual(items);
  });
});

describe("url helpers", () => {
  it("detects URL-ish input", () => {
    expect(isProbablyUrl("github.com")).toBe(true);
    expect(isProbablyUrl("a.co/path")).toBe(true);
    expect(isProbablyUrl("localhost:3000")).toBe(true);
    expect(isProbablyUrl("https://x.dev")).toBe(true);
    expect(isProbablyUrl("hello world")).toBe(false);
    expect(isProbablyUrl("notaurl")).toBe(false);
  });

  it("normalizes URL input", () => {
    expect(normalizeUrlInput("github.com")).toBe("https://github.com");
    expect(normalizeUrlInput("https://x.dev/a?b=1")).toBe("https://x.dev/a?b=1");
    expect(normalizeUrlInput("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeUrlInput("192.168.1.10/admin")).toBe("http://192.168.1.10/admin");
  });

  it("falls back to a web search for non-URL input", () => {
    expect(normalizeUrlInput("suma sync engine")).toBe(
      "https://www.google.com/search?q=suma%20sync%20engine",
    );
  });

  it("extracts hosts and pretty-prints URLs", () => {
    expect(hostOf("https://app.linear.app/team")).toBe("app.linear.app");
    expect(hostOf("not a url")).toBe("");
    expect(prettyUrl("https://www.github.com/")).toBe("github.com");
  });
});
