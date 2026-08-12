//! BLAKE3-addressed chunk cache and file hydration — the local half of Files
//! (PRD §8.6: FastCDC chunks, canonical in R2, hydrated on open).
//!
//! [`ChunkCache`] is the Phase 2 scaffold: real hashing, real LRU-by-bytes
//! eviction, in-memory storage (a disk tier is still to come). [`hydrate`] is
//! the Phase 3 half: given a [`Manifest`] and a [`ChunkSource`], rebuild the
//! file, taking from the cache what it already holds and asking the source
//! only for the rest.
//!
//! Hydration mirrors `assembleFromChunks` in `packages/chunking` (FROZEN),
//! with one addition: every chunk's own hash is verified, not just the
//! assembled file's. TS assembles from a local map it already trusts, whereas
//! a chunk here arrives from R2 over the network, and "the file is wrong"
//! is not a useful thing to learn about a 5 GB hydration — "chunk 431 is
//! wrong" is, because that is the one to re-fetch. The whole-file check still
//! runs, because per-chunk hashes cannot catch chunks assembled in the wrong
//! order.
//!
//! A manifest is bounded before any of it is believed: chunk count and
//! per-chunk length against the same limits the chunker works within. The
//! numbers in a manifest decide allocations, and an allocation sized from an
//! attacker's number is a process abort, not an error to handle.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

/// A chunk's content address: its BLAKE3 hash.
pub type ChunkHash = [u8; 32];

pub fn chunk_hash(data: &[u8]) -> ChunkHash {
    *blake3::hash(data).as_bytes()
}

