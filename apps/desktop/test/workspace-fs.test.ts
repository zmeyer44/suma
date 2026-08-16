/**
 * The IDE's workspace filesystem (suma://terminal), now served over the
 * agent link's vfs channel: the path guard that keeps renderer-supplied
 * paths inside the workspace, the tree the explorer renders, and the
 * read-classification ladder — all against a SimAgent on a temp root, the
 * same link shape production uses.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimAgent } from "../src/main/compute/sim-agent";
import { WorkspaceFsService } from "../src/main/workspace-fs";

let root: string;
let service: WorkspaceFsService;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "suma-workspace-"));
  service = new WorkspaceFsService();
  service.bind(new SimAgent({ root: () => root }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("path guard", () => {
  it("refuses absolute paths", async () => {
    await expect(service.read("/etc/passwd")).rejects.toThrow(/absolute/);
    await expect(service.write("/etc/x", "")).rejects.toThrow(/absolute/);
  });

  it("refuses ..-escapes", async () => {
    await expect(service.read("../outside")).rejects.toThrow(/escapes/);
    await expect(service.write("src/../../outside", "")).rejects.toThrow(
      /escapes/,
    );
  });

  it("refuses a sibling directory sharing the root as a prefix", async () => {
    // /tmp/suma-workspace-x must not authorize /tmp/suma-workspace-x-evil.
    await expect(
      service.read(`../${path.basename(root)}-evil/f`),
    ).rejects.toThrow(/escapes/);
  });

  it("throws before it is bound to a link", async () => {
    await expect(new WorkspaceFsService().tree()).rejects.toThrow(
      /not connected/,
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

  it("scopes to a workspace folder and creates it on first visit", async () => {
    service.bind(new SimAgent({ root: () => root }), () => "Personal");
    const first = await service.tree();
    expect(first.paths).toEqual([]);
    expect(first.root).toBe(`${root}/Personal`);

    await service.write("hello.txt", "hi");
    const after = await service.tree();
    expect(after.paths).toEqual(["hello.txt"]);
    // The file landed inside the scope folder, not at the shared root.
    expect((await service.read("hello.txt")).kind).toBe("text");
    const unscoped = new WorkspaceFsService();
    unscoped.bind(new SimAgent({ root: () => root }));
    expect((await unscoped.tree()).paths).toEqual(["Personal/hello.txt"]);
  });

  it("never lets a normalized dot target mutate the scoped workspace root", async () => {
    service.bind(new SimAgent({ root: () => root }), () => "Personal");
    await service.tree();
    await service.write("keep.txt", "precious");

    await expect(service.remove(".", true)).rejects.toThrow(/workspace root/);
    await expect(service.rename(".", "moved")).rejects.toThrow(
      /workspace root/,
    );
    await expect(service.rename("keep.txt", ".")).rejects.toThrow(
      /workspace root/,
    );

    expect(await service.read("keep.txt")).toEqual({
      path: "keep.txt",
      kind: "text",
      contents: "precious",
    });
  });
});

/** A 1×1 PNG — real magic bytes, so the sniffer sees what it would on disk. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** ID3v2 header + a frame's worth of filler — what a tagged MP3 opens with. */
const MP3 = Buffer.concat([
  Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"),
  Buffer.alloc(64, 0xaa),
]);

/** RIFF/WAVE header; the payload past it is irrelevant to sniffing. */
const WAV = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WAVEfmt ", "latin1"),
  Buffer.alloc(32),
]);

