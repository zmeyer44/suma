import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleTrailing } from "../src/renderer/src/lib/throttle";

describe("throttleTrailing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately when idle, and at most once per interval", () => {
    const calls: number[] = [];
    const throttled = throttleTrailing(() => calls.push(Date.now()), 1000);
    throttled();
    expect(calls).toHaveLength(1);
    throttled();
    throttled();
    expect(calls).toHaveLength(1); // window still open — trailing scheduled
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2); // exactly one trailing call
  });

  it("never drops the last signal of a burst", () => {
    let runs = 0;
    const throttled = throttleTrailing(() => {
      runs += 1;
    }, 1000);
    throttled(); // leading
    vi.advanceTimersByTime(300);
    throttled(); // inside the window — must survive as trailing
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(2);
  });

  it("separate quiet periods each get a leading call", () => {
    let runs = 0;
    const throttled = throttleTrailing(() => {
      runs += 1;
    }, 1000);
    throttled();
    vi.advanceTimersByTime(1500);
    throttled();
    expect(runs).toBe(2);
  });
});
