/**
 * Download-routing preference (§8.6 `alwaysLocal`).
 *
 * `cloudFetchEligibility` takes "the user said keep downloads on this Mac" as
 * an input, so it has to come from somewhere real. It lives in its own small
 * file next to workspace.json rather than in WorkspaceSettings, because that
 * type is part of the frozen sync contract and this is a device-local choice —
 * one Mac routing downloads to the cloud says nothing about another.
 *
 * Honest status: Phase 3 READS this preference but ships no UI to flip it (the
 * Phase-3 IPC surface is fixed to the files/transfers channels). Writing
 * `{"downloadsAlwaysLocal": true}` into the file is how it is set today.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const PREFS_FILENAME = "files-prefs.json";

/** Re-read at most this often — `will-download` must not do file I/O per byte. */
const CACHE_MS = 5_000;

export interface DownloadPolicy {
  /** Keep every download on this Mac, regardless of eligibility. */
  alwaysLocal: boolean;
}

export function parseDownloadPolicy(raw: string): DownloadPolicy {
  try {
    const parsed = JSON.parse(raw) as { downloadsAlwaysLocal?: unknown };
    return { alwaysLocal: parsed.downloadsAlwaysLocal === true };
  } catch {
    return { alwaysLocal: false };
  }
}

/** Cached reader for the `will-download` hot path. */
export function createDownloadPolicyReader(userDataDir: string): () => boolean {
  const file = path.join(userDataDir, PREFS_FILENAME);
  let cached: DownloadPolicy = { alwaysLocal: false };
  let readAtMs = 0;
  return () => {
    const now = Date.now();
    if (now - readAtMs < CACHE_MS) return cached.alwaysLocal;
    readAtMs = now;
    try {
      cached = parseDownloadPolicy(readFileSync(file, "utf8"));
    } catch {
      cached = { alwaysLocal: false }; // no file ⇒ the default, cloud routing allowed
    }
    return cached.alwaysLocal;
  };
}
