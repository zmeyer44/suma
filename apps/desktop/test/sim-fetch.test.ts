/**
 * The simulator's fetch.public: same policy as agent/src/fetch.rs — target
 * refusals, manual redirects with per-hop re-checks, Content-Length
 * required, cap enforcement with partial cleanup — over Node's fetch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCtlResponse } from "@suma/protocol";
import {
  checkTarget,
  ipIsPrivate,
  resolveRedirect,
  simFetchPublic,
} from "../src/main/compute/sim-fetch";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "suma-sim-fetch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function serve(
  handler: http.RequestListener,
): Promise<{ port: number; url: (p: string) => string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => server.close());
  return { port, url: (p) => `http://127.0.0.1:${port}${p}` };
}

/** Collects events; resolves when the terminal event lands. */
function collector(): {
  emit: (e: AgentCtlResponse) => void;
  finished: Promise<AgentCtlResponse[]>;
} {
  const events: AgentCtlResponse[] = [];
  let done: (events: AgentCtlResponse[]) => void;
  const finished = new Promise<AgentCtlResponse[]>((resolve) => {
    done = resolve;
  });
  return {
    emit: (e) => {
      events.push(e);
      if (e.t === "fetch.done" || e.t === "fetch.failed") done(events);
    },
    finished,
  };
}

describe("simFetchPublic", () => {
  it("downloads with monotonic progress and a terminal done", async () => {
    const body = Buffer.alloc(200_000, 0x5a);
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const dest = path.join(tempDir(), "file.bin");
    const { emit, finished } = collector();
    await simFetchPublic({
      url: url("/file.bin"),
      destTarget: dest,
      destWirePath: "/Downloads/file.bin",
      emit,
      allowPrivate: true,
    });
    const events = await finished;
    const last = events.at(-1);
    expect(last).toEqual({
      t: "fetch.done",
      url: url("/file.bin"),
      path: "/Downloads/file.bin",
      bytes: body.length,
    });
    const progress = events.filter((e) => e.t === "fetch.progress");
    expect(progress.length).toBeGreaterThan(0);
    let previous = 0;
    for (const p of progress) {
      if (p.t !== "fetch.progress") continue;
      expect(p.received).toBeGreaterThanOrEqual(previous);
      expect(p.total).toBe(body.length);
      previous = p.received;
    }
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
  });

  it("follows one redirect hop and lands the real body", async () => {
    const body = Buffer.from("redirected payload");
    const target = await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const hop = await serve((_req, res) => {
      res.writeHead(302, { location: target.url("/real.bin") });
      res.end();
    });
    const dest = path.join(tempDir(), "file.bin");
    const { emit, finished } = collector();
    await simFetchPublic({
      url: hop.url("/start"),
      destTarget: dest,
      destWirePath: "/Downloads/file.bin",
      emit,
      allowPrivate: true,
    });
    const events = await finished;
    expect(events.at(-1)?.t).toBe("fetch.done");
    expect((await fs.readFile(dest)).equals(body)).toBe(true);
  });

  it("refuses endless redirects, missing Content-Length, and oversize bodies", async () => {
    const loop = await serve((_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    });
    const dest1 = path.join(tempDir(), "a");
    const c1 = collector();
    await simFetchPublic({
      url: loop.url("/loop"),
      destTarget: dest1,
      destWirePath: "/a",
      emit: c1.emit,
      allowPrivate: true,
    });
    const loopEvents = await c1.finished;
    expect(loopEvents.at(-1)).toMatchObject({
      t: "fetch.failed",
      error: expect.stringContaining("redirects"),
    });

    const chunked = await serve((_req, res) => {
      res.writeHead(200); // no content-length ⇒ chunked
      res.end("data");
    });
    const c2 = collector();
    await simFetchPublic({
      url: chunked.url("/x"),
      destTarget: path.join(tempDir(), "b"),
      destWirePath: "/b",
      emit: c2.emit,
      allowPrivate: true,
    });
    expect((await c2.finished).at(-1)).toMatchObject({
      t: "fetch.failed",
      error: expect.stringContaining("Content-Length"),
    });

    // A declared size past the cap is refused before a byte is written.
    // (Unlike the raw Rust fetcher, undici itself truncates a body at the
    // declared Content-Length, so "lies small, streams big" cannot reach the
    // sim's own byte-cap check — the declared check is the enforceable one.)
    const big = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "4096" });
      res.end(Buffer.alloc(4096, 1));
    });
    const dest3 = path.join(tempDir(), "c");
    const c3 = collector();
    await simFetchPublic({
      url: big.url("/big"),
      destTarget: dest3,
      destWirePath: "/c",
      emit: c3.emit,
      allowPrivate: true,
      maxBytes: 1024,
    });
    expect((await c3.finished).at(-1)).toMatchObject({
      t: "fetch.failed",
      error: expect.stringContaining("exceeds"),
    });
    await expect(fs.stat(dest3)).rejects.toThrow();
  });
});

describe("target policy", () => {
  it("refuses private, loopback, metadata, and no-dot hosts", async () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "localhost",
      "web.localhost",
      "nas", // bare no-dot mDNS-ish name
    ]) {
      await expect(checkTarget(host, {}), host).rejects.toThrow(/private or local/);
    }
  });

  it("refuses a public name whose DNS answers include a private address", async () => {
    const lookup = async () => [
      { address: "93.184.216.34" },
      { address: "10.0.0.5" },
    ];
    await expect(checkTarget("evil.example.com", { lookup })).rejects.toThrow(
      /permitted public address/,
    );
    const cleanLookup = async () => [{ address: "93.184.216.34" }];
    await expect(
      checkTarget("fine.example.com", { lookup: cleanLookup }),
    ).resolves.toBeUndefined();
  });

  it("classifies addresses like the agent", () => {
    expect(ipIsPrivate("8.8.8.8")).toBe(false);
    expect(ipIsPrivate("2606:4700::1111")).toBe(false);
    expect(ipIsPrivate("::ffff:10.0.0.1")).toBe(true);
    expect(ipIsPrivate("100.127.255.255")).toBe(true);
    expect(ipIsPrivate("100.128.0.1")).toBe(false); // past CGNAT range
  });

  it("redirect resolution mirrors the agent's strictness", () => {
    const from = new URL("https://cdn.example.com/start");
    expect(resolveRedirect(from, "/next?sig=1").toString()).toBe(
      "https://cdn.example.com/next?sig=1",
    );
    expect(resolveRedirect(from, "https://other.example.com/x").hostname).toBe(
      "other.example.com",
    );
    expect(() => resolveRedirect(from, "http://cdn.example.com/x")).toThrow(/downgrade/);
    expect(() => resolveRedirect(from, "//evil.example.com/x")).toThrow();
    expect(() => resolveRedirect(from, "relative/path")).toThrow();
    // http may upgrade.
    const plain = new URL("http://example.com/a");
    expect(resolveRedirect(plain, "https://example.com/b").protocol).toBe("https:");
  });
});
