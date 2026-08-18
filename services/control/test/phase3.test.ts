import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLOUD_FETCH_MIN_BYTES,
  PRO_QUOTA_BYTES,
  TERMINAL_CAPABILITIES,
  fileEntrySchema,
  generateTokenKeypair,
  transferSchema,
  type Capability,
  type Manifest,
} from "@suma/protocol";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { createSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";
import {
  R2ObjectStore,
  StubObjectStore,
  objectStoreFromEnv,
} from "../src/providers/object-store.js";
import {
  MAX_CHUNK_BYTES,
  MAX_MANIFEST_CHUNKS,
  canTransferTransition,
  chunkObjectKey,
  distinctChunks,
  missingChunkRefs,
  newBytes,
  normalizeFilePath,
  normalizePrefix,
  validateManifest,
} from "../src/files.js";
import { transferReportRefusal } from "../src/capabilities.js";
import { ABUSE_LIMITS } from "../src/abuse.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let signing: SigningKeys;
let objects: StubObjectStore;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const pair = await generateTokenKeypair();
  signing = await createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
  objects = new StubObjectStore();
  app = createApp(db, new StubSandboxProvider(), signing, undefined, objects);
});

function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function authedInit(token: string, method = "GET"): RequestInit {
  return { method, headers: { authorization: `Bearer ${token}` } };
}

let emailCounter = 0;

interface Account {
  userId: string;
  token: string;
}

/** A signed-up account with the §8.6 Files/cloud-fetch plan features enabled. */
async function signup(): Promise<Account> {
  const email = `phase3-${emailCounter++}@example.com`;
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const body = await res.json();
  await db
    .update(schema.users)
    .set({ features: ["files", "cloud-fetch"] })
    .where(eq(schema.users.id, body.user.id));
  return { userId: body.user.id, token: `hbr_dev_${body.user.id}` };
}

async function mintCap(token: string, caps: ReadonlyArray<Capability>): Promise<string> {
  const res = await app.request("/v1/machine/capability-token", jsonInit("POST", { caps }, token));
  expect(res.status).toBe(201);
  return (await res.json()).token;
}

/**
 * A deterministic 64-hex stand-in for a BLAKE3 chunk address. The control
 * plane never rehashes chunk bytes — it records what the client computed with
 * `packages/chunking` — so the tests only need distinct, well-formed hashes.
 */
const hashFor = (label: string): string =>
  [...label]
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

interface ChunkSpec {
  label: string;
  length: number;
}

function manifestOf(fileLabel: string, specs: ReadonlyArray<ChunkSpec>): Manifest {
  let offset = 0;
  const chunks = specs.map((spec) => {
    const chunk = { hash: hashFor(spec.label), offset, length: spec.length };
    offset += spec.length;
    return chunk;
  });
  return { fileHash: hashFor(fileLabel), totalBytes: offset, chunks };
}

async function postManifest(
  token: string,
  path: string,
  manifest: Manifest,
  contentType?: string,
): Promise<Response> {
  return app.request(
    "/v1/files/manifest",
    jsonInit("POST", { path, manifest, ...(contentType ? { contentType } : {}) }, token),
  );
}

interface MissingChunk {
  hash: string;
  offset: number;
  length: number;
}

/** Walk the full upload path: manifest → presigned PUT → bytes → complete. */
async function uploadFile(
  account: Account,
  path: string,
  manifest: Manifest,
): Promise<{ fileId: string; missing: MissingChunk[] }> {
  const created = await postManifest(account.token, path, manifest);
  expect([200, 201]).toContain(created.status);
  const body = await created.json();
  const missing: MissingChunk[] = body.missing;
  for (const chunk of missing) {
    const presign = await app.request(
      `/v1/files/chunks/${chunk.hash}/upload-url`,
      authedInit(account.token, "POST"),
    );
    expect(presign.status).toBe(200);
    const presigned = await presign.json();
    expect(presigned.alreadyStored).toBe(false);
    expect(presigned.upload.method).toBe("PUT");
    // The client would PUT to `presigned.upload.url`; the stub store is the
    // other side of that URL.
    await objects.put(chunkObjectKey(account.userId, chunk.hash), new Uint8Array(chunk.length));
  }
  const completed = await app.request(
    "/v1/files/complete",
    jsonInit("POST", { fileId: body.file.id }, account.token),
  );
  expect(completed.status).toBe(200);
  expect((await completed.json()).complete).toBe(true);
  return { fileId: body.file.id, missing };
}

async function chunkRows(userId: string) {
  return db.select().from(schema.chunks).where(eq(schema.chunks.userId, userId));
}

