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

/** NUL in the head of a file is the classic "this is not text" heuristic. */
function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8_000).includes(0);
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
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return { path: rel, contents: "", unreadable: true };
    }
    const buffer = await fs.readFile(abs);
    if (looksBinary(buffer)) return { path: rel, contents: "", unreadable: true };
    return { path: rel, contents: buffer.toString("utf8"), unreadable: false };
  }

  async write(rel: string, contents: string): Promise<{ ok: true }> {
    const abs = this.resolve(rel);
    await fs.writeFile(abs, contents, "utf8");
    return { ok: true };
  }
}
