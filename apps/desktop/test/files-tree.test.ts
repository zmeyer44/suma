/**
 * Files presentation (§8.6): one directory level out of the control plane's
 * flat path list, and the quota meter's soft-block state.
 */

import { describe, expect, it } from "vitest";
import { PRO_QUOTA_BYTES, type FileEntry } from "@suma/protocol";
import {
  basename,
  dirname,
  formatFileBytes,
  listDirectory,
  normalizeDirPath,
  presentQuota,
} from "../src/main/files/tree";

function entry(path: string, sizeBytes: number): FileEntry {
  return {
    id: path,
    path,
    sizeBytes,
    fileHash: "a".repeat(64),
    contentType: null,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

const TREE: FileEntry[] = [
  entry("/notes.md", 100),
  entry("/Downloads/big.zip", 2_000),
  entry("/Downloads/nested/deep.bin", 3_000),
  entry("/Projects/suma/README.md", 50),
  entry("/Projects/notes.txt", 25),
];

describe("normalizeDirPath", () => {
  it("normalizes the root and refuses to escape it", () => {
    expect(normalizeDirPath(undefined)).toBe("/");
    expect(normalizeDirPath("")).toBe("/");
    expect(normalizeDirPath("Downloads/")).toBe("/Downloads");
    expect(normalizeDirPath("/Downloads/../Projects")).toBe("/Projects");
    expect(normalizeDirPath("../../etc")).toBe("/");
  });
});

describe("basename / dirname", () => {
  it("splits VFS paths", () => {
    expect(basename("/Downloads/big.zip")).toBe("big.zip");
    expect(basename("/")).toBe("");
    expect(dirname("/Downloads/big.zip")).toBe("/Downloads");
    expect(dirname("/notes.md")).toBe("/");
  });
});

describe("listDirectory", () => {
  it("shows immediate files and folders at the root", () => {
    const listing = listDirectory(TREE, "/");
    expect(listing.path).toBe("/");
    expect(listing.files.map((file) => file.path)).toEqual(["/notes.md"]);
    expect(listing.dirs.map((dir) => dir.name)).toEqual(["Downloads", "Projects"]);
  });

  it("counts everything beneath a folder, not just its direct children", () => {
    const downloads = listDirectory(TREE, "/").dirs.find((dir) => dir.name === "Downloads");
    expect(downloads).toMatchObject({ path: "/Downloads", fileCount: 2, sizeBytes: 5_000 });
  });

  it("descends into a subdirectory", () => {
    const listing = listDirectory(TREE, "/Downloads");
    expect(listing.files.map((file) => file.path)).toEqual(["/Downloads/big.zip"]);
    expect(listing.dirs.map((dir) => dir.path)).toEqual(["/Downloads/nested"]);
  });

  it("returns an empty level for a path with nothing under it", () => {
    expect(listDirectory(TREE, "/Nope")).toEqual({
      path: "/Nope",
      dirs: [],
      files: [],
      entries: [],
    });
  });

  it("also returns everything under the path, for a client-side tree", () => {
    expect(listDirectory(TREE, "/Downloads").entries.map((file) => file.path)).toEqual([
      "/Downloads/big.zip",
      "/Downloads/nested/deep.bin",
    ]);
    expect(listDirectory(TREE, "/").entries).toHaveLength(TREE.length);
  });

  it("sorts naturally and never treats a prefix match as containment", () => {
    const listing = listDirectory(
      [entry("/a/file2.txt", 1), entry("/a/file10.txt", 1), entry("/ab/other.txt", 1)],
      "/a",
    );
    expect(listing.files.map((file) => basename(file.path))).toEqual(["file2.txt", "file10.txt"]);
    expect(listing.dirs).toEqual([]);
  });
});

describe("formatFileBytes", () => {
  it("uses the same units the quota is defined in", () => {
    expect(formatFileBytes(0)).toBe("0 B");
    expect(formatFileBytes(512)).toBe("512 B");
    expect(formatFileBytes(1024)).toBe("1 KB");
    expect(formatFileBytes(1536)).toBe("1.5 KB");
    expect(formatFileBytes(PRO_QUOTA_BYTES)).toBe("100 GB");
  });
});

describe("presentQuota (§8.6 soft block)", () => {
  it("reports normal usage against the plan limit", () => {
    const meter = presentQuota({ usedBytes: PRO_QUOTA_BYTES / 4, limitBytes: PRO_QUOTA_BYTES });
    expect(meter.softBlocked).toBe(false);
    expect(meter.fraction).toBeCloseTo(0.25, 5);
    expect(meter.explanation).toContain("25 GB of 100 GB");
    expect(meter.explanation).toContain("~/cloud");
  });

  it("soft-blocks at the limit without ever implying data loss", () => {
    const meter = presentQuota({ usedBytes: PRO_QUOTA_BYTES, limitBytes: PRO_QUOTA_BYTES });
    expect(meter.softBlocked).toBe(true);
    expect(meter.fraction).toBe(1);
    expect(meter.explanation).toContain("stay available");
    expect(meter.explanation).not.toMatch(/delete|removed/i);
  });

  it("clamps a bogus limit instead of dividing by zero", () => {
    expect(presentQuota({ usedBytes: 10, limitBytes: 0 }).fraction).toBe(0);
  });
});