async function quota(token: string): Promise<{ usedBytes: number; limitBytes: number; softBlocked: boolean }> {
  const res = await app.request("/v1/files/quota", authedInit(token));
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Fill an account's quota until only `headroomBytes` are left. Chunk rows are
 * the accounting unit, so the fixture inflates their recorded sizes rather
 * than storing 100 GB; `size_bytes` is an int4, hence the batching.
 */
async function fillQuota(userId: string, headroomBytes: number): Promise<void> {
  const rows = [];
  let remaining = PRO_QUOTA_BYTES - headroomBytes;
  for (let i = 0; remaining > 0; i++) {
    const sizeBytes = Math.min(remaining, 2_000_000_000);
    rows.push({ userId, hash: hashFor(`fill-${i}`), sizeBytes, refCount: 1 });
    remaining -= sizeBytes;
  }
  await db.insert(schema.chunks).values(rows);
}

async function auditTypes(token: string): Promise<string[]> {
  const res = await app.request("/v1/audit?limit=200", authedInit(token));
  expect(res.status).toBe(200);
  return (await res.json()).events.map((e: { type: string }) => e.type);
}

const BIG_URL = "https://releases.example.com/datasets/imagenet.tar";
const BIG_BYTES = 200 * 1024 * 1024;

async function createTransfer(
  token: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.request(
    "/v1/files/transfers",
    jsonInit("POST", { url: BIG_URL, destPath: "/datasets/imagenet.tar", totalBytes: BIG_BYTES, ...body }, token),
  );
}

async function progress(cap: string, body: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/files/transfers/progress", jsonInit("POST", body, cap));
}

async function deviceProgress(
  token: string,
  transferId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/v1/files/transfers/${transferId}/progress`,
    jsonInit("POST", body, token),
  );
}

/* ------------------------------------------------------------------ *
 * Pure logic
 * ------------------------------------------------------------------ */

describe("files pure logic (§8.6)", () => {
  it("normalizeFilePath refuses traversal, the root, and control characters", () => {
    expect(normalizeFilePath("/docs/./notes.txt")).toEqual({ ok: true, path: "/docs/notes.txt" });
    expect(normalizeFilePath("docs//a/b.txt")).toEqual({ ok: true, path: "/docs/a/b.txt" });
    expect(normalizeFilePath("/docs/sub/../notes.txt")).toEqual({
      ok: true,
      path: "/docs/notes.txt",
    });

    for (const escape of ["../etc/passwd", "/../etc/passwd", "/a/../../b", "..", "/a/b/../../.."]) {
      expect(normalizeFilePath(escape), escape).toEqual({ ok: false, reason: "traversal" });
    }
    expect(normalizeFilePath("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeFilePath("/")).toEqual({ ok: false, reason: "is_root" });
    expect(normalizeFilePath("/a/.")).toEqual({ ok: true, path: "/a" });
    expect(normalizeFilePath("/a\u0000b")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeFilePath("/a\nb")).toEqual({ ok: false, reason: "control_characters" });
  });

  it("normalizePrefix admits the root and refuses escapes", () => {
    expect(normalizePrefix("")).toBe("/");
    expect(normalizePrefix("/")).toBe("/");
    expect(normalizePrefix("docs")).toBe("/docs");
    expect(normalizePrefix("../docs")).toBeNull();
    expect(normalizePrefix("/a\u0007")).toBeNull();
  });

  it("validateManifest requires the chunks to tile the file exactly", () => {
    const good = manifestOf("f", [
      { label: "a", length: 100 },
      { label: "b", length: 50 },
    ]);
    expect(validateManifest(good)).toBeNull();
    // A zero-byte file is zero chunks, and that is consistent.
    expect(validateManifest({ fileHash: hashFor("empty"), totalBytes: 0, chunks: [] })).toBeNull();

    expect(validateManifest({ ...good, totalBytes: 151 })).toBe("size_mismatch");
    expect(
      validateManifest({
        ...good,
        chunks: [
          { hash: hashFor("a"), offset: 0, length: 100 },
          { hash: hashFor("b"), offset: 200, length: 50 },
        ],
      }),
    ).toBe("non_contiguous");
    expect(
      validateManifest({
        fileHash: hashFor("f"),
        totalBytes: MAX_CHUNK_BYTES + 1,
        chunks: [{ hash: hashFor("a"), offset: 0, length: MAX_CHUNK_BYTES + 1 }],
      }),
    ).toBe("chunk_too_large");

    const tooMany = Array.from({ length: MAX_MANIFEST_CHUNKS + 1 }, (_, i) => ({
      hash: hashFor(`c${i}`),
      offset: i,
      length: 1,
    }));
    expect(
      validateManifest({ fileHash: hashFor("f"), totalBytes: tooMany.length, chunks: tooMany }),
    ).toBe("too_many_chunks");
  });

  it("missingChunkRefs deduplicates within the manifest, like packages/chunking", () => {
    const repeated = manifestOf("f", [
      { label: "a", length: 10 },
      { label: "b", length: 10 },
      { label: "a", length: 10 },
    ]);
    expect(distinctChunks(repeated).map((c) => c.hash)).toEqual([hashFor("a"), hashFor("b")]);
    expect(missingChunkRefs(repeated, () => false).map((c) => c.hash)).toEqual([
      hashFor("a"),
      hashFor("b"),
    ]);
    expect(newBytes(repeated, () => false)).toBe(20);
    expect(missingChunkRefs(repeated, (h) => h === hashFor("a")).map((c) => c.hash)).toEqual([
      hashFor("b"),
    ]);
    expect(newBytes(repeated, () => true)).toBe(0);
  });

  it("canTransferTransition allows heartbeats and freezes terminal states", () => {
    expect(canTransferTransition("queued", "fetching")).toBe(true);
    expect(canTransferTransition("fetching", "fetching")).toBe(true);
    expect(canTransferTransition("fetching", "storing")).toBe(true);
    expect(canTransferTransition("storing", "completed")).toBe(true);
    expect(canTransferTransition("queued", "completed")).toBe(false);
    expect(canTransferTransition("queued", "storing")).toBe(false);
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      for (const to of ["queued", "fetching", "storing", "completed"] as const) {
        expect(canTransferTransition(terminal, to), `${terminal}→${to}`).toBe(false);
      }
    }
  });

  it("transferReportRefusal requires the fetch.public grant", () => {
    expect(transferReportRefusal(["fetch.public"])).toBeNull();
    expect(transferReportRefusal([...TERMINAL_CAPABILITIES])).toBe(
      "capability token does not grant fetch.public",
    );
    expect(transferReportRefusal([])).toBe("capability token does not grant fetch.public");
  });
});

/* ------------------------------------------------------------------ *
 * Object store
 * ------------------------------------------------------------------ */

describe("object store provider (§7 exit hatch)", () => {
  it("the stub round-trips objects and presigns un-fetchable URLs", async () => {
    const store = new StubObjectStore();
    expect(await store.head("nope")).toBeNull();
    expect(await store.get("nope")).toBeNull();
    await store.put("chunks/u/abc", new Uint8Array([1, 2, 3]), "application/octet-stream");
    expect(await store.head("chunks/u/abc")).toEqual({
      sizeBytes: 3,
      contentType: "application/octet-stream",
    });
    expect([...(await store.get("chunks/u/abc"))!]).toEqual([1, 2, 3]);
    const put = await store.presignPut("chunks/u/abc", 60, 3);
    expect(new URL(put.url).hostname).toBe("object-store.invalid");
    expect(put.method).toBe("PUT");
    expect(put.contentLength).toBe(3);
    expect(put.expiresAtMs).toBeGreaterThan(Date.now());
    await store.delete("chunks/u/abc");
    expect(await store.head("chunks/u/abc")).toBeNull();
  });

  it("the local HTTP store round-trips bytes through its presigned URLs", async () => {
    const { LocalHttpObjectStore } = await import("../src/providers/object-store.js");
    const store = new LocalHttpObjectStore(0);
    try {
      const bytes = new Uint8Array([9, 8, 7, 6]);
      const put = await store.presignPut("chunks/u/local", 60, bytes.length);
      const putRes = await fetch(put.url, { method: "PUT", body: bytes });
      expect(putRes.status).toBe(200);

      const get = await store.presignGet("chunks/u/local", 60);
      const gotten = new Uint8Array(await (await fetch(get.url)).arrayBuffer());
      expect([...gotten]).toEqual([9, 8, 7, 6]);

      // The presigned content-length is a hard cap, like the R2 signature.
      const bounded = await store.presignPut("chunks/u/big", 60, 2);
      expect((await fetch(bounded.url, { method: "PUT", body: bytes })).status).toBe(413);

      // The token is the (dev) signature: without it, nothing is reachable.
      const tokenless = get.url.replace(/token=[^&]+/, "token=wrong");
      expect((await fetch(tokenless)).status).toBe(403);
    } finally {
      await store.close();
    }
  });

  it("fails loudly when R2 credentials are absent, rather than silently no-op", () => {
    expect(() => objectStoreFromEnv({})).toThrow(/R2_ENDPOINT \(or R2_ACCOUNT_ID\)/);
    expect(() => objectStoreFromEnv({ R2_ACCOUNT_ID: "acct" })).toThrow(/R2_BUCKET/);
    expect(() =>
      objectStoreFromEnv({ R2_ACCOUNT_ID: "acct", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k" }),
    ).toThrow(/R2_SECRET_ACCESS_KEY/);
    // The in-memory store exists, but only when it is asked for by name.
    expect(objectStoreFromEnv({ OBJECT_STORE: "stub" })).toBeInstanceOf(StubObjectStore);
    expect(
      objectStoreFromEnv({
        R2_ACCOUNT_ID: "acct",
        R2_BUCKET: "suma",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
      }),
    ).toBeInstanceOf(R2ObjectStore);
  });

  it("presigns an S3-compatible URL with the signature in the query string", async () => {
    const store = new R2ObjectStore({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "suma",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      region: "auto",
    });
    const presigned = await store.presignGet("chunks/user-1/deadbeef", 900);
    const url = new URL(presigned.url);
    expect(url.pathname).toBe("/suma/chunks/user-1/deadbeef");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the content length of a presigned PUT, so an oversized body cannot use it", async () => {
    const store = new R2ObjectStore({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "suma",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      region: "auto",
    });
    const chunkBytes = 4 * 1024 * 1024;
    const put = await store.presignPut("chunks/user-1/deadbeef", 900, chunkBytes);
    const url = new URL(put.url);
    // `content-length` is part of the signature, not a hint: the bucket
    // recomputes it from the header the client actually sends.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(put.contentLength).toBe(chunkBytes);

    // A 5 GB body would need a different signature — which this URL, and the
    // client holding it, cannot produce.
    const oversized = await store.presignPut("chunks/user-1/deadbeef", 900, 5 * 1024 ** 3);
    expect(new URL(oversized.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Manifests, dedup, refCounts
 * ------------------------------------------------------------------ */

describe("files: manifests, dedup and refCounts (§8.6)", () => {
  it("records a manifest, reports the missing chunks, and completes on upload", async () => {
    const account = await signup();
    const manifest = manifestOf("report", [
      { label: "r1", length: 1024 },
      { label: "r2", length: 2048 },
    ]);

    const created = await postManifest(account.token, "docs/report.pdf", manifest, "application/pdf");
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(fileEntrySchema.parse(body.file)).toMatchObject({
      path: "/docs/report.pdf",
      sizeBytes: 3072,
      fileHash: manifest.fileHash,
      contentType: "application/pdf",
    });
    expect(body.complete).toBe(false);
    expect(body.missing.map((c: MissingChunk) => c.hash)).toEqual([hashFor("r1"), hashFor("r2")]);

    // Not complete until the bytes are really there: completing early is a 409
    // naming what is still missing, not a success.
    const early = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, account.token),
    );
    expect(early.status).toBe(409);
    expect((await early.json()).missing).toHaveLength(2);

    // A short object is missing too — the file would never reassemble.
    await objects.put(chunkObjectKey(account.userId, hashFor("r1")), new Uint8Array(10));
    const short = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, account.token),
    );
    expect(short.status).toBe(409);
    expect((await short.json()).missing).toContain(hashFor("r1"));

    await objects.put(chunkObjectKey(account.userId, hashFor("r1")), new Uint8Array(1024));
    await objects.put(chunkObjectKey(account.userId, hashFor("r2")), new Uint8Array(2048));
    const done = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, account.token),
    );
    expect(done.status).toBe(200);
    expect((await done.json()).complete).toBe(true);

    const stat = await app.request(
      `/v1/files/stat?path=${encodeURIComponent("/docs/report.pdf")}`,
      authedInit(account.token),
    );
    expect(stat.status).toBe(200);
    const statBody = await stat.json();
    expect(statBody.complete).toBe(true);
    expect(statBody.chunkCount).toBe(2);
    expect(await auditTypes(account.token)).toContain("files.uploaded");
  });

  it("serves the stored manifest back, in chunk order (read-back for hydration)", async () => {
    const account = await signup();
    // Chunk order matters — labels chosen so hash order ≠ offset order would
    // expose a missing ORDER BY idx.
    const manifest = manifestOf("readback", [
      { label: "zz-first", length: 1024 },
      { label: "aa-second", length: 2048 },
      { label: "mm-third", length: 512 },
    ]);
    await uploadFile(account, "/videos/clip.mp4", manifest);

    const res = await app.request(
      `/v1/files/manifest?path=${encodeURIComponent("/videos/clip.mp4")}`,
      authedInit(account.token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The read-back manifest is byte-identical to what was declared: same
    // hash, same total, same chunks in the same order — what assembleFromChunks
    // needs to reproduce the file.
    expect(body.manifest).toEqual(manifest);
  });

  it("refuses the manifest of an incomplete file with 409, and 404s a missing path", async () => {
    const account = await signup();
    const manifest = manifestOf("half", [{ label: "h1", length: 64 }]);
    // Declared but never completed: the chunk bytes may not be in the store.
    const created = await postManifest(account.token, "/videos/half.mp4", manifest);
    expect(created.status).toBe(201);

    const incomplete = await app.request(
      `/v1/files/manifest?path=${encodeURIComponent("/videos/half.mp4")}`,
      authedInit(account.token),
    );
    expect(incomplete.status).toBe(409);

    const missing = await app.request(
      `/v1/files/manifest?path=${encodeURIComponent("/videos/nope.mp4")}`,
      authedInit(account.token),
    );
    expect(missing.status).toBe(404);
  });

  it("keeps one account's manifest unreadable from another", async () => {
    const owner = await signup();
    const stranger = await signup();
    const manifest = manifestOf("private", [{ label: "p1", length: 128 }]);
    await uploadFile(owner, "/videos/private.mp4", manifest);

    const res = await app.request(
      `/v1/files/manifest?path=${encodeURIComponent("/videos/private.mp4")}`,
      authedInit(stranger.token),
    );
    // The stranger sees "no such file", never "someone else's file exists".
    expect(res.status).toBe(404);
  });

  it("deduplicates: the same content at a second path uploads nothing", async () => {
    const account = await signup();
    const manifest = manifestOf("dataset", [
      { label: "d1", length: 4096 },
      { label: "d2", length: 4096 },
      // A repeated chunk inside one file is stored once.
      { label: "d1", length: 4096 },
    ]);

    const first = await uploadFile(account, "/a/dataset.bin", manifest);
    expect(first.missing.map((c) => c.hash)).toEqual([hashFor("d1"), hashFor("d2")]);
    const afterFirst = await quota(account.token);
    expect(afterFirst.usedBytes).toBe(8192);

    const second = await postManifest(account.token, "/b/dataset.bin", manifest);
    expect(second.status).toBe(201);
    expect((await second.json()).missing).toEqual([]);

    // One chunk set on disk, two files, and the quota did not move.
    const rows = await chunkRows(account.userId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.refCount === 2)).toBe(true);
    expect((await quota(account.token)).usedBytes).toBe(8192);
    expect(objects.keys().filter((k) => k.startsWith(`chunks/${account.userId}/`))).toHaveLength(2);
  });

  it("refCounts survive shared chunks: deleting one file keeps the other whole", async () => {
    const account = await signup();
    const shared = [
      { label: "s1", length: 512 },
      { label: "s2", length: 512 },
    ];
    await uploadFile(account, "/one.bin", manifestOf("one", [...shared, { label: "only-a", length: 256 }]));
    await uploadFile(account, "/two.bin", manifestOf("two", [...shared, { label: "only-b", length: 256 }]));

    const before = await chunkRows(account.userId);
    expect(before).toHaveLength(4);
    expect(before.find((r) => r.hash === hashFor("s1"))?.refCount).toBe(2);
    expect(before.find((r) => r.hash === hashFor("only-a"))?.refCount).toBe(1);
    expect((await quota(account.token)).usedBytes).toBe(512 + 512 + 256 + 256);

    const list = await (await app.request("/v1/files", authedInit(account.token))).json();
    const one = list.files.find((f: { path: string }) => f.path === "/one.bin");
    const deleted = await app.request(`/v1/files/${one.id}`, authedInit(account.token, "DELETE"));
    expect(deleted.status).toBe(200);
    expect(await auditTypes(account.token)).toContain("files.deleted");

    const after = await chunkRows(account.userId);
    expect(after.map((r) => r.hash).sort()).toEqual(
      [hashFor("s1"), hashFor("s2"), hashFor("only-b")].sort(),
    );
    expect(after.find((r) => r.hash === hashFor("s1"))?.refCount).toBe(1);
    // The chunk only the deleted file used left the object store; the shared
    // ones did not.
    expect(objects.has(chunkObjectKey(account.userId, hashFor("only-a")))).toBe(false);
    expect(objects.has(chunkObjectKey(account.userId, hashFor("s1")))).toBe(true);
    expect((await quota(account.token)).usedBytes).toBe(512 + 512 + 256);

    // The surviving file is still complete and still downloadable.
    const stat = await app.request("/v1/files/stat?path=%2Ftwo.bin", authedInit(account.token));
    expect((await stat.json()).complete).toBe(true);
    const download = await app.request(
      `/v1/files/chunks/${hashFor("s1")}/download-url`,
      authedInit(account.token),
    );
    expect(download.status).toBe(200);
    expect((await download.json()).download.method).toBe("GET");
  });

  it("replacing a path releases the old chunks instead of leaking them", async () => {
    const account = await signup();
    await uploadFile(account, "/notes.txt", manifestOf("v1", [{ label: "v1-c", length: 100 }]));
    expect((await quota(account.token)).usedBytes).toBe(100);

    const replaced = await postManifest(
      account.token,
      "/notes.txt",
      manifestOf("v2", [{ label: "v2-c", length: 300 }]),
    );
    // Same path, same row: an update, not a second file.
    expect(replaced.status).toBe(200);
    const body = await replaced.json();
    expect(body.complete).toBe(false);
    expect(body.missing.map((c: MissingChunk) => c.hash)).toEqual([hashFor("v2-c")]);

    const rows = await chunkRows(account.userId);
    expect(rows.map((r) => r.hash)).toEqual([hashFor("v2-c")]);
    expect(objects.has(chunkObjectKey(account.userId, hashFor("v1-c")))).toBe(false);
    expect((await quota(account.token)).usedBytes).toBe(300);
    const listed = await (await app.request("/v1/files", authedInit(account.token))).json();
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0].complete).toBe(false);
  });

  it("keeps the chunks a replacement REUSES, and reports `missing` truthfully", async () => {
    const account = await signup();
    const shared = { label: "rev-shared", length: 256 };
    await uploadFile(
      account,
      "/doc.bin",
      manifestOf("rev1", [shared, { label: "rev1-only", length: 128 }]),
    );
    const sharedKey = chunkObjectKey(account.userId, hashFor(shared.label));
    expect(objects.has(sharedKey)).toBe(true);

    // The new version keeps one chunk of the old one — the ordinary case for
    // an edited file, and the one where releasing before acquiring would
    // delete bytes the reply then claims are already uploaded.
    const replaced = await postManifest(
      account.token,
      "/doc.bin",
      manifestOf("rev2", [shared, { label: "rev2-only", length: 512 }]),
    );
    expect(replaced.status).toBe(200);
    const body = await replaced.json();
    expect(body.missing.map((c: MissingChunk) => c.hash)).toEqual([hashFor("rev2-only")]);

    // "Nothing to upload" is only an acceptable answer if the bytes are there.
    expect(objects.has(sharedKey)).toBe(true);
    const rows = await chunkRows(account.userId);
    expect(rows.map((r) => r.hash).sort()).toEqual(
      [hashFor(shared.label), hashFor("rev2-only")].sort(),
    );
    const sharedRow = rows.find((r) => r.hash === hashFor(shared.label));
    expect(sharedRow?.refCount).toBe(1);
    expect(sharedRow?.storedAt).not.toBeNull();
    // The chunk only the old version used is still released.
    expect(objects.has(chunkObjectKey(account.userId, hashFor("rev1-only")))).toBe(false);

    // And the client's next step succeeds: upload what it was told, then
    // complete — which is what a lie in `missing` would turn into a 409.
    await objects.put(chunkObjectKey(account.userId, hashFor("rev2-only")), new Uint8Array(512));
    const done = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, account.token),
    );
    expect(done.status).toBe(200);
    expect((await done.json()).complete).toBe(true);
    expect((await quota(account.token)).usedBytes).toBe(256 + 512);
  });

  it("bounds a chunk upload URL to the size the manifest declared", async () => {
    const account = await signup();
    const created = await postManifest(
      account.token,
      "/bounded.bin",
      manifestOf("bounded", [{ label: "bounded1", length: 4096 }]),
    );
    expect(created.status).toBe(201);
    const presign = await app.request(
      `/v1/files/chunks/${hashFor("bounded1")}/upload-url`,
      authedInit(account.token, "POST"),
    );
    expect(presign.status).toBe(200);
    const body = await presign.json();
    // The grant is scoped by size as well as by key, so the declared length
    // the quota is charged from is also the most that can be stored.
    expect(body.upload.contentLength).toBe(4096);
    expect(body.upload.url).toContain("content-length=4096");
  });

  it("deletes a stored object whose real size is not the size declared for it", async () => {
    const account = await signup();
    const created = await postManifest(
      account.token,
      "/oversized.bin",
      manifestOf("oversized", [{ label: "over-c1", length: 1024 }]),
    );
    expect(created.status).toBe(201);
    const fileId = (await created.json()).file.id;
    const key = chunkObjectKey(account.userId, hashFor("over-c1"));
    // A client that declared 1 KiB and stored 64 KiB anyway.
    await objects.put(key, new Uint8Array(64 * 1024));

    const refused = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId }, account.token),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).missing).toEqual([hashFor("over-c1")]);
    // Not merely left unconfirmed: the bytes are gone, so the account is not
    // holding 64 KiB of storage it declared (and is charged for) as 1 KiB.
    expect(objects.has(key)).toBe(false);
    expect(await auditTypes(account.token)).toContain("files.chunk_rejected");

    // The honest upload still completes afterwards.
    await objects.put(key, new Uint8Array(1024));
    const done = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId }, account.token),
    );
    expect(done.status).toBe(200);
    expect((await quota(account.token)).usedBytes).toBe(1024);
  });

  it("400s traversal, control characters and an inconsistent manifest", async () => {
    const account = await signup();
    const manifest = manifestOf("t", [{ label: "t1", length: 10 }]);
    for (const path of ["../../etc/passwd", "/a/../../b", "/", "/bad\u0000name", ".."]) {
      const res = await postManifest(account.token, path, manifest);
      expect(res.status, path).toBe(400);
      expect((await res.json()).error).toBe("invalid_path");
    }
    const bad = await postManifest(account.token, "/x.bin", { ...manifest, totalBytes: 11 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_manifest", reason: "size_mismatch" });

    // Traversal is refused on every path-bearing route, not only on create.
    expect((await app.request("/v1/files/stat?path=..%2F..%2Fetc", authedInit(account.token))).status).toBe(400);
    expect((await app.request("/v1/files?prefix=..%2Fetc", authedInit(account.token))).status).toBe(400);
    expect((await createTransfer(account.token, { destPath: "../../etc/passwd" })).status).toBe(400);

    // Nothing was recorded by any of the refusals.
    const rows = await db.select().from(schema.files).where(eq(schema.files.userId, account.userId));
    expect(rows).toEqual([]);
  });

  it("lists by prefix with keyset paging, matching only real descendants", async () => {
    const account = await signup();
    const paths = ["/docs/a.txt", "/docs/b.txt", "/docs/sub/c.txt", "/docsx.txt", "/other.txt"];
    for (const path of paths) {
      await uploadFile(account, path, manifestOf(path, [{ label: `chunk${path}`, length: 8 }]));
    }

    const all = await (await app.request("/v1/files?limit=100", authedInit(account.token))).json();
    expect(all.files.map((f: { path: string }) => f.path)).toEqual([...paths].sort());
    expect(all.nextCursor).toBeNull();

    const docs = await (
      await app.request("/v1/files?prefix=/docs&limit=100", authedInit(account.token))
    ).json();
    // "/docsx.txt" is a sibling, not a descendant.
    expect(docs.files.map((f: { path: string }) => f.path)).toEqual([
      "/docs/a.txt",
      "/docs/b.txt",
      "/docs/sub/c.txt",
    ]);

    const page1 = await (await app.request("/v1/files?limit=2", authedInit(account.token))).json();
    expect(page1.files).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.files[1].path);
    const page2 = await (
      await app.request(
        `/v1/files?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        authedInit(account.token),
      )
    ).json();
    const paged = [...page1.files, ...page2.files].map((f: { path: string }) => f.path);
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual([...paths].sort().slice(0, 4));
  });

  it("handles a zero-byte file, which has no chunks at all", async () => {
    const account = await signup();
    const created = await postManifest(account.token, "/empty.txt", {
      fileHash: hashFor("empty"),
      totalBytes: 0,
      chunks: [],
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.missing).toEqual([]);
    const done = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, account.token),
    );
    expect(done.status).toBe(200);
    expect((await done.json()).file.sizeBytes).toBe(0);
    expect((await quota(account.token)).usedBytes).toBe(0);
  });

  it("404s stat and delete for a path or id that is not there", async () => {
    const account = await signup();
    expect((await app.request("/v1/files/stat?path=/nope.bin", authedInit(account.token))).status).toBe(404);
    expect(
      (await app.request(`/v1/files/${crypto.randomUUID()}`, authedInit(account.token, "DELETE"))).status,
    ).toBe(404);
    expect(
      (await app.request("/v1/files/complete", jsonInit("POST", { fileId: crypto.randomUUID() }, account.token)))
        .status,
    ).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Quota
 * ------------------------------------------------------------------ */

describe("quota (§8.6: Pro 100 GB, soft-block at the limit)", () => {
  it("reports the meter the Files app renders", async () => {
    const account = await signup();
    const empty = await quota(account.token);
    expect(empty).toMatchObject({ usedBytes: 0, limitBytes: PRO_QUOTA_BYTES, softBlocked: false, fileCount: 0 });

    await uploadFile(account, "/m.bin", manifestOf("m", [{ label: "m1", length: 1234 }]));
    expect(await quota(account.token)).toMatchObject({ usedBytes: 1234, fileCount: 1 });
  });

  it("soft-blocks new bytes with a 413 and never deletes what is already stored", async () => {
    const account = await signup();
    await uploadFile(account, "/keep.bin", manifestOf("keep", [{ label: "keep1", length: 4096 }]));

    // Fill the quota without writing 100 GB: chunk rows are the accounting
    // unit, so the fixture inflates their recorded sizes.
    const filler = Array.from({ length: 54 }, (_, i) => ({
      userId: account.userId,
      hash: hashFor(`filler-${i}`),
      sizeBytes: 2_000_000_000,
      refCount: 1,
    }));
    await db.insert(schema.chunks).values(filler);
    const state = await quota(account.token);
    expect(state.usedBytes).toBeGreaterThan(PRO_QUOTA_BYTES);
    expect(state.softBlocked).toBe(true);

    const refused = await postManifest(
      account.token,
      "/too-much.bin",
      manifestOf("too-much", [{ label: "over1", length: 4096 }]),
    );
    expect(refused.status).toBe(413);
    const body = await refused.json();
    expect(body.error).toBe("quota_exceeded");
    expect(body.softBlocked).toBe(true);
    expect(body.limitBytes).toBe(PRO_QUOTA_BYTES);
    expect(body.explanation).toContain("Existing files stay available");
    expect(await auditTypes(account.token)).toContain("files.quota_blocked");

    // Refused, not recorded: no file row, no chunk row, nothing to clean up.
    expect(
      await db
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.userId, account.userId), eq(schema.files.path, "/too-much.bin"))),
    ).toEqual([]);

    // Soft block, not data loss: the existing file still lists, stats, and
    // hands out download URLs.
    const listed = await (await app.request("/v1/files", authedInit(account.token))).json();
    expect(listed.files.map((f: { path: string }) => f.path)).toEqual(["/keep.bin"]);
    const stat = await app.request("/v1/files/stat?path=%2Fkeep.bin", authedInit(account.token));
    expect((await stat.json()).complete).toBe(true);
    const download = await app.request(
      `/v1/files/chunks/${hashFor("keep1")}/download-url`,
      authedInit(account.token),
    );
    expect(download.status).toBe(200);

    // Every write path is gated, including the presigned upload.
    const upload = await app.request(
      `/v1/files/chunks/${hashFor("keep1")}/upload-url`,
      authedInit(account.token, "POST"),
    );
    expect(upload.status).toBe(413);
    expect((await createTransfer(account.token)).status).toBe(413);

    // Freeing space lifts the block, with no intervention.
    await db.delete(schema.chunks).where(
      and(eq(schema.chunks.userId, account.userId), eq(schema.chunks.hash, hashFor("filler-0"))),
    );
    await db
      .update(schema.chunks)
      .set({ refCount: 0 })
      .where(eq(schema.chunks.userId, account.userId));
    expect((await quota(account.token)).softBlocked).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency: read-then-write is not a transaction
 * ------------------------------------------------------------------ */

describe("concurrent Files writes cannot lose data (§8.6)", () => {
  it("survives two overlapping deletes of a file whose chunk a sibling shares", async () => {
    const account = await signup();
    const shared = { label: "conc-shared", length: 1024 };
    await uploadFile(
      account,
      "/first.bin",
      manifestOf("conc1", [shared, { label: "conc1-only", length: 32 }]),
    );
    await uploadFile(
      account,
      "/second.bin",
      manifestOf("conc2", [shared, { label: "conc2-only", length: 32 }]),
    );
    const listed = await (await app.request("/v1/files", authedInit(account.token))).json();
    const first = listed.files.find((f: { path: string }) => f.path === "/first.bin");

    // Two deletes of the SAME file, in flight together. Read-then-write would
    // have both of them decrement the shared chunk — two claims to zero — and
    // the object would leave the bucket while /second.bin still names it.
    const [a, b] = await Promise.all([
      app.request(`/v1/files/${first.id}`, authedInit(account.token, "DELETE")),
      app.request(`/v1/files/${first.id}`, authedInit(account.token, "DELETE")),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 404]);

    const rows = await chunkRows(account.userId);
    expect(rows.find((r) => r.hash === hashFor(shared.label))?.refCount).toBe(1);
    expect(objects.has(chunkObjectKey(account.userId, hashFor(shared.label)))).toBe(true);
    // The chunk only the deleted file used is still released, exactly once.
    expect(objects.has(chunkObjectKey(account.userId, hashFor("conc1-only")))).toBe(false);

    // The sibling is untouched: still complete, still downloadable.
    const stat = await app.request("/v1/files/stat?path=%2Fsecond.bin", authedInit(account.token));
    expect((await stat.json()).complete).toBe(true);
    const download = await app.request(
      `/v1/files/chunks/${hashFor(shared.label)}/download-url`,
      authedInit(account.token),
    );
    expect(download.status).toBe(200);
    expect((await quota(account.token)).usedBytes).toBe(1024 + 32);
  });

  // PGlite runs one connection, so a transaction here serializes by itself;
  // on Neon the `SELECT ... FOR UPDATE` on the account row is what makes the
  // check-then-write atomic across connections. This test pins the observable
  // rule — one quota, not one per request — on both.
  it("admits concurrent creates against ONE quota, not one quota each", async () => {
    const account = await signup();
    // Room for exactly one more 4 KiB chunk.
    await fillQuota(account.userId, 4096);

    const attempts = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        postManifest(
          account.token,
          `/race-${i}.bin`,
          manifestOf(`race-${i}`, [{ label: `race-c${i}`, length: 4096 }]),
        ),
      ),
    );
    const statuses = attempts.map((res) => res.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 413)).toHaveLength(3);
    // And the meter never went past the limit it was checked against.
    expect((await quota(account.token)).usedBytes).toBe(PRO_QUOTA_BYTES);
  });
});

