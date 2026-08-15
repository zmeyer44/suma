/**
 * WorkspaceFsService — the local filesystem behind the suma://terminal IDE
 * (explorer + editor). It is deliberately NOT the cloud files plane (§8.6,
 * `files:*`, rooted at ~/cloud): the IDE wants the directory the shells run
 * in, which today is this Mac (SimAgent spawns at $HOME; dev shells inherit
 * the repo). When shells move fully to the VM agent, this service is the seam
 * to reroute through the agent's vfs channel.
 *
 * Trust model: the renderer only ever holds workspace-RELATIVE paths. Every
 * path is resolved against the root here and rejected if it escapes —
 * chrome-renderer compromise must not become arbitrary file read/write.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceFile, WorkspaceTree } from "../shared/ipc";

/**
 * Where the IDE roots. Dev runs (`electron-vite dev`) sit in the project
 * being worked on — that IS the workspace. Packaged apps have a useless cwd
 * ("/"), so they fall back to $HOME, matching where SimAgent spawns shells.
 * SUMA_WORKSPACE_ROOT overrides both.
 */
export function resolveWorkspaceRoot(isPackaged: boolean): string {
  const override = process.env["SUMA_WORKSPACE_ROOT"];
  if (override !== undefined && override.length > 0)
    return path.resolve(override);
  return isPackaged ? os.homedir() : process.cwd();
}

/** Dependency/VCS/system trees that would drown the explorer. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".npm",
  ".cache",
  ".cargo",
  ".rustup",
  ".Trash",
  "Library",
]);

/** Junk files that carry no information in a tree. */
const SKIPPED_FILES: ReadonlySet<string> = new Set([".DS_Store"]);

/** Caps keep a homedir-rooted walk bounded; `truncated` makes the cut visible. */
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 12;

/** Editor cap — matches what a text editor can usefully hold, not files:*'s
 *  16 MiB preview budget. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Images ride to the renderer as a base64 data URL (~4/3 the bytes over IPC),
 * so they get their own, larger cap: screenshots and photos routinely clear
 * the editor's 2 MiB without being unreasonable to display.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** NUL in the head of a file is the classic "this is not text" heuristic. */
function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8_000).includes(0);
}

/** The DIB header sizes BMP writers actually emit (BITMAPCOREHEADER → V5). */
const DIB_HEADER_SIZES: ReadonlySet<number> = new Set([
  12, 40, 52, 56, 64, 108, 124,
]);

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, i) => buffer[i] === byte);
}

/**
 * The image type, from magic bytes rather than the extension: a ".png" that is
 * really a zip must not reach an <img>, and a screenshot saved without an
 * extension should still render. Only formats Chromium decodes are listed.
 *
 * SVG is deliberately absent — it is text, and an IDE is more useful showing
 * its source than a picture of it.
 */
function sniffImageMime(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const gifHead = buffer.subarray(0, 6).toString("latin1");
  if (gifHead === "GIF87a" || gifHead === "GIF89a") return "image/gif";
  // "BM" alone is two bytes a text file could open with; require a real DIB
  // header size behind it.
  if (
    startsWith(buffer, [0x42, 0x4d]) &&
    buffer.length >= 18 &&
    DIB_HEADER_SIZES.has(buffer.readUInt32LE(14))
  )
    return "image/bmp";
  if (startsWith(buffer, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  // RIFF and ISO-BMFF both carry their format tag past the leading size field.
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  // HEIC shares this container but Chromium has no decoder for it, so it stays
  // a binary notice rather than a broken image.
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

export class WorkspaceFsService {
  constructor(private readonly root: string) {}

  /** The absolute root, for the tree payload and logs. */
  get rootDir(): string {
    return this.root;
  }

  /**
   * Resolve a renderer-supplied relative path inside the root, throwing on
   * anything that would land outside it (absolute paths, ..-escapes).
   */
  resolve(rel: string): string {
    if (path.isAbsolute(rel)) throw new Error(`absolute path refused: ${rel}`);
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes workspace: ${rel}`);
    }
    return abs;
  }

  async tree(): Promise<WorkspaceTree> {
    const paths: string[] = [];
    let truncated = false;

    const walk = async (dirAbs: string, dirRel: string, depth: number) => {
      if (paths.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      if (depth > MAX_TREE_DEPTH) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return; // Unreadable directory (permissions) — skip, don't fail the tree.
      }
      for (const entry of entries) {
        if (paths.length >= MAX_TREE_ENTRIES) {
          truncated = true;
          break;
        }
        const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
        // Symlinks are skipped entirely: following them invites cycles and
        // walks outside the root.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue;
          const before = paths.length;
          await walk(path.join(dirAbs, entry.name), rel, depth + 1);
          // Empty directories still deserve a row (trees accepts "dir/").
          if (paths.length === before) paths.push(`${rel}/`);
        } else if (entry.isFile()) {
          if (SKIPPED_FILES.has(entry.name)) continue;
          paths.push(rel);
        }
      }
    };

    await walk(this.root, "", 0);
    paths.sort();
    return { root: this.root, paths, truncated };
  }

  async read(rel: string): Promise<WorkspaceFile> {
    const abs = this.resolve(rel);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { path: rel, kind: "unreadable", reason: "unsupported" };
    }
    // The image cap is the larger of the two, so it gates the read itself;
    // text is held to MAX_FILE_BYTES once we know it is not an image.
    if (stat.size > MAX_IMAGE_BYTES) {
      return { path: rel, kind: "unreadable", reason: "too-large" };
    }

    const buffer = await fs.readFile(abs);
    const mime = sniffImageMime(buffer);
    if (mime !== null) {
      return {
        path: rel,
        kind: "image",
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
        mime,
        bytes: stat.size,
      };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { path: rel, kind: "unreadable", reason: "too-large" };
    }
    if (looksBinary(buffer)) {
      return { path: rel, kind: "unreadable", reason: "binary" };
    }
    return { path: rel, kind: "text", contents: buffer.toString("utf8") };
  }

  async write(rel: string, contents: string): Promise<{ ok: true }> {
    const abs = this.resolve(rel);
    await fs.writeFile(abs, contents, "utf8");
    return { ok: true };
  }
}
