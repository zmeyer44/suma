import { describe, expect, it } from "vitest";
import { PRO_QUOTA_BYTES } from "@suma/protocol";
import { admitUpload, summarizeQuota } from "./quota";

const GIB = 1024 ** 3;

describe("summarizeQuota", () => {
  it("reads calmly well below the limit", () => {
    const summary = summarizeQuota({ usedBytes: 20 * GIB, limitBytes: PRO_QUOTA_BYTES });
    expect(summary).toMatchObject({
      fraction: 0.2,
      percentLabel: "20%",
      usageLabel: "20 GB of 100 GB",
      tone: "ok",
      softBlocked: false,
      note: "",
    });
  });

  it("warns from 90% without claiming anything is blocked", () => {
    const summary = summarizeQuota({ usedBytes: 92 * GIB, limitBytes: PRO_QUOTA_BYTES });
    expect(summary.tone).toBe("warn");
    expect(summary.softBlocked).toBe(false);
    expect(summary.note).toBe("Almost full.");
  });

  it("soft-blocks at the limit and promises existing files stay", () => {
    const summary = summarizeQuota({ usedBytes: PRO_QUOTA_BYTES, limitBytes: PRO_QUOTA_BYTES });
    expect(summary).toMatchObject({ tone: "danger", softBlocked: true, percentLabel: "100%" });
    expect(summary.note).toContain("stays available");
    expect(summary.note).not.toMatch(/delet|remov/i);
  });

  it("clamps past the limit rather than drawing a bar over 100%", () => {
    const summary = summarizeQuota({ usedBytes: PRO_QUOTA_BYTES * 2, limitBytes: PRO_QUOTA_BYTES });
    expect(summary.fraction).toBe(1);
    expect(summary.softBlocked).toBe(true);
  });

  it("treats negative or absent numbers as a full, blocked meter", () => {
    expect(summarizeQuota({ usedBytes: -5, limitBytes: 0 })).toMatchObject({
      usedBytes: 0,
      fraction: 1,
      softBlocked: true,
    });
  });
});

describe("admitUpload", () => {
  it("allows an upload that fits", () => {
    expect(admitUpload({ usedBytes: 10 * GIB, limitBytes: PRO_QUOTA_BYTES }, GIB)).toEqual({
      allowed: true,
      message: "",
    });
  });

  it("refuses one that would cross the limit, quoting checkQuota", () => {
    const result = admitUpload({ usedBytes: 99 * GIB, limitBytes: PRO_QUOTA_BYTES }, 2 * GIB);
    expect(result.allowed).toBe(false);
    expect(result.message).toContain("100 GB Files quota");
    expect(result.message).toContain("Existing files stay available");
  });

  it("allows an upload that lands exactly on the limit", () => {
    expect(admitUpload({ usedBytes: 99 * GIB, limitBytes: PRO_QUOTA_BYTES }, GIB).allowed).toBe(true);
  });

  it("never treats a negative size as free space", () => {
    expect(admitUpload({ usedBytes: PRO_QUOTA_BYTES, limitBytes: PRO_QUOTA_BYTES }, -100)).toEqual({
      allowed: true,
      message: "",
    });
  });
});