/* ------------------------------------------------------------------ *
 * Transfers
 * ------------------------------------------------------------------ */

describe("transfers (§8.6 cloud fetch)", () => {
  it("lets the owning desktop durably relay agent lifecycle events", async () => {
    const owner = await signup();
    const stranger = await signup();
    const transfer = transferSchema.parse(
      (await (await createTransfer(owner.token)).json()).transfer,
    );

    const moved = await deviceProgress(owner.token, transfer.id, {
      state: "fetching",
      receivedBytes: 123,
    });
    expect(moved.status).toBe(200);
    expect((await moved.json()).transfer).toMatchObject({
      state: "fetching",
      receivedBytes: 123,
    });

    expect(
      (
        await deviceProgress(stranger.token, transfer.id, {
          state: "fetching",
          receivedBytes: 124,
        })
      ).status,
    ).toBe(404);
  });

  it("runs the lifecycle: queued → fetching → storing → completed, visible to every device", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public"]);

    const created = await createTransfer(account.token);
    expect(created.status).toBe(201);
    const body = await created.json();
    const transfer = transferSchema.parse(body.transfer);
    expect(transfer).toMatchObject({
      url: BIG_URL,
      destPath: "/datasets/imagenet.tar",
      state: "queued",
      receivedBytes: 0,
      totalBytes: BIG_BYTES,
    });
    expect(body.eligibility).toEqual({ eligible: true, reason: "public" });

    for (const step of [
      { state: "fetching", receivedBytes: 0 },
      { state: "fetching", receivedBytes: BIG_BYTES / 2 },
      { state: "storing", receivedBytes: BIG_BYTES },
      { state: "completed", receivedBytes: BIG_BYTES },
    ]) {
      const res = await progress(cap, { transferId: transfer.id, ...step });
      expect(res.status, step.state).toBe(200);
      expect((await res.json()).transfer.state).toBe(step.state);
    }

    // What a second Mac polls.
    const listed = await (await app.request("/v1/files/transfers", authedInit(account.token))).json();
    expect(listed.transfers).toHaveLength(1);
    expect(listed.transfers[0]).toMatchObject({
      state: "completed",
      receivedBytes: BIG_BYTES,
      totalBytes: BIG_BYTES,
    });
    expect(transferSchema.parse(listed.transfers[0]).updatedAtMs).toBeGreaterThanOrEqual(
      listed.transfers[0].startedAtMs,
    );

    const filtered = await (
      await app.request("/v1/files/transfers?state=queued", authedInit(account.token))
    ).json();
    expect(filtered.transfers).toEqual([]);

    // A completed transfer is frozen: neither the user nor the VM can move it.
    const late = await progress(cap, {
      transferId: transfer.id,
      state: "fetching",
      receivedBytes: BIG_BYTES,
    });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe("transfer_terminal");
    const cancel = await app.request(
      `/v1/files/transfers/${transfer.id}/cancel`,
      authedInit(account.token, "POST"),
    );
    expect(cancel.status).toBe(409);
  });

  it("cancels a queued transfer and refuses later agent reports on it", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public"]);
    const transfer = (await (await createTransfer(account.token)).json()).transfer;

    const cancelled = await app.request(
      `/v1/files/transfers/${transfer.id}/cancel`,
      authedInit(account.token, "POST"),
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).transfer.state).toBe("cancelled");
    expect(await auditTypes(account.token)).toContain("transfer.cancelled");

    const resurrect = await progress(cap, {
      transferId: transfer.id,
      state: "fetching",
      receivedBytes: 1,
    });
    expect(resurrect.status).toBe(409);
    expect((await resurrect.json()).error).toBe("transfer_terminal");
  });

  it("records the origin device and the origin HOST, never the URL", async () => {
    const account = await signup();
    const enrolled = await app.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        { name: "MBP", platform: "darwin", devicePublicKey: `${"A".repeat(43)}=` },
        account.token,
      ),
    );
    expect(enrolled.status).toBe(201);
    const deviceId = (await enrolled.json()).device.id;
    const deviceToken = `hbr_dev_${account.userId}.${deviceId}`;

    const presigned = `${BIG_URL}?X-Amz-Signature=abc123&X-Amz-Credential=secret`;
    const created = await createTransfer(deviceToken, { url: presigned });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.transfer.originDeviceId).toBe(deviceId);
    expect(body.eligibility.reason).toBe("presigned");

    const events = await (await app.request("/v1/audit?limit=50", authedInit(account.token))).json();
    const entry = events.events.find((e: { type: string }) => e.type === "transfer.created");
    expect(entry.payload).toMatchObject({ host: "releases.example.com", destPath: "/datasets/imagenet.tar" });
    // A presigned URL is bearer authority; the audit trail must not hold one.
    expect(JSON.stringify(entry.payload)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(entry.payload)).not.toContain("abc123");
  });

  it("stops holding the fetch URL once the transfer is over", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public"]);
    const presigned = `${BIG_URL}?X-Amz-Signature=abc123&X-Amz-Credential=secret`;
    const created = await createTransfer(account.token, { url: presigned });
    expect(created.status).toBe(201);
    const transfer = transferSchema.parse((await created.json()).transfer);
    // Not even while it runs: the API answers with scheme, host and path.
    expect(transfer.url).toBe(BIG_URL);

    for (const step of [
      { state: "fetching", receivedBytes: 0 },
      { state: "storing", receivedBytes: BIG_BYTES },
      { state: "completed", receivedBytes: BIG_BYTES },
    ]) {
      expect((await progress(cap, { transferId: transfer.id, ...step })).status).toBe(200);
    }

    // The row itself, not just the projection: a completed transfer keeps no
    // query string, so the credential does not outlive the fetch it was for.
    const [row] = await db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transfer.id));
    expect(row?.url).toBe(BIG_URL);
    expect(row?.url).not.toContain("?");
    expect(JSON.stringify(row)).not.toContain("abc123");

    const listed = await (
      await app.request("/v1/files/transfers", authedInit(account.token))
    ).json();
    expect(JSON.stringify(listed)).not.toContain("X-Amz-Signature");
    const seen = listed.transfers.find((t: { id: string }) => t.id === transfer.id);
    expect(seen.url).not.toContain("?");
    // Still enough for the UI to name the source and the file.
    expect(new URL(seen.url).hostname).toBe("releases.example.com");
    expect(seen.url.endsWith("/imagenet.tar")).toBe(true);
  });

  it("redacts the URL of a cancelled transfer too", async () => {
    const account = await signup();
    const presigned = `${BIG_URL}?X-Amz-Signature=cancelme&sv=2024-01-01`;
    const created = await createTransfer(account.token, { url: presigned });
    const transfer = (await created.json()).transfer;
    const cancelled = await app.request(
      `/v1/files/transfers/${transfer.id}/cancel`,
      authedInit(account.token, "POST"),
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).transfer.url).toBe(BIG_URL);
    const [row] = await db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transfer.id));
    expect(row?.url).not.toContain("cancelme");
  });

  it("admits an undeclared-length transfer against the cloud-fetch floor", async () => {
    const account = await signup();
    // No declared length: the 50 MiB floor cannot be applied to it, so
    // admission charges the smallest size it could honestly turn out to be
    // rather than zero — which every account would pass.
    const allowed = await createTransfer(account.token, { totalBytes: undefined });
    expect(allowed.status).toBe(201);
    expect((await allowed.json()).transfer.totalBytes).toBe(0);

    const broke = await signup();
    await fillQuota(broke.userId, CLOUD_FETCH_MIN_BYTES - 1);
    const refused = await createTransfer(broke.token, { totalBytes: undefined });
    expect(refused.status).toBe(413);
    expect((await refused.json()).error).toBe("quota_exceeded");
    expect(await auditTypes(broke.token)).toContain("files.quota_blocked");
    expect(
      await db.select().from(schema.transfers).where(eq(schema.transfers.userId, broke.userId)),
    ).toEqual([]);
  });

  it("caps the transfers one account may have in flight at once", async () => {
    const account = await signup();
    for (let i = 0; i < ABUSE_LIMITS.maxActiveTransfers; i++) {
      const res = await createTransfer(account.token, { destPath: `/datasets/d${i}.tar` });
      expect(res.status, `transfer ${i}`).toBe(201);
    }
    const refused = await createTransfer(account.token, { destPath: "/datasets/one-too-many.tar" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      error: "abuse_limit",
      limit: "active_transfers",
    });
    expect(await auditTypes(account.token)).toContain("abuse.limit_hit");

    // The cap counts transfers IN FLIGHT, so finishing one frees its slot.
    const listed = await (
      await app.request("/v1/files/transfers?limit=200", authedInit(account.token))
    ).json();
    const cancel = await app.request(
      `/v1/files/transfers/${listed.transfers[0].id}/cancel`,
      authedInit(account.token, "POST"),
    );
    expect(cancel.status).toBe(200);
    expect(
      (await createTransfer(account.token, { destPath: "/datasets/after-cancel.tar" })).status,
    ).toBe(201);
  });
});