describe("read/write", () => {
  it("round-trips text through write and read", async () => {
    await writeFile(path.join(root, "a.txt"), "before");
    await service.write("a.txt", "after");
    const file = await service.read("a.txt");
    expect(file).toEqual({ path: "a.txt", kind: "text", contents: "after" });
  });

  it("flags binary files unreadable instead of returning bytes", async () => {
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x89, 0, 0x50]));
    const file = await service.read("blob.bin");
    expect(file).toEqual({
      path: "blob.bin",
      kind: "unreadable",
      reason: "binary",
    });
  });

  it("returns images as a data URL the renderer can show", async () => {
    await writeFile(path.join(root, "shot.png"), PNG);
    const file = await service.read("shot.png");
    expect(file).toEqual({
      path: "shot.png",
      kind: "image",
      mime: "image/png",
      bytes: PNG.byteLength,
      dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
    });
  });

  it("sniffs the image type from bytes, not the extension", async () => {
    // A PNG saved as .txt still renders; a .png that is not one does not.
    await writeFile(path.join(root, "mislabeled.txt"), PNG);
    await writeFile(
      path.join(root, "liar.png"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]),
    );

    expect((await service.read("mislabeled.txt")).kind).toBe("image");
    const liar = await service.read("liar.png");
    expect(liar).toEqual({
      path: "liar.png",
      kind: "unreadable",
      reason: "binary",
    });
  });

  it("does not mistake text starting with BM for a bitmap", async () => {
    await writeFile(path.join(root, "note.md"), "BMW service notes\n");
    const file = await service.read("note.md");
    expect(file.kind).toBe("text");
  });

  it("calls oversized files too-large rather than binary", async () => {
    await writeFile(path.join(root, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const file = await service.read("big.txt");
    expect(file).toEqual({
      path: "big.txt",
      kind: "unreadable",
      reason: "too-large",
    });
  });

  it("returns audio as a stream URL, never as bytes", async () => {
    await writeFile(path.join(root, "song.mp3"), MP3);
    const file = await service.read("song.mp3");
    expect(file).toEqual({
      path: "song.mp3",
      kind: "audio",
      mime: "audio/mpeg",
      bytes: MP3.byteLength,
      url: "suma-workspace://file/song.mp3",
    });
  });

  it("percent-encodes the stream URL so paths with spaces survive", async () => {
    await mkdir(path.join(root, "my music"), { recursive: true });
    await writeFile(path.join(root, "my music/take one.wav"), WAV);
    const file = await service.read("my music/take one.wav");
    expect(file).toMatchObject({
      kind: "audio",
      mime: "audio/wav",
      url: "suma-workspace://file/my%20music%2Ftake%20one.wav",
    });
  });

  it("does not read a huge audio file into memory to identify it", async () => {
    // 12 MiB — past every byte cap in the service. Streaming means the size
    // gates never apply to audio at all.
    const big = Buffer.concat([MP3, Buffer.alloc(12 * 1024 * 1024, 0x11)]);
    await writeFile(path.join(root, "podcast.mp3"), big);
    const file = await service.read("podcast.mp3");
    expect(file).toMatchObject({ kind: "audio", bytes: big.byteLength });
  });

  it("needs the name's agreement for an untagged MP3 frame", async () => {
    // A bare 0xFF sync word is too weak to hand a random binary to a decoder.
    const frame = Buffer.concat([
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      Buffer.alloc(64, 0x55),
    ]);
    await writeFile(path.join(root, "clip.mp3"), frame);
    await writeFile(path.join(root, "clip.dat"), frame);

    expect(await service.read("clip.mp3")).toMatchObject({
      kind: "audio",
      mime: "audio/mpeg",
    });
    expect((await service.read("clip.dat")).kind).toBe("unreadable");
  });

  it("refuses a directory rather than throwing", async () => {
    await mkdir(path.join(root, "adir"), { recursive: true });
    const file = await service.read("adir");
    expect(file).toEqual({
      path: "adir",
      kind: "unreadable",
      reason: "unsupported",
    });
  });

  it("creates, renames, and deletes through the explorer surface", async () => {
    await service.mkdir("newdir");
    await service.write("newdir/f.txt", "x");
    await service.rename("newdir/f.txt", "newdir/g.txt");
    expect((await service.tree()).paths).toEqual(["newdir/g.txt"]);
    await expect(service.remove("newdir", false)).rejects.toThrow(/not empty/);
    await service.remove("newdir", true);
    expect((await service.tree()).paths).toEqual([]);
  });

  it("streams media slices by size and offset", async () => {
    const big = Buffer.concat([MP3, Buffer.alloc(1024, 0x22)]);
    await writeFile(path.join(root, "pod.mp3"), big);
    expect(await service.mediaSize("pod.mp3")).toBe(big.byteLength);
    expect(await service.mediaSize("missing.mp3")).toBeNull();
    const slice = await service.mediaSlice("pod.mp3", 10, 32);
    expect(slice.equals(big.subarray(10, 42))).toBe(true);
  });
});
