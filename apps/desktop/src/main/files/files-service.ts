/**
 * FilesService — the `files:*` / `transfers:*` IPC surface (PRD §8.6, M-3
 * Lite). Browsing, chunked upload, hydration back to this Mac, deletion, the
 * quota meter, and the cloud-fetch transfer list that every device can see.
 *
 * Chunking is the shared @suma/chunking implementation (FROZEN, and
 * byte-identical to the Rust agent's) so an upload from this Mac deduplicates
 * against chunks any other device already stored. It is imported by path, the
 * way egress-service.ts imports @suma/egress-policy, because it is not a
 * declared dependency of the desktop package.
 *
 * §8.6 boundary: `startCloudFetch` is the ONLY path from a browser download to
 * the compute plane, and it is reached only for a URL the frozen
 * `cloudFetchEligibility` cleared — public or presigned, no cookie, no
 * Authorization header, no client certificate, no userinfo. This service never
 * reads a cookie jar and never forwards a request header.
 */

import { randomUUID } from "node:crypto";
import { stat as statFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import {
  CLOUD_ROOT,
  fromBase64,
  normalizeVfsPath,
  type AgentCtlRequest,
  type AgentCtlResponse,
  type FileEntry,
  type Transfer,
  type VfsRequest,
  type VfsResponse,
} from "@suma/protocol";
import {
  assembleFromChunks,
  buildManifest,
  hashChunk,
  type ChunkManifest,
} from "../../../../../packages/chunking/src/index";
import type {
  CloudFetchDeclined,
  DirectoryListing,
  FileBytes,
  FilesContext,
  FilesDevice,
  FileUploadResult,
  QuotaMeter,
  TransfersUpdate,
  UploadProgress,
  UploadState,
} from "../../shared/ipc";
import { FilesClient, FilesUnavailableError } from "./files-client";
import { contentTypeFor } from "./mime";
import { basename, dirname, listDirectory, normalizeDirPath, presentQuota } from "./tree";

/**
 * Uploads arrive as bytes from the Files page and are chunked in memory, so a
 * whole file is resident while it is stored. A refused upload with a clear
 * reason beats an out-of-memory crash; streaming chunking is a follow-up.
 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Ceiling on a `files:read`, whatever the caller asks for. It matches the
 * Files app's largest preview budget (a whole small image), which is the only
 * thing this channel exists for: preview reads a bounded head, and a real copy
 * of a file goes through `download` and lands on disk where the user can see
 * it.
 */
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

/** §8.6 V1 truth, stated once: Files storage is not end-to-end encrypted. */
const V1_END_TO_END_ENCRYPTED = false;

/** Poll cadence while a transfer is moving, and the idle refresh cadence. */
const POLL_MS = 4_000;
const IDLE_REFRESH_TICKS = 8;

/** How long to wait for `fetch.started` before treating the agent as too
 *  old to run background fetches (it would answer fetch.done-first, later). */
const FETCH_START_TIMEOUT_MS = 10_000;

/** Progress events arrive per 64 KiB; the renderer needs far less. */
const AGENT_PROGRESS_PUSH_MS = 500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const ACTIVE_STATES: ReadonlySet<Transfer["state"]> = new Set(["queued", "fetching", "storing"]);

export interface FilesDeps {
  client: FilesClient;
  /**
   * The machine behind the terminal/IDE — where an eligible public download
   * actually fetches (§8.6, via `fetch.public`). The VM in cloud mode, the
   * SimAgent/home Mac in local mode. Progress and completion arrive as
   * unsolicited ctl events, correlated by fetchId.
   */
  agent: {
    ctl: (request: AgentCtlRequest) => Promise<AgentCtlResponse | null>;
    onCtlEvent: (listener: (event: AgentCtlResponse) => void) => () => void;
    connected: () => boolean;
    vfs: (request: VfsRequest) => Promise<VfsResponse>;
  };
  /** Push to the chrome renderer AND the suma://files page. */
  emitTransfers: (update: TransfersUpdate) => void;
  emitChanged: (payload: { path: string }) => void;
  /** Per-upload progress, for the page that started it. */
  emitUploadProgress: (progress: UploadProgress) => void;
  /** This Mac's Downloads folder, for hydration. */
  downloadsDir: () => string;
  /** This device's id — shown as the origin of a transfer on other Macs. */
  deviceId: string;
  /**
   * How this Mac appears in `Transfer.originDeviceId` once enrolled (the
   * control-plane device row id), plus the label to show for it. Ids and
   * names only — never a token, an email, or key material (§8.2, §8.6).
   */
  identity: () => { cloudDeviceId: string | null; name: string | null };
  /** Display names for the account's devices; [] when offline or unenrolled. */
  listDevices: () => Promise<FilesDevice[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class FilesService {
  private transfers: Transfer[] = [];
  /** Transfers that never reached the control plane — kept so a failed cloud
   *  fetch is visible instead of vanishing after the local download stopped. */
  private readonly localFailures = new Map<string, Transfer>();
  /** Agent-side fetches (`fetch.public`), keyed by the durable control-plane
   * transfer id, which is also the fetchId on every mux event. */
  private readonly agentTransfers = new Map<string, Transfer>();
  /** Serialize reports/storage per transfer so completion cannot overtake a
   * slow progress request on the control plane. */
  private readonly agentTransferTails = new Map<string, Promise<void>>();
  private readonly lastAgentProgressPushMs = new Map<string, number>();
  private declined: CloudFetchDeclined | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private readonly unsubAgentEvents: () => void;

  constructor(private readonly deps: FilesDeps) {
    this.unsubAgentEvents = deps.agent.onCtlEvent((event) => {
      this.onAgentEvent(event);
    });
  }

  /* -------------------------------- browse ------------------------------- */

  async list(dirPath?: string): Promise<DirectoryListing> {
    const dir = normalizeDirPath(dirPath);
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const entries = await this.deps.client.list(prefix);
    return listDirectory(entries, dir);
  }

  async stat(filePath: string): Promise<FileEntry | null> {
    const normalized = this.requirePath(filePath);
    return this.deps.client.stat(normalized);
  }

  /** Every stored path under `prefix` — the raw list, for feature-owned cloud
   *  trees (the saved-videos /Videos reconcile) that want paths, not one
   *  directory level of the Files page's tree. */
  async listPaths(prefix: string): Promise<string[]> {
    const entries = await this.deps.client.list(prefix);
    return entries.map((entry) => entry.path);
  }

  async quota(): Promise<QuotaMeter> {
    return presentQuota(await this.deps.client.quota());
  }

  /**
   * The head of a file, for inline preview (§8.6 "text/image inline;
   * everything else gets a type + size"). Null means the file is not there —
   * distinct from an empty slice, so the page can say "no longer in Files"
   * instead of drawing a blank pane.
   *
   * Bounded twice (the caller's budget, then MAX_PREVIEW_BYTES) and only the
   * chunks that overlap the slice are fetched, so previewing the top of a 3 GB
   * archive costs one chunk rather than a hydration. Each chunk is still
   * verified against its BLAKE3 address: a presigned GET returns bytes from a
   * store Suma did not write.
   */
  async read(filePath: string, maxBytes: number): Promise<FileBytes | null> {
    const normalized = this.requirePath(filePath);
    const manifest = await this.deps.client.manifest(normalized);
    if (manifest === null) return null;

    const budget = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0;
    const limit = Math.min(Math.max(0, budget), MAX_PREVIEW_BYTES);
    const totalBytes = manifest.totalBytes;
    const length = Math.min(limit, totalBytes);
    const data = new Uint8Array(length);
    if (length === 0) return { data, truncated: totalBytes > 0, totalBytes };

    const needed = manifest.chunks.filter((chunk) => chunk.offset < length);
    const urls = await this.deps.client.presignChunkDownloads([
      ...new Set(needed.map((chunk) => chunk.hash)),
    ]);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const fetched = new Map<string, Uint8Array>();

    for (const chunk of needed) {
      let bytes = fetched.get(chunk.hash);
      if (bytes === undefined) {
        const url = urls.get(chunk.hash);
        if (url === undefined) throw new Error(`no download URL for chunk ${chunk.hash}`);
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`chunk ${chunk.hash} download failed (${String(res.status)})`);
        bytes = new Uint8Array(await res.arrayBuffer());
        if (hashChunk(bytes) !== chunk.hash) {
          throw new Error(`chunk ${chunk.hash} failed its integrity check`);
        }
        fetched.set(chunk.hash, bytes);
      }
      const take = Math.min(bytes.byteLength, length - chunk.offset);
      if (take > 0) data.set(bytes.subarray(0, take), chunk.offset);
    }
    return { data, truncated: length < totalBytes, totalBytes };
  }

  /**
   * Who this Mac is and what to call the devices a cloud fetch can come from.
   * Ids and display names only — the `files:context` contract spells out why
   * nothing else belongs here.
   */
  async context(): Promise<FilesContext> {
    const identity = this.deps.identity();
    const names = new Map<string, string>();
    try {
      for (const device of await this.deps.listDevices()) names.set(device.id, device.name);
    } catch {
      // Names are a courtesy. A raw device id in one row beats failing the
      // whole page because the control plane is unreachable.
    }
    // A cloud fetch that failed before the control plane ever saw it carries
    // the LOCAL device id, while control stamps its own row id on the ones it
    // created. Both mean this Mac, so both resolve to a label here.
    const localName = identity.name;
    if (localName !== null && !names.has(this.deps.deviceId)) {
      names.set(this.deps.deviceId, localName);
    }
    return {
      thisDeviceId: identity.cloudDeviceId ?? this.deps.deviceId,
      devices: [...names].map(([id, name]) => ({ id, name })),
      cloudRoot: CLOUD_ROOT,
      endToEndEncrypted: V1_END_TO_END_ENCRYPTED,
    };
  }

  /* -------------------------------- upload ------------------------------- */

  /**
   * Store bytes the Files page already holds. Chunking happens here, so only
   * chunks the store does not already have are uploaded (§7 dedup), and each
   * one goes straight to object storage through a presigned PUT rather than
   * through the control plane.
   *
   * Progress is reported from here for the same reason: only this side knows
   * how much of the file the store already had, so a page-side guess would be
   * a fiction. Dedup makes `sentBytes` jump — that is real progress, not
   * traffic.
   */
  async upload(args: {
    path: string;
    contentType: string | null;
    data: Uint8Array;
    /** The page's correlation id; without it no progress is emitted. */
    uploadId?: string;
  }): Promise<FileUploadResult> {
    const destPath = normalizeVfsPath(args.path);
    if (destPath === null || destPath === "/") throw new Error(`invalid destination "${args.path}"`);
    const totalBytes = args.data.byteLength;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${basename(destPath)} is larger than the ${String(
          Math.round(MAX_UPLOAD_BYTES / 1024 ** 2),
        )} MB upload limit in this version.`,
      );
    }
    const report = this.uploadReporter(args.uploadId, destPath, totalBytes);
    report("hashing", 0, null);
    try {
      const manifest = buildManifest(args.data);
      const created = await this.deps.client.createFromManifest({
        path: destPath,
        manifest,
        contentType: args.contentType ?? contentTypeFor(destPath),
      });
      const unique = new Set(manifest.chunks.map((chunk) => chunk.hash)).size;
      const missing = new Set(created.missing);
      // Chunks R2 already held are bytes the user never waits for.
      let sentBytes = manifest.chunks.reduce(
        (sum, chunk) => (missing.has(chunk.hash) ? sum : sum + chunk.length),
        0,
      );
      report("uploading", sentBytes, null);
      await this.uploadChunks(manifest, args.data, created.missing, (stored) => {
        sentBytes += stored;
        report("uploading", sentBytes, null);
      });
      // Completion is keyed by the id the manifest write just returned: the
      // control plane confirms chunk bytes per FILE, not per path.
      const file = await this.deps.client.completeUpload(created.file.id);
      report("completed", totalBytes, null);
      this.deps.emitChanged({ path: dirname(destPath) });
      return {
        file,
        uploadedChunks: created.missing.length,
        dedupedChunks: Math.max(0, unique - created.missing.length),
      };
    } catch (err) {
      // The invoke rejects too; this is so a page watching progress sees the
      // upload stop rather than hang at its last percentage.
      report("failed", 0, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /* ------------------------------- hydrate ------------------------------- */

  /**
   * Reassemble a cloud file into memory — the shared read-back path under
   * `download` (→ Downloads folder) and the saved-videos hydration (→ the
   * media cache, main/videos). Every chunk is verified against its BLAKE3
   * address before use, and `assembleFromChunks` re-checks the whole file
   * hash — a presigned GET is still bytes from a store we did not write.
   * Manifests come from `GET /v1/files/manifest` (the read-back route).
   */
  async downloadBytes(filePath: string): Promise<Uint8Array> {
    const normalized = this.requirePath(filePath);
    const manifest = await this.deps.client.manifest(normalized);
    if (manifest === null) throw new Error(`${normalized} is not in your cloud files`);
    const hashes = [...new Set(manifest.chunks.map((chunk) => chunk.hash))];
    const urls = await this.deps.client.presignChunkDownloads(hashes);
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    const chunks = new Map<string, Uint8Array>();
    for (const hash of hashes) {
      const url = urls.get(hash);
      if (url === undefined) throw new Error(`no download URL for chunk ${hash}`);
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`chunk ${hash} download failed (${String(res.status)})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (hashChunk(bytes) !== hash) throw new Error(`chunk ${hash} failed its integrity check`);
      chunks.set(hash, bytes);
    }

    return assembleFromChunks(manifest as ChunkManifest, (hash) => chunks.get(hash));
  }

  /** Hydrate a cloud file into this Mac's Downloads folder. */
  async download(filePath: string): Promise<{ savePath: string }> {
    const normalized = this.requirePath(filePath);
    const assembled = await this.downloadBytes(normalized);
    const savePath = await uniqueSavePath(
      path.join(this.deps.downloadsDir(), basename(normalized) || "download"),
    );
    await writeFile(savePath, assembled);
    return { savePath };
  }

  async remove(filePath: string): Promise<void> {
    const normalized = this.requirePath(filePath);
    await this.deps.client.remove(normalized);
    this.deps.emitChanged({ path: dirname(normalized) });
  }

  /* ------------------------------ transfers ------------------------------ */

  snapshot(): TransfersUpdate {
    const agentRows = [...this.agentTransfers.values()].map((transfer) => ({
      ...transfer,
      // No agent-side cancel op exists yet — active rows say so honestly.
      cancellable: !ACTIVE_STATES.has(transfer.state),
    }));
    const localIds = new Set([
      ...agentRows.map((transfer) => transfer.id),
      ...this.localFailures.keys(),
    ]);
    const merged = [
      ...agentRows,
      ...this.localFailures.values(),
      ...this.transfers.filter((transfer) => !localIds.has(transfer.id)),
    ].sort((a, b) => b.startedAtMs - a.startedAtMs);
    return { transfers: merged, declined: this.declined };
  }

  /** Fetch the current transfer list (all devices) and push it out. */
  async refreshTransfers(): Promise<TransfersUpdate> {
    if (!this.deps.client.configured()) return this.snapshot();
    try {
      this.transfers = await this.deps.client.listTransfers();
      // A control-plane transfer supersedes the local failure it replaced.
      for (const transfer of this.transfers) this.localFailures.delete(transfer.id);
    } catch (err) {
      if (!(err instanceof FilesUnavailableError)) throw err;
      // No Files API on this control plane — keep whatever we know locally.
    }
    this.push();
    return this.snapshot();
  }

  async cancelTransfer(id: string): Promise<void> {
    if (this.localFailures.delete(id)) {
      this.push();
      return;
    }
    const agentRow = this.agentTransfers.get(id);
    if (agentRow !== undefined) {
      // Settled rows dismiss; an active fetch has no cancel op (the UI
      // hides the button, but be safe against a stale renderer).
      if (!ACTIVE_STATES.has(agentRow.state)) {
        await this.agentTransferTails.get(id)?.catch(() => undefined);
        this.agentTransfers.delete(id);
        this.lastAgentProgressPushMs.delete(id);
        this.push();
      }
      return;
    }
    await this.deps.client.cancelTransfer(id);
    await this.refreshTransfers();
  }

  /** True when a cloud fetch could be created right now (§8.6 routing input)
   *  — the AGENT is what fetches now, so its link is the availability. */
  cloudAvailable(): boolean {
    return this.deps.agent.connected() && this.deps.client.configured();
  }

  /**
   * Hand an ELIGIBLE download to the account's computer via `fetch.public`.
   *
   * Returns true only when the agent answered `fetch.started` — the caller
   * keeps its local download running until then, and abandons it only on a
   * true. A failure is still visible either way: it becomes a failed
   * transfer row rather than a silent no-op.
   */
  async startCloudFetch(args: {
    url: string;
    filename: string;
    destPath: string;
    totalBytes: number;
  }): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    const pendingId = `agent-${randomUUID()}`;
    const row: Transfer = {
      id: pendingId,
      url: args.url,
      destPath: args.destPath,
      state: "queued",
      receivedBytes: 0,
      totalBytes: Math.max(0, args.totalBytes),
      originDeviceId: this.deps.deviceId,
      error: null,
      startedAtMs: now,
      updatedAtMs: now,
    };
    this.agentTransfers.set(pendingId, row);
    this.push();

    let transfer: Transfer;
    try {
      transfer = await this.deps.client.createTransfer(
        args.url,
        args.destPath,
        args.totalBytes > 0 ? args.totalBytes : undefined,
      );
    } catch (err) {
      this.agentTransfers.delete(pendingId);
      row.state = "failed";
      row.error = `Couldn't queue the fetch — ${
        err instanceof Error ? err.message : String(err)
      }`.slice(0, 500);
      row.updatedAtMs = (this.deps.now ?? Date.now)();
      this.localFailures.set(pendingId, row);
      this.push();
      return false;
    }

    const id = transfer.id;
    this.agentTransfers.delete(pendingId);
    this.agentTransfers.set(id, transfer);
    this.push();

    const fail = async (message: string): Promise<false> => {
      const current = this.agentTransfers.get(id);
      try {
        const updated = await this.deps.client.reportTransfer(id, {
          state: "failed",
          receivedBytes: current?.receivedBytes ?? 0,
          error: `Couldn't start the fetch — ${message}`.slice(0, 500),
        });
        this.agentTransfers.set(id, updated);
      } catch {
        this.settleAgentRow(id, {
          state: "failed",
          error: `Couldn't start the fetch — ${message}`.slice(0, 500),
        });
      }
      this.push();
      return false;
    };

    try {
      const updated = await this.deps.client.reportTransfer(id, {
        state: "fetching",
        receivedBytes: 0,
      });
      this.agentTransfers.set(id, updated);
      this.push();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    let response: AgentCtlResponse | null;
    try {
      // The timeout is the version-skew guard: an old agent runs the fetch
      // INSIDE dispatch and answers fetch.done first, which would leave this
      // promise waiting forever. Ten seconds without fetch.started ⇒ treat
      // as unsupported and keep the local download.
      response = await withTimeout(
        this.deps.agent.ctl({
          t: "fetch.public",
          fetchId: id,
          url: args.url,
          destPath: args.destPath,
        }),
        FETCH_START_TIMEOUT_MS,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (response === null) return fail("the agent gave no answer");
    if (response.t === "error") return fail(response.message);
    if (response.t !== "fetch.started")
      return fail(`unexpected answer ${response.t}`);
    if (response.fetchId !== id)
      return fail("the agent returned the wrong fetch id");
    return true;
  }

  /** Fold one unsolicited agent event into the matching durable transfer. */
  private onAgentEvent(event: AgentCtlResponse): void {
    if (
      event.t !== "fetch.progress" &&
      event.t !== "fetch.done" &&
      event.t !== "fetch.failed"
    ) {
      return;
    }
    const id = event.fetchId;
    const row = this.agentTransfers.get(id);
    if (row === undefined || !ACTIVE_STATES.has(row.state)) return;
    if (
      event.url !== row.url ||
      (event.t !== "fetch.progress" && event.path !== row.destPath)
    ) {
      this.settleAgentRow(id, {
        state: "failed",
        error: "Agent fetch event did not match its transfer.",
      });
      this.enqueueAgentTask(id, async () => {
        await this.reportAgentFailure(
          id,
          "Agent fetch event did not match its transfer.",
        );
      });
      return;
    }
    if (event.t === "fetch.progress") {
      row.receivedBytes = event.received;
      row.totalBytes = event.total;
      row.updatedAtMs = (this.deps.now ?? Date.now)();
      const nowMs = (this.deps.now ?? Date.now)();
      const lastPush = this.lastAgentProgressPushMs.get(id) ?? 0;
      if (nowMs - lastPush >= AGENT_PROGRESS_PUSH_MS) {
        this.lastAgentProgressPushMs.set(id, nowMs);
        this.push();
        this.enqueueAgentTask(id, async () => {
          try {
            const updated = await this.deps.client.reportTransfer(id, {
              state: "fetching",
              receivedBytes: event.received,
            });
            this.agentTransfers.set(id, updated);
            this.push();
          } catch {
            // A later heartbeat or terminal report retries the durable state.
          }
        });
      }
      return;
    }
    if (event.t === "fetch.done") {
      this.updateAgentRow(id, { state: "storing", receivedBytes: event.bytes });
      this.enqueueAgentTask(id, async () => this.storeAgentFetch(id, event));
      return;
    }
    this.settleAgentRow(id, {
      state: "failed",
      error: event.error.slice(0, 500),
    });
    this.enqueueAgentTask(id, async () => {
      await this.reportAgentFailure(id, event.error);
    });
  }

  private updateAgentRow(id: string, patch: Partial<Transfer>): void {
    const row = this.agentTransfers.get(id);
    if (row === undefined) return;
    Object.assign(row, patch, { updatedAtMs: (this.deps.now ?? Date.now)() });
    this.push();
  }

  private settleAgentRow(id: string, patch: Partial<Transfer>): void {
    this.updateAgentRow(id, patch);
  }

  private enqueueAgentTask(id: string, task: () => Promise<void>): void {
    const previous = this.agentTransferTails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.agentTransferTails.set(id, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.agentTransferTails.get(id) === next)
          this.agentTransferTails.delete(id);
      });
  }

  /** Store a completed agent fetch in the canonical Files data plane before
   * declaring its durable transfer complete. */
  private async storeAgentFetch(
    id: string,
    event: Extract<AgentCtlResponse, { t: "fetch.done" }>,
  ): Promise<void> {
    try {
      const storing = await this.deps.client.reportTransfer(id, {
        state: "storing",
        receivedBytes: event.bytes,
      });
      this.agentTransfers.set(id, storing);
      this.push();

      if (event.manifest === undefined) {
        throw new Error("agent completed the fetch without a chunk manifest");
      }
      if (event.manifest.totalBytes !== event.bytes) {
        throw new Error(
          "agent manifest size does not match the fetched byte count",
        );
      }
      const created = await this.deps.client.createFromManifest({
        path: event.path,
        manifest: event.manifest,
        contentType: contentTypeFor(event.path),
      });
      await this.uploadAgentChunks(event.path, event.manifest, created.missing);
      await this.deps.client.completeUpload(created.file.id);
      const completed = await this.deps.client.reportTransfer(id, {
        state: "completed",
        receivedBytes: event.bytes,
      });
      this.agentTransfers.set(id, completed);
      this.push();
      this.deps.emitChanged({ path: dirname(event.path) });
    } catch (err) {
      await this.reportAgentFailure(
        id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async reportAgentFailure(id: string, reason: string): Promise<void> {
    const message = reason.slice(0, 500);
    const row = this.agentTransfers.get(id);
    try {
      const failed = await this.deps.client.reportTransfer(id, {
        state: "failed",
        receivedBytes: row?.receivedBytes ?? 0,
        error: message,
      });
      this.agentTransfers.set(id, failed);
      this.push();
    } catch {
      this.settleAgentRow(id, { state: "failed", error: message });
    }
  }

  /** Upload only the content-addressed chunks the control plane is missing.
   * Each bounded chunk is read over vfs and verified before its presigned PUT. */
  private async uploadAgentChunks(
    filePath: string,
    manifest: ChunkManifest,
    missing: string[],
  ): Promise<void> {
    if (missing.length === 0) return;
    const urls = await this.deps.client.presignChunkUploads(missing);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    for (const hash of missing) {
      const chunk = manifest.chunks.find(
        (candidate) => candidate.hash === hash,
      );
      if (chunk === undefined)
        throw new Error(`chunk ${hash} is not part of the fetched file`);
      const response = await this.deps.agent.vfs({
        t: "vfs.read",
        path: filePath,
        offset: chunk.offset,
        length: chunk.length,
      });
      if (response.t === "error") {
        throw new Error(`reading fetched chunk ${hash}: ${response.message}`);
      }
      if (response.t !== "vfs.data" || response.offset !== chunk.offset) {
        throw new Error(`agent returned the wrong data for chunk ${hash}`);
      }
      const bytes = fromBase64(response.dataB64);
      if (bytes.byteLength !== chunk.length || hashChunk(bytes) !== hash) {
        throw new Error(`fetched chunk ${hash} failed its integrity check`);
      }
      const url = urls.get(hash);
      if (url === undefined) continue; // the store acquired it meanwhile
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const uploaded = await fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([copy]),
      });
      if (!uploaded.ok)
        throw new Error(`chunk upload failed (${String(uploaded.status)})`);
    }
  }

  /** Record why a download stayed on this Mac (§8.6) and surface it. */
  noteDeclined(declined: CloudFetchDeclined): void {
    this.declined = declined;
    this.push();
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.tick += 1;
      const active = this.transfers.some((transfer) => ACTIVE_STATES.has(transfer.state));
      if (!active && this.tick % IDLE_REFRESH_TICKS !== 0) return;
      void this.refreshTransfers().catch(() => {
        // Transient control-plane trouble; the next tick tries again.
      });
    }, POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubAgentEvents();
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private push(): void {
    this.deps.emitTransfers(this.snapshot());
  }

  private requirePath(filePath: string): string {
    const normalized = normalizeVfsPath(filePath);
    if (normalized === null || normalized === "/") throw new Error(`invalid file path "${filePath}"`);
    return normalized;
  }

  /** Progress reporter for one upload; a no-op when the page sent no id. */
  private uploadReporter(
    uploadId: string | undefined,
    uploadPath: string,
    totalBytes: number,
  ): (state: UploadState, sentBytes: number, error: string | null) => void {
    if (uploadId === undefined) {
      return () => {
        // Nothing to correlate against — the caller wanted no progress.
      };
    }
    return (state, sentBytes, error) => {
      this.deps.emitUploadProgress({
        uploadId,
        path: uploadPath,
        sentBytes: Math.max(0, Math.min(sentBytes, totalBytes)),
        totalBytes,
        state,
        error,
      });
    };
  }

  private async uploadChunks(
    manifest: ChunkManifest,
    bytes: Uint8Array,
    missing: string[],
    onStored?: (storedBytes: number) => void,
  ): Promise<void> {
    if (missing.length === 0) return;
    const urls = await this.deps.client.presignChunkUploads(missing);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    for (const hash of missing) {
      const chunk = manifest.chunks.find((candidate) => candidate.hash === hash);
      if (chunk === undefined) throw new Error(`chunk ${hash} is not part of this upload`);
      const url = urls.get(hash);
      if (url === undefined) {
        // The store took this chunk between the manifest write and now — the
        // client omits a URL only for a chunk the control plane reports as
        // already stored. Nothing to send; it still counts as progress.
        onStored?.(chunkBytes(manifest, hash));
        continue;
      }
      // One chunk-sized copy into a plain ArrayBuffer view: a fetch body must
      // be a BodyInit, and a subarray of a Buffer is not one.
      const slice = new Uint8Array(chunk.length);
      slice.set(bytes.subarray(chunk.offset, chunk.offset + chunk.length));
      const body = new Blob([slice]);
      const res = await fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      if (!res.ok) throw new Error(`chunk upload failed (${String(res.status)})`);
      // One PUT stores every occurrence of this hash, so all of them count.
      onStored?.(chunkBytes(manifest, hash));
    }
  }
}

/** Every byte one hash accounts for in a manifest — a chunk can repeat. */
function chunkBytes(manifest: ChunkManifest, hash: string): number {
  return manifest.chunks.reduce(
    (sum, candidate) => (candidate.hash === hash ? sum + candidate.length : sum),
    0,
  );
}

/** Never overwrite an existing local file — "name (1).ext", like the browser. */
async function uniqueSavePath(candidate: string): Promise<string> {
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  for (let attempt = 0; attempt < 500; attempt++) {
    const target = attempt === 0 ? candidate : path.join(dir, `${stem} (${String(attempt)})${ext}`);
    try {
      await statFile(target);
    } catch {
      return target; // stat failed ⇒ nothing there
    }
  }
  return path.join(dir, `${stem} (${String(Date.now())})${ext}`);
}