/* ------------------------------------------------------------------ *
 * The §8.6 rule
 * ------------------------------------------------------------------ */

describe("§8.6: no credential may reach the compute plane", () => {
  it("refuses, loudly, any attempt to attach a credential to a transfer", async () => {
    const account = await signup();
    // Zod would otherwise STRIP these and answer 201, so the caller would
    // believe the header was accepted. `.strict()` makes the refusal explicit.
    const smuggles: Array<Record<string, unknown>> = [
      { headers: { Cookie: "session=abc" } },
      { cookie: "session=abc" },
      { authorization: "Bearer secret" },
      { sealedRequest: "…" },
      { clientCert: "…" },
    ];
    for (const smuggle of smuggles) {
      const res = await createTransfer(account.token, smuggle);
      expect(res.status, JSON.stringify(smuggle)).toBe(400);
    }

    // And nothing the API DOES accept can carry one.
    const created = await createTransfer(account.token);
    expect(created.status).toBe(201);
    const transfer = (await created.json()).transfer;
    for (const key of Object.keys(transfer)) {
      expect(key, `transfer field ${key}`).not.toMatch(/cookie|header|auth|credential|secret|token/i);
    }
    const [row] = await db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transfer.id));
    for (const key of Object.keys(row ?? {})) {
      expect(key, `transfers column ${key}`).not.toMatch(/cookie|header|auth|credential|secret|token/i);
    }
  });

  it("re-runs the URL half of cloudFetchEligibility server-side and fails closed", async () => {
    const account = await signup();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: "https://user:pass@releases.example.com/big.bin" }, "userinfo_in_url"],
      [{ url: "http://localhost/big.bin" }, "private_host"],
      [{ url: "http://192.168.1.10/big.bin" }, "private_host"],
      [{ url: "http://10.0.0.4/big.bin" }, "private_host"],
      [{ url: "ftp://releases.example.com/big.bin" }, "not_http"],
      [{ url: "not a url" }, "not_http"],
      [{ totalBytes: 1024 }, "too_small"],
    ];
    for (const [body, reason] of cases) {
      const res = await createTransfer(account.token, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const json = await res.json();
      expect(json.error).toBe("not_eligible");
      expect(json.reason).toBe(reason);
      expect(typeof json.explanation).toBe("string");
    }
    expect(
      await db.select().from(schema.transfers).where(eq(schema.transfers.userId, account.userId)),
    ).toEqual([]);
  });

  it("gates cloud fetch on the account feature", async () => {
    const res = await app.request("/v1/accounts", jsonInit("POST", { email: `nofeature-${emailCounter++}@example.com` }));
    const user = (await res.json()).user;
    // Signup grants the V1 default feature set; strip it to exercise the gate.
    await db.update(schema.users).set({ features: [] }).where(eq(schema.users.id, user.id));
    const refused = await createTransfer(`hbr_dev_${user.id}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "feature_required", feature: "cloud-fetch" });
  });
});

/* ------------------------------------------------------------------ *
 * Agent-bounded progress (I-2, §9)
 * ------------------------------------------------------------------ */

describe("transfer progress is bounded, like the Phase 2 usage samples", () => {
  async function queued(account: Account): Promise<string> {
    const created = await createTransfer(account.token);
    expect(created.status).toBe(201);
    return (await created.json()).transfer.id;
  }

  it("refuses a decreasing counter, an over-total figure and a restated total", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public"]);
    const transferId = await queued(account);

    expect((await progress(cap, { transferId, state: "fetching", receivedBytes: 1000 })).status).toBe(200);

    const backwards = await progress(cap, { transferId, state: "fetching", receivedBytes: 999 });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toEqual({
      error: "out_of_range",
      field: "receivedBytes",
      reason: "decreased",
    });

    const overshoot = await progress(cap, {
      transferId,
      state: "fetching",
      receivedBytes: BIG_BYTES + 1,
    });
    expect(overshoot.status).toBe(400);
    expect((await overshoot.json()).reason).toBe("exceeds_total");

    const restated = await progress(cap, {
      transferId,
      state: "fetching",
      receivedBytes: 2000,
      totalBytes: 5,
    });
    expect(restated.status).toBe(400);
    expect(await restated.json()).toEqual({
      error: "out_of_range",
      field: "totalBytes",
      reason: "total_changed",
    });

    // Schema bounds: negatives, absurd sizes and an oversized error string.
    for (const body of [
      { transferId, state: "fetching", receivedBytes: -1 },
      { transferId, state: "fetching", receivedBytes: 200 * 1024 ** 3 },
      { transferId, state: "fetching", receivedBytes: 2000, error: "x".repeat(501) },
      { transferId, state: "teleporting", receivedBytes: 2000 },
      { transferId, state: "fetching", receivedBytes: 2000, headers: { Cookie: "a=b" } },
    ]) {
      expect((await progress(cap, body)).status, JSON.stringify(body)).toBe(400);
    }

    // The stored row still shows the last honest report.
    const [row] = await db.select().from(schema.transfers).where(eq(schema.transfers.id, transferId));
    expect(row?.receivedBytes).toBe(1000);
    expect(row?.state).toBe("fetching");
  });

  it("refuses an illegal state jump", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public"]);
    const transferId = await queued(account);
    const jump = await progress(cap, { transferId, state: "completed", receivedBytes: BIG_BYTES });
    expect(jump.status).toBe(409);
    expect(await jump.json()).toEqual({ error: "illegal_transition", from: "queued", to: "completed" });
  });

  it("accepts only a fetch.public capability token — never a device credential", async () => {
    const account = await signup();
    const transferId = await queued(account);
    const body = { transferId, state: "fetching", receivedBytes: 1 };

    // Device/user credentials are not the agent plane (I-2).
    expect((await progress(account.token, body)).status).toBe(401);
    expect((await app.request("/v1/files/transfers/progress", jsonInit("POST", body))).status).toBe(401);

    // A terminal-scoped token is a different grant and must not move a job.
    const terminal = await mintCap(account.token, TERMINAL_CAPABILITIES);
    const refused = await progress(terminal, body);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("capability_refused");

    const cap = await mintCap(account.token, ["fetch.public"]);
    expect((await progress(cap, body)).status).toBe(200);
  });

  it("never lets a capability token reach the device-facing Files routes (I-2)", async () => {
    const account = await signup();
    const cap = await mintCap(account.token, ["fetch.public", "fs.read", "fs.write"]);
    const manifest = manifestOf("cap", [{ label: "cap1", length: 16 }]);
    const attempts: Array<[string, RequestInit]> = [
      ["/v1/files", authedInit(cap)],
      ["/v1/files/quota", authedInit(cap)],
      ["/v1/files/stat?path=/x", authedInit(cap)],
      ["/v1/files/transfers", authedInit(cap)],
      [`/v1/files/chunks/${hashFor("cap1")}/download-url`, authedInit(cap)],
      [`/v1/files/chunks/${hashFor("cap1")}/upload-url`, authedInit(cap, "POST")],
      ["/v1/files/manifest", jsonInit("POST", { path: "/x.bin", manifest }, cap)],
      ["/v1/files/complete", jsonInit("POST", { fileId: crypto.randomUUID() }, cap)],
      ["/v1/files/transfers", jsonInit("POST", { url: BIG_URL, destPath: "/x.bin" }, cap)],
      [`/v1/files/transfers/${crypto.randomUUID()}/cancel`, authedInit(cap, "POST")],
      [`/v1/files/${crypto.randomUUID()}`, authedInit(cap, "DELETE")],
    ];
    for (const [path, init] of attempts) {
      const res = await app.request(path, init);
      expect(res.status, `capability token must not authenticate ${path}`).toBe(401);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe("authorization: one account cannot reach another's files", () => {
  it("hides files, chunks and transfers from every other account", async () => {
    const owner = await signup();
    const stranger = await signup();
    const manifest = manifestOf("private", [{ label: "private1", length: 64 }]);
    const { fileId } = await uploadFile(owner, "/private/secrets.txt", manifest);
    const ownerTransfer = (await (await createTransfer(owner.token)).json()).transfer;

    // Listing and stat are scoped to the caller.
    const listed = await (await app.request("/v1/files?limit=100", authedInit(stranger.token))).json();
    expect(listed.files).toEqual([]);
    expect(
      (await app.request("/v1/files/stat?path=%2Fprivate%2Fsecrets.txt", authedInit(stranger.token))).status,
    ).toBe(404);

    // Knowing the id, or the chunk hash, buys nothing.
    expect((await app.request(`/v1/files/${fileId}`, authedInit(stranger.token, "DELETE"))).status).toBe(404);
    expect(
      (await app.request("/v1/files/complete", jsonInit("POST", { fileId }, stranger.token))).status,
    ).toBe(404);
    expect(
      (await app.request(`/v1/files/chunks/${hashFor("private1")}/download-url`, authedInit(stranger.token)))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/v1/files/chunks/${hashFor("private1")}/upload-url`, authedInit(stranger.token, "POST")))
        .status,
    ).toBe(404);

    // Transfers likewise.
    const strangerTransfers = await (
      await app.request("/v1/files/transfers", authedInit(stranger.token))
    ).json();
    expect(strangerTransfers.transfers).toEqual([]);
    expect(
      (await app.request(`/v1/files/transfers/${ownerTransfer.id}/cancel`, authedInit(stranger.token, "POST")))
        .status,
    ).toBe(404);
    const strangerCap = await mintCap(stranger.token, ["fetch.public"]);
    expect(
      (await progress(strangerCap, { transferId: ownerTransfer.id, state: "fetching", receivedBytes: 1 }))
        .status,
    ).toBe(404);

    // The owner's file is untouched by all of that.
    const ownerStat = await app.request(
      "/v1/files/stat?path=%2Fprivate%2Fsecrets.txt",
      authedInit(owner.token),
    );
    expect(ownerStat.status).toBe(200);
    expect((await ownerStat.json()).complete).toBe(true);
  });

  it("does not deduplicate across accounts: a hash proves nothing about anyone else", async () => {
    const owner = await signup();
    const stranger = await signup();
    const manifest = manifestOf("shared-content", [{ label: "shared-c1", length: 2048 }]);
    await uploadFile(owner, "/mine.bin", manifest);

    // Same content, different account: the chunk is reported MISSING, so no
    // one learns that another account already holds it, and no one can claim
    // bytes they never uploaded.
    const created = await postManifest(stranger.token, "/theirs.bin", manifest);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.missing.map((c: MissingChunk) => c.hash)).toEqual([hashFor("shared-c1")]);

    // And the object keys are namespaced, so the two never collide.
    const early = await app.request(
      "/v1/files/complete",
      jsonInit("POST", { fileId: body.file.id }, stranger.token),
    );
    expect(early.status).toBe(409);
    expect(objects.has(chunkObjectKey(owner.userId, hashFor("shared-c1")))).toBe(true);
    expect(objects.has(chunkObjectKey(stranger.userId, hashFor("shared-c1")))).toBe(false);
  });

  it("401s every Files route without a credential", async () => {
    const paths: Array<[string, RequestInit]> = [
      ["/v1/files", {}],
      ["/v1/files/quota", {}],
      ["/v1/files/stat?path=/x", {}],
      ["/v1/files/transfers", {}],
      ["/v1/files/manifest", jsonInit("POST", {})],
      ["/v1/files/complete", jsonInit("POST", {})],
      [`/v1/files/${crypto.randomUUID()}`, { method: "DELETE" }],
    ];
    for (const [path, init] of paths) {
      expect((await app.request(path, init)).status, path).toBe(401);
    }
  });
});
