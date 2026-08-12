import { describe, expect, it } from "vitest";
import { PRO_QUOTA_BYTES } from "@suma/protocol";
import { agoLabel, baseName, errorMessage, formatBytes, formatCount, progressOf } from "./format";

describe("formatBytes", () => {
  it("floors at zero for empty, negative and non-finite input", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("scales on a 1024 base with one decimal below 100", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3 TB");
  });

  it("agrees with the wording checkQuota derives from PRO_QUOTA_BYTES", () => {
    // checkQuota says "100 GB" via limitBytes / 1024**3 — a decimal formatter
    // would print "107.4 GB" here and contradict the sentence beside it.
    expect(formatBytes(PRO_QUOTA_BYTES)).toBe("100 GB");
  });

  it("does not run past the largest unit", () => {
    expect(formatBytes(4096 * 1024 ** 4)).toBe("4096 TB");
  });
});

describe("formatCount", () => {
  it("pluralizes", () => {
    expect(formatCount(1, "file")).toBe("1 file");
    expect(formatCount(0, "file")).toBe("0 files");
    expect(formatCount(3, "entry", "entries")).toBe("3 entries");
  });
});

describe("progressOf", () => {
  it("computes a clamped fraction when the total is known", () => {
    expect(progressOf(512, 1024)).toEqual({
      fraction: 0.5,
      label: "512 B of 1 KB",
      percentLabel: "50%",
    });
    expect(progressOf(5000, 1000).fraction).toBe(1);
  });

  it("is indeterminate when no total was declared", () => {
    expect(progressOf(1536, 0)).toEqual({ fraction: null, label: "1.5 KB", percentLabel: "" });
    expect(progressOf(-10, -5)).toEqual({ fraction: null, label: "0 B", percentLabel: "" });
  });
});

describe("agoLabel", () => {
  it("buckets relative times", () => {
    const now = 1_000_000_000_000;
    expect(agoLabel(now, now)).toBe("just now");
    expect(agoLabel(now - 30_000, now)).toBe("just now");
    expect(agoLabel(now - 240_000, now)).toBe("4m ago");
    expect(agoLabel(now - 7_200_000, now)).toBe("2h ago");
    expect(agoLabel(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(agoLabel(now + 5_000, now)).toBe("just now");
  });
});

describe("baseName", () => {
  it("takes the last segment", () => {
    expect(baseName("/notes/todo.md")).toBe("todo.md");
    expect(baseName("todo.md")).toBe("todo.md");
    expect(baseName("/notes/")).toBe("notes");
    expect(baseName("/")).toBe("");
  });
});

describe("errorMessage", () => {
  it("prefers a real message and falls back honestly", () => {
    expect(errorMessage(new Error("bridge offline"))).toBe("bridge offline");
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
    expect(errorMessage({ nope: true })).toBe("Something went wrong.");
  });
});
