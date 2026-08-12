/**
 * `window.sumaFiles` — the bridge for the suma://files privileged page.
 *
 * Deliberately NOT the chrome bridge: the Files page can reach the
 * files/transfers channels and nothing else, so a bug in the Files app cannot
 * touch tabs, spaces, credentials, terminals, or egress. The allowlists are
 * derived from the typed contract, and every method below names the channel it
 * uses — there is no generic `invoke` escape hatch for the page to widen.
 *
 * Shape mirrors `apps/files/src/bridge.ts` (the app codes against methods, not
 * channels), so the two files must change together.
 *
 * Every method is a thin mapping onto one channel: main owns the decisions
 * (what a preview read may cost, which device labels the page may see, how
 * much of an upload the store already had), and this file only translates
 * between the channel result and the shape the app codes against.
 *
 * Lives in the same preload bundle as the chrome bridge because Electron loads
 * one preload per WebContents and this package builds a single preload entry;
 * `index.ts` picks which world to expose based on the page it is running in.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CLOUD_ROOT, type FileEntry, type QuotaState, type Transfer } from "@suma/protocol";
import {
  FILES_EVENT_CHANNELS,
  FILES_INVOKE_CHANNELS,
  type DeleteResult,
  type DirectoryListing,
  type DownloadResult,
  type FileBytes,
  type FilesContext,
  type FilesEventChannel,
  type FilesInvokeChannel,
  type FileUploadResult,
  type SumaEventMap,
  type SumaFilesApi,
  type SumaInvokeMap,
  type QuotaMeter,
  type TransfersUpdate,
  type Unsubscribe,
  type UploadInput,
  type UploadProgress,
  type UploadResult,
} from "../shared/ipc";

const invokeChannels: ReadonlySet<string> = new Set(FILES_INVOKE_CHANNELS);
const eventChannels: ReadonlySet<string> = new Set(FILES_EVENT_CHANNELS);

function invoke<C extends FilesInvokeChannel>(
  channel: C,
  args: SumaInvokeMap[C]["args"],
): Promise<SumaInvokeMap[C]["result"]> {
  if (!invokeChannels.has(channel)) {
    return Promise.reject(new Error(`sumaFiles: blocked invoke channel "${String(channel)}"`));
  }
  return ipcRenderer.invoke(channel, args) as Promise<SumaInvokeMap[C]["result"]>;
}

function subscribe<C extends FilesEventChannel>(
  channel: C,
  listener: (payload: SumaEventMap[C]) => void,
): Unsubscribe {
  if (!eventChannels.has(channel)) {
    throw new Error(`sumaFiles: blocked event channel "${String(channel)}"`);
  }
  const wrapped = (_event: IpcRendererEvent, payload: SumaEventMap[C]): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // ipcMain.handle wraps the main-process message; keep the human half.
  const match = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(err.message);
  return match?.[1] ?? err.message;
}

/**
 * The device this Mac is, passed in the page URL when the window opens
 * (files-window.ts). Only a fallback now that `files:context` answers the same
 * question with real device labels: if that call fails, the transfers list can
 * still say "this Mac" for its own rows instead of showing raw ids.
 */
function thisDeviceId(): string | null {
  const loc = (globalThis as { location?: { search?: string } }).location;
  if (loc?.search === undefined) return null;
  const id = new URLSearchParams(loc.search).get("device");
  return id === null || id.length === 0 ? null : id;
}

export const filesApi: SumaFilesApi = {
  async context(): Promise<FilesContext> {
    try {
      return await invoke("files:context", undefined);
    } catch {
      return {
        thisDeviceId: thisDeviceId(),
        devices: [],
        cloudRoot: CLOUD_ROOT,
        // §8.6: V1 is not end-to-end encrypted, and the UI says so.
        endToEndEncrypted: false,
      };
    }
  },

  async list(prefix: string): Promise<FileEntry[]> {
    const listing: DirectoryListing = await invoke("files:list", { path: prefix });
    return listing.entries;
  },

  async stat(path: string): Promise<FileEntry | null> {
    return invoke("files:stat", { path });
  },

  /** Bounded preview read; main clamps `maxBytes` again on its side. */
  async read(path: string, maxBytes: number): Promise<FileBytes | null> {
    return invoke("files:read", { path, maxBytes });
  },

  /**
   * The whole file crosses IPC here as one copy — acceptable at M-3 Lite sizes
   * and refused above `MAX_UPLOAD_BYTES` in main. Progress arrives separately
   * on `files:uploadProgress`, correlated by `uploadId`, because this promise
   * only settles at the end.
   */
  async upload(input: UploadInput): Promise<UploadResult> {
    try {
      const result: FileUploadResult = await invoke("files:upload", {
        path: input.path,
        contentType: input.contentType,
        data: input.data,
        uploadId: input.uploadId,
      });
      return { ok: true, entry: result.file };
    } catch (err) {
      const message = messageOf(err);
      return { ok: false, reason: /quota/i.test(message) ? "quota" : "error", message };
    }
  },

  async download(path: string): Promise<DownloadResult> {
    try {
      const { savePath } = await invoke("files:download", { path });
      return { ok: true, savePath };
    } catch (err) {
      const message = messageOf(err);
      return { ok: false, reason: /not in your cloud files/i.test(message) ? "missing" : "error", message };
    }
  },

  async remove(path: string): Promise<DeleteResult> {
    try {
      await invoke("files:delete", { path });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: messageOf(err) };
    }
  },

  async quota(): Promise<QuotaState> {
    const meter: QuotaMeter = await invoke("files:quota", undefined);
    return { usedBytes: meter.usedBytes, limitBytes: meter.limitBytes };
  },

  async listTransfers(): Promise<Transfer[]> {
    const update: TransfersUpdate = await invoke("transfers:list", undefined);
    return update.transfers;
  },

  async cancelTransfer(transferId: string): Promise<void> {
    await invoke("transfers:cancel", { id: transferId });
  },

  onFilesChanged(handler: () => void): Unsubscribe {
    return subscribe("files:changed", () => handler());
  },

  onTransfersUpdated(handler: (transfers: Transfer[]) => void): Unsubscribe {
    return subscribe("transfers:updated", (update) => handler(update.transfers));
  },

  onUploadProgress(handler: (progress: UploadProgress) => void): Unsubscribe {
    return subscribe("files:uploadProgress", (progress) => handler(progress));
  },
};

export function exposeFilesBridge(): void {
  contextBridge.exposeInMainWorld("sumaFiles", filesApi);
}
