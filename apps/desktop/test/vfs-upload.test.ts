/**
 * The cloud-mode download mirror: chunked write+append under the vfs frame
 * cap, partial-name upload, rename-into-place with numbered-collision
 * fallback, and honest failure that never touches the local file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VfsRequest, VfsResponse } from "@suma/protocol";
import { SimAgent } from "../src/main/compute/sim-agent";
import { numberedName, uploadFileToVfs } from "../src/main/files/vfs-upload";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function rig(): Promise<{
  vfs: (req: VfsRequest) => Promise<VfsResponse>;
  root: string;
  local: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "suma-upload-root-"));
  const local = mkdtempSync(path.join(os.tmpdir(), "suma-upload-local-"));
  roots.push(root, local);
  const sim = new SimAgent({ root: () => root });
  await sim.vfs({ t: "vfs.mkdir", path: "/Personal/Downloads" });
  return { vfs: (req) => sim.vfs(req), root, local };
}

describe("numberedName", () => {
  it("suffixes before the extension, first attempt untouched", () => {
    expect(numberedName("report.pdf", 1)).toBe("report.pdf");
    expect(numberedName("report.pdf", 2)).toBe("report (2).pdf");
    expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar (3).gz");
    expect(numberedName("README", 2)).toBe("README (2)");
    expect(numberedName(".env", 2)).toBe(".env (2)");
  });
});

describe("uploadFileToVfs", () => {
  it("mirrors a file byte-for-byte and leaves no partial behind", async () => {
    const { vfs, root, local } = await rig();
    const payload = Buffer.concat([Buffer.from("head-"), Buffer.alloc(1024, 0x42)]);
    const localPath = path.join(local, "file.bin");
    await fs.writeFile(localPath, payload);

    const result = await uploadFileToVfs(vfs, localPath, "/Personal/Downloads", "file.bin");
    expect(result).toEqual({ ok: true, remotePath: "/Personal/Downloads/file.bin" });
    const landed = await fs.readFile(path.join(root, "Personal/Downloads/file.bin"));
    expect(landed.equals(payload)).toBe(true);
    const names = await fs.readdir(path.join(root, "Personal/Downloads"));
    expect(names).toEqual(["file.bin"]);
    // Source untouched.
    expect((await fs.readFile(localPath)).equals(payload)).toBe(true);
  });

  it("numbers collisions instead of overwriting", async () => {
    const { vfs, root, local } = await rig();
    await fs.mkdir(path.join(root, "Personal/Downloads"), { recursive: true });
    await fs.writeFile(path.join(root, "Personal/Downloads/file.txt"), "existing");
    const localPath = path.join(local, "file.txt");
    await fs.writeFile(localPath, "fresh");

    const result = await uploadFileToVfs(vfs, localPath, "/Personal/Downloads", "file.txt");
    expect(result.ok).toBe(true);
    expect(result.remotePath).toBe("/Personal/Downloads/file (2).txt");
    expect(
      await fs.readFile(path.join(root, "Personal/Downloads/file.txt"), "utf8"),
    ).toBe("existing");
  });

  it("mirrors a zero-byte file", async () => {
    const { vfs, root, local } = await rig();
    const localPath = path.join(local, "empty.txt");
    await fs.writeFile(localPath, "");
    const result = await uploadFileToVfs(vfs, localPath, "/Personal/Downloads", "empty.txt");
    expect(result.ok).toBe(true);
    const stat = await fs.stat(path.join(root, "Personal/Downloads/empty.txt"));
    expect(stat.size).toBe(0);
  });

  it("fails honestly and cleans its partial when the transport dies mid-way", async () => {
    const { vfs, root, local } = await rig();
    const localPath = path.join(local, "file.bin");
    await fs.writeFile(localPath, Buffer.alloc(64, 1));
    let calls = 0;
    const flaky = async (req: VfsRequest): Promise<VfsResponse> => {
      calls += 1;
      if (req.t === "vfs.write") throw new Error("link lost");
      return vfs(req);
    };
    const result = await uploadFileToVfs(flaky, localPath, "/Personal/Downloads", "file.bin");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/transport failed/);
    expect(calls).toBeGreaterThan(0);
    const names = await fs.readdir(path.join(root, "Personal/Downloads"));
    expect(names.filter((n) => n.includes("suma-partial"))).toEqual([]);
  });

  it("refuses a missing local file without touching the remote side", async () => {
    const { vfs, root, local } = await rig();
    const result = await uploadFileToVfs(
      vfs,
      path.join(local, "ghost.bin"),
      "/Personal/Downloads",
      "ghost.bin",
    );
    expect(result.ok).toBe(false);
    expect(await fs.readdir(path.join(root, "Personal/Downloads"))).toEqual([]);
  });
});
