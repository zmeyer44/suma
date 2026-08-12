/**
 * The typed `SumaFilesBridge` built over a CHANNEL-shaped injection.
 *
 * Two shapes of `window.sumaFiles` exist in the wild. One is method-shaped
 * (already this interface, injected by a preload that owns the mapping); the
 * other is the allowlisted channel API — `{ invoke(channel, args), on(channel,
 * listener) }` — which is all the desktop preload has to expose for the page to
 * work. `adaptBridge` takes either and always hands the UI the typed bridge, so
 * `state.ts` never has to know which preload it is talking to. A channel-shaped
 * object reaching `bridge.list(...)` unadapted is a TypeError, and that is the
 * seam this file closes.
 *
 * Doing the mapping here keeps the desktop's security property exactly where it
 * is: the preload stays an allowlist over `files:*` / `transfers:*`, and this
 * adapter can only ever name channels that allowlist already permits. Nothing
 * here can widen it, and nothing here sends a credential anywhere — the only
 * outbound values are VFS paths, byte budgets, an upload id, and file bytes the
 * user dropped on the window (§8.6).
 *
 * The channel results are read defensively. They come from Suma's own main
 * process, so this is not a trust boundary; it is drift insurance, so a contract
 * change degrades one row instead of throwing inside React.
 */

import { CLOUD_ROOT, type FileEntry, type QuotaState, type Transfer } from "@suma/protocol";
import type {
  DeleteResult,
  DownloadResult,
  FileBytes,
  FilesContext,
  FilesDevice,
  SumaFilesBridge,
  Unsubscribe,
  UploadInput,
  UploadProgress,
  UploadResult,
  UploadState,
} from "./bridge";

/**
 * The channel-shaped injection. Deliberately re-declared rather than imported
 * from the desktop package: this app is built on its own and must not depend on
 * Electron sources.
 */
export interface SumaFilesChannelApi {
  invoke(channel: string, args?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): Unsubscribe;
}

/** Anything that may arrive on `window.sumaFiles`. */
export type InjectedFilesBridge = SumaFilesBridge | SumaFilesChannelApi;

/** Channel-shaped when it has the generic `invoke`; the typed bridge has none. */
export function isChannelApi(injected: InjectedFilesBridge): injected is SumaFilesChannelApi {
  return "invoke" in injected && typeof injected.invoke === "function";
}

/** The typed bridge, whichever shape the preload injected. */
export function adaptBridge(injected: InjectedFilesBridge): SumaFilesBridge {
  return isChannelApi(injected) ? new ChannelBridge(injected) : injected;
}

/* ------------------------------------------------------------------ *
 * Reading channel payloads
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readArray<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : [];
}

function isFileEntry(value: unknown): value is FileEntry {
  return (
    isRecord(value) && typeof value["path"] === "string" && typeof value["sizeBytes"] === "number"
  );
}

function isTransfer(value: unknown): value is Transfer {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["state"] === "string";
}

function isDevice(value: unknown): value is FilesDevice {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string";
}

const UPLOAD_STATES: ReadonlyArray<UploadState> = ["hashing", "uploading", "completed", "failed"];

function readUploadState(value: unknown): UploadState | null {
  return UPLOAD_STATES.find((state) => state === value) ?? null;
}

/**
 * A copy, deliberately. Structured clone can hand back a view onto a buffer
 * this page did not allocate, and the image preview needs bytes it can pass
 * straight to `new Blob([...])` as a plainly ArrayBuffer-backed view. The slice
 * is preview-bounded, so the copy is cheap.
 */
function readBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(0);
}

/** `ipcRenderer.invoke` wraps the main-process message; keep the human half. */
export function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const match = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(err.message);
  return match?.[1] ?? err.message;
}

/**
 * Why an upload failed, from the only signal an IPC rejection carries. The
 * quota case has to survive the trip: §8.6's soft block is "your files are all
 * still here, this write is refused", which reads very differently from a
 * generic failure.
 */
