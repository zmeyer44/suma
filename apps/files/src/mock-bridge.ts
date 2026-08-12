/**
 * Standalone stand-in for `window.sumaFiles`.
 *
 * The desktop stream injects the real bridge; this one exists so `vite build`
 * and a standalone `vite dev` produce a running app without Electron, and so
 * the empty / warning / soft-blocked quota states can be looked at directly.
 * It is a fixture: no network, no disk, no real transfers. The UI shows a
 * "Mock data" badge whenever it is the bridge in use, because a Files app that
 * lies about whether your files are really there would be worse than useless.
 */

import {
  checkQuota,
  normalizeVfsPath,
  PRO_QUOTA_BYTES,
  type FileEntry,
  type QuotaState,
  type Transfer,
} from "@suma/protocol";
import type {
  DeleteResult,
  DownloadResult,
  FileBytes,
  FilesContext,
  SumaFilesBridge,
  Unsubscribe,
  UploadInput,
  UploadProgress,
  UploadResult,
} from "./bridge";

const THIS_DEVICE = "dev_mbp_local";
const OTHER_DEVICE = "dev_mac_studio";

/** Space accounted for outside the fixture's own files, so the meter has a story. */
const BASELINE_USED_BYTES = 78 * 1024 ** 3;

const TEXT = new TextEncoder();

