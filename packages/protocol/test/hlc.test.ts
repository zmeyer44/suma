import { describe, expect, it } from "vitest";
import {
  HlcClock,
  MAX_CLOCK_DRIFT_MS,
  compareHlc,
  decodeHlc,
  encodeHlc,
  type Hlc,
} from "../src/index.js";

describe("HLC ordering", () => {
  it("orders by physical, then logical, then deviceId", () => {
    const a: Hlc = { physicalMs: 100, logical: 0, deviceId: "a" };
    expect(compareHlc(a, { physicalMs: 101, logical: 0, deviceId: "a" })).toBe(-1);
    expect(compareHlc(a, { physicalMs: 100, logical: 1, deviceId: "a" })).toBe(-1);
    expect(compareHlc(a, { physicalMs: 100, logical: 0, deviceId: "b" })).toBe(-1);
    expect(compareHlc(a, a)).toBe(0);
  });

  it("encode/decode round-trips and string order matches compare order", () => {
    const samples: Hlc[] = [
      { physicalMs: 1, logical: 0, deviceId: "dev-a" },
      { physicalMs: 1, logical: 5, deviceId: "dev-a" },
      { physicalMs: 2, logical: 0, deviceId: "dev-a" },
      { physicalMs: 1722400000000, logical: 250, deviceId: "dev-b" },
    ];
    for (const h of samples) expect(decodeHlc(encodeHlc(h))).toEqual(h);
    const sortedByString = [...samples].sort((x, y) => (encodeHlc(x) < encodeHlc(y) ? -1 : 1));
    const sortedByCompare = [...samples].sort(compareHlc);
    expect(sortedByString).toEqual(sortedByCompare);
  });
});

describe("HlcClock", () => {
  it("issues strictly increasing timestamps even with a frozen wall clock", () => {
    const wall = 1000;
    const clock = new HlcClock("dev-a", () => wall);
    const t1 = clock.send();
    const t2 = clock.send();
    const t3 = clock.send();
    expect(compareHlc(t1, t2)).toBe(-1);
    expect(compareHlc(t2, t3)).toBe(-1);
    expect(t3.physicalMs).toBe(1000);
    expect(t3.logical).toBe(2);
  });

  it("advances past a received remote timestamp", () => {
    const clock = new HlcClock("dev-a", () => 1000);
    const merged = clock.receive({ physicalMs: 5000, logical: 7, deviceId: "dev-b" });
    expect(compareHlc({ physicalMs: 5000, logical: 7, deviceId: "dev-b" }, merged)).toBe(-1);
    const next = clock.send();
    expect(compareHlc(merged, next)).toBe(-1);
  });

  it("clamps a wildly skewed remote clock (untrusted device clocks)", () => {
    const wall = 1_000_000;
    const clock = new HlcClock("dev-a", () => wall);
    const skewed: Hlc = { physicalMs: wall + 10 * 60 * 60 * 1000, logical: 0, deviceId: "dev-b" };
    const merged = clock.receive(skewed);
    expect(merged.physicalMs).toBeLessThanOrEqual(wall + MAX_CLOCK_DRIFT_MS);
  });

  it("restores persisted state monotonically", () => {
    const clock = new HlcClock("dev-a", () => 50);
    clock.restore({ physicalMs: 900, logical: 3, deviceId: "dev-a" });
    const t = clock.send();
    expect(compareHlc({ physicalMs: 900, logical: 3, deviceId: "dev-a" }, t)).toBe(-1);
  });
});
