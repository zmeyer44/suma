/**
 * Pure Files logic (PRD §8.6, M-3 Lite): path admission, manifest validation,
 * the deduplicated upload set, and the transfer state machine. Kept out of
 * `app.ts` so every rule here is unit-testable without a database.
 *
 * `@suma/protocol` owns the wire contracts (`Manifest`, `FileEntry`,
 * `Transfer`, `checkQuota`, `normalizeVfsPath`) and is used, not restated.
 *
 * `@suma/chunking` is NOT a declared dependency of this service, so the two
 * values below and `missingChunkRefs` replicate its semantics rather than
 * importing them. Chunk boundaries are decided by the client and the agent,
 * which do import it; the control plane only needs to bound what it accepts
 * and to answer "which of these do you already have?".
 */

import {
  TRANSFER_STATES,
  normalizeVfsPath,
  type FileEntry,
  type Manifest,
  type Transfer,
  type TransferState,
} from "@suma/protocol";

/** Mirrors `MAX_CHUNK_BYTES` in packages/chunking — no chunk may exceed it. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Chunks one manifest may declare. At packages/chunking's 1 MiB average this
 * covers ~16 GB in a single request, comfortably above §5's 5 GB dataset,
 * while keeping a manifest body a few megabytes rather than tens.
 */
export const MAX_MANIFEST_CHUNKS = 16_384;

/** Longest path the Files API accepts, matching the protocol's schemas. */
export const MAX_PATH_LENGTH = 4096;

export type PathRefusal = "empty" | "traversal" | "control_characters" | "is_root";

export type PathResult = { ok: true; path: string } | { ok: false; reason: PathRefusal };

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Admit a user-supplied file path. `normalizeVfsPath` is the frozen traversal
 * rule (`..` may never escape the root); this adds the two cases a FILE path
 * has beyond a VFS path — the root is a directory, and control characters have
 * no place in a name that becomes an object key and a UI string.
 */
export function normalizeFilePath(raw: string): PathResult {
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (CONTROL_CHARACTERS.test(raw)) return { ok: false, reason: "control_characters" };
  const normalized = normalizeVfsPath(raw);
  if (normalized === null) return { ok: false, reason: "traversal" };
  if (normalized === "/") return { ok: false, reason: "is_root" };
  return { ok: true, path: normalized };
}

/** Normalize a prefix for listing; the root prefix is legal here. */
export function normalizePrefix(raw: string): string | null {
  if (CONTROL_CHARACTERS.test(raw)) return null;
  return normalizeVfsPath(raw === "" ? "/" : raw);
}

export type ManifestRefusal =
  | "too_many_chunks"
  | "chunk_too_large"
  | "non_contiguous"
  | "size_mismatch";

/**
 * A manifest the control plane will record. The client computed it, so it is
 * checked for internal consistency before any of it becomes a row: offsets
 * must tile [0, totalBytes) exactly, in order, with no gaps or overlaps.
 * Without this, a lying manifest would produce a "file" that can never
 * reassemble, and a size the quota meter would bill for.
 */
export function validateManifest(manifest: Manifest): ManifestRefusal | null {
  if (manifest.chunks.length > MAX_MANIFEST_CHUNKS) return "too_many_chunks";
  let offset = 0;
  for (const chunk of manifest.chunks) {
    if (chunk.length > MAX_CHUNK_BYTES) return "chunk_too_large";
    if (chunk.offset !== offset) return "non_contiguous";
    offset += chunk.length;
  }
  if (offset !== manifest.totalBytes) return "size_mismatch";
  return null;
}

export interface ChunkRef {
  hash: string;
  offset: number;
  length: number;
}

/** Each distinct chunk of a manifest, first occurrence order. */
export function distinctChunks(manifest: Manifest): ChunkRef[] {
  const seen = new Set<string>();
  const out: ChunkRef[] = [];
  for (const chunk of manifest.chunks) {
    if (seen.has(chunk.hash)) continue;
    seen.add(chunk.hash);
    out.push(chunk);
  }
  return out;
}

/**
 * The upload set after deduplication — replicates `missingChunks` from
 * packages/chunking (which this package may not import): each distinct chunk
 * the destination does not already hold, in first-occurrence order.
 */
