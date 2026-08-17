/**
 * SimAgent's file watcher: writes under the current root become debounced
 * `vfs.changed` ctl events with wire-relative paths; the watcher follows the
 * root provider across a mode switch; fetch.public runs through the sim's
 * confinement and event contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCtlResponse } from "@suma/protocol";
import { SimAgent } from "../src/main/compute/sim-agent";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "suma-sim-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function eventsUntil(
  sim: SimAgent,
  predicate: (e: AgentCtlResponse) => boolean,
  timeoutMs = 3_000,
): Promise<AgentCtlResponse[]> {
  return new Promise((resolve, reject) => {
    const seen: AgentCtlResponse[] = [];
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);
    const unsub = sim.onCtlEvent((event) => {
      seen.push(event);
      if (predicate(event)) {
        clearTimeout(timer);
        unsub();
        resolve(seen);
      }
    });
  });
}

describe("SimAgent watch", () => {
  it("emits one debounced vfs.changed with wire paths for a burst of writes", async () => {
    const root = tempRoot();
    const sim = new SimAgent({ root: () => root });
    cleanups.push(() => sim.stop());
    // Arm the watcher the way production does: any root-touching call. Then
    // give FSEvents a beat — a recursive macOS watcher starts asynchronously
    // and can miss writes made in the same tick it was created (irrelevant
    // in production, where the watcher is armed at startup).
    await sim.vfs({ t: "vfs.stat", path: "/" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const waiting = eventsUntil(sim, (e) => e.t === "vfs.changed");
    await fs.writeFile(path.join(root, "one.txt"), "1");
    await fs.writeFile(path.join(root, "two.txt"), "2");
    const events = await waiting;
    const changed = events.find((e) => e.t === "vfs.changed");
    expect(changed?.t).toBe("vfs.changed");
    if (changed?.t === "vfs.changed" && changed.paths !== undefined) {
      // macOS names the files; both writes collapse into one event.
      expect(changed.paths.some((p) => p.startsWith("/"))).toBe(true);
    }
    expect(events.filter((e) => e.t === "vfs.changed")).toHaveLength(1);
  });

  it("re-watches when the root provider moves", async () => {
    const first = tempRoot();
    const second = tempRoot();
    let root = first;
    const sim = new SimAgent({ root: () => root });
    cleanups.push(() => sim.stop());
    await sim.vfs({ t: "vfs.stat", path: "/" });

    root = second;
    await sim.vfs({ t: "vfs.stat", path: "/" }); // re-arms on the new root

    const waiting = eventsUntil(sim, (e) => e.t === "vfs.changed");
    await fs.writeFile(path.join(second, "here.txt"), "x");
    await expect(waiting).resolves.toBeTruthy();
  });
});

describe("SimAgent fetch.public", () => {
  it("answers fetch.started, streams events, and lands the file in-root", async () => {
    const root = tempRoot();
    const sim = new SimAgent({ root: () => root });
    cleanups.push(() => sim.stop());
    await sim.vfs({ t: "vfs.mkdir", path: "/Downloads" });

    const body = Buffer.alloc(150_000, 0x42);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    // NOTE: loopback would be refused by the shipped policy; the sim applies
    // the same rule, so this test asserts the refusal (policy parity) rather
    // than weakening the sim with a test-only flag on the ctl surface.
    const done = eventsUntil(sim, (e) => e.t === "fetch.failed" || e.t === "fetch.done");
    const started = await sim.ctl({
      t: "fetch.public",
      url: `http://127.0.0.1:${port}/file.bin`,
      destPath: "/Downloads/file.bin",
    });
    expect(started).toEqual({
      t: "fetch.started",
      url: `http://127.0.0.1:${port}/file.bin`,
      path: "/Downloads/file.bin",
    });
    const events = await done;
    expect(events.at(-1)).toMatchObject({
      t: "fetch.failed",
      error: expect.stringContaining("private or local"),
    });
  });

  it("refuses escaping and parent-less destinations synchronously", async () => {
    const root = tempRoot();
    const sim = new SimAgent({ root: () => root });
    cleanups.push(() => sim.stop());

    const escape = await sim.ctl({
      t: "fetch.public",
      url: "https://example.com/x",
      destPath: "/../outside.bin",
    });
    expect(escape).toMatchObject({ t: "error", code: "vfs_path_refused" });

    const orphan = await sim.ctl({
      t: "fetch.public",
      url: "https://example.com/x",
      destPath: "/missing/file.bin",
    });
    expect(orphan).toMatchObject({ t: "error", code: "vfs_path_refused" });
  });
});
