/**
 * suma-workspace:// — playback for audio files opened in the IDE
 * (suma://terminal), streamed from the workspace with HTTP Range support.
 *
 *   suma-workspace://file/<url-encoded workspace-relative path>
 *
 * Why a protocol and not a data: URL (which is how the editor gets images):
 * audio files are big and a player is useless without seeking. A data: URL
 * means the whole track crosses IPC as base64 and sits in renderer memory,
 * while <audio> seeking is nothing but Range requests — which this answers.
 *
 * Two guards, because this scheme addresses arbitrary user files rather than
 * an app-owned cache like suma-video://:
 *   1. Every request re-resolves the path through WorkspaceFsService, so a
 *      crafted URL cannot escape the workspace root.
 *   2. The file must still sniff as audio. This is a MEDIA stream, not a
 *      general workspace reader — a URL naming .env or id_rsa gets 415, not
 *      its contents.
 * Registered on the default session only (Suma's own UI). Space sessions never
 * get a handler, so site content has nothing to reach even if it could name
 * the URL.
 */

import {
  closeSync,
  createReadStream,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { Readable } from "node:stream";
import type { Session } from "electron";
import { parseRangeHeader } from "./videos/videos-core";
import { sniffAudioMime, SNIFF_BYTES } from "./workspace-sniff";
import type { WorkspaceFsService } from "./workspace-fs";

export const WORKSPACE_MEDIA_SCHEME = "suma-workspace";

/** The playback URL for a workspace-relative path. */
export function workspaceMediaUrl(rel: string): string {
  return `${WORKSPACE_MEDIA_SCHEME}://file/${encodeURIComponent(rel)}`;
}

/**
 * The workspace-relative path a request names, or null when the URL is not
 * one this scheme serves. Decoding can produce anything (including "..") —
 * the caller still resolves it against the root, which is what refuses.
 */
export function parseWorkspaceMediaUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${WORKSPACE_MEDIA_SCHEME}:`) return null;
  if (parsed.hostname !== "file") return null;
  const encoded = parsed.pathname.replace(/^\/+/, "");
  if (encoded === "") return null;
  try {
    const rel = decodeURIComponent(encoded);
    return rel === "" ? null : rel;
  } catch {
    return null; // Malformed percent-escapes.
  }
}

export function installWorkspaceMediaProtocol(
  ses: Session,
  workspaceFs: WorkspaceFsService,
): void {
  ses.protocol.handle(WORKSPACE_MEDIA_SCHEME, (request) => {
    const rel = parseWorkspaceMediaUrl(request.url);
    if (rel === null) return new Response(null, { status: 404 });

    let abs: string;
    try {
      abs = workspaceFs.resolve(rel);
    } catch {
      return new Response(null, { status: 403 }); // Escaped the root.
    }

    let size: number;
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      size = stat.size;
    } catch {
      return new Response(null, { status: 404 });
    }

    const contentType = sniffAudioMime(readHeadSync(abs), rel);
    if (contentType === null) return new Response(null, { status: 415 });

    const range = parseRangeHeader(request.headers.get("range"), size);
    if (range === null) {
      return new Response(streamFile(abs), {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          "accept-ranges": "bytes",
        },
      });
    }
    return new Response(streamFile(abs, range.start, range.end), {
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

function readHeadSync(abs: string): Buffer {
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    closeSync(fd);
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
