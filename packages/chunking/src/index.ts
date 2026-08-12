/**
 * Content-defined chunking for the data plane (PRD §7: "R2 (FastCDC + BLAKE3
 * chunks; $0 egress)"; §8.6 uploads/hydration; §8.5 $HOME snapshots).
 *
 * Why content-defined rather than fixed-size: inserting a byte near the start
 * of a file shifts every subsequent fixed-size block, so an incremental
 * snapshot would re-upload the whole file. FastCDC picks boundaries from a
 * rolling hash of the content itself, so an edit only disturbs the chunks
 * around it and the rest still hash to what R2 already holds.
 *
 * The Rust agent chunks the same bytes and must reach the SAME boundaries and
 * the same BLAKE3 addresses, or deduplication silently stops working and
 * every device re-uploads everything. Everything that decides a boundary is
 * therefore derived deterministically here — including the gear table, which
 * is generated from a domain-separated BLAKE3 stream rather than shipped as a
 * literal both languages could copy differently.
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

/* ------------------------------------------------------------------ *
 * Parameters
 * ------------------------------------------------------------------ */

/**
 * Chunk sizes are deliberately large. §11 flags "R2 request costs from
 * small-file chunking" as a margin risk: an 8 KiB average would turn a 5 GB
 * dataset (§5 M-3) into ~650k objects and ~650k PUTs. At a 1 MiB average the
 * same file is ~5k chunks, which keeps request costs negligible while still
 * deduplicating edits at a useful granularity.
 */
export const MIN_CHUNK_BYTES = 256 * 1024;
export const AVG_CHUNK_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/** Domain separation for the gear table — changing this changes every boundary. */
const GEAR_DOMAIN = "suma.fastcdc.gear.v1";

/**
 * Deterministic mask with `bits` bits set, spread evenly across the 32-bit
 * word. A boundary needs every masked bit of the rolling hash to be zero, so
 * the bit COUNT sets the expected distance between cuts (2^bits bytes) while
 * the positions only need to be fixed and agreed on by both languages.
 */
function maskWithBits(bits: number): number {
  let mask = 0;
  for (let i = 0; i < bits; i++) mask |= 1 << Math.floor((i * 32) / bits);
  return mask >>> 0;
}

/**
 * FastCDC's normalized chunking uses two masks: a stricter one before the
 * average size (making an early cut unlikely) and a looser one after (making
 * a late cut likely). That pulls the size distribution toward the average
 * instead of the long exponential tail plain CDC produces.
 *
 * log2(AVG_CHUNK_BYTES) is 20, so 22/18 bits straddle the target.
 */
const MASK_SMALL = maskWithBits(22);
const MASK_LARGE = maskWithBits(18);

/**
 * 256-entry gear table, derived from BLAKE3 so both languages can regenerate
 * it identically: entry i is the little-endian u32 of
 * blake3(GEAR_DOMAIN ‖ [i])[0..4].
 *
 * 32-bit on purpose: the rolling hash runs once per byte, and 64-bit values
 * in JS mean BigInt, which is ~100x slower here — enough to make chunking a
 * multi-gigabyte dataset (§5 M-3) take minutes instead of seconds.
 */
function buildGearTable(): Uint32Array {
  const table = new Uint32Array(256);
  const domain = new TextEncoder().encode(GEAR_DOMAIN);
  const input = new Uint8Array(domain.length + 1);
  input.set(domain, 0);
  for (let i = 0; i < 256; i++) {
    input[domain.length] = i;
    const d = blake3(input);
    table[i] =
      (((d[3] as number) << 24) |
        ((d[2] as number) << 16) |
        ((d[1] as number) << 8) |
        (d[0] as number)) >>>
      0;
  }
  return table;
}

export const GEAR_TABLE: Uint32Array = buildGearTable();

