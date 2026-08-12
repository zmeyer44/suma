import { describe, expect, it } from "vitest";
import { firstNameOf, greetingFor, periodOfDay } from "./greeting";

describe("periodOfDay", () => {
  it("buckets the day at 5, 12, 17, and 22", () => {
    expect(periodOfDay(5)).toBe("morning");
    expect(periodOfDay(11)).toBe("morning");
    expect(periodOfDay(12)).toBe("afternoon");
    expect(periodOfDay(16)).toBe("afternoon");
    expect(periodOfDay(17)).toBe("evening");
    expect(periodOfDay(21)).toBe("evening");
    expect(periodOfDay(22)).toBe("late-night");
    expect(periodOfDay(0)).toBe("late-night");
    expect(periodOfDay(4)).toBe("late-night");
  });
});

describe("firstNameOf", () => {
  it("takes the first word of a display name", () => {
    expect(firstNameOf("Zach Meyer")).toBe("Zach");
    expect(firstNameOf("  Ada   Lovelace ")).toBe("Ada");
    expect(firstNameOf("Prince")).toBe("Prince");
  });

  it("treats missing and blank names as unknown", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
  });
});

describe("greetingFor", () => {
  it("is deterministic for a given seed and context", () => {
    const args = { displayName: "Zach Meyer", hour: 9, seed: 0.4 };
    expect(greetingFor(args)).toBe(greetingFor(args));
  });

  it("greets by first name when one is known", () => {
    expect(greetingFor({ displayName: "Zach Meyer", hour: 9, seed: 0 })).toBe(
      "Good morning, Zach",
    );
  });

  it("never leaks a placeholder when the name is unknown", () => {
    for (const hour of [3, 9, 14, 19]) {
      for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
        const line = greetingFor({ displayName: null, hour, seed });
        expect(line).not.toContain("null");
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });

  it("survives edge seeds", () => {
    expect(() =>
      greetingFor({ displayName: null, hour: 23, seed: 0.9999999 }),
    ).not.toThrow();
    expect(() =>
      greetingFor({ displayName: "A", hour: 0, seed: 0 }),
    ).not.toThrow();
  });
});