function uploadReason(message: string): "quota" | "rejected" | "error" {
  if (/quota/i.test(message)) return "quota";
  if (/invalid destination|invalid file path|can't be used/i.test(message)) return "rejected";
  return "error";
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export class ChannelBridge implements SumaFilesBridge {
  constructor(private readonly api: SumaFilesChannelApi) {}

  async context(): Promise<FilesContext> {
    const payload = await this.api.invoke("files:context", undefined);
    const record = isRecord(payload) ? payload : {};
    const thisDeviceId = record["thisDeviceId"];
    return {
      thisDeviceId: typeof thisDeviceId === "string" ? thisDeviceId : null,
      devices: readArray(record["devices"], isDevice),
      cloudRoot: readString(record["cloudRoot"], CLOUD_ROOT),
      // Only an explicit `true` claims encryption: defaulting the other way
      // would make the UI promise something V1 does not do (§8.6).
      endToEndEncrypted: record["endToEndEncrypted"] === true,
    };
  }

  async list(prefix: string): Promise<FileEntry[]> {
    const payload = await this.api.invoke("files:list", { path: prefix });
    if (!isRecord(payload)) return [];
    // `entries` is the recursive list this app's tree is built from; `files`
    // (one directory level) is the fallback for a listing that predates it.
    const entries = payload["entries"];
    return readArray(Array.isArray(entries) ? entries : payload["files"], isFileEntry);
  }

  async stat(path: string): Promise<FileEntry | null> {
    const payload = await this.api.invoke("files:stat", { path });
    return isFileEntry(payload) ? payload : null;
  }

  async read(path: string, maxBytes: number): Promise<FileBytes | null> {
    const payload = await this.api.invoke("files:read", { path, maxBytes });
    // null means the file is gone — distinct from an empty slice, and the UI
    // says so rather than drawing a blank preview.
    if (!isRecord(payload)) return null;
    return {
      data: readBytes(payload["data"]),
      truncated: payload["truncated"] === true,
      totalBytes: readNumber(payload["totalBytes"]),
    };
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    try {
      const payload = await this.api.invoke("files:upload", {
        path: input.path,
        contentType: input.contentType,
        data: input.data,
        // Correlates the progress events that arrive before this resolves.
        uploadId: input.uploadId,
      });
      const entry = isRecord(payload) ? payload["file"] : undefined;
      if (!isFileEntry(entry)) {
        return {
          ok: false,
          reason: "error",
          message: "The upload finished but Files didn't say where it landed.",
        };
      }
      return { ok: true, entry };
    } catch (err) {
      const message = messageOf(err);
      return { ok: false, reason: uploadReason(message), message };
    }
  }

  async download(path: string): Promise<DownloadResult> {
    try {
      const payload = await this.api.invoke("files:download", { path });
      const savePath = isRecord(payload) ? payload["savePath"] : undefined;
      if (typeof savePath !== "string") {
        return { ok: false, reason: "error", message: "Files didn't say where the download went." };
      }
      return { ok: true, savePath };
    } catch (err) {
      const message = messageOf(err);
      const missing = /not in your cloud files|no longer/i.test(message);
      return { ok: false, reason: missing ? "missing" : "error", message };
    }
  }

  async remove(path: string): Promise<DeleteResult> {
    try {
      await this.api.invoke("files:delete", { path });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: messageOf(err) };
    }
  }

  async quota(): Promise<QuotaState> {
    const payload = await this.api.invoke("files:quota", undefined);
    const meter = isRecord(payload) ? payload : {};
    return { usedBytes: readNumber(meter["usedBytes"]), limitBytes: readNumber(meter["limitBytes"]) };
  }

  async listTransfers(): Promise<Transfer[]> {
    const payload = await this.api.invoke("transfers:list", undefined);
    // The snapshot also carries the download that stayed on this Mac; the
    // transfers list is the half this page renders.
    return readArray(isRecord(payload) ? payload["transfers"] : undefined, isTransfer);
  }

  async cancelTransfer(transferId: string): Promise<void> {
    await this.api.invoke("transfers:cancel", { id: transferId });
  }

  onFilesChanged(handler: () => void): Unsubscribe {
    return this.subscribe("files:changed", () => handler());
  }

  onTransfersUpdated(handler: (transfers: Transfer[]) => void): Unsubscribe {
    return this.subscribe("transfers:updated", (payload) => {
      handler(readArray(isRecord(payload) ? payload["transfers"] : undefined, isTransfer));
    });
  }

  onUploadProgress(handler: (progress: UploadProgress) => void): Unsubscribe {
    return this.subscribe("files:uploadProgress", (payload) => {
      if (!isRecord(payload)) return;
      const uploadId = payload["uploadId"];
      const state = readUploadState(payload["state"]);
      if (typeof uploadId !== "string" || state === null) return;
      const error = payload["error"];
      handler({
        uploadId,
        path: readString(payload["path"], ""),
        sentBytes: readNumber(payload["sentBytes"]),
        totalBytes: readNumber(payload["totalBytes"]),
        state,
        error: typeof error === "string" ? error : null,
      });
    });
  }

  /**
   * The preload rejects an event channel outside its allowlist by throwing. A
   * preload generation without one of these channels means no events of that
   * kind — a documented no-op, never a broken page and never a fabricated
   * event.
   */
  private subscribe(channel: string, listener: (payload: unknown) => void): Unsubscribe {
    try {
      return this.api.on(channel, listener);
    } catch {
      return () => {
        // Nothing was subscribed.
      };
    }
  }
}
