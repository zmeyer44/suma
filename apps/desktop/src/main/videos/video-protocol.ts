/**
 * suma-video:// — the playback stream for saved videos (§8.1 privileged
 * scheme posture, like suma://).
 *
 * The PIP view and the chrome (both on the default session — Suma's own UI,
 * never site content) address cached media as:
 *
 *   suma-video://media/<id>   the video file, with HTTP Range support —
 *                             <video> seeking is nothing but Range requests
 *   suma-video://thumb/<id>   the poster frame for library cards
 *
 * The handler serves ONLY from the app's own media cache directory, keyed by
 * validated item ids (`findMediaFile` matches `<id>.<known-ext>` exactly), so
 * there is no path to traverse. Space sessions never get a handler for this
 * scheme — a site that names the URL reaches nothing (same posture as
 * suma://files).
 */

import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Session } from "electron";
import {
  findMediaFile,
  findThumbnailFile,
  mediaContentType,
  parseRangeHeader,
} from "./videos-core";
import { readdirSync } from "node:fs";

export const VIDEO_SCHEME = "suma-video";

export function mediaUrlFor(id: string): string {
  return `${VIDEO_SCHEME}://media/${id}`;
}

export function thumbnailUrlFor(id: string): string {
  return `${VIDEO_SCHEME}://thumb/${id}`;
}

/** Resolve a request to a file in the cache, or null. Exported for tests. */
export function resolveVideoRequest(
  url: string,
  filenames: string[],
): { filename: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const kind = parsed.hostname;
  const id = parsed.pathname.replace(/^\/+/, "");
  if (!/^[\w-]+$/.test(id)) return null;
  const filename =
    kind === "media"
      ? findMediaFile(id, filenames)
      : kind === "thumb"
        ? findThumbnailFile(id, filenames)
        : null;
  return filename === null ? null : { filename };
}

/**
 * Install the handler on `ses` (the default session — the only one whose
 * documents are Suma's own UI). `mediaDir` is stable across sign-outs
 * (userData/videos), so this registers once per process; after a sign-out
 * wipe the directory is simply empty and every request 404s.
 */
export function installVideoProtocol(ses: Session, mediaDir: string): void {
  ses.protocol.handle(VIDEO_SCHEME, (request) => {
    const resolved = resolveVideoRequest(request.url, listDir(mediaDir));
    if (resolved === null) return new Response(null, { status: 404 });
    const filePath = path.join(mediaDir, resolved.filename);
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return new Response(null, { status: 404 });
    }
    const contentType = mediaContentType(resolved.filename);
    const range = parseRangeHeader(request.headers.get("range"), size);
    if (range === null) {
      return new Response(streamFile(filePath), {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          "accept-ranges": "bytes",
        },
      });
    }
    return new Response(streamFile(filePath, range.start, range.end), {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
        "accept-ranges": "bytes",
      },
    });
  });
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function streamFile(
  filePath: string,
  start?: number,
  end?: number,
): ReadableStream<Uint8Array> {
  const stream =
    start === undefined
      ? createReadStream(filePath)
      : createReadStream(filePath, { start, end });
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
