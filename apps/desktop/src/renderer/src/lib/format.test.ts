import { describe, expect, it } from "vitest";
import { agoLabel, downloadProgress, formatBytes } from "./format";

describe("formatBytes", () => {
  it("handles zero and non-finite input", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("scales through units with one decimal below 100", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1200)).toBe("1.2 KB");
    expect(formatBytes(3_400_000)).toBe("3.4 MB");
    expect(formatBytes(250_000_000)).toBe("250 MB");
    expect(formatBytes(1_100_000_000)).toBe("1.1 GB");
  });

  it("drops a trailing .0", () => {
    expect(formatBytes(2000)).toBe("2 KB");
  });
});

describe("downloadProgress", () => {
  it("computes a clamped fraction and a 'x of y' label when the total is known", () => {
    expect(downloadProgress(1200, 3_400_000)).toEqual({
      fraction: 1200 / 3_400_000,
      label: "1.2 KB of 3.4 MB",
    });
    expect(downloadProgress(5000, 4000).fraction).toBe(1);
  });

  it("is indeterminate when the server sent no length", () => {
    expect(downloadProgress(1200, 0)).toEqual({ fraction: null, label: "1.2 KB" });
    expect(downloadProgress(-10, 0)).toEqual({ fraction: null, label: "0 B" });
  });
});

describe("agoLabel", () => {
  it("buckets relative times", () => {
    const now = 1_000_000_000;
    expect(agoLabel(now - 20_000, now)).toBe("just now");
    expect(agoLabel(now - 4 * 60_000, now)).toBe("4m ago");
    expect(agoLabel(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(agoLabel(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(agoLabel(now + 60_000, now)).toBe("just now");
  });
});
