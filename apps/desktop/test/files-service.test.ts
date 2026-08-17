/**
 * FilesService: the bounded preview read, the Files page's device context, and
 * upload progress (PRD §8.6).
 *
 * These are the three things the suma://files page cannot do for itself, so
 * they run against a stubbed control plane rather than being mocked away: a
 * preview that quietly hydrates a whole file, a context that carries more than
 * a device label, or progress that reports bytes nobody sent would each be a
 * quiet failure rather than a loud one.
 */

import { describe, expect, it } from "vitest";
// Workspace-relative like files-service.ts: @suma/chunking is not in this
// package's manifest, and the shared implementation must not be duplicated.
import { buildManifest, hashChunk } from "../../../packages/chunking/src/index";
import type {
  AgentCtlRequest,
  AgentCtlResponse,
  FileEntry,
  VfsRequest,
  VfsResponse,
} from "@suma/protocol";
import { FilesClient } from "../src/main/files/files-client";
import { FilesService } from "../src/main/files/files-service";
import type { FilesDevice, UploadProgress } from "../src/shared/ipc";

const HASH_64 = "b".repeat(64);

interface StubRequest {
  url: string;
  method: string;
  /** Parsed JSON body, or null for a bodyless request. */
  body: unknown;
}

interface Route {
  /** Substring of the URL this route answers; first match wins. */
  match: string;
  respond: (req: StubRequest) => Response;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(bytes: Uint8Array): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, { status: 200 });
}

/** The chunk hash in `/v1/files/chunks/<hash>/upload-url` (or download-url). */
function chunkHashIn(url: string): string {
  return url.split("/chunks/")[1]?.split("/")[0] ?? "";
}

/**
 * `POST /v1/files/chunks/<hash>/upload-url` — the real route, one chunk at a
 * time, answering with the presign envelope the control plane returns.
 */
const UPLOAD_URL_ROUTE: Route = {
  match: "/upload-url",
  respond: (req) => {
    const hash = chunkHashIn(req.url);
    return json({
      hash,
      alreadyStored: false,
      sizeBytes: 4,
      upload: { url: `https://r2.test/${hash}`, method: "PUT", expiresAtMs: 0 },
    });
  },
};

/** Serve chunk bytes by the hash in the presigned URL. */
function objectStoreRoute(store: ReadonlyMap<string, Uint8Array>): Route {
  return {
    match: "https://r2.test/",
    respond: (req) => {
      const bytes = store.get(req.url.slice(req.url.lastIndexOf("/") + 1));
      return bytes === undefined ? new Response("missing", { status: 404 }) : bytesResponse(bytes);
    },
  };
}


/** `GET /v1/files/manifest?path=` — the chunk list a stored file is made of. */
function manifestRoute(manifest: unknown): Route {
  return { match: "/v1/files/manifest", respond: () => json({ manifest }) };
}

/** `GET /v1/files/chunks/<hash>/download-url` — presigned read for one chunk. */
function downloadUrlRoute(): Route {
  return {
    match: "/download-url",
    respond: (req) =>
      json({
        hash: chunkHashIn(req.url),
        sizeBytes: 16,
        download: {
          url: `https://r2.test/${chunkHashIn(req.url)}`,
          method: "GET",
          expiresAtMs: 0,
        },
      }),
  };
}

/** `GET /v1/files/stat?path=` — the only route that can say a file exists. */
function statRoute(file: FileEntry | null): Route {
  return {
    match: "/v1/files/stat",
    respond: () =>
      file === null
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : json({ file, complete: true, chunkCount: 2 }),
  };
}

interface Harness {
  service: FilesService;
  /** "METHOD url", in order. */
  requests: string[];
  progress: UploadProgress[];
  changed: Array<{ path: string }>;
}

interface HarnessOptions {
  routes: Route[];
  devices?: () => Promise<FilesDevice[]>;
  identity?: { cloudDeviceId: string | null; name: string | null };
  agent?: FakeAgent;
}

