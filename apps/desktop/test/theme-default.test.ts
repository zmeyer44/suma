import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  clearStoredTheme,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  followSystemTheme,
  getActiveTheme,
  isFollowingSystemTheme,
  isLightBase,
  readStoredTheme,
  systemTheme,
} from "../src/renderer/src/lib/theme";

/**
 * The default palette follows the Mac's appearance setting, and an explicit
 * choice outranks it (lib/theme.ts). These run in the plain node environment,
 * so the two things the module reads — the prefers-color-scheme media query and
 * localStorage — are stubbed globals.
 */

let stored: Record<string, string>;
let prefersDark: boolean;
/** What paintTheme wrote onto <html>, so the palette can be asserted. */
let painted: Record<string, string>;

beforeEach(() => {
  stored = {};
  prefersDark = true;
  painted = {};

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
  });
  vi.stubGlobal("window", {
    // Only the dark query is ever asked; answer it from the fixture.
    matchMedia: (query: string) => ({ matches: query.includes("dark") && prefersDark }),
    // No `suma`: without the preload bridge the module answers locally,
    // which is what lets these tests observe the decision instead of an IPC.
  });
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => {
          painted[name] = value;
        },
      },
      dataset: {} as Record<string, string>,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("system default theme", () => {
  it("picks the dark palette when the Mac asks for dark", () => {
    prefersDark = true;
    expect(systemTheme()).toEqual(DEFAULT_DARK_THEME);
    expect(isLightBase(systemTheme().base)).toBe(false);
  });

  it("picks the light palette when the Mac asks for light", () => {
    prefersDark = false;
    expect(systemTheme()).toEqual(DEFAULT_LIGHT_THEME);
    expect(isLightBase(systemTheme().base)).toBe(true);
  });

  it("follows the system while nothing is stored", () => {
    expect(readStoredTheme()).toBeNull();
    expect(isFollowingSystemTheme()).toBe(true);
    prefersDark = false;
    expect(getActiveTheme()).toEqual(DEFAULT_LIGHT_THEME);
    prefersDark = true;
    expect(getActiveTheme()).toEqual(DEFAULT_DARK_THEME);
  });

  it("ignores the default palette left behind by builds with no follow mode", () => {
    // Those builds re-persisted the default on every launch, so this is what
    // every existing install looks like — not a decision.
    stored["suma:theme"] = JSON.stringify(DEFAULT_DARK_THEME);
    expect(readStoredTheme()).toBeNull();
    expect(isFollowingSystemTheme()).toBe(true);
    prefersDark = false;
    expect(getActiveTheme()).toEqual(DEFAULT_LIGHT_THEME);
  });

  it("keeps a legacy theme that is anything but the default", () => {
    const legacy = { base: "#0c1210", accent: "#45d19a" };
    stored["suma:theme"] = JSON.stringify(legacy);
    expect(readStoredTheme()).toEqual(legacy);
    expect(isFollowingSystemTheme()).toBe(false);
  });

  it("pins the dark default once it is chosen deliberately", () => {
    applyTheme(DEFAULT_DARK_THEME);
    expect(readStoredTheme()).toEqual(DEFAULT_DARK_THEME);
    expect(isFollowingSystemTheme()).toBe(false);
    prefersDark = false;
    expect(getActiveTheme()).toEqual(DEFAULT_DARK_THEME);
  });

  it("reads a corrupt stored theme as no choice at all", () => {
    stored["suma:theme"] = "{not json";
    expect(readStoredTheme()).toBeNull();
    stored["suma:theme"] = JSON.stringify({ base: "nonsense", accent: "#5b8cff" });
    expect(readStoredTheme()).toBeNull();
    expect(isFollowingSystemTheme()).toBe(true);
  });
});

describe("an explicit choice", () => {
  const chosen = { base: "#141020", accent: "#a78bfa" };

  it("outranks the system preference and survives a reload", () => {
    applyTheme(chosen);
    expect(readStoredTheme()).toEqual(chosen);
    expect(isFollowingSystemTheme()).toBe(false);
    // The Mac flipping appearance no longer moves the palette.
    prefersDark = false;
    expect(getActiveTheme()).toEqual(chosen);
    expect(painted["--color-base"]).toBe(chosen.base);
  });

  it("is handed back by followSystemTheme", async () => {
    applyTheme(chosen);
    prefersDark = false;

    const next = await followSystemTheme();

    expect(next).toEqual(DEFAULT_LIGHT_THEME);
    expect(isFollowingSystemTheme()).toBe(true);
    expect(painted["--color-base"]).toBe(DEFAULT_LIGHT_THEME.base);
    expect(painted["--color-accent"]).toBe(DEFAULT_LIGHT_THEME.accent);
  });

  it("is dropped by the sign-out reset, so the next launch follows the Mac", () => {
    applyTheme(chosen);
    clearStoredTheme();
    expect(isFollowingSystemTheme()).toBe(true);
    prefersDark = false;
    expect(getActiveTheme()).toEqual(DEFAULT_LIGHT_THEME);
  });
});
