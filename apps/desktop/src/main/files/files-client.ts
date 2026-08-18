/**
 * FilesClient — the desktop's half of the control plane's `/v1/files` API
 * (services/control, Phase 3 Stream A). Deliberately separate from
 * ControlClient: Files is a Phase-3 surface that a deployed Phase-1/2 control
 * plane does not have, and this client's job is to degrade honestly when the
 * routes are missing rather than surface a stack trace.
 *
 * ROUTE CONTRACT — these are the routes services/control actually serves
 * (services/control/src/app.ts, `v1.*("/files…")`). This client is the only
 * place the desktop encodes them, and test/files-routes.test.ts pins every
 * string below so the two halves cannot drift apart again:
 *
 *   GET    /v1/files?prefix=&limit=&cursor=  → { files: FileEntry[], nextCursor }
 *   GET    /v1/files/stat?path=              → { file, complete, chunkCount } | 404
 *   POST   /v1/files/manifest { path, manifest, contentType? }
 *                          → { file, complete, missing: ChunkRef[], quota }
 *   POST   /v1/files/complete { fileId }     → { file: FileEntry, complete }
 *   DELETE /v1/files/<id>                    → { deleted, path } | 404
 *   POST   /v1/files/chunks/<hash>/upload-url
 *                          → { hash, alreadyStored, sizeBytes, upload? }
 *   GET    /v1/files/chunks/<hash>/download-url → { hash, sizeBytes, download }
 *   GET    /v1/files/quota                   → { usedBytes, limitBytes, … }
 *   POST   /v1/files/transfers { url, destPath, totalBytes? } → { transfer }
 *   GET    /v1/files/transfers               → { transfers: Transfer[] }
 *   POST   /v1/files/transfers/<id>/progress → { transfer: Transfer }
 *   POST   /v1/files/transfers/<id>/cancel   → { transfer: Transfer }
 *
 *   GET    /v1/files/manifest?path=          → { manifest } | 404 | 409
 *
 * Nothing on any of these paths carries a browser credential: the transfer
 * route takes a URL the §8.6 eligibility check already cleared as
 * credential-free, and never a cookie, header, or client certificate (§8.6).
 */

import {
  fileEntrySchema,
  manifestSchema,
  transferSchema,
  type FileEntry,
  type Manifest,
  type QuotaState,
  type Transfer,
} from "@suma/protocol";

/** Thrown when the control plane has no Files API (or none is configured). */
export class FilesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesUnavailableError";
  }
}

/** Thrown for the §8.6 soft block, so callers can show the quota copy. */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** The control plane's own per-page ceiling (`filesListQuerySchema.limit`). */
const LIST_PAGE_LIMIT = 200;

/** Pages a single `list()` will walk before it stops asking. */
const MAX_LIST_PAGES = 25;

/** Entries one `list()` returns at most — MAX_LIST_PAGES × LIST_PAGE_LIMIT. */
export const MAX_LIST_ENTRIES = LIST_PAGE_LIMIT * MAX_LIST_PAGES;

export interface FilesClientDeps {
  /** Control-plane base URL; null in local-only mode. */
  baseUrl: () => string | null;
  /** Device token; null while unenrolled. */
  token: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class FilesClient {
  constructor(private readonly deps: FilesClientDeps) {}

  /** Whether a cloud fetch could even be created right now. */
  configured(): boolean {
    return this.deps.baseUrl() !== null;
  }

  /**
   * One directory's worth of entries. The control plane caps a page at 200 and
   * pages with a keyset cursor, so asking for more than that is a 400 rather
   * than a bigger answer: this walks the cursor instead, up to a bounded total.
   */
  async list(prefix: string, limit = MAX_LIST_ENTRIES): Promise<FileEntry[]> {
    const budget = Math.min(Math.max(0, Math.floor(limit)), MAX_LIST_ENTRIES);
    const entries: FileEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES && entries.length < budget; page++) {
      const query = new URLSearchParams({
        prefix,
        limit: String(Math.min(LIST_PAGE_LIMIT, budget - entries.length)),
      });
      if (cursor !== null) query.set("cursor", cursor);
      const body = await this.request<{ files?: unknown; nextCursor?: unknown }>(
        "GET",
        `/v1/files?${query.toString()}`,
      );
      entries.push(...parseEntries(body.files));
      // A cursor with no entries behind it would loop forever; the page bound
      // above is the backstop, and an empty page ends the walk here.
      if (typeof body.nextCursor !== "string" || body.nextCursor.length === 0) break;
      cursor = body.nextCursor;
    }
    return entries;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const body = await this.request<{ file?: unknown }>(
      "GET",
      `/v1/files/stat?path=${encodeURIComponent(path)}`,
      undefined,
      /* missingOk */ true,
    );
    if (body === null || body.file === undefined) return null;
    return fileEntrySchema.parse(body.file);
  }

