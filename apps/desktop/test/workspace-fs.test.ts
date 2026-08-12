/**
 * The IDE's workspace filesystem (suma://terminal): the root guard that keeps
 * renderer-supplied paths inside the workspace, and the tree walk the
 * explorer renders.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceFsService } from "../src/main/workspace-fs";

let root: string;
let service: WorkspaceFsService;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "suma-workspace-"));
  service = new WorkspaceFsService(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolve", () => {
  it("keeps relative paths inside the root", () => {
    expect(service.resolve("src/index.ts")).toBe(
      path.join(root, "src/index.ts"),
    );
  });

  it("refuses absolute paths", () => {
    expect(() => service.resolve("/etc/passwd")).toThrow(/absolute/);
  });

  it("refuses ..-escapes", () => {
    expect(() => service.resolve("../outside")).toThrow(/escapes/);
    expect(() => service.resolve("src/../../outside")).toThrow(/escapes/);
  });

  it("refuses a sibling directory sharing the root as a prefix", () => {
    // /tmp/suma-workspace-x must not authorize /tmp/suma-workspace-x-evil.
    expect(() => service.resolve(`../${path.basename(root)}-evil/f`)).toThrow(
      /escapes/,
    );
  });
});

describe("tree", () => {
  it("lists files workspace-relative, sorted, with empty dirs kept", async () => {
    await mkdir(path.join(root, "src/components"), { recursive: true });
    await mkdir(path.join(root, "empty"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# hi");
    await writeFile(path.join(root, "src/index.ts"), "export {}");
    await writeFile(path.join(root, "src/components/App.tsx"), "x");

    const tree = await service.tree();
    expect(tree.root).toBe(root);
    expect(tree.truncated).toBe(false);
    expect(tree.paths).toEqual([
      "README.md",
      "empty/",
      "src/components/App.tsx",
      "src/index.ts",
    ]);
  });

  it("skips dependency dirs, junk files, and symlinks", async () => {
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "x");
    await writeFile(path.join(root, ".DS_Store"), "x");
    await writeFile(path.join(root, "kept.txt"), "x");
    await symlink(os.tmpdir(), path.join(root, "loop"));

    const tree = await service.tree();
    expect(tree.paths).toEqual(["kept.txt"]);
  });
});

describe("read/write", () => {
  it("round-trips text through write and read", async () => {
    await writeFile(path.join(root, "a.txt"), "before");
    await service.write("a.txt", "after");
    const file = await service.read("a.txt");
    expect(file).toEqual({ path: "a.txt", contents: "after", unreadable: false });
  });

  it("flags binary files unreadable instead of returning bytes", async () => {
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x89, 0, 0x50]));
    const file = await service.read("blob.bin");
    expect(file.unreadable).toBe(true);
    expect(file.contents).toBe("");
  });
});
