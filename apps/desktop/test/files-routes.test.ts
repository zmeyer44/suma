/**
 * The Files route contract, pinned on the desktop side.
 *
 * FilesClient is the only place the desktop encodes the control plane's
 * `/v1/files` API, and the two halves ship from different streams — so nothing
 * fails at build time when they disagree. They already had: the client posted
 * uploads to `/v1/files`, presigned chunks at `/v1/files/chunks/presign`,
 * deleted by `?path=`, and read manifests from a route that was never served.
 * Every one of those is a runtime 404 or 400, i.e. an upload or a hydration
 * that simply does not work.
 *
 * So this file transcribes the server's routes as LITERAL strings — copied
 * from services/control/src/app.ts, which it deliberately does not import (the
 * desktop must not depend on the service) — and drives every client method
 * against a recording stub to check what it actually puts on the wire. A route
 * that changes on either side breaks a test here rather than a user's upload.
 *
 * Bodies are pinned too, not only paths: every Files write schema on the
 * server is `.strict()`, so an extra or misnamed key is a 400 rather than a
 * silently ignored field.
 */

import { describe, expect, it } from "vitest";
import type { FileEntry, Manifest, Transfer } from "@suma/protocol";
import { FilesClient } from "../src/main/files/files-client";

/**
 * services/control/src/app.ts, `createFilesRoutes`-side registrations, in
 * source order. `:hash` and `:id` are the server's own param names.
 */
const SERVER_ROUTES = [
  "POST /v1/files/manifest", // app.ts: v1.post("/files/manifest", …)
  "POST /v1/files/complete", // app.ts: v1.post("/files/complete", …)
  "GET /v1/files/quota", // app.ts: v1.get("/files/quota", …)
  "GET /v1/files/stat", // app.ts: v1.get("/files/stat", …)
  "POST /v1/files/chunks/:hash/upload-url", // app.ts: v1.post("/files/chunks/:hash/upload-url", …)
  "GET /v1/files/chunks/:hash/download-url", // app.ts: v1.get("/files/chunks/:hash/download-url", …)
  "GET /v1/files/transfers", // app.ts: v1.get("/files/transfers", …)
  "POST /v1/files/transfers", // app.ts: v1.post("/files/transfers", …)
  "POST /v1/files/transfers/progress", // app.ts — the AGENT's route, never the desktop's
  "POST /v1/files/transfers/:id/progress", // app.ts — device relay of agent events
  "POST /v1/files/transfers/:id/cancel", // app.ts: v1.post("/files/transfers/:id/cancel", …)
  "GET /v1/files", // app.ts: v1.get("/files", …)
  "DELETE /v1/files/:id", // app.ts: v1.delete("/files/:id", …)
  "GET /v1/files/manifest", // app.ts: v1.get("/files/manifest", …) — reads the chunk list back
] as const;

const BASE_URL = "https://control.test";
const FILE_ID = "3f1c0a3e-6f3a-4a5b-9c1d-2e4f6a8b0c2d";
const TRANSFER_ID = "9b2d4e6f-1a3c-4d5e-8f70-a1b2c3d4e5f6";
const HASH = "a".repeat(64);
const FILE_HASH = "b".repeat(64);

const FILE: FileEntry = {
  id: FILE_ID,
  path: "/notes/a.bin",
  sizeBytes: 4,
  fileHash: FILE_HASH,
  contentType: "application/octet-stream",
  createdAtMs: 1,
  updatedAtMs: 2,
};

const MANIFEST: Manifest = {
  fileHash: FILE_HASH,
  totalBytes: 4,
  chunks: [{ hash: HASH, offset: 0, length: 4 }],
};

const TRANSFER: Transfer = {
  id: TRANSFER_ID,
  url: "https://cdn.example.com/big.zip",
  destPath: "/Downloads/big.zip",
  state: "queued",
  receivedBytes: 0,
  totalBytes: 1024,
  originDeviceId: null,
  error: null,
  startedAtMs: 1,
  updatedAtMs: 1,
};

interface Call {
  method: string;
  /** Path with its query string, as sent. */
  path: string;
  /** The route template: query dropped, hashes and ids named. */
  route: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

/**
 * Collapse one request into "METHOD /template", the form SERVER_ROUTES is
 * written in: a 64-hex segment is the server's `:hash`, a UUID is its `:id`.
 */
function routeOf(method: string, path: string): string {
  const template = path
    .split("?")[0]
    ?.split("/")
    .map((segment) => {
      if (/^[0-9a-f]{64}$/.test(segment)) return ":hash";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segment)) {
        return ":id";
      }
      return segment;
    })
    .join("/");
  return `${method} ${template ?? path}`;
}

interface Client {
  client: FilesClient;
  calls: Call[];
}

