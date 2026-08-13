/**
 * DownloadManager — §8.1 downloads baseline, local only (the cloud-fetch
 * fast path is Files/Phase 3). Registers a `will-download` listener on every
 * space session via SpaceManager's session hook, tracks DownloadItemInfo
 * through the pure reducer (downloads-state.ts), pushes `downloads:updated`,
 * and persists completed-download metadata so the panel survives restart.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { shell, type DownloadItem, type Session } from "electron";
import type { DownloadItemInfo } from "../shared/ipc";
import { reduceDownloads, uniqueSavePath, type DownloadEvent } from "./downloads-state";
import type { WorkspaceStore } from "./workspace-store";

/** Progress pushes are throttled; state transitions always push. */
const PROGRESS_PUSH_MS = 250;

export interface DownloadDeps {
  store: WorkspaceStore;
  emit: (items: DownloadItemInfo[]) => void;
  /** Where local downloads land — `app.getPath("downloads")` in the app. */
  downloadsDir: () => string;
  /**
   * One file finished writing. Separate from `emit`, which pushes the whole
   * list on every progress tick: this fires exactly once per download, which
   * is what a completion card can be built on (DownloadCompleteOverlay).
   * A cancelled or interrupted item never reaches it — there is no file.
   */
  onCompleted?: (item: DownloadItemInfo) => void;
}

export class DownloadManager {
  private items: DownloadItemInfo[];
  /** In-flight Electron items, for cancel(). */
  private readonly live = new Map<string, DownloadItem>();
  private lastProgressPushMs = 0;

  constructor(private readonly deps: DownloadDeps) {
    this.items = deps.store.downloads();
  }

  /** SpaceManager session hook — one listener per space session. */
  attachTo(ses: Session, spaceId: string): void {
    ses.on("will-download", (_event, item) => this.track(spaceId, item));
  }

  list(): DownloadItemInfo[] {
    return this.items.map((item) => ({ ...item }));
  }

  open(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item === undefined || item.state !== "completed" || item.savePath === "") return;
    void shell.openPath(item.savePath);
  }

  reveal(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item === undefined || item.savePath === "") return;
    shell.showItemInFolder(item.savePath);
  }

  cancel(id: string): void {
    this.live.get(id)?.cancel();
  }

  /* ------------------------------ internals ------------------------------ */

  private track(spaceId: string, item: DownloadItem): void {
    const id = randomUUID();
    this.live.set(id, item);
    // Choose the destination synchronously, before this handler returns.
    // Without it Electron never resolves a path: the item reaches 100% and
    // then sits at `progressing` forever — `done` never fires, so Open and
    // Reveal stay disabled and no completed metadata is ever persisted.
    // DownloadRouter may still preventDefault this same event to hand the
    // fetch to the cloud (§8.6); a cancelled item settles as cancelled and
    // the path is simply never used.
    this.assignSavePath(item);
    this.apply({
      type: "started",
      id,
      spaceId,
      url: item.getURL(),
      filename: item.getFilename(),
      savePath: item.getSavePath(),
      totalBytes: item.getTotalBytes(),
      startedAtMs: Date.now(),
    });
    item.on("updated", () => {
      this.apply(
        {
          type: "progress",
          id,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          savePath: item.getSavePath(),
        },
        /* throttled */ true,
      );
    });
    item.once("done", (_event, state) => {
      this.live.delete(id);
      if (state === "completed") {
        this.apply({
          type: "completed",
          id,
          receivedBytes: item.getReceivedBytes(),
          savePath: item.getSavePath(),
        });
        // Only completed metadata persists — a restart cannot resume the rest.
        this.deps.store.setDownloads(this.items.filter((i) => i.state === "completed"));
        // The reduced row, not the raw item: it carries the id the Open
        // action comes back with, and the same shape the panel renders.
        const landed = this.items.find((i) => i.id === id);
        if (landed !== undefined) this.deps.onCompleted?.({ ...landed });
      } else {
        this.apply({ type: state, id });
      }
    });
  }

  /** Never throws: a download without a save path is worse than a clumsy one. */
  private assignSavePath(item: DownloadItem): void {
    try {
      if (item.getSavePath() !== "") return; // something upstream already chose
      const dir = this.deps.downloadsDir();
      item.setSavePath(uniqueSavePath(dir, item.getFilename(), existsSync, path.sep));
    } catch (err) {
      console.error("suma downloads: could not set a save path", err);
    }
  }

  private apply(event: DownloadEvent, throttled = false): void {
    this.items = reduceDownloads(this.items, event);
    const now = Date.now();
    if (throttled && now - this.lastProgressPushMs < PROGRESS_PUSH_MS) return;
    this.lastProgressPushMs = now;
    this.deps.emit(this.list());
  }
}