/// Hex form of an address — how it travels in a manifest and how R2 names the
/// object.
pub fn hash_hex(hash: &ChunkHash) -> String {
    let mut out = String::with_capacity(64);
    for byte in hash {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Parse a 64-character hex address. Anything else is a malformed manifest,
/// not a cache miss — the difference matters, because a miss is retried and a
/// malformed manifest never becomes valid.
pub fn parse_hash(hex: &str) -> Option<ChunkHash> {
    // Lowercase hex only, matching the `^[0-9a-f]{64}$` the protocol's zod
    // schemas enforce — `from_str_radix` would also accept `+f` and `AB`, and
    // two spellings of one address are two cache entries for one chunk.
    let text = hex.as_bytes();
    if text.len() != 64 || !text.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let nibble = |b: u8| {
        if b.is_ascii_digit() {
            b - b'0'
        } else {
            b - b'a' + 10
        }
    };
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (nibble(text[i * 2]) << 4) | nibble(text[i * 2 + 1]);
    }
    Some(out)
}

struct Entry {
    data: Vec<u8>,
    last_used: u64,
}

/// LRU-by-bytes chunk cache. Content-addressed, so inserts are idempotent
/// and a hash collision is a BLAKE3 break, not a cache bug.
pub struct ChunkCache {
    max_bytes: usize,
    used_bytes: usize,
    clock: u64,
    entries: HashMap<ChunkHash, Entry>,
}

impl ChunkCache {
    pub fn new(max_bytes: usize) -> Self {
        ChunkCache {
            max_bytes,
            used_bytes: 0,
            clock: 0,
            entries: HashMap::new(),
        }
    }

    /// Insert a chunk, returning its address. A chunk larger than the whole
    /// cache is hashed but not stored — the address is still valid, the
    /// bytes just are not retained.
    pub fn insert(&mut self, data: Vec<u8>) -> ChunkHash {
        let hash = chunk_hash(&data);
        if self.entries.contains_key(&hash) {
            self.touch(&hash);
            return hash;
        }
        if data.len() > self.max_bytes {
            return hash;
        }
        self.evict_to_fit(data.len());
        self.used_bytes += data.len();
        self.clock += 1;
        self.entries.insert(
            hash,
            Entry {
                data,
                last_used: self.clock,
            },
        );
        hash
    }

    /// Fetch a chunk and mark it recently used.
    pub fn get(&mut self, hash: &ChunkHash) -> Option<&[u8]> {
        if self.entries.contains_key(hash) {
            self.touch(hash);
        }
        self.entries.get(hash).map(|e| e.data.as_slice())
    }

    pub fn contains(&self, hash: &ChunkHash) -> bool {
        self.entries.contains_key(hash)
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn touch(&mut self, hash: &ChunkHash) {
        self.clock += 1;
        if let Some(entry) = self.entries.get_mut(hash) {
            entry.last_used = self.clock;
        }
    }

    /// Evict least-recently-used chunks until `incoming` fits. Linear scan —
    /// fine at Phase 2 scale; an ordered index arrives with the disk tier.
    fn evict_to_fit(&mut self, incoming: usize) {
        while self.used_bytes + incoming > self.max_bytes && !self.entries.is_empty() {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(h, _)| *h)
                .expect("non-empty checked");
            if let Some(entry) = self.entries.remove(&oldest) {
                self.used_bytes -= entry.data.len();
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Hydration
 * ------------------------------------------------------------------ */

/// One chunk's address and placement within a file. Mirrors `chunkRefSchema`
/// in `packages/protocol/src/files.ts`, so a manifest from the control plane
/// deserializes into it directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    /// BLAKE3 of the chunk bytes, hex.
    pub hash: String,
    pub offset: u64,
    pub length: u64,
}

/// A file as the control plane records it: an ordered list of chunk addresses.
/// The chunks themselves live in R2 and may be shared by any number of files,
/// which is why hydration is address-driven rather than file-driven.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// BLAKE3 of the whole file, hex.
    pub file_hash: String,
    pub total_bytes: u64,
    pub chunks: Vec<ChunkRef>,
}

/// Where hydration gets a chunk the cache does not hold — in production the R2
/// client, in tests a map. Returning `None` means "not available", which is a
/// hard failure for the hydration but says nothing about the chunk's validity;
/// bad *bytes* are caught by the verification below, not by the source.
pub trait ChunkSource {
    fn fetch(&mut self, hash: &ChunkHash) -> Option<Vec<u8>>;
}

impl<F> ChunkSource for F
where
    F: FnMut(&ChunkHash) -> Option<Vec<u8>>,
{
    fn fetch(&mut self, hash: &ChunkHash) -> Option<Vec<u8>> {
        self(hash)
    }
}

/// Rebuild a file from its manifest, verifying as it goes, and hand back the
/// bytes. For anything large prefer [`hydrate_to_path`], which never holds the
/// whole file.
pub fn hydrate(
    manifest: &Manifest,
    cache: &mut ChunkCache,
    source: &mut dyn ChunkSource,
) -> anyhow::Result<Vec<u8>> {
    let declared = declared_bytes(manifest)?;
    // Reserve for what the manifest claims only up to a point. Even a manifest
    // inside the bounds above may declare 64 GiB, and `with_capacity` on a
    // number a caller supplied is an abort waiting to happen — the allocator
    // failing is a process abort, not a `Result`. The buffer grows as verified
    // chunks actually arrive instead, so a lying manifest costs the bytes it
    // can really produce rather than the ones it asserts.
    let mut out: Vec<u8> = Vec::with_capacity(declared.min(MAX_HYDRATE_PREALLOC_BYTES) as usize);
    hydrate_into(manifest, cache, source, &mut out)?;
    Ok(out)
}

/// Hydrate to a file on disk, atomically: the bytes are written beside the
/// destination and renamed into place only after the whole-file hash matches.
/// A half-hydrated or corrupted file must never appear at a path the user is
/// about to open.
pub fn hydrate_to_path(
    manifest: &Manifest,
    cache: &mut ChunkCache,
    source: &mut dyn ChunkSource,
    dest: &Path,
) -> anyhow::Result<()> {
    let parent = dest
        .parent()
        .context("destination path has no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let temp = parent.join(format!(
        ".suma-hydrate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let result = (|| -> anyhow::Result<()> {
        let file =
            std::fs::File::create(&temp).with_context(|| format!("creating {}", temp.display()))?;
        let mut writer = std::io::BufWriter::new(file);
        hydrate_into(manifest, cache, source, &mut writer)?;
        writer.flush()?;
        Ok(())
    })();
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    std::fs::rename(&temp, dest).with_context(|| format!("renaming into {}", dest.display()))?;
    Ok(())
}

/// Largest chunk the chunker can produce, and therefore the largest a manifest
/// may declare. Mirrors `MAX_CHUNK_BYTES` in `packages/chunking` (FROZEN) and
/// the copy the control plane checks against in
/// `services/control/src/files.ts`.
pub const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// Chunks one manifest may declare, mirroring `MAX_MANIFEST_CHUNKS` in
/// `services/control/src/files.ts` — ~16 GB of content at the chunker's 1 MiB
/// average, comfortably above §5's 5 GB dataset.
pub const MAX_MANIFEST_CHUNKS: usize = 16_384;

/// Ceiling on what [`hydrate`] will reserve up front. Not a limit on the file:
/// the buffer still grows to hold everything that verifies.
const MAX_HYDRATE_PREALLOC_BYTES: u64 = 64 * 1024 * 1024;

/// Sum of the chunk lengths, checked against what the manifest claims and
/// against the bounds the chunker works within.
///
/// This runs before anything is allocated or fetched, because a manifest is
/// data from the network and `totalBytes` is the number a caller would
/// otherwise size a buffer from. A manifest whose parts do not add up to its
/// whole is rejected rather than half-believed — and so is one whose parts are
/// sizes no chunker could have produced: a single chunk declaring 2^40 bytes
/// used to reach `Vec::with_capacity` and abort the process before a byte was
/// fetched, which made a hostile (or merely corrupt) manifest a way to kill
/// sumad outright.
fn declared_bytes(manifest: &Manifest) -> anyhow::Result<u64> {
    if manifest.chunks.len() > MAX_MANIFEST_CHUNKS {
        bail!(
            "manifest declares {} chunks, more than the {MAX_MANIFEST_CHUNKS} a manifest may hold",
            manifest.chunks.len()
        );
    }
    let mut total: u64 = 0;
    for chunk in &manifest.chunks {
        if chunk.length > MAX_CHUNK_BYTES {
            bail!(
                "chunk {} declares {} bytes, more than the {MAX_CHUNK_BYTES} byte chunk ceiling",
                chunk.hash,
                chunk.length
            );
        }
        // Cannot overflow while the bounds above hold; kept so a change to
        // either constant cannot turn this sum into a wrap.
        total = total
            .checked_add(chunk.length)
            .context("manifest chunk lengths overflow a u64")?;
    }
    if total != manifest.total_bytes {
        bail!(
            "manifest chunk lengths sum to {total} bytes, manifest says {}",
            manifest.total_bytes
        );
    }
    Ok(total)
}

fn hydrate_into(
    manifest: &Manifest,
    cache: &mut ChunkCache,
    source: &mut dyn ChunkSource,
    out: &mut dyn Write,
) -> anyhow::Result<()> {
    let expected_file_hash = parse_hash(&manifest.file_hash)
        .with_context(|| format!("manifest fileHash {} is not a hash", manifest.file_hash))?;
    let total = declared_bytes(manifest)?;

    let mut file_hasher = blake3::Hasher::new();
    let mut written: u64 = 0;
    for chunk in &manifest.chunks {
        let hash = parse_hash(&chunk.hash)
            .with_context(|| format!("manifest chunk hash {} is not a hash", chunk.hash))?;
        if chunk.offset != written {
            bail!(
                "chunk {} claims offset {} but {written} bytes precede it",
                chunk.hash,
                chunk.offset
            );
        }
        // Cache first: chunks are shared between files, so a second hydration
        // of anything overlapping costs no network at all.
        let bytes = match cache.get(&hash) {
            Some(cached) => cached.to_vec(),
            None => {
                let fetched = source
                    .fetch(&hash)
                    .with_context(|| format!("missing chunk {}", chunk.hash))?;
                // Verify before it is cached, so a bad chunk cannot be served
                // to the next hydration as if it were good.
                let actual = chunk_hash(&fetched);
                if actual != hash {
                    bail!(
                        "chunk {} does not hash to its address (got {})",
                        chunk.hash,
                        hash_hex(&actual)
                    );
                }
                cache.insert(fetched.clone());
                fetched
            }
        };
        if bytes.len() as u64 != chunk.length {
            bail!(
                "chunk {} has {} bytes, manifest says {}",
                chunk.hash,
                bytes.len(),
                chunk.length
            );
        }
        file_hasher.update(&bytes);
        out.write_all(&bytes)
            .with_context(|| format!("writing chunk {}", chunk.hash))?;
        written += bytes.len() as u64;
    }

    if written != total {
        bail!("assembled {written} bytes, manifest says {total}");
    }
    // Per-chunk hashes prove each part; only this proves the whole, including
    // the order the parts were written in.
    if *file_hasher.finalize().as_bytes() != expected_file_hash {
        bail!("assembled bytes do not match the manifest file hash");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_round_trip_by_content_address() {
        let mut cache = ChunkCache::new(1024);
        let hash = cache.insert(b"hello suma".to_vec());
        assert_eq!(hash, chunk_hash(b"hello suma"));
        assert_eq!(cache.get(&hash), Some(b"hello suma".as_slice()));
        assert!(cache.contains(&hash));
        assert_eq!(cache.get(&chunk_hash(b"absent")), None);
    }

    #[test]
    fn inserting_the_same_content_twice_stores_it_once() {
        let mut cache = ChunkCache::new(1024);
        let h1 = cache.insert(vec![7u8; 100]);
        let h2 = cache.insert(vec![7u8; 100]);
        assert_eq!(h1, h2);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.used_bytes(), 100);
    }

    #[test]
    fn evicts_least_recently_used_by_bytes() {
        let mut cache = ChunkCache::new(300);
        let a = cache.insert(vec![b'a'; 100]);
        let b = cache.insert(vec![b'b'; 100]);
        let c = cache.insert(vec![b'c'; 100]);
        assert_eq!(cache.used_bytes(), 300);

        // Touch `a`, making `b` the least recently used.
        assert!(cache.get(&a).is_some());
        let d = cache.insert(vec![b'd'; 100]);

        assert!(cache.contains(&a), "recently used survives");
        assert!(!cache.contains(&b), "LRU chunk evicted");
        assert!(cache.contains(&c));
        assert!(cache.contains(&d));
        assert_eq!(cache.used_bytes(), 300);
    }

    #[test]
    fn oversized_chunks_are_addressed_but_not_stored() {
        let mut cache = ChunkCache::new(10);
        let hash = cache.insert(vec![0u8; 100]);
        assert_eq!(hash, chunk_hash(&[0u8; 100]));
        assert!(!cache.contains(&hash));
        assert!(cache.is_empty());
        assert_eq!(cache.used_bytes(), 0);
    }

    /* -------------------------------------------------------------- *
     * Hydration
     * -------------------------------------------------------------- */

    /// Build a manifest over `parts` plus the store a source would read from.
    fn manifest_for(parts: &[&[u8]]) -> (Manifest, HashMap<ChunkHash, Vec<u8>>, Vec<u8>) {
        let mut chunks = Vec::new();
        let mut store = HashMap::new();
        let mut whole = Vec::new();
        let mut offset = 0u64;
        for part in parts {
            let hash = chunk_hash(part);
            chunks.push(ChunkRef {
                hash: hash_hex(&hash),
                offset,
                length: part.len() as u64,
            });
            store.insert(hash, part.to_vec());
            whole.extend_from_slice(part);
            offset += part.len() as u64;
        }
        let manifest = Manifest {
            file_hash: hash_hex(&chunk_hash(&whole)),
            total_bytes: whole.len() as u64,
            chunks,
        };
        (manifest, store, whole)
    }

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "suma-hydrate-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn hydrates_a_file_and_keeps_its_chunks_for_the_next_one() {
        let (manifest, store, whole) =
            manifest_for(&[b"suma ", b"files ", b"hydrate ", b"locally"]);
        let mut cache = ChunkCache::new(1024);

        let rebuilt = hydrate(&manifest, &mut cache, &mut |h: &ChunkHash| {
            store.get(h).cloned()
        })
        .unwrap();
        assert_eq!(rebuilt, whole);
        assert_eq!(cache.len(), manifest.chunks.len());

        // Everything is cached now, so a second hydration needs no source at
        // all — the property that makes hydrating a file sharing chunks with
        // one already open nearly free.
        let rebuilt = hydrate(&manifest, &mut cache, &mut |_: &ChunkHash| None).unwrap();
        assert_eq!(rebuilt, whole);
    }

    #[test]
    fn refuses_a_missing_chunk() {
        let (manifest, store, _) = manifest_for(&[b"a".repeat(64).as_slice(), b"b"]);
        let mut cache = ChunkCache::new(1024);
        let absent = manifest.chunks[1].hash.clone();
        let err = hydrate(&manifest, &mut cache, &mut |h: &ChunkHash| {
            if hash_hex(h) == absent {
                None
            } else {
                store.get(h).cloned()
            }
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains(&format!("missing chunk {absent}")), "{err}");
    }

    /// The check TS's whole-file hash catches only at the end, and only as
    /// "the file is wrong": here the bad chunk is named, and — the part that
    /// matters for a cache — it is never stored.
    #[test]
    fn refuses_and_does_not_cache_a_chunk_that_does_not_match_its_address() {
        let (manifest, store, _) = manifest_for(&[b"good chunk", b"second chunk"]);
        let mut cache = ChunkCache::new(1024);
        let target = manifest.chunks[0].hash.clone();
        let err = hydrate(&manifest, &mut cache, &mut |h: &ChunkHash| {
            if hash_hex(h) == target {
                // Same length, different bytes — a corruption or a lying
                // store, not a truncation.
                Some(b"g00d chunk".to_vec())
            } else {
                store.get(h).cloned()
            }
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("does not hash to its address"), "{err}");
        assert!(err.contains(&target), "{err}");
        assert!(cache.is_empty(), "a bad chunk must not be cached");
    }

    #[test]
    fn refuses_a_chunk_whose_length_contradicts_the_manifest() {
        let (mut manifest, store, _) = manifest_for(&[b"exactly ten"]);
        // The manifest lies about the length; `totalBytes` is adjusted so the
        // lie survives the sum check and has to be caught per chunk.
        manifest.chunks[0].length = 5;
        manifest.total_bytes = 5;
        let mut cache = ChunkCache::new(1024);
        let err = hydrate(&manifest, &mut cache, &mut |h: &ChunkHash| {
            store.get(h).cloned()
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("bytes, manifest says 5"), "{err}");
    }

    #[test]
    fn refuses_a_manifest_whose_parts_do_not_add_up_before_fetching_anything() {
        let (mut manifest, store, _) = manifest_for(&[b"one", b"two"]);
        manifest.total_bytes = 9_999_999_999;
        let mut cache = ChunkCache::new(1024);
        let fetches = std::cell::Cell::new(0usize);
        let err = hydrate(&manifest, &mut cache, &mut |h: &ChunkHash| {
            fetches.set(fetches.get() + 1);
            store.get(h).cloned()
        })
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("sum to 6 bytes, manifest says 9999999999"),
            "{err}"
        );
        assert_eq!(fetches.get(), 0, "nothing is fetched for a bad manifest");
    }

    /// A manifest is a number an attacker can choose, and `Vec::with_capacity`
    /// on such a number aborts the process rather than returning an error. One
    /// chunk claiming 2^40 bytes used to do exactly that, before a byte was
    /// fetched; now it is refused for being a size no chunker could produce.
    #[test]
    fn refuses_a_manifest_declaring_sizes_the_chunker_could_never_produce() {
        let (template, store, _) = manifest_for(&[b"small"]);
        let mut cache = ChunkCache::new(1024);
        let fetches = std::cell::Cell::new(0usize);
        let mut source = |h: &ChunkHash| {
            fetches.set(fetches.get() + 1);
            store.get(h).cloned()
        };

        // One chunk larger than any the chunker cuts — the allocation that
        // used to take the process down with it.
        let huge = 1u64 << 40;
        let mut oversized = template.clone();
        oversized.chunks[0].length = huge;
        oversized.total_bytes = huge;
        let err = hydrate(&oversized, &mut cache, &mut source)
            .unwrap_err()
            .to_string();
        assert!(err.contains("byte chunk ceiling"), "{err}");

        // Exactly at the ceiling is a size the chunker does produce (zero
        // entropy cuts every chunk at MAX_CHUNK_BYTES), so the manifest is
        // believed and hydration fails on the chunk itself instead.
        let mut at_ceiling = template.clone();
        at_ceiling.chunks[0].length = MAX_CHUNK_BYTES;
        at_ceiling.total_bytes = MAX_CHUNK_BYTES;
        let err = hydrate(&at_ceiling, &mut cache, &mut source)
            .unwrap_err()
            .to_string();
        assert!(err.contains("manifest says 4194304"), "{err}");

        // And a manifest of many small chunks: bounded by count, so the
        // 64 GiB ceiling the two limits imply cannot be walked past either.
        let mut too_many = template.clone();
        too_many.chunks = (0..MAX_MANIFEST_CHUNKS + 1)
            .map(|i| ChunkRef {
                hash: template.chunks[0].hash.clone(),
                offset: i as u64 * 5,
                length: 5,
            })
            .collect();
        too_many.total_bytes = too_many.chunks.len() as u64 * 5;
        let err = hydrate(&too_many, &mut cache, &mut source)
            .unwrap_err()
            .to_string();
        assert!(err.contains("more than the 16384"), "{err}");

        assert_eq!(
            fetches.get(),
            1,
            "a manifest refused by the bounds fetches nothing"
        );

        // The largest manifest the bounds still admit declares 64 GiB, which
        // is why the reservation is clamped rather than taken from the
        // manifest: this has to end at the missing chunk, not at an allocator
        // the process cannot survive.
        let mut largest = template.clone();
        largest.chunks = (0..MAX_MANIFEST_CHUNKS)
            .map(|i| ChunkRef {
                hash: hash_hex(&chunk_hash(b"never stored")),
                offset: i as u64 * MAX_CHUNK_BYTES,
                length: MAX_CHUNK_BYTES,
            })
            .collect();
        largest.total_bytes = MAX_MANIFEST_CHUNKS as u64 * MAX_CHUNK_BYTES;
        let err = hydrate(&largest, &mut cache, &mut |_: &ChunkHash| None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("missing chunk"), "{err}");

        // The bounds are restated from packages/chunking (FROZEN) and
        // services/control/src/files.ts, not chosen here.
        assert_eq!(
            (MAX_CHUNK_BYTES, MAX_MANIFEST_CHUNKS),
            (4 * 1024 * 1024, 16_384)
        );
    }

    /// Chunks that each verify can still be the wrong file: order is not
    /// something a content address can attest to.
    #[test]
    fn refuses_chunks_assembled_in_the_wrong_order() {
        let (manifest, store, _) = manifest_for(&[b"first ", b"second"]);
        let mut swapped = manifest.clone();
        swapped.chunks.swap(0, 1);
        swapped.chunks[0].offset = 0;
        swapped.chunks[1].offset = swapped.chunks[0].length;
        let mut cache = ChunkCache::new(1024);
        let err = hydrate(&swapped, &mut cache, &mut |h: &ChunkHash| {
            store.get(h).cloned()
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("do not match the manifest file hash"), "{err}");

        // An offset that disagrees with the bytes written so far is caught
        // earlier, by name.
        let mut gapped = manifest.clone();
        gapped.chunks[1].offset += 3;
        let err = hydrate(&gapped, &mut cache, &mut |h: &ChunkHash| {
            store.get(h).cloned()
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("claims offset"), "{err}");
    }

    #[test]
    fn hydrating_to_a_path_is_all_or_nothing() {
        let (manifest, store, whole) = manifest_for(&[b"alpha", b"beta", b"gamma"]);
        let dir = temp_path("atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("file.bin");
        let mut cache = ChunkCache::new(1024);

        hydrate_to_path(
            &manifest,
            &mut cache,
            &mut |h: &ChunkHash| store.get(h).cloned(),
            &dest,
        )
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), whole);

        // A hydration that fails leaves the destination exactly as it was and
        // no temporary file behind.
        let mut broken = manifest.clone();
        broken.file_hash = hash_hex(&chunk_hash(b"a different file"));
        let mut fresh = ChunkCache::new(1024);
        let err = hydrate_to_path(
            &broken,
            &mut fresh,
            &mut |h: &ChunkHash| store.get(h).cloned(),
            &dest,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("do not match the manifest file hash"), "{err}");
        assert_eq!(std::fs::read(&dest).unwrap(), whole, "left untouched");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "file.bin")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The manifest crosses from the control plane as JSON validated by
    /// `manifestSchema` (files.ts) — camelCase, lowercase hex.
    #[test]
    fn manifests_parse_from_the_protocol_json_shape() {
        let raw = r#"{
            "fileHash":"ce397785329838409ce046650347b89c0e1a39dac9a67fe4a783b80b82d62859",
            "totalBytes":12,
            "chunks":[{"hash":"ce397785329838409ce046650347b89c0e1a39dac9a67fe4a783b80b82d62859","offset":0,"length":12}]
        }"#;
        let manifest: Manifest = serde_json::from_str(raw).unwrap();
        assert_eq!(manifest.total_bytes, 12);
        assert_eq!(manifest.chunks[0].length, 12);
        assert_eq!(
            serde_json::to_value(&manifest).unwrap()["fileHash"],
            manifest.file_hash.as_str()
        );

        let mut cache = ChunkCache::new(1024);
        let rebuilt = hydrate(&manifest, &mut cache, &mut |_: &ChunkHash| {
            Some(b"hello suma".to_vec())
        })
        .unwrap();
        assert_eq!(rebuilt, b"hello suma");
    }

    /// The addresses in that manifest are not arbitrary: they are what
    /// `@noble/hashes` computes in `packages/chunking`, pinned here so a
    /// divergence in either BLAKE3 implementation fails loudly instead of
    /// turning into a hydration that can never find its chunks.
    #[test]
    fn addresses_match_the_typescript_hasher() {
        assert_eq!(
            hash_hex(&chunk_hash(b"hello suma")),
            "ce397785329838409ce046650347b89c0e1a39dac9a67fe4a783b80b82d62859"
        );
        assert_eq!(
            hash_hex(&chunk_hash(b"")),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        let hash = chunk_hash(b"round trip");
        assert_eq!(parse_hash(&hash_hex(&hash)), Some(hash));

        for bad in [
            "",
            "abc",
            &"A".repeat(64),                 // uppercase: the schema says lowercase
            &format!("+{}", "a".repeat(63)), // from_str_radix would take a sign
            &format!("{}g", "a".repeat(63)), // outside the alphabet
            &"a".repeat(65),
        ] {
            assert!(parse_hash(bad).is_none(), "{bad:?} must not parse");
        }
    }
}
