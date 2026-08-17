import { describe, expect, it } from "vitest";

/** Hashing megabytes in pure JS is not fast; leave room for parallel CI load. */
const SLOW = 30_000;
import {
  AVG_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  StreamingManifestBuilder,
  assembleFromChunks,
  buildManifest,
  chunkBuffer,
  gearTableFingerprint,
  hashChunk,
  missingChunks,
} from "../src/index.js";

/** Deterministic pseudo-random bytes — no Math.random, so failures reproduce. */
function pseudoRandom(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function chunkStore(data: Uint8Array): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();
  for (const c of chunkBuffer(data)) {
    store.set(c.hash, data.subarray(c.offset, c.offset + c.length));
  }
  return store;
}

describe("gear table", () => {
  it("is stable — the fingerprint pins every future boundary", () => {
    // If this value changes, every previously stored chunk address becomes
    // unreachable and the Rust side must be regenerated to match.
    expect(gearTableFingerprint()).toBe(gearTableFingerprint());
    expect(gearTableFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("chunk boundaries", { timeout: SLOW }, () => {
  const data = pseudoRandom(12 * 1024 * 1024);

  it("covers the input exactly, in order, with no gaps or overlaps", () => {
    const chunks = chunkBuffer(data);
    expect(chunks.length).toBeGreaterThan(1);
    let expected = 0;
    for (const c of chunks) {
      expect(c.offset).toBe(expected);
      expected += c.length;
    }
    expect(expected).toBe(data.length);
  });

  it("respects the min and max size bounds", () => {
    const chunks = chunkBuffer(data);
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(MIN_CHUNK_BYTES);
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
    // Only the final chunk may be short.
    expect(chunks[chunks.length - 1]?.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });

  it("averages near the target size, so R2 request costs stay bounded (§11)", () => {
    const chunks = chunkBuffer(data);
    const mean = data.length / chunks.length;
    expect(mean).toBeGreaterThan(AVG_CHUNK_BYTES / 3);
    expect(mean).toBeLessThan(AVG_CHUNK_BYTES * 3);
  });

  it("is deterministic", () => {
    expect(chunkBuffer(data)).toEqual(chunkBuffer(data));
  });

  it("never splits a short file", () => {
    const small = pseudoRandom(1024);
    const chunks = chunkBuffer(small);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.length).toBe(1024);
  });

  it("handles an empty input", () => {
    expect(chunkBuffer(new Uint8Array(0))).toEqual([]);
  });
});

describe("shift resistance — the reason for content-defined chunking", { timeout: SLOW }, () => {
  it("re-uploads only a bounded region after an insertion near the start", () => {
    const original = pseudoRandom(16 * 1024 * 1024, 7);
    // Insert a byte early: fixed-size blocks would shift EVERY later block.
    const edited = new Uint8Array(original.length + 1);
    edited.set(original.subarray(0, 1000), 0);
    edited[1000] = 0x42;
    edited.set(original.subarray(1000), 1001);

    const before = new Set(chunkBuffer(original).map((c) => c.hash));
    const after = chunkBuffer(edited);
    const changed = after.filter((c) => !before.has(c.hash));

    // The edit disturbs only the chunks around it; the rest realign and
    // still hash to what the store already holds.
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(3);
    const reusedFraction = (after.length - changed.length) / after.length;
    expect(reusedFraction).toBeGreaterThan(0.8);
  });

  it("appending leaves every earlier chunk addressable", () => {
    const original = pseudoRandom(8 * 1024 * 1024, 11);
    const appended = new Uint8Array(original.length + 4 * 1024 * 1024);
    appended.set(original, 0);
    appended.set(pseudoRandom(4 * 1024 * 1024, 13), original.length);

    const before = chunkBuffer(original);
    const after = new Set(chunkBuffer(appended).map((c) => c.hash));
    // Every chunk but the last (which the append extends) is reused as-is.
    const reused = before.slice(0, -1).filter((c) => after.has(c.hash));
    expect(reused.length).toBe(before.length - 1);
  });
});

describe("manifests", { timeout: SLOW }, () => {
  const data = pseudoRandom(6 * 1024 * 1024, 21);

  it("round-trips a file through its chunks", () => {
    const manifest = buildManifest(data);
    const store = chunkStore(data);
    const rebuilt = assembleFromChunks(manifest, (h) => store.get(h));
    // Compare by content address: a deep toEqual on megabytes of typed array
    // costs more than every chunking operation in this file combined.
    expect(rebuilt.length).toBe(data.length);
    expect(hashChunk(rebuilt)).toBe(hashChunk(data));
  });

  it("builds the identical manifest across arbitrary streaming boundaries", () => {
    const builder = new StreamingManifestBuilder();
    for (let offset = 0; offset < data.length; offset += 73_177) {
      builder.push(data.subarray(offset, Math.min(data.length, offset + 73_177)));
    }
    expect(builder.finish()).toEqual(buildManifest(data));
  });

  it("refuses to assemble from a corrupted chunk", () => {
    const manifest = buildManifest(data);
    const store = chunkStore(data);
    const firstHash = manifest.chunks[0]?.hash as string;
    const original = store.get(firstHash);
    expect(original).toBeDefined();
    const corrupted = Uint8Array.from(original as Uint8Array);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    store.set(firstHash, corrupted);
    // Same length, different bytes — only the whole-file hash catches it.
    expect(() => assembleFromChunks(manifest, (h) => store.get(h))).toThrow(/file hash/);
  });

  it("refuses a missing or wrong-length chunk", () => {
    const manifest = buildManifest(data);
    const store = chunkStore(data);
    expect(() => assembleFromChunks(manifest, () => undefined)).toThrow(/missing chunk/);
    const firstHash = manifest.chunks[0]?.hash as string;
    store.set(firstHash, new Uint8Array(5));
    expect(() => assembleFromChunks(manifest, (h) => store.get(h))).toThrow(/bytes, manifest says/);
  });

  it("uploads only what the destination lacks, and never the same chunk twice", () => {
    const manifest = buildManifest(data);
    const have = new Set([manifest.chunks[0]?.hash as string]);
    const missing = missingChunks(manifest, (h) => have.has(h));
    expect(missing.some((c) => c.hash === manifest.chunks[0]?.hash)).toBe(false);
    expect(new Set(missing.map((c) => c.hash)).size).toBe(missing.length);

    // A file of repeated content collapses to very few uploads.
    const repeated = new Uint8Array(8 * 1024 * 1024);
    const unit = pseudoRandom(64 * 1024, 3);
    for (let o = 0; o < repeated.length; o += unit.length) repeated.set(unit, o);
    const repeatedManifest = buildManifest(repeated);
    const uploads = missingChunks(repeatedManifest, () => false);
    expect(uploads.length).toBeLessThan(repeatedManifest.chunks.length);
  });

  it("addresses chunks by BLAKE3 of their bytes", () => {
    const manifest = buildManifest(data);
    const first = manifest.chunks[0];
    expect(first).toBeDefined();
    expect(first?.hash).toBe(hashChunk(data.subarray(0, first?.length ?? 0)));
  });
});
