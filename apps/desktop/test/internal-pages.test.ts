/**
 * suma:// internal pages (§8.1) — what the scheme routes to, and what it
 * refuses. The canonical string these produce is a tab's synced address
 * register, so main and the renderer must agree on it exactly.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalInternalUrl,
  internalPageTitle,
  isInternalPage,
  isInternalPageUrl,
  parseInternalUrl,
  SETTINGS_SECTIONS,
  settingsUrl,
  TERMINAL_URL,
} from "../src/shared/internal-pages";
import {
  isAllowedTabTarget,
  isAllowedTabUrl,
  isValidNewTabUrl,
} from "../src/main/tab-policy";

describe("settings routes", () => {
  it("parses the root, with or without a trailing slash", () => {
    for (const raw of [
      "suma://settings",
      "suma://settings/",
      " suma://settings ",
    ]) {
      expect(parseInternalUrl(raw)).toMatchObject({
        page: "settings",
        section: "",
        url: "suma://settings",
        title: "Settings",
      });
    }
  });

  it("parses every section the sidebar can reach", () => {
    for (const section of Object.keys(SETTINGS_SECTIONS)) {
      const url = settingsUrl(section as keyof typeof SETTINGS_SECTIONS);
      expect(parseInternalUrl(url)).toMatchObject({
        page: "settings",
        section,
      });
    }
  });

  it("titles a section with its label, so a narrow tab truncates usefully", () => {
    expect(internalPageTitle("suma://settings/account/devices")).toBe(
      "Devices — Settings",
    );
  });

  it("normalizes case and redundant slashes to one canonical string", () => {
    for (const raw of [
      "suma://settings/Account/Devices",
      "suma://settings//account//devices/",
      "SUMA://SETTINGS/account/devices",
    ]) {
      expect(canonicalInternalUrl(raw)).toBe("suma://settings/account/devices");
    }
  });

  it("drops a query or fragment rather than routing on it", () => {
    expect(canonicalInternalUrl("suma://settings/appearance?x=1#y")).toBe(
      "suma://settings/appearance",
    );
  });

  /* A settings URL from a newer build (or a typo in the address bar) should
     land on Settings, not fail to open as a tab at all. */
  it("falls back to the root for an unknown section", () => {
    expect(canonicalInternalUrl("suma://settings/does-not-exist")).toBe(
      "suma://settings",
    );
  });

  it("is not fooled by lookalike hosts or other suma pages", () => {
    for (const raw of [
      "suma://settings2",
      "suma://settingsevil.com",
      "suma://files",
      "suma://files/settings",
      "https://suma://settings",
      "https://example.com/suma://settings",
      "javascript:alert(1)",
      "about:blank",
      "",
    ]) {
      expect(isInternalPageUrl(raw)).toBe(false);
    }
  });
});

describe("terminal route", () => {
  it("parses the bare host, with or without a trailing slash", () => {
    for (const raw of [
      "suma://terminal",
      "suma://terminal/",
      " SUMA://Terminal ",
    ]) {
      expect(parseInternalUrl(raw)).toEqual({
        page: "terminal",
        url: TERMINAL_URL,
        title: "Terminal",
      });
    }
  });

  it("drops a query or fragment rather than routing on it", () => {
    expect(canonicalInternalUrl("suma://terminal?pty=3#x")).toBe(TERMINAL_URL);
  });

  /* Which shell is showing is UI state inside the page, not an address — so a
     path is not a terminal route at all rather than silently landing on it. */
  it("has no sub-pages", () => {
    for (const raw of ["suma://terminal/3", "suma://terminal/shell/a"]) {
      expect(isInternalPageUrl(raw)).toBe(false);
    }
  });

  it("is not fooled by lookalike hosts", () => {
    for (const raw of ["suma://terminal2", "suma://terminalevil.com"]) {
      expect(isInternalPageUrl(raw)).toBe(false);
    }
  });

  /* The whole point of `isInternalPage`: settings and the terminal are
     separate destinations, so openSettings can never grab the terminal's tab
     and navigate a running shell away (store.goToInternalPage). */
  it("distinguishes the two pages from each other", () => {
    expect(isInternalPage(TERMINAL_URL, "terminal")).toBe(true);
    expect(isInternalPage(TERMINAL_URL, "settings")).toBe(false);
    expect(isInternalPage("suma://settings/account", "settings")).toBe(true);
    expect(isInternalPage("suma://settings/account", "terminal")).toBe(false);
    expect(isInternalPage("https://example.com", "settings")).toBe(false);
  });
});

describe("tab policy and internal pages", () => {
  /* The whole security property: an internal page is somewhere SUMA can send
     you, never somewhere a page can send itself. isAllowedTabUrl guards
     will-navigate/will-redirect, where the caller is site content. */
  it("still refuses suma:// on the site-initiated navigation path", () => {
    expect(isAllowedTabUrl("suma://settings")).toBe(false);
    expect(isAllowedTabUrl("suma://settings/account")).toBe(false);
    expect(isAllowedTabUrl(TERMINAL_URL)).toBe(false);
  });

  it("allows Suma itself to open an internal page in a tab", () => {
    expect(isAllowedTabTarget("suma://settings")).toBe(true);
    expect(isAllowedTabTarget("suma://settings/privacy/audit")).toBe(true);
    expect(isAllowedTabTarget(TERMINAL_URL)).toBe(true);
    expect(isAllowedTabTarget("https://example.com")).toBe(true);
    expect(isAllowedTabTarget("about:blank")).toBe(true);
  });

  it("refuses every other privileged or unknown scheme either way", () => {
    for (const raw of [
      "suma://files",
      "file:///etc/passwd",
      "chrome://settings",
    ]) {
      expect(isAllowedTabUrl(raw)).toBe(false);
      expect(isAllowedTabTarget(raw)).toBe(false);
    }
  });

  /* A new-tab page is a setting that SYNCS. Pointing ⌘T at settings would be
     merely odd here, but the register is also written by other builds, so the
     narrow rule stays narrow. */
  it("keeps internal pages out of the configurable new-tab page", () => {
    expect(isValidNewTabUrl("suma://settings")).toBe(false);
    expect(isValidNewTabUrl(TERMINAL_URL)).toBe(false);
  });
});
