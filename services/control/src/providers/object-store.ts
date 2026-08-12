/**
 * Chunk storage behind an interface, mirroring `SandboxProvider` (PRD §7: the
 * V2 exit hatch). Routes only ever see `ObjectStore`, so R2 can be swapped for
 * any S3-compatible bucket — or for the in-memory stub the tests run against —
 * without touching route logic.
 *
 * The bytes are content-addressed chunks (BLAKE3 of the chunk, produced by
 * `packages/chunking`), so a key is only ever written with the bytes that hash
 * to it. §8.6 is honest that these objects are NOT end-to-end encrypted in V1.
 */

import { toHex, utf8 } from "@suma/protocol";

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

export interface PresignedUrl {
  url: string;
  method: "PUT" | "GET";
  expiresAtMs: number;
  /**
   * For a PUT: the exact `Content-Length` the URL was signed for. The uploader
   * must send this and only this — see `presignPut`.
   */
  contentLength?: number;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  /**
   * Presign a PUT that accepts a body of EXACTLY `contentLength` bytes.
   *
   * The size is part of the signature, not advice: a presigned URL is handed
   * to a client the threat model treats as hostile, and one that accepted any
   * body would let a caller who declared a 4 MiB chunk store gigabytes under
   * that key — bytes the quota (which is charged from the DECLARED manifest)
   * would never see. Signing `content-length` makes an oversized upload fail
   * at the bucket rather than at the accounting.
   */
  presignPut(key: string, expiresInSeconds: number, contentLength: number): Promise<PresignedUrl>;
  presignGet(key: string, expiresInSeconds: number): Promise<PresignedUrl>;
}

/** Default lifetime of a presigned chunk URL — long enough for one chunk. */
export const PRESIGN_TTL_SECONDS = 900;

/* ------------------------------------------------------------------ *
 * In-memory stub (tests, and the explicitly opted-in dev mode)
 * ------------------------------------------------------------------ */

export class StubObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string | null }>();

  get size(): number {
    return this.objects.size;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    this.objects.set(key, { body, contentType: contentType ?? null });
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key)?.body ?? null);
  }

  head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object === undefined ? null : { sizeBytes: object.body.length, contentType: object.contentType },
    );
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  // Deliberately un-fetchable hosts: a stub URL that resolved would let a test
  // (or a dev build) quietly talk to something real.
  presignPut(key: string, expiresInSeconds: number, contentLength: number): Promise<PresignedUrl> {
    return Promise.resolve(this.stubUrl("PUT", key, expiresInSeconds, contentLength));
  }

  presignGet(key: string, expiresInSeconds: number): Promise<PresignedUrl> {
    return Promise.resolve(this.stubUrl("GET", key, expiresInSeconds));
  }

  private stubUrl(
    method: "PUT" | "GET",
    key: string,
    expiresInSeconds: number,
    contentLength?: number,
  ): PresignedUrl {
    // The size rides in the URL exactly as it does in the real signature, so a
    // caller (or a test) can see that the grant is bounded.
    const bound = contentLength === undefined ? "" : `&content-length=${contentLength}`;
    return {
      url: `https://object-store.invalid/${encodeURI(key)}?method=${method}&expires=${expiresInSeconds}${bound}`,
      method,
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
      ...(contentLength === undefined ? {} : { contentLength }),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Local HTTP store (dev only): the stub, made fetchable
 * ------------------------------------------------------------------ */

/**
 * `OBJECT_STORE=local` — the in-memory stub behind a real loopback HTTP
 * server, so presigned URLs actually accept and serve bytes. This exists for
 * one reason: end-to-end exercising of the upload/hydration paths (chunk PUT
 * → complete → manifest read-back → chunk GET) against a dev control plane,
 * which the deliberately un-fetchable stub URLs cannot do.
 *
 * Dev semantics, stated plainly:
 *  - loopback only, and every URL carries a per-process random token — a
 *    crude but honest stand-in for a signature;
 *  - a PUT larger than the presigned content-length bound is refused, the
 *    same property the R2 signature enforces;
 *  - contents are memory, lost on restart, exactly like the stub.
 */
export class LocalHttpObjectStore extends StubObjectStore {
  private readonly token = globalThis.crypto.randomUUID();
  private server: import("node:http").Server | null = null;
  private baseUrl: string | null = null;
  private listening: Promise<string> | null = null;

  constructor(private readonly port: number) {
    super();
  }

  override async presignPut(
    key: string,
    expiresInSeconds: number,
    contentLength: number,
  ): Promise<PresignedUrl> {
    const base = await this.ensureListening();
    return {
      url: `${base}/${encodeURI(key)}?token=${this.token}&content-length=${String(contentLength)}`,
      method: "PUT",
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
      contentLength,
    };
  }

  override async presignGet(key: string, expiresInSeconds: number): Promise<PresignedUrl> {
    const base = await this.ensureListening();
    return {
      url: `${base}/${encodeURI(key)}?token=${this.token}`,
      method: "GET",
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.listening = null;
    if (server !== null) await new Promise((resolve) => server.close(resolve));
  }

  private ensureListening(): Promise<string> {
    if (this.listening !== null) return this.listening;
    this.listening = (async () => {
      const { createServer } = await import("node:http");
      const server = createServer((req, res) => void this.handle(req, res));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", resolve);
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : this.port;
      this.baseUrl = `http://127.0.0.1:${String(port)}`;
      return this.baseUrl;
    })();
    return this.listening;
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", this.baseUrl ?? "http://127.0.0.1");
      if (url.searchParams.get("token") !== this.token) {
        res.writeHead(403).end("bad token");
        return;
      }
      const key = decodeURI(url.pathname.replace(/^\/+/, ""));
      if (key === "") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "PUT") {
        const bound = Number.parseInt(url.searchParams.get("content-length") ?? "", 10);
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of req) {
          const buffer = chunk as Buffer;
          received += buffer.length;
          // The signed bound is a hard cap, as it is at the real bucket.
          if (Number.isFinite(bound) && received > bound) {
            res.writeHead(413).end("body exceeds the presigned content-length");
            return;
          }
          chunks.push(buffer);
        }
        await this.put(key, new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(200).end();
        return;
      }
      if (req.method === "GET") {
        const body = await this.get(key);
        if (body === null) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
          })
          .end(Buffer.from(body));
        return;
      }
      res.writeHead(405).end();
    } catch {
      res.writeHead(500).end();
    }
  }
}

