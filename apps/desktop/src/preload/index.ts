/**
 * Preload — the only bridge between Suma's own pages and main.
 *
 * Two worlds, one bundle. The chrome renderer gets `window.suma` (the full
 * invoke/on contract); the suma://files privileged page gets ONLY
 * `window.sumaFiles` (files/transfers channels — see preload/files.ts). The
 * page decides which: a preload runs after the URL is committed, and site
 * content can never navigate into suma:// (tab-policy.ts), so this check
 * cannot be spoofed by a page. Nothing else crosses context isolation.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type SumaApi,
  type SumaEventMap,
  type InvokeChannel,
} from "../shared/ipc";
import { exposeFilesBridge } from "./files";

const invokeChannels: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventChannels: ReadonlySet<string> = new Set(EVENT_CHANNELS);

const api: SumaApi = {
  invoke<C extends InvokeChannel>(channel: C, args: unknown): Promise<never> {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`suma: blocked invoke channel "${String(channel)}"`));
    }
    return ipcRenderer.invoke(channel, args) as Promise<never>;
  },
  on<C extends EventChannel>(channel: C, listener: (payload: SumaEventMap[C]) => void) {
    if (!eventChannels.has(channel)) {
      throw new Error(`suma: blocked event channel "${String(channel)}"`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: SumaEventMap[C]): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

/**
 * The privileged Files page — suma://files — and nothing else. Read off the
 * committed document URL (`globalThis.location`, typed loosely because this
 * bundle compiles with node types, not DOM types).
 */
function isFilesPage(): boolean {
  const loc = (globalThis as { location?: { protocol?: string; hostname?: string } }).location;
  return loc?.protocol === "suma:" && loc.hostname === "files";
}

if (isFilesPage()) exposeFilesBridge();
else contextBridge.exposeInMainWorld("suma", api);
