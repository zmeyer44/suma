/**
 * Flat `FileEntry[]` → browsable tree. Pure; unit-tested.
 *
 * Every path goes through `normalizeVfsPath` (the frozen protocol helper)
 * before it becomes a node, so a traversal-shaped path from anywhere can never
 * produce a node above the root — it is dropped instead.
 */

import { normalizeVfsPath, type FileEntry } from "@suma/protocol";

export const ROOT_PATH = "/";

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  sizeBytes: number;
  entry: FileEntry;
}

export interface TreeDir {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  /** Files at or below this directory. */
  fileCount: number;
  /** Sum of file sizes at or below this directory. */
  sizeBytes: number;
}

export type TreeNode = TreeDir | TreeFile;

interface DirBuilder {
  name: string;
  path: string;
  dirs: Map<string, DirBuilder>;
  files: Map<string, FileEntry>;
}

function newDir(name: string, path: string): DirBuilder {
  return { name, path, dirs: new Map(), files: new Map() };
}

function joinSegment(dirPath: string, segment: string): string {
  return dirPath === ROOT_PATH ? `/${segment}` : `${dirPath}/${segment}`;
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const byName = a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });
  return byName !== 0 ? byName : a.path.localeCompare(b.path);
}

function finalize(builder: DirBuilder): TreeDir {
  const children: TreeNode[] = [];
  let fileCount = 0;
  let sizeBytes = 0;

  for (const child of builder.dirs.values()) {
    const dir = finalize(child);
    children.push(dir);
    fileCount += dir.fileCount;
    sizeBytes += dir.sizeBytes;
  }
  for (const [name, entry] of builder.files) {
    // A name can be a directory *or* a file, never both. Directories win:
    // dropping a leaf keeps one entry out of the browser, dropping a directory
    // would hide everything underneath it.
    if (builder.dirs.has(name)) continue;
    children.push({
      kind: "file",
      name,
      path: joinSegment(builder.path, name),
      sizeBytes: entry.sizeBytes,
      entry,
    });
    fileCount += 1;
    sizeBytes += entry.sizeBytes;
  }

  children.sort(compareNodes);
  return { kind: "dir", name: builder.name, path: builder.path, children, fileCount, sizeBytes };
}

/**
 * Build the root directory. Entries with unusable paths (traversal, empty,
 * NUL) are skipped rather than guessed at; a later entry for the same
 * normalized path replaces an earlier one.
 */
export function buildTree(entries: readonly FileEntry[]): TreeDir {
  const root = newDir("", ROOT_PATH);

  for (const entry of entries) {
    const normalized = normalizeVfsPath(entry.path);
    if (normalized === null || normalized === ROOT_PATH) continue;

    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const leaf = segments[segments.length - 1];
    if (leaf === undefined) continue;

    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.dirs.get(segment);
      if (next === undefined) {
        next = newDir(segment, joinSegment(cursor.path, segment));
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.set(leaf, { ...entry, path: normalized });
  }

  return finalize(root);
}

export interface TreeRow {
  node: TreeNode;
  /** 0 for the root's direct children. */
  depth: number;
  /** Meaningful for directories only. */
  expanded: boolean;
}

/** Depth-first rows for rendering: a directory's children appear only when open. */
export function flattenTree(root: TreeDir, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.kind === "file") {
        rows.push({ node, depth, expanded: false });
        continue;
      }
      const isOpen = expanded.has(node.path);
      rows.push({ node, depth, expanded: isOpen });
      if (isOpen) walk(node.children, depth + 1);
    }
  };
  walk(root.children, 0);
  return rows;
}

/** "/a/b/c.txt" → "/a/b"; a top-level path → "/". */
export function parentPath(path: string): string {
  const normalized = normalizeVfsPath(path);
  if (normalized === null) return ROOT_PATH;
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? ROOT_PATH : normalized.slice(0, idx);
}

/** Every directory containing `path`, root first: ["/", "/a", "/a/b"]. */
export function ancestorPaths(path: string): string[] {
  const normalized = normalizeVfsPath(path);
  if (normalized === null) return [ROOT_PATH];
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const out: string[] = [ROOT_PATH];
  let current = ROOT_PATH;
  for (const segment of segments.slice(0, -1)) {
    current = joinSegment(current, segment);
    out.push(current);
  }
  return out;
}

/** Join a directory and a leaf name, refusing anything that escapes the root. */
export function joinPath(dirPath: string, name: string): string | null {
  const dir = normalizeVfsPath(dirPath) ?? ROOT_PATH;
  return normalizeVfsPath(joinSegment(dir, name));
}

/** Find a node by exact path (the root itself is addressable as "/"). */
export function findNode(root: TreeDir, path: string): TreeNode | null {
  if (path === ROOT_PATH) return root;
  const normalized = normalizeVfsPath(path);
  if (normalized === null) return null;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  let cursor: TreeNode = root;
  for (const segment of segments) {
    if (cursor.kind !== "dir") return null;
    const next: TreeNode | undefined = cursor.children.find((child) => child.name === segment);
    if (next === undefined) return null;
    cursor = next;
  }
  return cursor;
}

/** Breadcrumb segments for a path, root excluded. */
export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const normalized = normalizeVfsPath(path);
  if (normalized === null || normalized === ROOT_PATH) return [];
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const out: Array<{ name: string; path: string }> = [];
  let current = ROOT_PATH;
  for (const segment of segments) {
    current = joinSegment(current, segment);
    out.push({ name: segment, path: current });
  }
  return out;
}