/* ------------------------------------------------------------------ *
 * R2 (S3-compatible) adapter
 * ------------------------------------------------------------------ */

/** Reads R2_ENDPOINT (or R2_ACCOUNT_ID), R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. */
export type ObjectStoreEnv = Record<string, string | undefined>;

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8(data) as BufferSource));
}

/** RFC 3986 encoding; S3 canonicalization keeps `/` literal in the path. */
function uriEncode(value: string, keepSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

function amzDate(now: Date): { stamp: string; date: string } {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp, date: stamp.slice(0, 8) };
}

async function signingKey(config: R2Config, date: string): Promise<Uint8Array> {
  const kDate = await hmac(utf8(`AWS4${config.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, config.region);
  const kService = await hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

/**
 * AWS SigV4 over WebCrypto. Written out rather than pulled from an SDK because
 * the control plane adds no dependencies for four verbs and a query signature.
 */
class SigV4 {
  constructor(private readonly config: R2Config) {}

  private scope(date: string): string {
    return `${date}/${this.config.region}/s3/aws4_request`;
  }

  private objectUrl(key: string): URL {
    const base = this.config.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${uriEncode(this.config.bucket, false)}/${uriEncode(key, true)}`);
  }

  /**
   * Query-string ("presigned") authorization — the URL is the credential.
   *
   * When `contentLength` is given, `content-length` joins `host` in the signed
   * headers. The payload itself stays UNSIGNED (the client streams it and the
   * control plane never sees the bytes), but the LENGTH is now part of the
   * canonical request: a body of any other size, or one sent without the
   * header at all, produces a different signature and the bucket refuses it.
   * That is what stops a 4 MiB chunk grant from absorbing 5 GB.
   */
  async presign(
    method: "PUT" | "GET",
    key: string,
    expiresInSeconds: number,
    now: Date,
    contentLength?: number,
  ): Promise<PresignedUrl> {
    const { stamp, date } = amzDate(now);
    const url = this.objectUrl(key);
    const headers: Array<[string, string]> = [["host", url.host]];
    if (contentLength !== undefined) headers.push(["content-length", String(contentLength)]);
    headers.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const signedHeaders = headers.map(([name]) => name).join(";");
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${this.scope(date)}`,
      "X-Amz-Date": stamp,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
    });
    query.sort();
    const canonical = [
      method,
      url.pathname,
      query.toString(),
      `${headers.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      stamp,
      this.scope(date),
      await sha256Hex(utf8(canonical)),
    ].join("\n");
    const signature = toHex(await hmac(await signingKey(this.config, date), stringToSign));
    query.set("X-Amz-Signature", signature);
    url.search = query.toString();
    return {
      url: url.toString(),
      method,
      expiresAtMs: now.getTime() + expiresInSeconds * 1000,
      ...(contentLength === undefined ? {} : { contentLength }),
    };
  }

  /** Header authorization for the control plane's own requests. */
  async request(
    method: "PUT" | "GET" | "HEAD" | "DELETE",
    key: string,
    body: Uint8Array | undefined,
    contentType: string | undefined,
    now: Date,
  ): Promise<Request> {
    const { stamp, date } = amzDate(now);
    const url = this.objectUrl(key);
    const payloadHash = body === undefined ? EMPTY_SHA256 : await sha256Hex(body);
    const headers: Array<[string, string]> = [
      ["host", url.host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", stamp],
    ];
    if (contentType !== undefined) headers.push(["content-type", contentType]);
    headers.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const signedHeaders = headers.map(([name]) => name).join(";");
    const canonical = [
      method,
      url.pathname,
      "",
      `${headers.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      stamp,
      this.scope(date),
      await sha256Hex(utf8(canonical)),
    ].join("\n");
    const signature = toHex(await hmac(await signingKey(this.config, date), stringToSign));
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${this.scope(date)}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return new Request(url, {
      method,
      headers: Object.fromEntries([...headers, ["authorization", authorization]]),
      ...(body === undefined ? {} : { body: body as BodyInit }),
    });
  }
}

export class R2ObjectStore implements ObjectStore {
  private readonly signer: SigV4;

  constructor(private readonly config: R2Config) {
    this.signer = new SigV4(config);
  }

  async put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    const res = await fetch(await this.signer.request("PUT", key, body, contentType, new Date()));
    if (!res.ok) throw new Error(`object store PUT ${key} failed: ${res.status}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await fetch(await this.signer.request("GET", key, undefined, undefined, new Date()));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store GET ${key} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async head(key: string): Promise<ObjectHead | null> {
    const res = await fetch(await this.signer.request("HEAD", key, undefined, undefined, new Date()));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store HEAD ${key} failed: ${res.status}`);
    return {
      sizeBytes: Number(res.headers.get("content-length") ?? 0),
      contentType: res.headers.get("content-type"),
    };
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(
      await this.signer.request("DELETE", key, undefined, undefined, new Date()),
    );
    // 404 is success: the caller wants the object gone.
    if (!res.ok && res.status !== 404) {
      throw new Error(`object store DELETE ${key} failed: ${res.status}`);
    }
  }

  // No default for `contentLength`: an unbounded PUT grant must never be one
  // forgotten argument away.
  presignPut(key: string, expiresInSeconds: number, contentLength: number): Promise<PresignedUrl> {
    return this.signer.presign("PUT", key, expiresInSeconds, new Date(), contentLength);
  }

  presignGet(key: string, expiresInSeconds = PRESIGN_TTL_SECONDS): Promise<PresignedUrl> {
    return this.signer.presign("GET", key, expiresInSeconds, new Date());
  }

  describe(): string {
    return `${this.config.endpoint}/${this.config.bucket}`;
  }
}

/**
 * Build the production object store from the environment.
 *
 * Absent credentials are a HARD FAILURE, not a silent fallback to the stub: a
 * control plane that accepts uploads it cannot store would report success for
 * files that do not exist, which is the one failure mode a storage product
 * must never have. The stub is reachable only by naming it
 * (`OBJECT_STORE=stub`), and it says so on the way up.
 */
export function objectStoreFromEnv(env: ObjectStoreEnv): ObjectStore {
  if (env["OBJECT_STORE"] === "stub") {
    console.warn(
      "OBJECT_STORE=stub: chunk uploads are held in memory and lost on restart. Never use this in production.",
    );
    return new StubObjectStore();
  }
  if (env["OBJECT_STORE"] === "local") {
    console.warn(
      "OBJECT_STORE=local: chunk bytes are held in memory behind a loopback HTTP " +
        "server (fetchable presigned URLs, for dev end-to-end). Never use this in production.",
    );
    const port = Number.parseInt(env["OBJECT_STORE_PORT"] ?? "", 10);
    return new LocalHttpObjectStore(Number.isFinite(port) ? port : 0);
  }
  const accountId = env["R2_ACCOUNT_ID"];
  const endpoint =
    env["R2_ENDPOINT"] ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const bucket = env["R2_BUCKET"];
  const accessKeyId = env["R2_ACCESS_KEY_ID"];
  const secretAccessKey = env["R2_SECRET_ACCESS_KEY"];
  const missing = [
    endpoint === undefined ? "R2_ENDPOINT (or R2_ACCOUNT_ID)" : null,
    bucket === undefined ? "R2_BUCKET" : null,
    accessKeyId === undefined ? "R2_ACCESS_KEY_ID" : null,
    secretAccessKey === undefined ? "R2_SECRET_ACCESS_KEY" : null,
  ].filter((name): name is string => name !== null);
  if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      `object store is not configured: missing ${missing.join(", ")}. ` +
        "Set them, or set OBJECT_STORE=stub for an in-memory dev store.",
    );
  }
  return new R2ObjectStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env["R2_REGION"] ?? "auto",
  });
}
