/**
 * LocalVfs — the SimAgent's filesystem, a one-for-one port of the agent's
 * vfs channel (agent/src/vfs.rs) over node:fs.
 *
 * When the "VM" is this Mac (dev, or local compute mode where the user
 * dedicates this machine as their computer), the vfs channel still has to
 * answer exactly like the Rust agent does: same ops, same confinement
 * (normalizeVfsPath + symlink-escape check), same caps, same error codes.
 * One behavior on two machines is the whole point — the IDE cannot care
 * which one it is talking to.
 *
 * The one deliberate difference: no capability gating. The sim serves the
 * user's own disk inside their own logged-in session; there are no claims to
 * check and pretending otherwise would be theater. The root is confined all
 * the same, because the *renderer* is not trusted with paths outside it.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  fromBase64,
  normalizeVfsPath,
  toBase64,
  VFS_MAX_LIST_ENTRIES,
  VFS_MAX_READ_BYTES,
  VFS_MAX_TREE_DEPTH,
  VFS_MAX_TREE_ENTRIES,
  VFS_MAX_WRITE_BYTES,
  VFS_TREE_SKIPPED_DIRS,
  VFS_TREE_SKIPPED_FILES,
  type VfsEntry,
  type VfsKind,
  type VfsRequest,
  type VfsResponse,
} from "@suma/protocol";

function error(code: string, message: string): VfsResponse {
  return { t: "error", code, message };
}

function ioError(context: string, err: unknown): VfsResponse {
  const code = (err as NodeJS.ErrnoException)?.code;
  const wire =
    code === "ENOENT"
      ? "vfs_not_found"
      : code === "EACCES" || code === "EPERM"
        ? "vfs_permission_denied"
        : "vfs_io_failed";
  const message = err instanceof Error ? err.message : String(err);
  return error(wire, `${context}: ${message}`);
}

function joinWirePath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

export class LocalVfs {
  /** Serializes the check-and-rename critical section within this filesystem. */
  private renameTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  rootDir(): string {
    return this.root;
  }

  /**
   * Resolve a path a file is about to be CREATED at, for a caller outside
   * the vfs channel (the sim's fetch.public) — a port of
   * `VfsRoot::resolve_new_file`: the usual confinement plus the two refusals
   * a destination has that a path in general does not (the root is a
   * directory; a missing parent is vfs.mkdir's job).
   */
  async resolveNewFile(
    destPath: string,
  ): Promise<{ path: string; target: string } | { refused: string }> {
    const resolved = await this.resolve(destPath);
    if (typeof resolved === "string") return { refused: resolved };
    const [wire, target] = resolved;
    if (wire === "/") {
      return { refused: "the Files root is a directory, not a destination" };
    }
    if (!(await isDirectory(path.dirname(target)))) {
      return {
        refused: `${wire}: parent directory does not exist (use vfs.mkdir first)`,
      };
    }
    return { path: wire, target };
  }

  /** Answer one vfs request; failures are the `error` variant, never a throw. */
  async handle(request: VfsRequest): Promise<VfsResponse> {
    try {
      return await this.dispatch(request);
    } catch (err) {
      // A bug in the port should read like an agent I/O failure, not crash
      // the main process.
      return ioError(`vfs ${request.t}`, err);
    }
  }

  private async dispatch(request: VfsRequest): Promise<VfsResponse> {
    const primary = request.t === "vfs.rename" ? request.from : request.path;
    const resolved = await this.resolve(primary);
    if (typeof resolved === "string")
      return error("vfs_path_refused", resolved);
    const [wire, target] = resolved;

    switch (request.t) {
      case "vfs.list":
        return this.list(wire, target);
      case "vfs.stat":
        return this.stat(wire, target);
      case "vfs.read":
        return this.read(wire, target, request.offset, request.length);
      case "vfs.write":
        return this.write(wire, target, request.dataB64);
      case "vfs.append":
        return this.append(wire, target, request.dataB64);
      case "vfs.delete":
        return this.delete(wire, target, request.recursive === true);
      case "vfs.mkdir":
        return this.mkdir(wire, target);
      case "vfs.tree":
        return this.tree(wire, target);
      case "vfs.rename":
        return this.rename(wire, target, request.to);
    }
  }

  /* ------------------------------ paths ------------------------------ */

  /**
   * Normalize, join under the root, and prove the deepest existing component
   * still resolves inside it — the same two-layer confinement as
   * VfsRoot::resolve_within. Returns the refusal reason as a string.
   */
  private async resolve(requested: string): Promise<[string, string] | string> {
    const normalized = normalizeVfsPath(requested);
    if (normalized === null)
      return "path escapes the Files root or contains a NUL";
    const relative = normalized.replace(/^\/+/, "");
    const target = relative === "" ? this.root : path.join(this.root, relative);
    const escape = await this.checkNoSymlinkEscape(target);
    if (escape !== null) return escape;
    return [normalized, target];
  }

  private async checkNoSymlinkEscape(target: string): Promise<string | null> {
    let rootReal: string;
    try {
      rootReal = await fs.realpath(this.root);
    } catch {
      // No root on disk yet means nothing inside it exists to link through.
      return null;
    }
    let probe = target;
    for (;;) {
      if (await pathExists(probe)) {
        let real: string;
        try {
          real = await fs.realpath(probe);
        } catch {
          return "path passes through a link that cannot be resolved";
        }
        if (real === rootReal || real.startsWith(rootReal + path.sep))
          return null;
        return "path resolves outside the Files root";
      }
      const parent = path.dirname(probe);
      if (parent === probe) return "path has no resolvable parent";
      probe = parent;
    }
  }

  /* ------------------------------ ops ------------------------------ */

  private async list(wire: string, target: string): Promise<VfsResponse> {
    let names: import("node:fs").Dirent[];
    try {
      names = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      return ioError(`listing ${wire}`, err);
    }
    const truncated = names.length > VFS_MAX_LIST_ENTRIES;
    const entries: VfsEntry[] = [];
    for (const dirent of names.slice(0, VFS_MAX_LIST_ENTRIES)) {
      const kind: VfsKind = dirent.isDirectory()
        ? "dir"
        : dirent.isFile()
          ? "file"
          : "other";
      let sizeBytes = 0;
      let modifiedAtMs = 0;
      try {
        const stat = await fs.lstat(path.join(target, dirent.name));
        sizeBytes = stat.size;
        modifiedAtMs = Math.max(0, Math.floor(stat.mtimeMs));
      } catch {
        // Entry vanished mid-listing; report it with zeroed metadata.
      }
      entries.push({
        name: dirent.name,
        path: joinWirePath(wire, dirent.name),
        kind,
        sizeBytes,
        modifiedAtMs,
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { t: "vfs.listing", path: wire, entries, truncated };
  }

  private async stat(wire: string, target: string): Promise<VfsResponse> {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(target);
    } catch (err) {
      return ioError(`stat ${wire}`, err);
    }
    const name =
      wire
        .split("/")
        .filter((s) => s.length > 0)
        .at(-1) ?? "/";
    return {
      t: "vfs.info",
      entry: {
        name,
        path: wire,
        kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        sizeBytes: stat.size,
        modifiedAtMs: Math.max(0, Math.floor(stat.mtimeMs)),
      },
    };
  }

  private async read(
    wire: string,
    target: string,
    offset: number,
    length: number,
  ): Promise<VfsResponse> {
    if (length === 0 || length > VFS_MAX_READ_BYTES) {
      return error(
        "invalid_request",
        `length must be 1..=${VFS_MAX_READ_BYTES}: a larger read cannot fit one mux frame once base64-encoded`,
      );
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, fsConstants.O_RDONLY);
    } catch (err) {
      return ioError(`reading ${wire}`, err);
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory())
        return error("vfs_is_a_directory", `${wire} is a directory`);
      const size = stat.size;
      if (offset > size) {
        return error(
          "invalid_request",
          `offset ${offset} is past the end of ${wire} (${size} bytes)`,
        );
      }
      const want = Math.min(length, size - offset);
      const buf = Buffer.alloc(want);
      let read = 0;
      while (read < want) {
        const { bytesRead } = await handle.read(
          buf,
          read,
          want - read,
          offset + read,
        );
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return {
        t: "vfs.data",
        path: wire,
        offset,
        dataB64: toBase64(buf.subarray(0, read)),
        eof: offset + read >= size,
      };
    } catch (err) {
      return ioError(`reading ${wire}`, err);
    } finally {
      await handle.close();
    }
  }

  private async write(
    wire: string,
    target: string,
    dataB64: string,
  ): Promise<VfsResponse> {
    const tooLarge = error(
      "vfs_too_large",
      `a single write is limited to ${VFS_MAX_WRITE_BYTES} bytes`,
    );
    if ((dataB64.length / 4) * 3 > VFS_MAX_WRITE_BYTES) return tooLarge;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(dataB64);
    } catch (err) {
      return error("invalid_request", `dataB64 is not base64: ${String(err)}`);
    }
    if (bytes.byteLength > VFS_MAX_WRITE_BYTES) return tooLarge;
    if (wire === "/")
      return error("vfs_path_refused", "cannot write to the Files root itself");
    const parent = path.dirname(target);
    if (!(await isDirectory(parent))) {
      return error(
        "vfs_not_found",
        `${wire}: parent directory does not exist (use vfs.mkdir first)`,
      );
    }
    // Write beside the destination and rename: a write that dies partway must
    // not leave a truncated file where a complete one used to be.
    const temp = path.join(
      parent,
      `.suma-vfs-${process.pid}-${process.hrtime.bigint()}`,
    );
    try {
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return ioError(`writing ${wire}`, err);
    }
    return { t: "vfs.wrote", path: wire, sizeBytes: bytes.byteLength };
  }

  private async append(
    wire: string,
    target: string,
    dataB64: string,
  ): Promise<VfsResponse> {
    const tooLarge = error(
      "vfs_too_large",
      `a single append is limited to ${VFS_MAX_WRITE_BYTES} bytes`,
    );
    if ((dataB64.length / 4) * 3 > VFS_MAX_WRITE_BYTES) return tooLarge;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(dataB64);
    } catch (err) {
      return error("invalid_request", `dataB64 is not base64: ${String(err)}`);
    }
    if (bytes.byteLength > VFS_MAX_WRITE_BYTES) return tooLarge;
    // Append extends a file that already exists — creating one is vfs.write's
    // job, so a typo'd path fails loudly instead of starting a stray file.
    let before: import("node:fs").Stats;
    try {
      before = await fs.lstat(target);
    } catch (err) {
      return ioError(`appending to ${wire}`, err);
    }
    if (before.isDirectory())
      return error("vfs_is_a_directory", `${wire} is a directory`);
    try {
      await fs.appendFile(target, bytes);
    } catch (err) {
      return ioError(`appending to ${wire}`, err);
    }
    return {
      t: "vfs.wrote",
      path: wire,
      sizeBytes: before.size + bytes.byteLength,
    };
  }

  private async delete(
    wire: string,
    target: string,
    recursive: boolean,
  ): Promise<VfsResponse> {
    if (wire === "/")
      return error("vfs_path_refused", "the Files root cannot be deleted");
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(target);
    } catch (err) {
      return ioError(`deleting ${wire}`, err);
    }
    try {
      if (stat.isDirectory()) {
        if (recursive) {
          // Erasing a subtree takes an explicit flag; a bare delete cannot.
          await fs.rm(target, { recursive: true });
        } else {
          await fs.rmdir(target);
        }
      } else {
        await fs.unlink(target);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Some platforms report a populated directory as EEXIST.
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return error(
          "vfs_not_empty",
          `${wire} is not empty: delete its entries first`,
        );
      }
      return ioError(`deleting ${wire}`, err);
    }
    return { t: "vfs.deleted", path: wire };
  }

  private async mkdir(wire: string, target: string): Promise<VfsResponse> {
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (err) {
      return ioError(`creating ${wire}`, err);
    }
    return { t: "vfs.created", path: wire };
  }

  private async tree(wire: string, target: string): Promise<VfsResponse> {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory())
        return error("vfs_io_failed", `${wire} is not a directory`);
    } catch (err) {
      return ioError(`walking ${wire}`, err);
    }
    const paths: string[] = [];
    let truncated = false;
    // Iterative DFS mirroring the agent's walk: skip-lists, symlinks omitted,
    // unreadable directories skipped rather than fatal, empty dirs kept as
    // trailing-slash rows.
    const stack: Array<[string, string, number]> = [[target, wire, 0]];
    while (stack.length > 0) {
      const [dir, dirRel, depth] = stack.pop() as [string, string, number];
      if (paths.length >= VFS_MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let contributed = false;
      for (const dirent of dirents) {
        if (paths.length >= VFS_MAX_TREE_ENTRIES) {
          truncated = true;
          break;
        }
        const name = dirent.name;
        if (dirent.isDirectory()) {
          if (VFS_TREE_SKIPPED_DIRS.includes(name)) continue;
          if (depth + 1 > VFS_MAX_TREE_DEPTH) {
            truncated = true;
            continue;
          }
          stack.push([
            path.join(dir, name),
            joinWirePath(dirRel, name),
            depth + 1,
          ]);
          contributed = true;
        } else if (dirent.isFile()) {
          if (VFS_TREE_SKIPPED_FILES.includes(name)) continue;
          paths.push(joinWirePath(dirRel, name));
          contributed = true;
        }
        // Symlinks/sockets/devices are omitted entirely.
      }
      if (!contributed && !truncated && dirRel !== wire) {
        paths.push(`${dirRel}/`);
      }
    }
    paths.sort();
    return { t: "vfs.paths", path: wire, paths, truncated };
  }

  private async rename(
    fromWire: string,
    fromTarget: string,
    to: string,
  ): Promise<VfsResponse> {
    return this.withRenameLock(async () => {
      const resolved = await this.resolve(to);
      if (typeof resolved === "string")
        return error("vfs_path_refused", resolved);
      const [toWire, toTarget] = resolved;
      if (fromWire === "/") {
        return error("vfs_path_refused", "the Files root cannot be renamed");
      }
      if (toWire === "/") {
        return error(
          "vfs_path_refused",
          "the Files root is a directory, not a destination",
        );
      }
      if (!(await pathExists(fromTarget))) {
        return error("vfs_not_found", `${fromWire}: no such path`);
      }
      // This check and the rename are one critical section. Without it, two
      // clients can both observe an absent destination and macOS rename(2)
      // lets the later one silently replace the earlier result.
      if (await pathExists(toTarget)) {
        return error(
          "vfs_already_exists",
          `${toWire} already exists: rename must not overwrite`,
        );
      }
      if (!(await isDirectory(path.dirname(toTarget)))) {
        return error(
          "vfs_not_found",
          `${toWire}: parent directory does not exist (use vfs.mkdir first)`,
        );
      }
      try {
        await fs.rename(fromTarget, toTarget);
      } catch (err) {
        return ioError(`renaming ${fromWire}`, err);
      }
      return { t: "vfs.renamed", from: fromWire, to: toWire };
    });
  }

  private async withRenameLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.renameTail;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.renameTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