/** Scriptable stand-in for the agent link's ctl surface. */
interface FakeAgent {
  dep: {
    ctl: (request: AgentCtlRequest) => Promise<AgentCtlResponse | null>;
    onCtlEvent: (listener: (event: AgentCtlResponse) => void) => () => void;
    connected: () => boolean;
    vfs: (request: VfsRequest) => Promise<VfsResponse>;
  };
  emit: (event: AgentCtlResponse) => void;
  ctlRequests: AgentCtlRequest[];
  setConnected: (up: boolean) => void;
}

function fakeAgent(
  onCtl?: (
    request: AgentCtlRequest,
  ) => AgentCtlResponse | null | Promise<AgentCtlResponse | null>,
  fileBytes?: Uint8Array,
): FakeAgent {
  const listeners = new Set<(event: AgentCtlResponse) => void>();
  const ctlRequests: AgentCtlRequest[] = [];
  let connected = true;
  return {
    dep: {
      ctl: async (request) => {
        ctlRequests.push(request);
        return (await onCtl?.(request)) ?? null;
      },
      onCtlEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connected: () => connected,
      vfs: async (request) => {
        if (request.t === "vfs.read" && fileBytes !== undefined) {
          const bytes = fileBytes.subarray(
            request.offset,
            request.offset + request.length,
          );
          return {
            t: "vfs.data",
            path: request.path,
            offset: request.offset,
            dataB64: Buffer.from(bytes).toString("base64"),
            eof: request.offset + bytes.byteLength >= fileBytes.byteLength,
          };
        }
        return {
          t: "error",
          code: "vfs_not_found",
          message: "the fake agent has no file bytes",
        };
      },
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    ctlRequests,
    setConnected: (up) => {
      connected = up;
    },
  };
}

/** An agent that accepts every fetch — the happy default. */
function acceptingAgent(fileBytes?: Uint8Array): FakeAgent {
  return fakeAgent(
    (request) =>
      request.t === "fetch.public"
        ? {
            t: "fetch.started",
            fetchId: request.fetchId,
            url: request.url,
            path: request.destPath,
          }
        : null,
    fileBytes,
  );
}

/** Stateful control-plane transfer routes for the fetch-service tests. */
function transferRoutes(): Route[] {
  const transfers = new Map<string, import("@suma/protocol").Transfer>();
  let sequence = 0;
  return [
    {
      match: "/progress",
      respond: (req) => {
        const id = req.url.split("/transfers/")[1]?.split("/")[0] ?? "";
        const current = transfers.get(id);
        if (current === undefined)
          return new Response("missing", { status: 404 });
        const report = req.body as {
          state: import("@suma/protocol").Transfer["state"];
          receivedBytes: number;
          error?: string;
        };
        const updated = {
          ...current,
          state: report.state,
          receivedBytes: report.receivedBytes,
          error: report.error ?? null,
          updatedAtMs: current.updatedAtMs + 1,
        };
        transfers.set(id, updated);
        return json({ transfer: updated });
      },
    },
    {
      match: "/v1/files/transfers",
      respond: (req) => {
        if (req.method === "GET")
          return json({ transfers: [...transfers.values()] });
        const body = req.body as {
          url: string;
          destPath: string;
          totalBytes?: number;
        };
        sequence += 1;
        const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
        const transfer = {
          id,
          url: body.url,
          destPath: body.destPath,
          state: "queued" as const,
          receivedBytes: 0,
          totalBytes: body.totalBytes ?? 0,
          originDeviceId: "dev_local",
          error: null,
          startedAtMs: sequence,
          updatedAtMs: sequence,
        };
        transfers.set(id, transfer);
        return json({ transfer });
      },
    },
  ];
}

function fetchedFileRoutes(data: Uint8Array): Route[] {
  const hash = hashChunk(data);
  const file: FileEntry = {
    id: "10000000-0000-4000-8000-000000000001",
    path: "/Personal/Downloads/big.bin",
    sizeBytes: data.byteLength,
    fileHash: hash,
    contentType: "application/octet-stream",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  return [
    {
      match: "/v1/files/manifest",
      respond: () =>
        json({
          file,
          missing: [{ hash, offset: 0, length: data.byteLength }],
        }),
    },
    UPLOAD_URL_ROUTE,
    {
      match: "https://r2.test/",
      respond: () => json({ ok: true }),
    },
    {
      match: "/v1/files/complete",
      respond: () => json({ file }),
    },
  ];
}

async function waitForTransferState(
  service: FilesService,
  id: string,
  state: import("@suma/protocol").Transfer["state"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      service.snapshot().transfers.find((transfer) => transfer.id === id)
        ?.state === state
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`transfer ${id} did not reach ${state}`);
}

function harness(options: HarnessOptions): Harness {
  const requests: string[] = [];
  const progress: UploadProgress[] = [];
  const changed: Array<{ path: string }> = [];

  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    const raw = init?.body;
    const body: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    for (const route of options.routes) {
      if (url.includes(route.match)) return Promise.resolve(route.respond({ url, method, body }));
    }
    return Promise.resolve(new Response("no stub route", { status: 404 }));
  };

  const service = new FilesService({
    client: new FilesClient({
      baseUrl: () => "https://control.test",
      token: () => Promise.resolve("tok_dev"),
      fetchImpl,
    }),
    agent: (options.agent ?? acceptingAgent()).dep,
    emitTransfers: () => undefined,
    emitChanged: (payload) => changed.push(payload),
    emitUploadProgress: (item) => progress.push(item),
    downloadsDir: () => "/tmp/suma-test-downloads",
    deviceId: "dev_local",
    identity: () => options.identity ?? { cloudDeviceId: null, name: null },
    listDevices: options.devices ?? (() => Promise.resolve([])),
    fetchImpl,
  });

  return { service, requests, progress, changed };
}

/* ------------------------------------------------------------------ *
 * read — bounded preview
 * ------------------------------------------------------------------ */

describe("read and download (§8.6)", () => {
  const stored: FileEntry = {
    id: "3f1c0a3e-6f3a-4a5b-9c1d-2e4f6a8b0c2d",
    path: "/notes/a.bin",
    sizeBytes: 16,
    fileHash: HASH_64,
    contentType: "application/octet-stream",
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  it("says null — not empty — when the file is not there", async () => {
    const { service } = harness({ routes: [statRoute(null)] });
    expect(await service.read("/gone.txt", 1024)).toBeNull();
  });

  /**
   * Preview and hydration both read the file's chunk list back from
   * `GET /v1/files/manifest` and then fetch chunk bytes from a store Suma did
   * not write — so every chunk must hash to the address the manifest names,
   * or the assembled "file" is whatever the store felt like serving.
   */
  it("refuses a manifest whose bytes do not hash to the addresses it names", async () => {
    // The chunk store is the untrusted half of hydration: a wrong-but-plausible
    // chunk must fail the BLAKE3 check rather than reach the user as their file.
    const bytes = new Uint8Array(16).fill(7);
    const wrong = new Uint8Array(16).fill(9);
    const manifest = {
      fileHash: hashChunk(bytes),
      totalBytes: bytes.length,
      chunks: [{ hash: hashChunk(bytes), offset: 0, length: bytes.length }],
    };
    const { service } = harness({
      routes: [
        statRoute(stored),
        manifestRoute(manifest),
        downloadUrlRoute(),
        objectStoreRoute(new Map([[hashChunk(bytes), wrong]])),
      ],
    });
    await expect(service.read("/notes/a.bin", 16)).rejects.toThrow();
  });

  it("refuses a path that escapes the root", async () => {
    const { service } = harness({ routes: [] });
    await expect(service.read("../../etc/passwd", 16)).rejects.toThrow(/invalid file path/);
  });
});

/* ------------------------------------------------------------------ *
 * context — device labels, and nothing else
 * ------------------------------------------------------------------ */

describe("context (§8.6 transfers list)", () => {
  it("names the account's devices and marks this Mac by its control-plane id", async () => {
    const { service } = harness({
      routes: [],
      identity: { cloudDeviceId: "ctl_this", name: "MacBook Pro" },
      devices: () =>
        Promise.resolve([
          { id: "ctl_this", name: "MacBook Pro" },
          { id: "ctl_studio", name: "Mac Studio" },
        ]),
    });
    const context = await service.context();
    expect(context.thisDeviceId).toBe("ctl_this");
    expect(context.devices).toEqual([
      { id: "ctl_this", name: "MacBook Pro" },
      { id: "ctl_studio", name: "Mac Studio" },
      // The local id is here too: a cloud fetch that failed before the control
      // plane ever saw it carries that id, and it still means this Mac.
      { id: "dev_local", name: "MacBook Pro" },
    ]);
    expect(context.cloudRoot).toBe("~/cloud");
    // §8.6: V1 storage is not end-to-end encrypted, and the page says so.
    expect(context.endToEndEncrypted).toBe(false);
  });

  it("carries labels only — nothing credential-shaped can ride along", async () => {
    const { service } = harness({
      routes: [],
      identity: { cloudDeviceId: "ctl_this", name: "MacBook Pro" },
      devices: () => Promise.resolve([{ id: "ctl_this", name: "MacBook Pro" }]),
    });
    const context = await service.context();
    expect(Object.keys(context).sort()).toEqual([
      "cloudRoot",
      "devices",
      "endToEndEncrypted",
      "thisDeviceId",
    ]);
    for (const device of context.devices) expect(Object.keys(device).sort()).toEqual(["id", "name"]);
  });

  it("falls back to the local device id while unenrolled", async () => {
    const { service } = harness({ routes: [] });
    const context = await service.context();
    expect(context.thisDeviceId).toBe("dev_local");
    expect(context.devices).toEqual([]);
  });

  it("still answers when the device list is unreachable", async () => {
    const { service } = harness({
      routes: [],
      identity: { cloudDeviceId: "ctl_this", name: "MacBook Pro" },
      devices: () => Promise.reject(new Error("control plane down")),
    });
    const context = await service.context();
    expect(context.thisDeviceId).toBe("ctl_this");
    expect(context.devices).toEqual([{ id: "dev_local", name: "MacBook Pro" }]);
  });
});

/* ------------------------------------------------------------------ *
 * upload progress
 * ------------------------------------------------------------------ */

describe("agent-driven cloud fetch (fetch.public)", () => {
  const args = {
    url: "https://cdn.example.com/big.bin",
    filename: "big.bin",
    destPath: "/Personal/Downloads/big.bin",
    totalBytes: 100_000_000,
  };

  it("runs queued → fetching → progress → completed off agent events", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const agent = acceptingAgent(data);
    const { service, changed, requests } = harness({
      routes: [...transferRoutes(), ...fetchedFileRoutes(data)],
      agent,
    });
    await expect(
      service.startCloudFetch({ ...args, totalBytes: data.byteLength }),
    ).resolves.toBe(true);
    let row = service.snapshot().transfers.find((t) => t.url === args.url);
    expect(row).toMatchObject({ state: "fetching", cancellable: false });
    if (row === undefined) throw new Error("missing transfer row");
    expect(agent.ctlRequests).toEqual([
      {
        t: "fetch.public",
        fetchId: row.id,
        url: args.url,
        destPath: args.destPath,
      },
    ]);

    agent.emit({
      t: "fetch.progress",
      fetchId: row.id,
      url: args.url,
      received: 2,
      total: data.byteLength,
    });
    agent.emit({
      t: "fetch.done",
      fetchId: row.id,
      url: args.url,
      path: args.destPath,
      bytes: data.byteLength,
      manifest: buildManifest(data),
    });
    await waitForTransferState(service, row.id, "completed");
    row = service.snapshot().transfers.find((t) => t.url === args.url);
    expect(row).toMatchObject({
      state: "completed",
      receivedBytes: data.byteLength,
      cancellable: true,
    });
    expect(
      requests.some((request) => request.includes("/v1/files/manifest")),
    ).toBe(true);
    expect(
      requests.some((request) => request.startsWith("PUT https://r2.test/")),
    ).toBe(true);
    expect(
      requests.some((request) => request.includes("/v1/files/complete")),
    ).toBe(true);
    // Completion nudges the Files surface at the destination directory.
    expect(changed.at(-1)).toEqual({ path: "/Personal/Downloads" });
  });

  it("an agent error settles the row failed and keeps the local download", async () => {
    const agent = fakeAgent(() => ({
      t: "error",
      code: "vfs_path_refused",
      message: "path escapes the Files root",
    }));
    const { service } = harness({ routes: transferRoutes(), agent });
    await expect(service.startCloudFetch(args)).resolves.toBe(false);
    const row = service.snapshot().transfers.find((t) => t.url === args.url);
    expect(row).toMatchObject({ state: "failed" });
    expect(row?.error).toContain("path escapes");
  });

  it("fetch.failed events settle the row with the agent's reason", async () => {
    const agent = acceptingAgent();
    const { service } = harness({ routes: transferRoutes(), agent });
    await service.startCloudFetch(args);
    const started = service
      .snapshot()
      .transfers.find((transfer) => transfer.url === args.url);
    if (started === undefined) throw new Error("missing transfer row");
    agent.emit({
      t: "fetch.failed",
      fetchId: started.id,
      url: args.url,
      path: args.destPath,
      error: "fetch truncated: got 5 of 10 bytes",
    });
    const row = service.snapshot().transfers.find((t) => t.url === args.url);
    expect(row).toMatchObject({ state: "failed", error: "fetch truncated: got 5 of 10 bytes" });
    // A settled agent row can be dismissed locally.
    if (row !== undefined) await service.cancelTransfer(row.id);
    expect(service.snapshot().transfers.some((t) => t.url === args.url)).toBe(false);
  });

  it("cloudAvailable mirrors the agent link, not the control plane", () => {
    const agent = acceptingAgent();
    const { service } = harness({ routes: [], agent });
    expect(service.cloudAvailable()).toBe(true);
    agent.setConnected(false);
    expect(service.cloudAvailable()).toBe(false);
  });

  it("correlates simultaneous fetches of the same URL by fetchId", async () => {
    const agent = acceptingAgent();
    const { service } = harness({ routes: transferRoutes(), agent });
    await service.startCloudFetch({
      ...args,
      destPath: "/Personal/Downloads/a.bin",
    });
    await service.startCloudFetch({
      ...args,
      destPath: "/Personal/Downloads/b.bin",
    });
    const rows = service
      .snapshot()
      .transfers.filter((transfer) => transfer.url === args.url);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first === undefined || second === undefined)
      throw new Error("missing transfer rows");

    agent.emit({
      t: "fetch.failed",
      fetchId: first.id,
      url: args.url,
      path: first.destPath,
      error: "first failed",
    });
    expect(
      service.snapshot().transfers.find((transfer) => transfer.id === first.id)
        ?.state,
    ).toBe("failed");
    expect(
      service.snapshot().transfers.find((transfer) => transfer.id === second.id)
        ?.state,
    ).toBe("fetching");
  });
});