/** Hex of the gear table's own BLAKE3 — a cheap cross-language equality check. */
export function gearTableFingerprint(): string {
  const bytes = new Uint8Array(GEAR_TABLE.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < GEAR_TABLE.length; i++) view.setUint32(i * 4, GEAR_TABLE[i] as number, true);
  return bytesToHex(blake3(bytes));
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/**
 * Index of the first boundary at or after MIN_CHUNK_BYTES, or `data.length`
 * when none is found before MAX_CHUNK_BYTES. Operates on a whole buffer; the
 * streaming caller feeds it successive slices.
 */
export function nextBoundary(data: Uint8Array, start: number): number {
  const remaining = data.length - start;
  if (remaining <= MIN_CHUNK_BYTES) return data.length;

  const hardLimit = start + Math.min(remaining, MAX_CHUNK_BYTES);
  const normalLimit = start + Math.min(remaining, AVG_CHUNK_BYTES);
  let hash = 0;
  let i = start + MIN_CHUNK_BYTES;

  // Before the average size: the strict mask makes a cut unlikely.
  for (; i < normalLimit; i++) {
    hash = (((hash << 1) >>> 0) + (GEAR_TABLE[data[i] as number] as number)) >>> 0;
    if ((hash & MASK_SMALL) === 0) return i + 1;
  }
  // Past the average: the loose mask makes a cut likely, bounding the tail.
  for (; i < hardLimit; i++) {
    hash = (((hash << 1) >>> 0) + (GEAR_TABLE[data[i] as number] as number)) >>> 0;
    if ((hash & MASK_LARGE) === 0) return i + 1;
  }
  return hardLimit;
}

export interface Chunk {
  /** BLAKE3 of the chunk bytes, hex — the R2 object key and dedup identity. */
  hash: string;
  offset: number;
  length: number;
}

/** Split a buffer into content-defined chunks with their content addresses. */
export function chunkBuffer(data: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  while (offset < data.length) {
    const end = nextBoundary(data, offset);
    const slice = data.subarray(offset, end);
    chunks.push({ hash: bytesToHex(blake3(slice)), offset, length: slice.length });
    offset = end;
  }
  return chunks;
}

export function hashChunk(data: Uint8Array): string {
  return bytesToHex(blake3(data));
}

/* ------------------------------------------------------------------ *
 * Manifests
 * ------------------------------------------------------------------ */

/**
 * A file as stored: an ordered list of chunk addresses. The manifest is what
 * the control plane keeps; the chunks themselves live in R2 and may be shared
 * by any number of files.
 */
export interface ChunkManifest {
  /** BLAKE3 of the whole file — identity, and what an integrity check compares. */
  fileHash: string;
  totalBytes: number;
  chunks: Chunk[];
}

export function buildManifest(data: Uint8Array): ChunkManifest {
  return {
    fileHash: bytesToHex(blake3(data)),
    totalBytes: data.length,
    chunks: chunkBuffer(data),
  };
}

/** Reassemble a file from its manifest and a chunk source; verifies as it goes. */
export function assembleFromChunks(
  manifest: ChunkManifest,
  lookup: (hash: string) => Uint8Array | undefined,
): Uint8Array {
  const out = new Uint8Array(manifest.totalBytes);
  let offset = 0;
  for (const chunk of manifest.chunks) {
    const bytes = lookup(chunk.hash);
    if (bytes === undefined) throw new Error(`missing chunk ${chunk.hash}`);
    if (bytes.length !== chunk.length) {
      throw new Error(`chunk ${chunk.hash} has ${bytes.length} bytes, manifest says ${chunk.length}`);
    }
    out.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== manifest.totalBytes) {
    throw new Error(`assembled ${offset} bytes, manifest says ${manifest.totalBytes}`);
  }
  if (bytesToHex(blake3(out)) !== manifest.fileHash) {
    throw new Error("assembled bytes do not match the manifest file hash");
  }
  return out;
}

/** Chunks the destination is missing — the upload set after deduplication. */
export function missingChunks(
  manifest: ChunkManifest,
  has: (hash: string) => boolean,
): Chunk[] {
  const seen = new Set<string>();
  const missing: Chunk[] = [];
  for (const chunk of manifest.chunks) {
    if (seen.has(chunk.hash) || has(chunk.hash)) continue;
    seen.add(chunk.hash);
    missing.push(chunk);
  }
  return missing;
}
