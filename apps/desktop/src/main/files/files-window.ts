/**
 * FilesWindow — the hardened WebContents behind `suma://files` (PRD §8.1
 * "Privileged pages", §8.6 Files).
 *
 * Unlike the terminal/settings surfaces, which are renderer routes inside the
 * chrome view, this is a genuinely separate page: its own window, its own
 * ephemeral session (no site cookies, no site storage), a document served from
 * the privileged `suma:` scheme under a strict CSP, and a preload that
 * exposes ONLY `window.sumaFiles` — the Files half of the IPC contract,
 * never the browser-chrome channels.
 *
 * Hardening applied here:
 *   contextIsolation ....... on
 *   nodeIntegration ........ off (both main world and subframes)
 *   webviewTag ............. off
 *   navigation ............. locked to suma://files (will-navigate,
 *                            will-redirect, and window.open all refused)
 *   permissions ............ every request denied — the Files page needs none
 *   CSP .................... served with the document (bundle.ts)
 *
 * SANDBOX, honestly: `sandbox` is NOT enabled. Electron cannot load an ESM
 * preload in a sandboxed renderer, and electron-vite emits this package's
 * preload as ESM (`index.mjs`) because the package is `"type": "module"` — the
 * same constraint shell-window.ts documents for the chrome view. Everything
 * else above is enforced, and the page loads only Suma's own local bundle
 * with no remote code. Making this window sandboxed requires emitting a CJS
 * preload, which is a build-config change outside this stream.
 *
 * Verification status: this file needs a running Electron to exercise, and no
 * Electron build or launch was performed in this stream. What IS verified by
 * tests is everything it depends on — bundle discovery and serving, the URL
 * the window loads, the channel allowlists the preload enforces, and the
 * routing decisions behind the transfers it displays.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, type Session, type WebContents } from "electron";
import type { EventChannel, SumaEventMap } from "../../shared/ipc";
import { FILES_URL } from "./bundle";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Matches the renderer's --color-bg so opening never flashes white. */
const BACKGROUND_COLOR = "#0f1115";

function isFilesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "suma:" && parsed.hostname === "files";
  } catch {
    return false;
  }
}

export class FilesWindow {
  private window: BrowserWindow | null = null;

  /**
   * `deviceId` rides in the page URL so the transfers list can say "this Mac"
   * without a channel for it — the Phase-3 IPC surface is files/transfers
   * only. It is this device's own id, on this device's own privileged page.
   */
  constructor(
    private readonly session: Session,
    private readonly deviceId: string,
  ) {}

  /** Open the Files page, or focus it when it is already open. */
  open(): void {
    const existing = this.window;
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      title: "Suma Files",
      backgroundColor: BACKGROUND_COLOR,
      titleBarStyle: "hiddenInset",
      show: true,
      webPreferences: {
        session: this.session,
        preload: path.join(dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        // Explicit, not accidental: Electron sandboxes renderers by default,
        // and a sandboxed renderer cannot load an ESM preload — which is what
        // this package builds (see the SANDBOX note above). Leaving the
        // default on would silently drop `window.sumaFiles` and leave the
        // page with no bridge at all.
        sandbox: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.window = win;
    this.harden(win.webContents);
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    void win.webContents.loadURL(`${FILES_URL}?device=${encodeURIComponent(this.deviceId)}`);
  }

  /** True for invokes coming from the Files page (ipc.ts sender check). */
  ownsWebContents(webContentsId: number): boolean {
    const win = this.window;
    return win !== null && !win.isDestroyed() && win.webContents.id === webContentsId;
  }

  /** Push an event to the Files page, when it is open. */
  send<C extends EventChannel>(channel: C, payload: SumaEventMap[C]): void {
    const win = this.window;
    if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  close(): void {
    const win = this.window;
    this.window = null;
    if (win !== null && !win.isDestroyed()) win.close();
  }

  /* ------------------------------ internals ------------------------------ */

  private harden(contents: WebContents): void {
    // The page is a privileged origin; nothing may navigate it elsewhere.
    contents.on("will-navigate", (event, url) => {
      if (!isFilesUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isFilesUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    // No popups, no external windows, from a page that needs neither.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Fail closed on permissions: the Files page asks for none, so anything
    // asking is either a bug or something that should not be here.
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
  }
}
