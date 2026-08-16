/**
 * Space ↔ folder binding: name sanitation, collision suffixes, and the
 * SpaceFsService lifecycle (lazy bind, best-effort rename, delete keeps the
 * folder) against a SimAgent on a temp root.
 */

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimAgent } from "../src/main/compute/sim-agent";
import {
  pickSpaceFolder,
  sanitizeSpaceFolderName,
} from "../src/main/space-folders";
import { SpaceFsService } from "../src/main/space-fs";

describe("sanitizeSpaceFolderName", () => {
  it("strips path-hostile characters and trims dots/spaces", () => {
    expect(sanitizeSpaceFolderName("Work")).toBe("Work");
    expect(sanitizeSpaceFolderName("  ..Work: stuff?  ")).toBe("Work stuff");
    expect(sanitizeSpaceFolderName("a/b\\c|d")).toBe("abcd");
    expect(sanitizeSpaceFolderName("../../etc")).toBe("etc");
  });

  it("caps length and falls back when nothing survives", () => {
    expect(sanitizeSpaceFolderName("x".repeat(100))).toHaveLength(64);
    expect(sanitizeSpaceFolderName("///")).toBe("Space");
    expect(sanitizeSpaceFolderName("...")).toBe("Space");
    expect(sanitizeSpaceFolderName("")).toBe("Space");
  });
});

describe("pickSpaceFolder", () => {
  it("is deterministic per space and distinct across concurrent allocations", () => {
    const first = pickSpaceFolder({}, "space-a", "Work");
    expect(pickSpaceFolder({}, "space-a", "Work")).toBe(first);
    expect(pickSpaceFolder({}, "space-b", "Work")).not.toBe(first);
    expect(first).toMatch(/^Work--[a-f0-9]{12}$/);
  });

  it("treats existing names case-insensitively and ignores its own binding", () => {
    const desired = pickSpaceFolder({}, "space-a", "Work");
    expect(pickSpaceFolder({ "space-a": desired }, "space-a", "Work")).toBe(
      desired,
    );
    expect(
      pickSpaceFolder({ legacy: desired.toUpperCase() }, "space-a", "Work"),
    ).toBe(`${desired}-2`);
  });

  it("keeps the complete folder name under the filesystem limit", () => {
    expect(pickSpaceFolder({}, "space-a", "x".repeat(100))).toHaveLength(64);
  });
});

describe("SpaceFsService", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function makeService(names: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "suma-space-fs-"));
    roots.push(root);
    const folders: Record<string, string> = {};
    const store = {
      spaceFolders: () => ({ ...folders }),
      setSpaceFolder: (id: string, folder: string) => {
        folders[id] = folder;
      },
      removeSpaceFolder: (id: string) => {
        delete folders[id];
      },
    };
    const service = new SpaceFsService({
      link: new SimAgent({ root: () => root }),
      store,
      spaceName: (id) => names[id] ?? null,
    });
    return { service, root, folders };
  }

  it("binds lazily, creates dirs idempotently, and keeps bindings stable", async () => {
    const { service, root, folders } = makeService({
      s1: "Personal",
      s2: "Personal",
    });
    const s1Folder = pickSpaceFolder({}, "s1", "Personal");
    const s2Folder = pickSpaceFolder({}, "s2", "Personal");
    expect(service.folderFor("s1")).toBe(s1Folder);
    // Same-name spaces remain distinct even if devices allocate concurrently.
    expect(service.folderFor("s2")).toBe(s2Folder);
    // Bindings are stable on re-ask.
    expect(service.folderFor("s1")).toBe(s1Folder);

    await service.ensureDownloadsDir("s1");
    await service.ensureDownloadsDir("s1");
    const stat = await fs.stat(path.join(root, s1Folder, "Downloads"));
    expect(stat.isDirectory()).toBe(true);
    expect(folders).toEqual({ s1: s1Folder, s2: s2Folder });
  });

  it("renames move the folder when free and keep the binding when refused", async () => {
    const { service, root, folders } = makeService({ s1: "Old" });
    const oldFolder = pickSpaceFolder({}, "s1", "Old");
    const newFolder = pickSpaceFolder({}, "s1", "New");
    const takenFolder = pickSpaceFolder({}, "s1", "Taken");
    await service.ensureSpaceDir("s1");
    await fs.writeFile(path.join(root, oldFolder, "keep.txt"), "x");

    await service.onSpaceRenamed("s1", "New");
    expect(folders["s1"]).toBe(newFolder);
    expect(
      await fs.readFile(path.join(root, newFolder, "keep.txt"), "utf8"),
    ).toBe("x");

    // A rename onto an occupied name is refused: binding stands, files stay.
    await fs.mkdir(path.join(root, takenFolder));
    await service.onSpaceRenamed("s1", "Taken");
    expect(folders["s1"]).toBe(newFolder);
    expect(
      await fs.readFile(path.join(root, newFolder, "keep.txt"), "utf8"),
    ).toBe("x");
  });

  it("space removal drops the binding but never the folder", async () => {
    const { service, root, folders } = makeService({ s1: "Docs" });
    const folder = pickSpaceFolder({}, "s1", "Docs");
    await service.ensureSpaceDir("s1");
    await fs.writeFile(path.join(root, folder, "precious.txt"), "x");

    service.onSpaceRemoved("s1");
    expect(folders["s1"]).toBeUndefined();
    expect(
      await fs.readFile(path.join(root, folder, "precious.txt"), "utf8"),
    ).toBe("x");
  });
});