describe("upload progress", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const stored = {
    id: "file_1",
    path: "/n/a.bin",
    sizeBytes: 4,
    fileHash: HASH_64,
    contentType: "application/octet-stream",
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  /**
   * The real upload path: `POST /v1/files/manifest` answers with the chunk
   * REFS it still needs (not bare hashes), each of which is presigned by its
   * own `POST /v1/files/chunks/<hash>/upload-url`, and `POST /v1/files/complete`
   * takes the file id the manifest write returned.
   */
  function uploadRoutes(
    missing: (hashes: string[]) => string[],
    uploadUrlRoute: Route = UPLOAD_URL_ROUTE,
  ): Route[] {
    return [
      { match: "/v1/files/complete", respond: () => json({ file: stored, complete: true }) },
      uploadUrlRoute,
      { match: "https://r2.test/", respond: () => new Response("", { status: 200 }) },
      {
        match: "/v1/files/manifest",
        respond: (req) => {
          const manifest = (
            req.body as { manifest?: { chunks?: Array<{ hash: string; offset: number; length: number }> } } | null
          )?.manifest;
          const chunks = manifest?.chunks ?? [];
          const needed = new Set(missing(chunks.map((chunk) => chunk.hash)));
          return json({
            file: stored,
            complete: false,
            missing: chunks.filter((chunk) => needed.has(chunk.hash)),
          });
        },
      },
    ];
  }

  it("reports hashing, then bytes, then completion — correlated by upload id", async () => {
    const { service, progress, changed } = harness({ routes: uploadRoutes((hashes) => hashes) });
    await service.upload({ path: "/n/a.bin", contentType: null, data, uploadId: "up_1" });
    expect(progress.map((item) => [item.state, item.sentBytes])).toEqual([
      ["hashing", 0],
      ["uploading", 0],
      ["uploading", 4],
      ["completed", 4],
    ]);
    expect(progress.every((item) => item.uploadId === "up_1" && item.totalBytes === 4)).toBe(true);
    expect(progress[0]?.path).toBe("/n/a.bin");
    expect(changed).toEqual([{ path: "/n" }]);
  });

  it("counts deduplicated chunks as progress the user never waits for", async () => {
    // The store already holds every chunk: nothing is uploaded, and the meter
    // still reaches 100% instead of sitting at zero (§7 dedup).
    const { service, progress, requests } = harness({ routes: uploadRoutes(() => []) });
    await service.upload({ path: "/n/a.bin", contentType: null, data, uploadId: "up_2" });
    expect(progress.map((item) => [item.state, item.sentBytes])).toEqual([
      ["hashing", 0],
      ["uploading", 4],
      ["completed", 4],
    ]);
    expect(requests.filter((line) => line.includes("r2.test"))).toEqual([]);
  });

  it("treats a chunk the store took meanwhile as progress, not as an error", async () => {
    // `alreadyStored` is the control plane saying the bytes are already there:
    // there is nothing to PUT, and the meter must still reach 100%.
    const { service, progress, requests } = harness({
      routes: uploadRoutes(
        (hashes) => hashes,
        {
          match: "/upload-url",
          respond: (req) => json({ hash: chunkHashIn(req.url), alreadyStored: true, sizeBytes: 4 }),
        },
      ),
    });
    await service.upload({ path: "/n/a.bin", contentType: null, data, uploadId: "up_4" });
    expect(progress.map((item) => [item.state, item.sentBytes])).toEqual([
      ["hashing", 0],
      ["uploading", 0],
      ["uploading", 4],
      ["completed", 4],
    ]);
    expect(requests.filter((line) => line.includes("r2.test"))).toEqual([]);
  });

  it("reports the failure instead of leaving the bar mid-flight", async () => {
    const { service, progress } = harness({
      routes: [
        {
          match: "/v1/files",
          respond: () => new Response(JSON.stringify({ error: "over quota" }), { status: 413 }),
        },
      ],
    });
    await expect(
      service.upload({ path: "/n/a.bin", contentType: null, data, uploadId: "up_3" }),
    ).rejects.toThrow();
    expect(progress.map((item) => item.state)).toEqual(["hashing", "failed"]);
    expect(progress[1]?.error).toMatch(/quota/i);
  });

  it("emits nothing when the caller sent no correlation id", async () => {
    const { service, progress } = harness({ routes: uploadRoutes(() => []) });
    await service.upload({ path: "/n/a.bin", contentType: null, data });
    expect(progress).toEqual([]);
  });
});
