/**
 * suma-workspace:// — the URL contract behind IDE audio playback, and the
 * guard that keeps it from becoming a general workspace file reader.
 *
 * The protocol handler itself needs an Electron Session, so what is unit-
 * tested here is everything up to it: the round trip a renderer relies on, and
 * the two refusals the handler makes its decisions from.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nextMediaPage,
  parseWorkspaceMediaUrl,
  workspaceMediaUrl,
} from "../src/main/workspace-media";
import { SimAgent } from "../src/main/compute/sim-agent";
import { WorkspaceFsService } from "../src/main/workspace-fs";
import { sniffAudioMime } from "../src/main/workspace-sniff";

describe("workspaceMediaUrl / parseWorkspaceMediaUrl", () => {
  it("round-trips paths, including spaces, unicode, and #?", () => {
    for (const rel of [
      "song.mp3",
      "my music/take one.wav",
      "sounds/día #1?.flac",
      "a+b&c.ogg",
    ]) {
      expect(parseWorkspaceMediaUrl(workspaceMediaUrl(rel))).toBe(rel);
    }
  });

  it("refuses URLs that are not this scheme's file host", () => {
    expect(parseWorkspaceMediaUrl("suma-video://media/abc")).toBeNull();
    expect(parseWorkspaceMediaUrl("suma-workspace://other/x.mp3")).toBeNull();
    expect(parseWorkspaceMediaUrl("suma-workspace://file/")).toBeNull();
    expect(parseWorkspaceMediaUrl("not a url")).toBeNull();
  });

  it("returns the decoded path even when it escapes — the service refuses", async () => {
    // Parsing is not the guard; it hands the caller exactly what was asked for
    // so the root check is the single place that says no.
    const escape = parseWorkspaceMediaUrl(
      "suma-workspace://file/..%2F..%2Fetc%2Fpasswd",
    );
    expect(escape).toBe("../../etc/passwd");

    const service = new WorkspaceFsService();
    service.bind(new SimAgent({ root: () => "/tmp/some-workspace" }));
    await expect(service.mediaSize(escape ?? "")).rejects.toThrow(/escapes/);
  });
});

describe("nextMediaPage", () => {
  it("pages a range in cap-sized slices with an exact final page", () => {
    // [0, 9] in pages of 4 → 4, 4, 2, done.
    expect(nextMediaPage(0, 9, 4)).toBe(4);
    expect(nextMediaPage(4, 9, 4)).toBe(4);
    expect(nextMediaPage(8, 9, 4)).toBe(2);
    expect(nextMediaPage(10, 9, 4)).toBe(0);
  });

  it("handles a single-byte range and an exact page boundary", () => {
    expect(nextMediaPage(5, 5, 4)).toBe(1);
    // [0, 7] in pages of 4 ends exactly on the boundary.
    expect(nextMediaPage(4, 7, 4)).toBe(4);
    expect(nextMediaPage(8, 7, 4)).toBe(0);
  });
});

describe("the handler's audio-only rule", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "suma-media-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("recognizes each format Chromium can play", async () => {
    const cases: [string, Buffer, string][] = [
      [
        "a.mp3",
        Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"),
        "audio/mpeg",
      ],
      [
        "a.wav",
        Buffer.concat([
          Buffer.from("RIFF", "latin1"),
          Buffer.from([0x24, 0, 0, 0]),
          Buffer.from("WAVE", "latin1"),
        ]),
        "audio/wav",
      ],
      ["a.flac", Buffer.from("fLaC\x00\x00\x00\x22", "latin1"), "audio/flac"],
      ["a.ogg", Buffer.from("OggS\x00\x02\x00\x00", "latin1"), "audio/ogg"],
      [
        "a.m4a",
        Buffer.concat([
          Buffer.from([0, 0, 0, 0x20]),
          Buffer.from("ftypM4A ", "latin1"),
        ]),
        "audio/mp4",
      ],
      ["a.aac", Buffer.from([0xff, 0xf1, 0x50, 0x80]), "audio/aac"],
    ];
    for (const [name, head, mime] of cases) {
      await writeFile(path.join(root, name), head);
      expect(sniffAudioMime(head, name)).toBe(mime);
    }
  });

  it("says no to files that merely live in the workspace", () => {
    // The scheme streams media, not secrets: naming .env in an <audio src>
    // has to come back 415, which is this returning null.
    expect(sniffAudioMime(Buffer.from("SECRET=1\n"), ".env")).toBeNull();
    expect(sniffAudioMime(Buffer.alloc(0), "empty.mp3")).toBeNull();
    // An .mp3 name over a PNG is still not audio.
    expect(
      sniffAudioMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "liar.mp3",
      ),
    ).toBeNull();
  });
});
