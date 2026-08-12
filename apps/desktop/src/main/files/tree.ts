/**
 * Pure presentation helpers for Files (§8.6): turning the control plane's flat
 * path list into one directory level, and the raw quota numbers into the
 * soft-block meter. No Electron, no I/O — unit-tested directly.
 *
 * Terminology (§8.6, and it matters): everything here describes `~/cloud`, the
 * only cloud-native tree — canonical in R2. `$HOME` on the machine is a Fly
 * volume with snapshots and is NOT end-to-end encrypted in V1; it is not
 * presented here as having one canonical cloud location.
 */

import { CLOUD_ROOT, checkQuota, normalizeVfsPath, type FileEntry, type QuotaState } from "@suma/protocol";
import type { DirectoryListing, FileDirInfo, QuotaMeter } from "../../shared/ipc";

/** The root of the cloud-native tree, as shown to the user. */
export const CLOUD_TREE_LABEL = CLOUD_ROOT;

/** Normalize a directory path; anything that escapes the root becomes "/". */
export function normalizeDirPath(path: string | undefined): string {
  if (path === undefined || path.length === 0 || path === "/") return "/";
  return normalizeVfsPath(path) ?? "/";
}

/** The path's last segment ("" for the root). */
export function basename(path: string): string {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  return parts.length === 0 ? "" : (parts[parts.length - 1] as string);
}

/** The parent directory of a VFS path ("/" for a top-level entry). */
export function dirname(path: string): string {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * One directory level: immediate files, plus immediate subfolders with the
 * RECURSIVE file count and size beneath them (a folder that only contains
 * folders still shows what it holds).
 */
export function listDirectory(entries: readonly FileEntry[], path: string | undefined): DirectoryListing {
  const dirPath = normalizeDirPath(path);
  const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
  const files: FileEntry[] = [];
  const all: FileEntry[] = [];
  const dirs = new Map<string, FileDirInfo>();

  for (const entry of entries) {
    const normalized = normalizeVfsPath(entry.path);
    if (normalized === null || !normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    if (rest.length === 0) continue;
    all.push({ ...entry, path: normalized });
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ ...entry, path: normalized });
      continue;
    }
    const name = rest.slice(0, slash);
    const childPath = `${prefix}${name}`;
    const existing = dirs.get(name);
    if (existing === undefined) {
      dirs.set(name, { name, path: childPath, fileCount: 1, sizeBytes: entry.sizeBytes });
    } else {
      existing.fileCount += 1;
      existing.sizeBytes += entry.sizeBytes;
    }
  }

  const collator = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, "en", { numeric: true });
  const byName = (a: FileEntry, b: FileEntry): number =>
    basename(a.path).localeCompare(basename(b.path), "en", { numeric: true });
  return {
    path: dirPath,
    dirs: [...dirs.values()].sort(collator),
    files: files.sort(byName),
    entries: all.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true })),
  };
}

/**
 * Byte sizes in the same units the quota is defined in. §8.6's "Pro 100 GB" is
 * 100 GiB in `PRO_QUOTA_BYTES`, and `checkQuota` labels it "GB" — so the meter
 * divides by 1024 too. Showing 107.4 GB for a "100 GB" plan would be the kind
 * of small dishonesty that makes users distrust the big claims.
 */
const BYTE_UNITS: ReadonlyArray<string> = ["B", "KB", "MB", "GB", "TB"];

export function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded.replace(/\.0$/, "")} ${BYTE_UNITS[unit] as string}`;
}

/**
 * The quota meter. The soft-block verdict comes from `checkQuota` (FROZEN)
 * rather than a re-derived comparison: at the limit Suma refuses NEW bytes
 * and never deletes or hides what is already stored.
 */
export function presentQuota(state: QuotaState): QuotaMeter {
  const verdict = checkQuota(state, 0);
  const usedLabel = formatFileBytes(verdict.usedBytes);
  const limitLabel = formatFileBytes(verdict.limitBytes);
  const fraction =
    verdict.limitBytes <= 0 ? 0 : Math.max(0, Math.min(1, verdict.usedBytes / verdict.limitBytes));
  return {
    usedBytes: verdict.usedBytes,
    limitBytes: verdict.limitBytes,
    usedLabel,
    limitLabel,
    fraction,
    softBlocked: verdict.softBlocked,
    explanation: verdict.softBlocked
      ? `Files is full at ${usedLabel} of ${limitLabel}. Your files stay available — free up space to add more.`
      : `${usedLabel} of ${limitLabel} used in ${CLOUD_TREE_LABEL}.`,
  };
}
