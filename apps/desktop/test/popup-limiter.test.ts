import { describe, expect, it, vi } from "vitest";

// tabs.ts imports Electron for TabManager; the limiter under test is pure.
vi.mock("electron", () => ({ WebContentsView: class {} }));

import { MAX_TABS_PER_SPACE, PopupRateLimiter } from "../src/main/tabs";

function makeLimiter(): { limiter: PopupRateLimiter; advance: (ms: number) => void } {
  let now = 0;
  return {
    limiter: new PopupRateLimiter(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PopupRateLimiter", () => {
  it("allows 5 opens per source, then denies", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.tryOpen("tab-a")).toBe(true);
    expect(limiter.tryOpen("tab-a")).toBe(false);
    expect(limiter.tryOpen("tab-a")).toBe(false);
  });

  it("tracks sources independently", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.tryOpen("tab-a");
    expect(limiter.tryOpen("tab-a")).toBe(false);
    expect(limiter.tryOpen("tab-b")).toBe(true);
  });

  it("frees quota on a rolling 10-second window", () => {
    const { limiter, advance } = makeLimiter();
    // Opens at t = 0, 1000, ..., 4000.
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryOpen("tab-a")).toBe(true);
      advance(1_000);
    }
    // t = 5000: window still holds all five.
    expect(limiter.tryOpen("tab-a")).toBe(false);
    advance(5_000);
    // t = 10000: the t=0 open has aged out — exactly one slot free.
    expect(limiter.tryOpen("tab-a")).toBe(true);
    expect(limiter.tryOpen("tab-a")).toBe(false);
    advance(1_000);
    // t = 11000: the t=1000 open has aged out too.
    expect(limiter.tryOpen("tab-a")).toBe(true);
  });

  it("does not let denied attempts extend the window", () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.tryOpen("tab-a");
    for (let i = 0; i < 20; i++) expect(limiter.tryOpen("tab-a")).toBe(false);
    advance(10_001);
    for (let i = 0; i < 5; i++) expect(limiter.tryOpen("tab-a")).toBe(true);
  });

  it("forget resets a source's quota", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.tryOpen("tab-a");
    expect(limiter.tryOpen("tab-a")).toBe(false);
    limiter.forget("tab-a");
    expect(limiter.tryOpen("tab-a")).toBe(true);
  });
});

describe("tab cap", () => {
  it("caps each space at 500 tabs", () => {
    expect(MAX_TABS_PER_SPACE).toBe(500);
  });
});
