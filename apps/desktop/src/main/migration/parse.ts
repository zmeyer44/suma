/**
 * Pure Chrome/Arc bookmark parsing + sign-in queue construction (M-0,
 * PRD §5). Takes already-read JSON, returns plain data — no fs, no Electron.
 */

import { matchOriginPolicy, type OriginPolicy } from "@suma/protocol";
import type { SignInQueueItem } from "../../shared/ipc";

export interface ParsedBookmark {
  title: string;
  url: string;
}

export interface ParsedFolder {
  name: string;
  /** All http(s) bookmarks under the folder, nested folders flattened. */
  bookmarks: ParsedBookmark[];
}

export interface ParsedBookmarkTree {
  /** Top-level folders of the bookmark bar, in file order. */
  folders: ParsedFolder[];
  /** Every http(s) bookmark anywhere in the file, in traversal order. */
  bookmarks: ParsedBookmark[];
}

interface RawNode {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  children?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function collectBookmarks(node: RawNode, out: ParsedBookmark[]): void {
  if (node.type === "url") {
    if (typeof node.url === "string" && isHttpUrl(node.url)) {
      const title = typeof node.name === "string" && node.name.length > 0 ? node.name : node.url;
      out.push({ title, url: node.url });
    }
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isRecord(child)) collectBookmarks(child, out);
    }
  }
}

/**
 * Parse a Chrome-format Bookmarks file (Arc uses the same shape). Malformed
 * input yields an empty tree rather than throwing — imports must degrade,
 * not crash.
 */
export function parseBookmarksJson(input: unknown): ParsedBookmarkTree {
  const empty: ParsedBookmarkTree = { folders: [], bookmarks: [] };
  if (!isRecord(input) || !isRecord(input["roots"])) return empty;
  const roots = input["roots"];
  const folders: ParsedFolder[] = [];
  const bookmarks: ParsedBookmark[] = [];
  const bar = roots["bookmark_bar"];
  if (isRecord(bar) && Array.isArray(bar["children"])) {
    for (const child of bar["children"]) {
      if (!isRecord(child)) continue;
      if (child["type"] === "folder" && typeof child["name"] === "string") {
        const own: ParsedBookmark[] = [];
        collectBookmarks(child, own);
        folders.push({ name: child["name"], bookmarks: own });
        bookmarks.push(...own);
      } else {
        collectBookmarks(child, bookmarks);
      }
    }
  }
  for (const key of ["other", "synced"]) {
    const root = roots[key];
    if (isRecord(root)) collectBookmarks(root, bookmarks);
  }
  return { folders, bookmarks };
}

export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Guided sign-in queue (M-0): corpus origins present in the imported
 * bookmarks, ranked by bookmark count (most-used first), sensitive origins
 * flagged (excluded from sync by default, §4), capped at `limit`.
 */
export function buildSignInQueue(
  bookmarks: ReadonlyArray<ParsedBookmark>,
  policies: ReadonlyArray<OriginPolicy>,
  limit = 12,
): SignInQueueItem[] {
  const counts = new Map<string, { policy: OriginPolicy; count: number }>();
  for (const bookmark of bookmarks) {
    const host = hostOfUrl(bookmark.url);
    if (host === null) continue;
    const policy = matchOriginPolicy(policies, host);
    if (policy.domain === "") continue; // outside the tested corpus
    const entry = counts.get(policy.domain);
    if (entry === undefined) counts.set(policy.domain, { policy, count: 1 });
    else entry.count += 1;
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.policy.domain.localeCompare(b.policy.domain))
    .slice(0, limit)
    .map(({ policy }, index) => ({
      domain: policy.domain,
      label: policy.label,
      mode: policy.mode,
      sensitive: policy.sensitive,
      rank: index + 1,
      done: false,
    }));
}
