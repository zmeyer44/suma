/**
 * The completion hook behind the download-complete card
 * (DownloadCompleteOverlay.tsx). The card is the ONLY notification the user
 * gets that a file landed, so the contract is narrow and worth pinning: it
 * fires once per finished download, carries the id the Open action comes back
 * with, and never fires for a download that produced no file — a cancelled
 * one, or one the §8.6 router handed to the cloud (which cancels the local
 * copy, so it settles as cancelled here).
 */

import { describe, expect, it, vi } from "vitest";
import type { DownloadItem, Session } from "electron";
import type { DownloadItemInfo } from "../src/shared/ipc";

vi.mock("electron", () => ({
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

const { DownloadManager } = await import("../src/main/downloads");
type WorkspaceStoreStub = ConstructorParameters<typeof DownloadManager>[0]["store"];

const SPACE = "space-1";

interface Harness {
  /** Drive the space session's will-download listener. */
  start: (filename: string) => FakeItem;
  completed: DownloadItemInfo[];
  list: () => DownloadItemInfo[];
}

/** The slice of Electron's DownloadItem the manager actually touches. */
class FakeItem {
  private savePath = "";
  private received = 0;
  private handlers = new Map<string, (event: unknown, state: string) => void>();

  constructor(private readonly filename: string) {}

  getURL(): string {
    return `https://example.com/${this.filename}`;
  }
  getFilename(): string {
    return this.filename;
  }
  getTotalBytes(): number {
    return 2048;
  }
  getReceivedBytes(): number {
    return this.received;
  }
  getSavePath(): string {
    return this.savePath;
  }
  setSavePath(next: string): void {
    this.savePath = next;
  }
  on(event: string, handler: (e: unknown, state: string) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  once(event: string, handler: (e: unknown, state: string) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  /** Finish with the given terminal state, as Electron would. */
  finish(state: "completed" | "cancelled" | "interrupted"): void {
    if (state === "completed") this.received = this.getTotalBytes();
    this.handlers.get("done")?.({}, state);
  }
}

function harness(): Harness {
  const completed: DownloadItemInfo[] = [];
  let onWillDownload: ((event: unknown, item: DownloadItem) => void) | null = null;

  const store = {
    downloads: () => [],
    setDownloads: () => undefined,
  } as unknown as WorkspaceStoreStub;

  const manager = new DownloadManager({
    store,
    emit: () => undefined,
    downloadsDir: () => "/tmp/suma-test-downloads",
    onCompleted: (item) => completed.push(item),
  });

  const session = {
    on: (_event: string, listener: (event: unknown, item: DownloadItem) => void) => {
      onWillDownload = listener;
    },
  } as unknown as Session;
  manager.attachTo(session, SPACE);

  return {
    start: (filename) => {
      const item = new FakeItem(filename);
      onWillDownload?.({}, item as unknown as DownloadItem);
      return item;
    },
    completed,
    list: () => manager.list(),
  };
}

describe("DownloadManager completion hook", () => {
  it("reports a finished download once, with the row the card renders", () => {
    const h = harness();
    h.start("report.pdf").finish("completed");

    expect(h.completed).toHaveLength(1);
    const notice = h.completed[0];
    expect(notice?.filename).toBe("report.pdf");
    expect(notice?.state).toBe("completed");
    expect(notice?.receivedBytes).toBe(2048);
    expect(notice?.savePath).toContain("report.pdf");
    // The id must address a row the manager still knows about — it is what
    // `downloadOverlay:open` comes back with.
    expect(h.list().some((row) => row.id === notice?.id)).toBe(true);
  });

  it("stays silent for a cancelled download — there is no file to open", () => {
    const h = harness();
    h.start("moved-to-cloud.zip").finish("cancelled");

    expect(h.completed).toEqual([]);
  });

  it("stays silent for an interrupted download", () => {
    const h = harness();
    h.start("half.iso").finish("interrupted");

    expect(h.completed).toEqual([]);
  });

  it("gives concurrent downloads distinct ids", () => {
    const h = harness();
    const first = h.start("a.pdf");
    const second = h.start("b.pdf");
    second.finish("completed");
    first.finish("completed");

    expect(h.completed.map((c) => c.filename)).toEqual(["b.pdf", "a.pdf"]);
    expect(new Set(h.completed.map((c) => c.id)).size).toBe(2);
  });
});
