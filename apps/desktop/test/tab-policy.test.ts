import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_SETTINGS } from "@suma/protocol";
import { isAllowedTabUrl, isValidNewTabUrl, newTabUrlFor, NEW_TAB_URL } from "../src/main/tab-policy";

describe("isAllowedTabUrl", () => {
  it("allows http and https", () => {
    expect(isAllowedTabUrl("http://example.com/")).toBe(true);
    expect(isAllowedTabUrl("https://github.com/suma")).toBe(true);
    expect(isAllowedTabUrl("https://app.linear.app/team?issue=1#top")).toBe(true);
    expect(isAllowedTabUrl("http://localhost:3000/dev")).toBe(true);
  });

  it("allows the new-tab page", () => {
    expect(isAllowedTabUrl(NEW_TAB_URL)).toBe(true);
  });

  it("blocks privileged and local schemes", () => {
    expect(isAllowedTabUrl("suma://settings")).toBe(false);
    expect(isAllowedTabUrl("suma://migration")).toBe(false);
    expect(isAllowedTabUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedTabUrl("chrome://settings")).toBe(false);
    expect(isAllowedTabUrl("about:config")).toBe(false);
    expect(isAllowedTabUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedTabUrl("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("blocks unparseable input", () => {
    expect(isAllowedTabUrl("")).toBe(false);
    expect(isAllowedTabUrl("not a url")).toBe(false);
    expect(isAllowedTabUrl("//no-scheme.example")).toBe(false);
  });
});

describe("isValidNewTabUrl", () => {
  it("accepts http/https and empty (meaning a blank tab)", () => {
    expect(isValidNewTabUrl("https://www.google.com")).toBe(true);
    expect(isValidNewTabUrl("http://localhost:3000/dev")).toBe(true);
    expect(isValidNewTabUrl("")).toBe(true);
  });

  it("refuses anything a tab may not load — about:blank included", () => {
    // "Blank" has exactly one spelling in the setting: empty.
    expect(isValidNewTabUrl(NEW_TAB_URL)).toBe(false);
    expect(isValidNewTabUrl("suma://settings")).toBe(false);
    expect(isValidNewTabUrl("file:///etc/passwd")).toBe(false);
    expect(isValidNewTabUrl("javascript:alert(1)")).toBe(false);
    expect(isValidNewTabUrl("google.com")).toBe(false); // must be normalized first
  });
});

describe("newTabUrlFor", () => {
  it("defaults to Google", () => {
    expect(newTabUrlFor(DEFAULT_WORKSPACE_SETTINGS)).toBe("https://www.google.com");
  });

  it("uses the configured page, trimmed", () => {
    expect(newTabUrlFor({ newTabUrl: "  https://example.com/start  " })).toBe(
      "https://example.com/start",
    );
  });

  it("falls back to a blank tab when unset or empty", () => {
    expect(newTabUrlFor({})).toBe(NEW_TAB_URL);
    expect(newTabUrlFor({ newTabUrl: "" })).toBe(NEW_TAB_URL);
    expect(newTabUrlFor({ newTabUrl: "   " })).toBe(NEW_TAB_URL);
  });

  it("never opens a value a tab may not load, however it got stored", () => {
    // The setting syncs, so a peer (or a hand-edited workspace.json) could
    // hold anything; a fresh tab still only ever lands on http/https.
    expect(newTabUrlFor({ newTabUrl: "suma://settings" })).toBe(NEW_TAB_URL);
    expect(newTabUrlFor({ newTabUrl: "file:///etc/passwd" })).toBe(NEW_TAB_URL);
    expect(newTabUrlFor({ newTabUrl: "not a url" })).toBe(NEW_TAB_URL);
  });
});
