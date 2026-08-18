/**
 * Mirror a finished local file onto the shared filesystem over the vfs
 * channel — the cloud-mode half of "downloads land on your computer".
 *
 * The local file is the source of truth and is never touched: a failed
 * mirror loses nothing (the overlay says "kept on this Mac"). The upload is
 * chunked under the vfs frame cap — first page via vfs.write (atomic
 * create), the rest via vfs.append — into a `.suma-partial` name, then
 * renamed into place. Rename refuses to overwrite, which is exactly the
 * collision behavior a Downloads folder wants; on a name collision we retry
 * with "name (2).ext" style suffixes, mirroring uniqueSavePath.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { VFS_MAX_WRITE_BYTES, type VfsRequest, type VfsResponse } from "@suma/protocol";

/** Chunked-append uploads stay sane below this; past it, keep the file local. */
export const VFS_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

export type VfsCall = (request: VfsRequest) => Promise<VfsResponse>;

export interface VfsUploadResult {
  ok: boolean;
  /** Wire path the file landed at (ok), or why it did not (ok: false). */
  remotePath?: string;
  reason?: string;
}

function splitName(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, dot), ext: filename.slice(dot) };
}

/** "report.pdf", "report (2).pdf", … — the same shape uniqueSavePath makes. */
export function numberedName(filename: string, attempt: number): string {
  if (attempt <= 1) return filename;
  const { stem, ext } = splitName(filename);
  return `${stem} (${attempt})${ext}`;
}

async function fail(vfs: VfsCall, partial: string, reason: string): Promise<VfsUploadResult> {
  await vfs({ t: "vfs.delete", path: partial }).catch(() => undefined);
  return { ok: false, reason };
}

/**
 * Upload `localPath` to `<destDir>/<filename>` on the shared FS.
 * `destDir` is a wire path (e.g. "/Personal/Downloads") that already exists.
 */
export async function uploadFileToVfs(
  vfs: VfsCall,
  localPath: string,
  destDir: string,
  filename: string,
): Promise<VfsUploadResult> {
  let size: number;
  try {
    size = (await stat(localPath)).size;
  } catch (err) {
    return { ok: false, reason: `local file unreadable: ${String(err)}` };
  }
  if (size > VFS_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: "file is too large to mirror" };
  }

  const partial = `${destDir}/.suma-partial-${process.pid}-${process.hrtime.bigint()}`;
  let first = true;
  const stream = createReadStream(localPath, { highWaterMark: VFS_MAX_WRITE_BYTES });
  try {
    for await (const chunk of stream) {
      const dataB64 = Buffer.from(chunk as Buffer).toString("base64");
      const resp = first
        ? await vfs({ t: "vfs.write", path: partial, dataB64 })
        : await vfs({ t: "vfs.append", path: partial, dataB64 });
      first = false;
      if (resp.t === "error") {
        return await fail(vfs, partial, `${resp.code}: ${resp.message}`);
      }
    }
    if (first) {
      // Zero-byte file: the loop never ran; create it explicitly.
      const resp = await vfs({ t: "vfs.write", path: partial, dataB64: "" });
      if (resp.t === "error") {
        return await fail(vfs, partial, `${resp.code}: ${resp.message}`);
      }
    }
  } catch (err) {
    return await fail(vfs, partial, `transport failed: ${String(err)}`);
  }

  // Rename into place; on collision walk "name (2).ext" like uniqueSavePath.
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const target = `${destDir}/${numberedName(filename, attempt)}`;
    let resp: VfsResponse;
    try {
      resp = await vfs({ t: "vfs.rename", from: partial, to: target });
    } catch (err) {
      return await fail(vfs, partial, `transport failed: ${String(err)}`);
    }
    if (resp.t === "vfs.renamed") return { ok: true, remotePath: resp.to };
    if (resp.t === "error" && resp.code === "vfs_already_exists") continue;
    return await fail(
      vfs,
      partial,
      resp.t === "error" ? `${resp.code}: ${resp.message}` : "unexpected vfs answer",
    );
  }
  return await fail(vfs, partial, "could not find a free filename");
}