/** A client whose every request is recorded and answered from `respond`. */
function client(respond: (call: Call) => unknown = () => ({})): Client {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.slice(BASE_URL.length);
    const raw = init?.body;
    const call: Call = {
      method,
      path,
      route: routeOf(method, path),
      query: new URLSearchParams(path.slice(path.indexOf("?") + 1)),
      body: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(respond(call)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    client: new FilesClient({
      baseUrl: () => BASE_URL,
      token: () => Promise.resolve("tok_dev"),
      fetchImpl,
    }),
    calls,
  };
}

describe("FilesClient route contract (services/control /v1/files)", () => {
  it("lists with the server's paging params, inside its per-page ceiling", async () => {
    const { client: files, calls } = client(() => ({ files: [FILE], nextCursor: null }));
    await files.list("/notes/");
    expect(calls.map((call) => call.route)).toEqual(["GET /v1/files"]);
    expect(calls[0]?.query.get("prefix")).toBe("/notes/");
    // filesListQuerySchema caps `limit` at 200 — asking for more is a 400.
    expect(Number(calls[0]?.query.get("limit"))).toBeLessThanOrEqual(200);
  });

  it("follows the keyset cursor instead of asking for one huge page", async () => {
    let page = 0;
    const { client: files, calls } = client(() => ({
      files: [FILE],
      nextCursor: page++ === 0 ? "/notes/a.bin" : null,
    }));
    const entries = await files.list("/notes/");
    expect(entries).toHaveLength(2);
    expect(calls.map((call) => call.query.get("cursor"))).toEqual([null, "/notes/a.bin"]);
  });

  it("stats by path", async () => {
    const { client: files, calls } = client(() => ({ file: FILE, complete: true, chunkCount: 1 }));
    await files.stat("/notes/a.bin");
    expect(calls[0]?.route).toBe("GET /v1/files/stat");
    expect(calls[0]?.query.get("path")).toBe("/notes/a.bin");
  });

  it("creates from a manifest at /v1/files/manifest, not /v1/files", async () => {
    const { client: files, calls } = client(() => ({
      file: FILE,
      complete: false,
      missing: [{ hash: HASH, offset: 0, length: 4 }],
    }));
    const created = await files.createFromManifest({
      path: "/notes/a.bin",
      manifest: MANIFEST,
      contentType: "application/octet-stream",
    });
    expect(calls[0]?.route).toBe("POST /v1/files/manifest");
    // createFromManifestSchema is `.strict()`: exactly these keys.
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["contentType", "manifest", "path"]);
    // `missing` arrives as chunk REFS; the upload path needs their hashes.
    expect(created.missing).toEqual([HASH]);
  });

  it("omits contentType rather than sending null to a strict schema", async () => {
    const { client: files, calls } = client(() => ({ file: FILE, complete: false, missing: [] }));
    await files.createFromManifest({ path: "/notes/a.bin", manifest: MANIFEST, contentType: null });
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["manifest", "path"]);
  });

  it("completes an upload by file id, which is what the server accepts", async () => {
    const { client: files, calls } = client(() => ({ file: FILE, complete: true }));
    await files.completeUpload(FILE_ID);
    expect(calls[0]?.route).toBe("POST /v1/files/complete");
    // completeUploadSchema is `.strict()` on { fileId } — a path is a 400.
    expect(calls[0]?.body).toEqual({ fileId: FILE_ID });
  });

  it("deletes by id, resolving the path through stat first", async () => {
    const { client: files, calls } = client(() => ({ file: FILE, complete: true, chunkCount: 1 }));
    await files.remove("/notes/a.bin");
    expect(calls.map((call) => call.route)).toEqual(["GET /v1/files/stat", "DELETE /v1/files/:id"]);
    expect(calls[1]?.path).toBe(`/v1/files/${FILE_ID}`);
  });

  it("does not call the control plane at all for a path that is already gone", async () => {
    const calls: Call[] = [];
    const files = new FilesClient({
      baseUrl: () => BASE_URL,
      token: () => Promise.resolve(null),
      fetchImpl: (input, init) => {
        const path = String(input).slice(BASE_URL.length);
        calls.push({
          method: init?.method ?? "GET",
          path,
          route: routeOf(init?.method ?? "GET", path),
          query: new URLSearchParams(),
          body: null,
        });
        return Promise.resolve(new Response("", { status: 404 }));
      },
    });
    await files.remove("/notes/gone.bin");
    expect(calls.map((call) => call.route)).toEqual(["GET /v1/files/stat"]);
  });

  it("presigns one chunk at a time, per the server's per-hash routes", async () => {
    const { client: files, calls } = client((call) => ({
      hash: HASH,
      alreadyStored: false,
      sizeBytes: 4,
      upload: { url: "https://r2.test/put", method: "PUT", expiresAtMs: 0 },
      download: { url: "https://r2.test/get", method: "GET", expiresAtMs: 0 },
      route: call.route,
    }));
    const uploads = await files.presignChunkUploads([HASH]);
    const downloads = await files.presignChunkDownloads([HASH]);
    expect(calls.map((call) => call.route)).toEqual([
      "POST /v1/files/chunks/:hash/upload-url",
      "GET /v1/files/chunks/:hash/download-url",
    ]);
    expect(calls[0]?.path).toBe(`/v1/files/chunks/${HASH}/upload-url`);
    expect(uploads.get(HASH)).toBe("https://r2.test/put");
    expect(downloads.get(HASH)).toBe("https://r2.test/get");
  });

  it("skips a presigned PUT for a chunk the store already holds", async () => {
    const { client: files } = client(() => ({ hash: HASH, alreadyStored: true, sizeBytes: 4 }));
    expect((await files.presignChunkUploads([HASH])).size).toBe(0);
  });

  it("reads the quota meter", async () => {
    const { client: files, calls } = client(() => ({ usedBytes: 1, limitBytes: 2 }));
    expect(await files.quota()).toEqual({ usedBytes: 1, limitBytes: 2 });
    expect(calls[0]?.route).toBe("GET /v1/files/quota");
  });

  it("creates, lists, and cancels transfers on the transfer routes", async () => {
    const { client: files, calls } = client(() => ({
      transfer: TRANSFER,
      transfers: [TRANSFER],
    }));
    await files.createTransfer(
      TRANSFER.url,
      TRANSFER.destPath,
      TRANSFER.totalBytes,
    );
    await files.reportTransfer(TRANSFER_ID, {
      state: "fetching",
      receivedBytes: 1,
    });
    await files.listTransfers();
    await files.cancelTransfer(TRANSFER_ID);
    expect(calls.map((call) => call.route)).toEqual([
      "POST /v1/files/transfers",
      "POST /v1/files/transfers/:id/progress",
      "GET /v1/files/transfers",
      "POST /v1/files/transfers/:id/cancel",
    ]);
    // createTransferSchema is `.strict()` and has no field that could carry a
    // cookie, a header, or a certificate — §8.6, enforced on both sides.
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual([
      "destPath",
      "totalBytes",
      "url",
    ]);
    expect(calls[1]?.body).toEqual({ state: "fetching", receivedBytes: 1 });
    expect(calls[3]?.path).toBe(`/v1/files/transfers/${TRANSFER_ID}/cancel`);
  });

  it("never calls a route the control plane does not serve", async () => {
    const { client: files, calls } = client((call) => ({
      files: [FILE],
      nextCursor: null,
      file: FILE,
      complete: true,
      chunkCount: 1,
      missing: [],
      usedBytes: 1,
      limitBytes: 2,
      transfer: TRANSFER,
      transfers: [TRANSFER],
      hash: HASH,
      alreadyStored: false,
      sizeBytes: 4,
      upload: { url: "https://r2.test/put", method: "PUT", expiresAtMs: 0 },
      download: { url: "https://r2.test/get", method: "GET", expiresAtMs: 0 },
      route: call.route,
    }));

    await files.list("/");
    await files.stat("/notes/a.bin");
    await files.createFromManifest({ path: "/notes/a.bin", manifest: MANIFEST, contentType: null });
    await files.completeUpload(FILE_ID);
    await files.presignChunkUploads([HASH]);
    await files.presignChunkDownloads([HASH]);
    await files.quota();
    await files.remove("/notes/a.bin");
    await files.createTransfer(TRANSFER.url, TRANSFER.destPath);
    await files.reportTransfer(TRANSFER_ID, {
      state: "fetching",
      receivedBytes: 1,
    });
    await files.listTransfers();
    await files.cancelTransfer(TRANSFER_ID);
    await files.manifest("/notes/a.bin");

    const served = new Set<string>(SERVER_ROUTES);
    const used = [...new Set(calls.map((call) => call.route))];
    expect(used.filter((route) => !served.has(route))).toEqual([]);
  });

  it("reads a stored file's chunk list from the route that serves it", async () => {
    // Preview and hydration both need the chunk list; a path with no file
    // behind it stays null so the page says "no longer in Files" rather than
    // showing an error.
    const present = client(() => ({ manifest: MANIFEST }));
    expect(await present.client.manifest("/notes/a.bin")).toEqual(MANIFEST);
    expect(present.calls.map((call) => call.route)).toEqual(["GET /v1/files/manifest"]);

    const absent = new FilesClient({
      baseUrl: () => BASE_URL,
      token: () => Promise.resolve(null),
      fetchImpl: () => Promise.resolve(new Response("", { status: 404 })),
    });
    expect(await absent.manifest("/notes/gone.bin")).toBeNull();
  });
});
