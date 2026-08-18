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
 * The bytes come from wherever the workspace lives — the agent link's vfs
 * channel — in single-read-cap pages, pulled on demand: a paused player
 * stops issuing vfs reads because the stream's pull() stops being called.
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

import { VFS_MAX_READ_BYTES } from "@suma/protocol";
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

/**
 * The next page of a byte range: how many bytes to request at `cursor` when
 * streaming [start, endInclusive] in pages of `pageSize`. Zero means done.
 */
export function nextMediaPage(cursor: number, endInclusive: number, pageSize: number): number {
  if (cursor > endInclusive) return 0;
  return Math.min(pageSize, endInclusive - cursor + 1);
}

export function installWorkspaceMediaProtocol(
  ses: Session,
  workspaceFs: WorkspaceFsService,
): void {
  ses.protocol.handle(WORKSPACE_MEDIA_SCHEME, async (request) => {
    const rel = parseWorkspaceMediaUrl(request.url);
    if (rel === null) return new Response(null, { status: 404 });

    let size: number | null;
    try {
      size = await workspaceFs.mediaSize(rel);
    } catch {
      return new Response(null, { status: 403 }); // Escaped the root, or no link yet.
    }
    if (size === null) return new Response(null, { status: 404 });

    let head: Buffer;
    try {
      head = await workspaceFs.mediaSlice(rel, 0, Math.min(SNIFF_BYTES, size));
    } catch {
      return new Response(null, { status: 404 });
    }
    const contentType = sniffAudioMime(head, rel);
    if (contentType === null) return new Response(null, { status: 415 });

    const range = parseRangeHeader(request.headers.get("range"), size);
    if (range === null) {
      return new Response(streamSlices(workspaceFs, rel, 0, size - 1), {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          "accept-ranges": "bytes",
        },
      });
    }
    return new Response(streamSlices(workspaceFs, rel, range.start, range.end), {
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

/**
 * Pull-based paging over the vfs single-read cap: each pull() fetches one
 * page, so backpressure from the <audio> element throttles vfs traffic.
 */
function streamSlices(
  workspaceFs: WorkspaceFsService,
  rel: string,
  start: number,
  endInclusive: number,
): ReadableStream<Uint8Array> {
  let cursor = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const want = nextMediaPage(cursor, endInclusive, VFS_MAX_READ_BYTES);
      if (want === 0) {
        controller.close();
        return;
      }
      let page: Buffer;
      try {
        page = await workspaceFs.mediaSlice(rel, cursor, want);
      } catch (err) {
        controller.error(err);
        return;
      }
      if (page.byteLength === 0) {
        controller.close(); // File shrank underneath us — end honestly.
        return;
      }
      cursor += page.byteLength;
      controller.enqueue(page);
    },
  });
}
