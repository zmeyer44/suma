/**
 * LocalVfs must answer exactly like agent/src/vfs.rs — these cases mirror
 * that module's test suite so the sim and the VM stay one behavior. When a
 * case is added there, add it here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  toBase64,
  VFS_MAX_WRITE_BYTES,
  type VfsResponse,
} from "@suma/protocol";
import { LocalVfs } from "../src/main/compute/local-vfs";

const roots: string[] = [];

function tempVfs(): { vfs: LocalVfs; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "suma-local-vfs-"));
  roots.push(root);
  return { vfs: new LocalVfs(root), root };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function b64(text: string): string {
  return toBase64(Buffer.from(text, "utf8"));
}

function expectError(resp: VfsResponse, code: string): void {
  expect(resp.t, JSON.stringify(resp)).toBe("error");
  if (resp.t === "error") expect(resp.code).toBe(code);
}

describe("LocalVfs confinement", () => {
  it("refuses traversal without side effects", async () => {
    const { vfs, root } = tempVfs();
    for (const bad of ["../escape.txt", "a/../../etc", "/.."]) {
      expectError(
        await vfs.handle({ t: "vfs.write", path: bad, dataB64: b64("x") }),
        "vfs_path_refused",
      );
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses paths through a symlink that leaves the root, allows in-root links", async () => {
    const { vfs, root } = tempVfs();
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "real/f.txt"), "hello");
    await fs.symlink("/etc", path.join(root, "outside"));
    await fs.symlink(path.join(root, "real"), path.join(root, "inside"));

    expectError(
      await vfs.handle({
        t: "vfs.read",
        path: "/outside/passwd",
        offset: 0,
        length: 16,
      }),
      "vfs_path_refused",
    );
    const ok = await vfs.handle({
      t: "vfs.read",
      path: "/inside/f.txt",
      offset: 0,
      length: 16,
    });
    expect(ok.t).toBe("vfs.data");
  });

  it("refuses the root as a delete/rename/write target", async () => {
    const { vfs } = tempVfs();
    expectError(
      await vfs.handle({ t: "vfs.delete", path: "/" }),
      "vfs_path_refused",
    );
    expectError(
      await vfs.handle({ t: "vfs.delete", path: "/", recursive: true }),
      "vfs_path_refused",
    );
    expectError(
      await vfs.handle({ t: "vfs.rename", from: "/", to: "/x" }),
      "vfs_path_refused",
    );
    expectError(
      await vfs.handle({ t: "vfs.write", path: "/", dataB64: b64("x") }),
      "vfs_path_refused",
    );
  });
});

describe("LocalVfs operations", () => {
  it("write/read/stat/list round-trip with the agent's shapes", async () => {
    const { vfs } = tempVfs();
    expect(await vfs.handle({ t: "vfs.mkdir", path: "/notes/2026" })).toEqual({
      t: "vfs.created",
      path: "/notes/2026",
    });
    expect(
      await vfs.handle({
        t: "vfs.write",
        path: "/notes/2026/a.txt",
        dataB64: b64("suma files"),
      }),
    ).toEqual({ t: "vfs.wrote", path: "/notes/2026/a.txt", sizeBytes: 10 });

    const read = await vfs.handle({
      t: "vfs.read",
      path: "/notes/2026/a.txt",
      offset: 5,
      length: 5,
    });
    expect(read).toEqual({
      t: "vfs.data",
      path: "/notes/2026/a.txt",
      offset: 5,
      dataB64: b64("files"),
      eof: true,
    });

    const stat = await vfs.handle({ t: "vfs.stat", path: "/notes/2026/a.txt" });
    expect(stat.t).toBe("vfs.info");
    if (stat.t === "vfs.info") {
      expect(stat.entry.name).toBe("a.txt");
      expect(stat.entry.kind).toBe("file");
      expect(stat.entry.sizeBytes).toBe(10);
      expect(stat.entry.modifiedAtMs).toBeGreaterThan(0);
    }

    const listing = await vfs.handle({ t: "vfs.list", path: "/notes" });
    expect(listing.t).toBe("vfs.listing");
    if (listing.t === "vfs.listing") {
      expect(listing.entries.map((e) => [e.name, e.kind])).toEqual([
        ["2026", "dir"],
      ]);
      expect(listing.truncated).toBe(false);
    }
  });

  it("writes are refused without a parent, and atomically leave no temp file", async () => {
    const { vfs, root } = tempVfs();
    expectError(
      await vfs.handle({
        t: "vfs.write",
        path: "/missing/f.txt",
        dataB64: b64("x"),
      }),
      "vfs_not_found",
    );
    await vfs.handle({ t: "vfs.write", path: "/f.txt", dataB64: b64("x") });
    const names = await fs.readdir(root);
    expect(names).toEqual(["f.txt"]);
  });

  it("oversized writes and appends are refused before touching disk", async () => {
    const { vfs, root } = tempVfs();
    const over = "A".repeat(Math.ceil((VFS_MAX_WRITE_BYTES + 4) / 3) * 4);
    expectError(
      await vfs.handle({ t: "vfs.write", path: "/big", dataB64: over }),
      "vfs_too_large",
    );
    expectError(
      await vfs.handle({ t: "vfs.append", path: "/big", dataB64: over }),
      "vfs_too_large",
    );
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("append extends existing files only", async () => {
    const { vfs, root } = tempVfs();
    expectError(
      await vfs.handle({ t: "vfs.append", path: "/log", dataB64: b64("one") }),
      "vfs_not_found",
    );
    await vfs.handle({ t: "vfs.write", path: "/log", dataB64: b64("one") });
    expect(
      await vfs.handle({ t: "vfs.append", path: "/log", dataB64: b64(" two") }),
    ).toEqual({
      t: "vfs.wrote",
      path: "/log",
      sizeBytes: 7,
    });
    expect(await fs.readFile(path.join(root, "log"), "utf8")).toBe("one two");
    await fs.mkdir(path.join(root, "d"));
    expectError(
      await vfs.handle({ t: "vfs.append", path: "/d", dataB64: b64("x") }),
      "vfs_is_a_directory",
    );
  });

  it("delete refuses a populated directory unless recursive", async () => {
    const { vfs, root } = tempVfs();
    await fs.mkdir(path.join(root, "sub/deep"), { recursive: true });
    await fs.writeFile(path.join(root, "sub/deep/f.txt"), "x");

    expectError(
      await vfs.handle({ t: "vfs.delete", path: "/sub" }),
      "vfs_not_empty",
    );
    expect(
      await vfs.handle({ t: "vfs.delete", path: "/sub", recursive: true }),
    ).toEqual({
      t: "vfs.deleted",
      path: "/sub",
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rename round-trips and never overwrites, escapes, or invents parents", async () => {
    const { vfs, root } = tempVfs();
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.writeFile(path.join(root, "b.txt"), "other");

    expect(
      await vfs.handle({ t: "vfs.rename", from: "/a.txt", to: "/dir/a2.txt" }),
    ).toEqual({
      t: "vfs.renamed",
      from: "/a.txt",
      to: "/dir/a2.txt",
    });

    expectError(
      await vfs.handle({ t: "vfs.rename", from: "/dir/a2.txt", to: "/b.txt" }),
      "vfs_already_exists",
    );
    expectError(
      await vfs.handle({ t: "vfs.rename", from: "/b.txt", to: "/../x" }),
      "vfs_path_refused",
    );
    expectError(
      await vfs.handle({ t: "vfs.rename", from: "/b.txt", to: "/missing/x" }),
      "vfs_not_found",
    );
    expectError(
      await vfs.handle({ t: "vfs.rename", from: "/ghost", to: "/x" }),
      "vfs_not_found",
    );
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("other");
  });

  it("allows exactly one concurrent rename claim for a destination", async () => {
    const { vfs, root } = tempVfs();
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");

    const responses = await Promise.all([
      vfs.handle({ t: "vfs.rename", from: "/a.txt", to: "/winner.txt" }),
      vfs.handle({ t: "vfs.rename", from: "/b.txt", to: "/winner.txt" }),
    ]);

    expect(
      responses.filter((response) => response.t === "vfs.renamed"),
    ).toHaveLength(1);
    const refused = responses.find((response) => response.t === "error");
    expectError(refused as VfsResponse, "vfs_already_exists");
    expect(["a", "b"]).toContain(
      await fs.readFile(path.join(root, "winner.txt"), "utf8"),
    );
    const sources = await Promise.all(
      ["a.txt", "b.txt"].map(async (name) => {
        try {
          return await fs.readFile(path.join(root, name), "utf8");
        } catch {
          return null;
        }
      }),
    );
    expect(sources.filter((source) => source !== null)).toHaveLength(1);
  });

  it("tree walks with skips, sorted output, and empty-dir rows", async () => {
    const { vfs, root } = tempVfs();
    await fs.mkdir(path.join(root, "src/lib"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await fs.mkdir(path.join(root, "empty"));
    await fs.writeFile(path.join(root, "src/main.ts"), "x");
    await fs.writeFile(path.join(root, "src/lib/util.ts"), "x");
    await fs.writeFile(path.join(root, ".DS_Store"), "x");
    await fs.writeFile(path.join(root, "README.md"), "x");
    await fs.symlink("/etc", path.join(root, "outside"));

    const resp = await vfs.handle({ t: "vfs.tree", path: "/" });
    expect(resp).toEqual({
      t: "vfs.paths",
      path: "/",
      paths: ["/README.md", "/empty/", "/src/lib/util.ts", "/src/main.ts"],
      truncated: false,
    });

    const sub = await vfs.handle({ t: "vfs.tree", path: "/src" });
    expect(sub).toEqual({
      t: "vfs.paths",
      path: "/src",
      paths: ["/src/lib/util.ts", "/src/main.ts"],
      truncated: false,
    });

    expectError(
      await vfs.handle({ t: "vfs.tree", path: "/README.md" }),
      "vfs_io_failed",
    );
  });
});