  /**
   * The stored chunk list for a file, so hydration and inline preview can
   * presign, verify and assemble it. A path with no file is `null`; an upload
   * that never completed answers 409 upstream, which surfaces as a refusal
   * rather than a manifest whose chunks the store may not hold yet.
   */
  async manifest(path: string): Promise<Manifest | null> {
    const body = await this.request<{ manifest?: unknown }>(
      "GET",
      `/v1/files/manifest?path=${encodeURIComponent(path)}`,
      undefined,
      /* missingOk */ true,
    );
    if (body === null || body.manifest === undefined) return null;
    return manifestSchema.parse(body.manifest);
  }

  /** Create-from-manifest: returns the chunk hashes the store still needs. */
  async createFromManifest(args: {
    path: string;
    manifest: Manifest;
    contentType: string | null;
  }): Promise<{ file: FileEntry; missing: string[] }> {
    const body = await this.request<{ file?: unknown; missing?: unknown }>(
      "POST",
      "/v1/files/manifest",
      // The write schemas are `.strict()`: a null contentType is a 400, not a
      // shrug, so an absent one is absent rather than null.
      args.contentType === null
        ? { path: args.path, manifest: args.manifest }
        : { path: args.path, manifest: args.manifest, contentType: args.contentType },
    );
    return { file: fileEntrySchema.parse(body.file), missing: missingHashes(body.missing) };
  }

  /** Confirm every chunk landed. Keyed by file id — the path is not accepted. */
  async completeUpload(fileId: string): Promise<FileEntry> {
    const body = await this.request<{ file?: unknown }>("POST", "/v1/files/complete", { fileId });
    return fileEntrySchema.parse(body.file);
  }

  /**
   * Delete by path, which the control plane deletes by id — so the id is
   * looked up first. A path that is already gone is not an error: the caller
   * asked for it to not be there.
   */
  async remove(path: string): Promise<void> {
    const file = await this.stat(path);
    if (file === null) return;
    await this.request(
      "DELETE",
      `/v1/files/${encodeURIComponent(file.id)}`,
      undefined,
      // Deleted between the stat and here: still gone, which is what was asked
      // for — not "this account has no Files".
      /* missingOk */ true,
    );
  }

  /**
   * Presigned PUT per chunk — chunk bytes never pass through control. A hash
   * the store already holds has NO url and is absent from the map: there is
   * nothing to upload for it. Any other missing url is an error, not a skip.
   */
  async presignChunkUploads(hashes: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (const hash of hashes) {
      const body = await this.request<{ alreadyStored?: unknown; upload?: unknown }>(
        "POST",
        `/v1/files/chunks/${encodeURIComponent(hash)}/upload-url`,
        undefined,
        // A 404 means the control plane has no row for this chunk — a fact
        // about this upload, reported below, not a control plane without Files.
        /* missingOk */ true,
      );
      if (body === null) throw new Error(`control plane returned no upload URL for chunk ${hash}`);
      if (body.alreadyStored === true) continue;
      const url = presignedUrl(body.upload);
      if (url === null) throw new Error(`control plane returned no upload URL for chunk ${hash}`);
      urls.set(hash, url);
    }
    return urls;
  }

  /** Presigned GET per chunk — every hash must resolve or hydration is a lie. */
  async presignChunkDownloads(hashes: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (const hash of hashes) {
      const body = await this.request<{ download?: unknown }>(
        "GET",
        `/v1/files/chunks/${encodeURIComponent(hash)}/download-url`,
        undefined,
        // A 404 here means this chunk's bytes are not stored — a fact about
        // one file, not a control plane without Files.
        /* missingOk */ true,
      );
      const url = body === null ? null : presignedUrl(body.download);
      if (url === null) throw new Error(`control plane returned no download URL for chunk ${hash}`);
      urls.set(hash, url);
    }
    return urls;
  }

  async quota(): Promise<QuotaState> {
    const body = await this.request<{ usedBytes?: unknown; limitBytes?: unknown }>(
      "GET",
      "/v1/files/quota",
    );
    return {
      usedBytes: typeof body.usedBytes === "number" ? body.usedBytes : 0,
      limitBytes: typeof body.limitBytes === "number" ? body.limitBytes : 0,
    };
  }

  /**
   * Queue a cloud fetch. The URL handed over has already passed
   * `cloudFetchEligibility` — public or presigned only, no credential of any
   * kind travels with it (§8.6).
   */
  async createTransfer(
    url: string,
    destPath: string,
    totalBytes?: number,
  ): Promise<Transfer> {
    const body = await this.request<{ transfer?: unknown }>(
      "POST",
      "/v1/files/transfers",
      {
        url,
        destPath,
        ...(totalBytes === undefined ? {} : { totalBytes }),
      },
    );
    return transferSchema.parse(body.transfer);
  }