/** 1×1 PNG — enough to prove the image path renders. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic stand-in for BLAKE3 — shape-correct (64 hex), not a real digest. */
function fakeHash(seed: string): string {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  for (let i = 0; i < seed.length; i += 1) {
    a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + a + i, 0x85ebca6b) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    a = Math.imul(a ^ (a >>> 15), 0x2545f491) >>> 0;
    b = (b ^ (a + i)) >>> 0;
    out += b.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

interface StoredFile {
  entry: FileEntry;
  data: Uint8Array<ArrayBuffer>;
}

const SAMPLE_TEXT: Readonly<Record<string, string>> = {
  "/notes/roadmap.md": [
    "# Files — V1 scope",
    "",
    "- Browse, preview, upload, download, delete",
    "- Quota meter with the soft-block state",
    "- Cloud fetches visible on every device",
    "",
    "Out of V1: Finder File Provider, dataless placeholders, versioning,",
    "share links. Those are demand-gated for V1.1+.",
    "",
  ].join("\n"),
  "/notes/inbox.txt": "remember: authenticated downloads stay on this Mac.\n",
  "/datasets/pageviews.csv": [
    "day,views,uniques",
    "2026-07-28,1841,903",
    "2026-07-29,2204,1108",
    "2026-07-30,1990,1017",
    "",
  ].join("\n"),
  "/datasets/schema.json": '{\n  "day": "date",\n  "views": "int",\n  "uniques": "int"\n}\n',
};

function makeEntry(path: string, sizeBytes: number, contentType: string | null, ageMinutes: number): FileEntry {
  const updatedAtMs = Date.now() - ageMinutes * 60_000;
  return {
    id: `file_${fakeHash(path).slice(0, 12)}`,
    path,
    sizeBytes,
    fileHash: fakeHash(`${path}:${sizeBytes}`),
    contentType,
    createdAtMs: updatedAtMs - 3_600_000,
    updatedAtMs,
  };
}

export interface MockBridgeOptions {
  /** Start at the limit, to exercise the soft-block state. */
  full?: boolean;
  /** Start with nothing stored, to exercise the empty state. */
  empty?: boolean;
}

export class MockBridge implements SumaFilesBridge {
  readonly #files = new Map<string, StoredFile>();
  readonly #transfers = new Map<string, Transfer>();
  readonly #filesHandlers = new Set<() => void>();
  readonly #transferHandlers = new Set<(transfers: Transfer[]) => void>();
  readonly #uploadHandlers = new Set<(progress: UploadProgress) => void>();
  readonly #baselineUsedBytes: number;
  #ticker: ReturnType<typeof setInterval> | null = null;

  constructor(options: MockBridgeOptions = {}) {
    this.#baselineUsedBytes = options.full === true ? PRO_QUOTA_BYTES : BASELINE_USED_BYTES;
    if (options.empty !== true) this.#seed();
  }

  #seed(): void {
    for (const [path, text] of Object.entries(SAMPLE_TEXT)) {
      const data = TEXT.encode(text);
      const contentType = path.endsWith(".json")
        ? "application/json"
        : path.endsWith(".csv")
          ? "text/csv"
          : path.endsWith(".md")
            ? "text/markdown"
            : "text/plain";
      this.#files.set(path, { entry: makeEntry(path, data.byteLength, contentType, 12), data });
    }

    const png = decodeBase64(TINY_PNG_BASE64);
    this.#files.set("/design/pixel.png", {
      entry: makeEntry("/design/pixel.png", png.byteLength, "image/png", 90),
      data: png,
    });

    // Files with no bytes behind them: they exercise the "type + size" path,
    // which never reads anything anyway.
    for (const [path, size, type, age] of [
      ["/design/hero-render.png", 22 * 1024 * 1024, "image/png", 240],
      ["/archives/nightly-build.zip", 1.4 * 1024 ** 3, "application/zip", 700],
      ["/clips/walkthrough.mp4", 612 * 1024 * 1024, "video/mp4", 1500],
      ["/docs/security-model.pdf", 2.1 * 1024 * 1024, "application/pdf", 2600],
    ] as const) {
      this.#files.set(path, {
        entry: makeEntry(path, Math.round(size), type, age),
        data: new Uint8Array(0),
      });
    }

    const now = Date.now();
    this.#transfers.set("tr_active", {
      id: "tr_active",
      url: "https://releases.example.com/datasets/corpus-2026-07.tar",
      destPath: "/datasets/corpus-2026-07.tar",
      state: "fetching",
      receivedBytes: 640 * 1024 * 1024,
      totalBytes: 3 * 1024 ** 3,
      originDeviceId: OTHER_DEVICE,
      error: null,
      startedAtMs: now - 420_000,
      updatedAtMs: now,
    });
    this.#transfers.set("tr_done", {
      id: "tr_done",
      url: "https://cdn.example.org/models/embeddings.bin?sig=redacted",
      destPath: "/models/embeddings.bin",
      state: "completed",
      receivedBytes: 900 * 1024 * 1024,
      totalBytes: 900 * 1024 * 1024,
      originDeviceId: THIS_DEVICE,
      error: null,
      startedAtMs: now - 5_400_000,
      updatedAtMs: now - 4_900_000,
    });
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  async context(): Promise<FilesContext> {
    await sleep(40);
    return {
      thisDeviceId: THIS_DEVICE,
      devices: [
        { id: THIS_DEVICE, name: "MacBook Pro" },
        { id: OTHER_DEVICE, name: "Mac Studio" },
      ],
      cloudRoot: "~/cloud",
      endToEndEncrypted: false,
    };
  }

  async list(prefix: string): Promise<FileEntry[]> {
    await sleep(60);
    const normalized = normalizeVfsPath(prefix) ?? "/";
    const scope = normalized === "/" ? "/" : `${normalized}/`;
    return [...this.#files.values()]
      .map((stored) => stored.entry)
      .filter((entry) => scope === "/" || entry.path.startsWith(scope))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<FileEntry | null> {
    await sleep(20);
    return this.#files.get(normalizeVfsPath(path) ?? "")?.entry ?? null;
  }

  async read(path: string, maxBytes: number): Promise<FileBytes | null> {
    await sleep(90);
    const stored = this.#files.get(normalizeVfsPath(path) ?? "");
    if (stored === undefined) return null;
    const total = stored.entry.sizeBytes;
    if (stored.data.byteLength === 0 && total > 0) {
      // Fixture with no bytes behind it — say so instead of showing a blank pane.
      const filler = TEXT.encode(`(mock bridge: no sample bytes for ${stored.entry.path})\n`);
      return { data: filler, truncated: true, totalBytes: total };
    }
    const slice = stored.data.slice(0, Math.max(0, maxBytes));
    return { data: slice, truncated: slice.byteLength < stored.data.byteLength, totalBytes: total };
  }

  async quota(): Promise<QuotaState> {
    await sleep(20);
    return this.#quotaState();
  }

  async listTransfers(): Promise<Transfer[]> {
    await sleep(30);
    return [...this.#transfers.values()];
  }

  /* ---------------------------------------------------------------- *
   * Writes
   * ---------------------------------------------------------------- */

  async upload(input: UploadInput): Promise<UploadResult> {
    const path = normalizeVfsPath(input.path);
    if (path === null) {
      return { ok: false, reason: "rejected", message: "That name can't be used as a path." };
    }
    const totalBytes = input.data.byteLength;
    const verdict = checkQuota(this.#quotaState(), totalBytes);
    if (!verdict.allowed) {
      this.#emitUpload({
        uploadId: input.uploadId,
        path,
        sentBytes: 0,
        totalBytes,
        state: "failed",
        error: verdict.explanation,
      });
      return { ok: false, reason: "quota", message: verdict.explanation };
    }

    this.#emitUpload({
      uploadId: input.uploadId,
      path,
      sentBytes: 0,
      totalBytes,
      state: "hashing",
      error: null,
    });
    await sleep(220);
    for (let step = 1; step <= 5; step += 1) {
      await sleep(130);
      this.#emitUpload({
        uploadId: input.uploadId,
        path,
        sentBytes: Math.round((totalBytes * step) / 5),
        totalBytes,
        state: step === 5 ? "completed" : "uploading",
        error: null,
      });
    }

    const entry = makeEntry(path, totalBytes, input.contentType, 0);
    this.#files.set(path, { entry, data: input.data });
    this.#emitFilesChanged();
    return { ok: true, entry };
  }

  async download(path: string): Promise<DownloadResult> {
    await sleep(400);
    const stored = this.#files.get(normalizeVfsPath(path) ?? "");
    if (stored === undefined) {
      return { ok: false, reason: "missing", message: "That file is no longer in Files." };
    }
    const name = stored.entry.path.slice(stored.entry.path.lastIndexOf("/") + 1);
    return { ok: true, savePath: `~/Downloads/${name}` };
  }

  async remove(path: string): Promise<DeleteResult> {
    await sleep(160);
    const normalized = normalizeVfsPath(path);
    if (normalized === null || !this.#files.delete(normalized)) {
      return { ok: false, message: "That file is no longer in Files." };
    }
    this.#emitFilesChanged();
    return { ok: true };
  }

  async cancelTransfer(transferId: string): Promise<void> {
    await sleep(80);
    const transfer = this.#transfers.get(transferId);
    if (transfer === undefined || transfer.state === "completed") return;
    this.#transfers.set(transferId, { ...transfer, state: "cancelled", updatedAtMs: Date.now() });
    this.#emitTransfers();
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  onFilesChanged(handler: () => void): Unsubscribe {
    this.#filesHandlers.add(handler);
    return () => this.#filesHandlers.delete(handler);
  }

  onTransfersUpdated(handler: (transfers: Transfer[]) => void): Unsubscribe {
    this.#transferHandlers.add(handler);
    this.#startTicker();
    return () => {
      this.#transferHandlers.delete(handler);
      if (this.#transferHandlers.size === 0) this.#stopTicker();
    };
  }

  onUploadProgress(handler: (progress: UploadProgress) => void): Unsubscribe {
    this.#uploadHandlers.add(handler);
    return () => this.#uploadHandlers.delete(handler);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #quotaState(): QuotaState {
    let used = this.#baselineUsedBytes;
    for (const stored of this.#files.values()) used += stored.entry.sizeBytes;
    return { usedBytes: used, limitBytes: PRO_QUOTA_BYTES };
  }

  #startTicker(): void {
    if (this.#ticker !== null) return;
    this.#ticker = setInterval(() => {
      let changed = false;
      for (const [id, transfer] of this.#transfers) {
        if (transfer.state !== "fetching") continue;
        const next = Math.min(transfer.totalBytes, transfer.receivedBytes + 48 * 1024 * 1024);
        this.#transfers.set(id, {
          ...transfer,
          receivedBytes: next,
          state: next >= transfer.totalBytes ? "storing" : "fetching",
          updatedAtMs: Date.now(),
        });
        changed = true;
      }
      if (changed) this.#emitTransfers();
    }, 900);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  #emitFilesChanged(): void {
    for (const handler of this.#filesHandlers) handler();
  }

  #emitTransfers(): void {
    const snapshot = [...this.#transfers.values()];
    for (const handler of this.#transferHandlers) handler(snapshot);
  }

  #emitUpload(progress: UploadProgress): void {
    for (const handler of this.#uploadHandlers) handler(progress);
  }
}