export function missingChunkRefs(manifest: Manifest, has: (hash: string) => boolean): ChunkRef[] {
  return distinctChunks(manifest).filter((chunk) => !has(chunk.hash));
}

/** Bytes a manifest would newly store, i.e. what the quota check must weigh. */
export function newBytes(manifest: Manifest, has: (hash: string) => boolean): number {
  return missingChunkRefs(manifest, has).reduce((total, chunk) => total + chunk.length, 0);
}

/** Chunk objects are namespaced per user — see the `chunks` table comment. */
export function chunkObjectKey(userId: string, hash: string): string {
  return `chunks/${userId}/${hash}`;
}

export interface FileRow {
  id: string;
  path: string;
  sizeBytes: number;
  fileHash: string;
  contentType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Project a stored row onto the frozen `FileEntry` wire shape. */
export function fileEntryView(row: FileRow): FileEntry {
  return {
    id: row.id,
    path: row.path,
    sizeBytes: row.sizeBytes,
    fileHash: row.fileHash,
    contentType: row.contentType,
    createdAtMs: row.createdAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}

/* ------------------------------------------------------------------ *
 * Transfers (§8.6 cloud fetch)
 * ------------------------------------------------------------------ */

/**
 * A transfer that can never land is not worth queueing: nothing above the
 * whole Files quota will ever fit, whatever the origin reports.
 */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024 * 1024;

export const TERMINAL_TRANSFER_STATES: ReadonlyArray<TransferState> = [
  "completed",
  "failed",
  "cancelled",
];

/** The states a transfer still occupies a queue slot in. */
export const ACTIVE_TRANSFER_STATES: ReadonlyArray<TransferState> = TRANSFER_STATES.filter(
  (state) => !TERMINAL_TRANSFER_STATES.includes(state),
);

const TRANSFER_TRANSITIONS: Readonly<Record<TransferState, ReadonlyArray<TransferState>>> = {
  queued: ["fetching", "failed", "cancelled"],
  fetching: ["fetching", "storing", "failed", "cancelled"],
  storing: ["storing", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalTransfer(state: TransferState): boolean {
  return TERMINAL_TRANSFER_STATES.includes(state);
}

/**
 * Legal moves for a transfer. Self-transitions on `fetching`/`storing` are the
 * progress heartbeat; terminal states accept nothing, so a cancelled transfer
 * can never be resurrected by a late agent report.
 */
export function canTransferTransition(from: TransferState, to: TransferState): boolean {
  return TRANSFER_TRANSITIONS[from].includes(to);
}

export function isTransferState(value: string): value is TransferState {
  return (TRANSFER_STATES as ReadonlyArray<string>).includes(value);
}

export interface TransferRow {
  id: string;
  url: string;
  destPath: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
  originDeviceId: string | null;
  error: string | null;
  startedAt: Date;
  updatedAt: Date;
}

/**
 * The part of a fetch URL the product needs and nothing else: scheme, host and
 * path — enough for the UI to name the source and the file, with the query
 * string, fragment and any userinfo removed.
 *
 * A presigned URL IS the authorization for the object it names, so the query
 * string is a bearer credential with a lifetime of its own. The audit trail
 * already stores only the hostname for exactly this reason; a transfer row
 * that kept the whole link — and an API that handed it to every device that
 * polls — would put that credential back, in a place that outlives the fetch.
 */
export function redactTransferUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Unreachable through the API (`cloudFetchEligibility` refuses anything
    // that is not an http(s) URL), but a stored row is still truncated at the
    // first delimiter rather than returned whole.
    return raw.split(/[?#]/)[0] ?? "";
  }
}

/**
 * Project a stored row onto the frozen `Transfer` wire shape. The URL is
 * redacted on the way out, so a credentialed link cannot be read back out of
 * the API even while the transfer it belongs to is still running.
 */
export function transferView(row: TransferRow): Transfer {
  return {
    id: row.id,
    url: redactTransferUrl(row.url),
    destPath: row.destPath,
    state: row.state as TransferState,
    receivedBytes: row.receivedBytes,
    totalBytes: row.totalBytes,
    originDeviceId: row.originDeviceId,
    error: row.error,
    startedAtMs: row.startedAt.getTime(),
    updatedAtMs: row.updatedAt.getTime(),
  };
}
