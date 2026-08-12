import { describe, expect, it } from "vitest";
import type { FileEntry } from "@suma/protocol";
import {
  ancestorPaths,
  breadcrumbs,
  buildTree,
  findNode,
  flattenTree,
  joinPath,
  parentPath,
  ROOT_PATH,
  type TreeDir,
} from "./tree";

const HASH = "a".repeat(64);

function entry(path: string, sizeBytes = 10, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: `f_${path}`,
    path,
    sizeBytes,
    fileHash: HASH,
    contentType: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

function dirAt(root: TreeDir, path: string): TreeDir {
  const node = findNode(root, path);
  if (node === null || node.kind !== "dir") throw new Error(`expected a directory at ${path}`);
  return node;
}

describe("buildTree", () => {
  it("nests files into directories created on the way down", () => {
    const root = buildTree([entry("/notes/2026/q3.md"), entry("/notes/todo.txt"), entry("/README")]);

    expect(root.path).toBe(ROOT_PATH);
    expect(root.children.map((c) => c.name)).toEqual(["notes", "README"]);

    const notes = dirAt(root, "/notes");
    expect(notes.children.map((c) => `${c.kind}:${c.name}`)).toEqual(["dir:2026", "file:todo.txt"]);
    expect(dirAt(root, "/notes/2026").children.map((c) => c.path)).toEqual(["/notes/2026/q3.md"]);
  });

  it("sorts directories first, then names case-insensitively and numerically", () => {
    const root = buildTree([
      entry("/zeta.txt"),
      entry("/Alpha.txt"),
      entry("/img/10.png"),
      entry("/img/2.png"),
      entry("/beta/one.txt"),
    ]);

    expect(root.children.map((c) => c.name)).toEqual(["beta", "img", "Alpha.txt", "zeta.txt"]);
    expect(dirAt(root, "/img").children.map((c) => c.name)).toEqual(["2.png", "10.png"]);
  });

  it("aggregates size and file count up the tree", () => {
    const root = buildTree([
      entry("/a/b/one.bin", 100),
      entry("/a/b/two.bin", 200),
      entry("/a/three.bin", 50),
      entry("/loose.bin", 7),
    ]);

    expect(dirAt(root, "/a/b")).toMatchObject({ fileCount: 2, sizeBytes: 300 });
    expect(dirAt(root, "/a")).toMatchObject({ fileCount: 3, sizeBytes: 350 });
    expect(root).toMatchObject({ fileCount: 4, sizeBytes: 357 });
  });

  it("normalizes redundant separators and drops paths that escape the root", () => {
    const root = buildTree([
      entry("//notes///todo.txt"),
      entry("/notes/./clean.txt"),
      entry("../../etc/passwd"),
      entry("/notes/../../escape.txt"),
      entry("/"),
      entry(""),
    ]);

    expect(dirAt(root, "/notes").children.map((c) => c.path)).toEqual([
      "/notes/clean.txt",
      "/notes/todo.txt",
    ]);
    expect(root.children.map((c) => c.name)).toEqual(["notes"]);
    expect(root.fileCount).toBe(2);
  });

  it("keeps the directory when a name is claimed as both a file and a directory", () => {
    const root = buildTree([entry("/data", 999), entry("/data/inner.txt", 5)]);

    const data = dirAt(root, "/data");
    expect(data.children.map((c) => c.name)).toEqual(["inner.txt"]);
    expect(root.fileCount).toBe(1);
    expect(root.sizeBytes).toBe(5);
  });

  it("lets a later entry replace an earlier one at the same normalized path", () => {
    const root = buildTree([entry("/a.txt", 1), entry("//a.txt", 900, { id: "newer" })]);

    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ kind: "file", sizeBytes: 900 });
    expect(root.sizeBytes).toBe(900);
  });

  it("returns an empty root for no entries", () => {
    expect(buildTree([])).toEqual({
      kind: "dir",
      name: "",
      path: ROOT_PATH,
      children: [],
      fileCount: 0,
      sizeBytes: 0,
    });
  });
});

describe("flattenTree", () => {
  const root = buildTree([entry("/a/b/deep.txt"), entry("/a/shallow.txt"), entry("/top.txt")]);

  it("shows only collapsed directories when nothing is expanded", () => {
    expect(flattenTree(root, new Set()).map((r) => `${r.depth}:${r.node.path}`)).toEqual([
      "0:/a",
      "0:/top.txt",
    ]);
  });

  it("reveals children of expanded directories at increasing depth", () => {
    const rows = flattenTree(root, new Set(["/a", "/a/b"]));
    expect(rows.map((r) => `${r.depth}:${r.node.path}`)).toEqual([
      "0:/a",
      "1:/a/b",
      "2:/a/b/deep.txt",
      "1:/a/shallow.txt",
      "0:/top.txt",
    ]);
    expect(rows[0]?.expanded).toBe(true);
  });

  it("does not reveal grandchildren through a collapsed parent", () => {
    expect(flattenTree(root, new Set(["/a/b"])).map((r) => r.node.path)).toEqual(["/a", "/top.txt"]);
  });
});

describe("path helpers", () => {
  it("parentPath walks up one level and stops at the root", () => {
    expect(parentPath("/a/b/c.txt")).toBe("/a/b");
    expect(parentPath("/top.txt")).toBe(ROOT_PATH);
    expect(parentPath("/")).toBe(ROOT_PATH);
    expect(parentPath("../escape")).toBe(ROOT_PATH);
  });

  it("ancestorPaths lists containing directories, root first", () => {
    expect(ancestorPaths("/a/b/c.txt")).toEqual(["/", "/a", "/a/b"]);
    expect(ancestorPaths("/top.txt")).toEqual(["/"]);
    expect(ancestorPaths("/a/../b/c.txt")).toEqual(["/", "/b"]);
  });

  it("joinPath refuses escapes", () => {
    expect(joinPath("/a", "b.txt")).toBe("/a/b.txt");
    expect(joinPath("/", "b.txt")).toBe("/b.txt");
    expect(joinPath("/a", "../../../etc/passwd")).toBe(null);
  });

  it("breadcrumbs accumulate segment paths", () => {
    expect(breadcrumbs("/a/b/c.txt")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
      { name: "c.txt", path: "/a/b/c.txt" },
    ]);
    expect(breadcrumbs("/")).toEqual([]);
  });

  it("findNode resolves exact paths and nothing else", () => {
    const root = buildTree([entry("/a/b.txt")]);
    expect(findNode(root, "/")).toBe(root);
    expect(findNode(root, "/a")?.kind).toBe("dir");
    expect(findNode(root, "/a/b.txt")?.kind).toBe("file");
    expect(findNode(root, "/a/b.txt/deeper")).toBe(null);
    expect(findNode(root, "/missing")).toBe(null);
  });
});
