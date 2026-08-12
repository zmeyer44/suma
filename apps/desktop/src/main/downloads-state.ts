/**
 * Pure download-list state machine (PRD §8.1 downloads baseline): Electron
 * `will-download` lifecycle events fold into the DownloadItemInfo list the
 * renderer panel shows. No Electron — unit tests exercise this directly.
 */

import type { DownloadItemInfo } from "../shared/ipc";

export type DownloadEvent =
  | {
      type: "started";
      id: string;
      spaceId: string;
      url: string;
      filename: string;
      savePath: string;
      totalBytes: number;
      startedAtMs: number;
    }
  | { type: "progress"; id: string; receivedBytes: number; totalBytes: number; savePath?: string }
  | { type: "completed"; id: string; receivedBytes: number; savePath?: string }
  | { type: "cancelled"; id: string }
  | { type: "interrupted"; id: string };

/** The panel keeps at most this many items; the oldest fall off the end. */
export const MAX_TRACKED_DOWNLOADS = 100;

/** Enough retries that a real collision run always resolves; a loop bound, not a policy. */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * Reduce a Chromium-supplied filename to a single safe path segment. Chromium
 * already sanitizes it, so this is the second lock on the same door: a name
 * carrying separators or `..` must never be able to steer the write out of the
 * downloads directory.
 */
function safeSegment(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const trimmed = base.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return "download";
  return trimmed;
}

/**
 * Where a download should land, Chrome-style: `report.pdf`, then
 * `report (1).pdf`, `report (2).pdf`. `exists` is injected so this stays pure
 * and unit-testable; the caller supplies the filesystem.
 *
 * Electron shows a save dialog — or, headless, stalls the item forever — when
 * `will-download` returns without a save path, so every tracked download must
 * get one synchronously.
 */
export function uniqueSavePath(
  dir: string,
  filename: string,
  exists: (path: string) => boolean,
  separator = "/",
): string {
  const name = safeSegment(filename);
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the name (`.gitignore`), not an extension.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const join = (candidate: string): string =>
    dir.endsWith(separator) ? `${dir}${candidate}` : `${dir}${separator}${candidate}`;

  let candidate = join(name);
  for (let n = 1; exists(candidate) && n <= MAX_NAME_ATTEMPTS; n += 1) {
    candidate = join(`${stem} (${n})${ext}`);
  }
  return candidate;
}

/** Fold one event into the list (newest first). Unknown ids are ignored;
 * terminal states never regress back to progressing. */
export function reduceDownloads(
  items: readonly DownloadItemInfo[],
  event: DownloadEvent,
): DownloadItemInfo[] {
  if (event.type === "started") {
    const item: DownloadItemInfo = {
      id: event.id,
      spaceId: event.spaceId,
      url: event.url,
      filename: event.filename,
      savePath: event.savePath,
      state: "progressing",
      receivedBytes: 0,
      totalBytes: event.totalBytes,
      startedAtMs: event.startedAtMs,
    };
    return [item, ...items.filter((i) => i.id !== event.id)].slice(0, MAX_TRACKED_DOWNLOADS);
  }
  return items.map((item) => {
    if (item.id !== event.id) return item;
    switch (event.type) {
      case "progress":
        if (item.state !== "progressing") return item;
        return {
          ...item,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          savePath: event.savePath ?? item.savePath,
        };
      case "completed":
        return {
          ...item,
          state: "completed",
          receivedBytes: event.receivedBytes,
          savePath: event.savePath ?? item.savePath,
        };
      case "cancelled":
        return { ...item, state: "cancelled" };
      case "interrupted":
        return { ...item, state: "interrupted" };
    }
  });
}