  /** Persist a lifecycle event received over the agent mux. */
  async reportTransfer(
    id: string,
    report: {
      state: Transfer["state"];
      receivedBytes: number;
      totalBytes?: number;
      error?: string;
    },
  ): Promise<Transfer> {
    const body = await this.request<{ transfer?: unknown }>(
      "POST",
      `/v1/files/transfers/${encodeURIComponent(id)}/progress`,
      report,
    );
    return transferSchema.parse(body.transfer);
  }

  async listTransfers(): Promise<Transfer[]> {
    const body = await this.request<{ transfers?: unknown }>("GET", "/v1/files/transfers");
    return Array.isArray(body.transfers)
      ? body.transfers.map((transfer) => transferSchema.parse(transfer))
      : [];
  }

  async cancelTransfer(id: string): Promise<Transfer | null> {
    const body = await this.request<{ transfer?: unknown }>(
      "POST",
      `/v1/files/transfers/${encodeURIComponent(id)}/cancel`,
      {},
    );
    return body.transfer === undefined ? null : transferSchema.parse(body.transfer);
  }

  /* ------------------------------ internals ------------------------------ */

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    missingOk = false,
  ): Promise<T> {
    const baseUrl = this.deps.baseUrl();
    if (baseUrl === null) {
      throw new FilesUnavailableError(
        "Suma Files needs an account — sign in to use your cloud files.",
      );
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = await this.deps.token();
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch (err) {
      throw new FilesUnavailableError(`Files service unreachable at ${baseUrl} (${String(err)})`);
    }

    if (res.status === 404 && missingOk) return null as T;
    if (res.status === 404 || res.status === 501) {
      // A control plane that predates Phase 3 — say so instead of pretending
      // the user's files are missing.
      throw new FilesUnavailableError("This Suma account doesn't have Files enabled yet.");
    }
    if (res.status === 413) {
      throw new QuotaExceededError(await errorDetail(res, "That would put you over your Files quota."));
    }
    if (res.status === 401 || res.status === 403) {
      // 401 and 403 are different problems and the fix differs, so they must
      // not share one sentence. A 401 is this Mac's token (the control client
      // re-proves the device key and retries before we ever get here, so
      // reaching this means the device really is revoked); a 403 is the
      // account not being allowed to do this, and the control plane says why
      // in the body — throwing that away left users chasing a sign-in problem
      // they did not have.
      throw new FilesUnavailableError(await authFailureDetail(res));
    }
    if (!res.ok) {
      throw new Error(await errorDetail(res, `files: ${String(res.status)} (${method} ${path})`));
    }
    if (res.status === 204) return {} as T;
    try {
      return (await res.json()) as T;
    } catch {
      return {} as T;
    }
  }
}

/** Plain-English names for the account features the control plane gates on. */
const FEATURE_LABELS: Readonly<Record<string, string>> = {
  "cloud-fetch": "cloud downloads",
  files: "Files",
};

/**
 * Why a Files request was refused, in words the user can act on. A 403 carries
 * a structured reason (`feature_required` and which feature); a 401 that
 * survived the control client's re-proof means this Mac is genuinely revoked.
 */
async function authFailureDetail(res: Response): Promise<string> {
  let parsed: { error?: unknown; explanation?: unknown; feature?: unknown } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // non-JSON body — fall through to the status-based copy
  }
  if (parsed.error === "feature_required") {
    const feature = typeof parsed.feature === "string" ? parsed.feature : "";
    const label = FEATURE_LABELS[feature] ?? feature ?? "";
    return label === ""
      ? "This Suma account isn't enabled for that yet."
      : `This Suma account isn't enabled for ${label} yet.`;
  }
  if (typeof parsed.explanation === "string") return parsed.explanation;
  if (res.status === 403) {
    return typeof parsed.error === "string"
      ? `Suma Files refused that for this account (${parsed.error}).`
      : "Suma Files refused that for this account.";
  }
  return "This Mac is no longer authorized for Suma Files — it may have been revoked.";
}

async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const parsed = (await res.json()) as { error?: unknown; explanation?: unknown };
    if (typeof parsed.explanation === "string") return parsed.explanation;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // non-JSON body — the fallback copy is what the user sees
  }
  return fallback;
}

/**
 * The chunks `POST /v1/files/manifest` says are still missing. They arrive as
 * `{ hash, offset, length }` refs; the upload path only needs the hashes.
 */
function missingHashes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hashes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { hash } = entry as { hash?: unknown };
    if (typeof hash === "string" && hash.length > 0) hashes.push(hash);
  }
  return hashes;
}

/** The `{ url, method, expiresAtMs }` a presign route answers with. */
function presignedUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { url } = value as { url?: unknown };
  return typeof url === "string" && url.length > 0 ? url : null;
}

function parseEntries(value: unknown): FileEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FileEntry[] = [];
  for (const raw of value) {
    const parsed = fileEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}
