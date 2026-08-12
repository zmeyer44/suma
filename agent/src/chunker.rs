//! FastCDC content-defined chunking with BLAKE3 addressing — the Rust half of
//! `packages/chunking` (PRD §7 data plane, §8.6 uploads/hydration).
//!
//! `packages/chunking/src/index.ts` is the source of truth and is FROZEN. This
//! module is a port, not a variant: the same gear table, the same masks, the
//! same min/avg/max, the same normalized two-stage scan. If the two disagree
//! on a single boundary byte the chunks either side of it get different
//! addresses, the control plane reports them missing, and every device
//! re-uploads content R2 already holds. Deduplication does not fail loudly
//! when it breaks — it just quietly stops working — so the agreement is pinned
//! by tests (`gear_table_fingerprint_matches_the_typescript_value` and the
//! boundary vectors below) rather than trusted.
//!
//! The gear table is *derived* rather than written out as 256 literals for the
//! same reason: two hand-copied tables can differ by one transcription error,
//! and a table computed from BLAKE3 of a domain string cannot. TS
//! `@noble/hashes` and the `blake3` crate produce identical digests, so both
//! languages regenerate the identical table at startup.

use std::io::{self, Read};
use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ *
 * Parameters — mirror of the TS constants
 * ------------------------------------------------------------------ */

/// Chunk sizes are deliberately large (§11 flags R2 request costs from
/// small-file chunking): at a 1 MiB average a 5 GB dataset is ~5k objects
/// rather than the ~650k an 8 KiB average would produce.
pub const MIN_CHUNK_BYTES: usize = 256 * 1024;
pub const AVG_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Domain separation for the gear table — changing this changes every
/// boundary, and therefore every stored chunk address.
const GEAR_DOMAIN: &[u8] = b"suma.fastcdc.gear.v1";

/// Deterministic mask with `bits` bits set, spread evenly across the 32-bit
/// word. A boundary needs every masked bit of the rolling hash to be zero, so
/// the bit COUNT sets the expected distance between cuts (2^bits bytes) while
/// the positions only need to be fixed and agreed on by both languages.
const fn mask_with_bits(bits: u32) -> u32 {
    let mut mask: u32 = 0;
    let mut i: u32 = 0;
    while i < bits {
        mask |= 1u32 << ((i * 32) / bits);
        i += 1;
    }
    mask
}

/// FastCDC's normalized chunking uses two masks: a stricter one before the
/// average size (making an early cut unlikely) and a looser one after (making
/// a late cut likely), which pulls the size distribution toward the average
/// instead of plain CDC's long exponential tail. log2(AVG) is 20, so 22/18
/// straddle the target.
const MASK_SMALL: u32 = mask_with_bits(22);
const MASK_LARGE: u32 = mask_with_bits(18);

/// 256-entry gear table: entry `i` is the little-endian u32 of
/// `blake3(GEAR_DOMAIN ‖ [i])[0..4]`.
///
/// 32-bit on purpose. The rolling hash runs once per byte and 64-bit values in
/// JS mean BigInt, which is ~100x slower there — the width is chosen by the
/// language that cannot afford the other one.
fn build_gear_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut input = [0u8; GEAR_DOMAIN.len() + 1];
    input[..GEAR_DOMAIN.len()].copy_from_slice(GEAR_DOMAIN);
    for (i, entry) in table.iter_mut().enumerate() {
        input[GEAR_DOMAIN.len()] = i as u8;
        let digest = blake3::hash(&input);
        let bytes = digest.as_bytes();
        *entry = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    table
}

pub fn gear_table() -> &'static [u32; 256] {
    static GEAR_TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    GEAR_TABLE.get_or_init(build_gear_table)
}

/// Hex of the gear table's own BLAKE3 (entries little-endian) — the cheap
/// cross-language equality check, mirroring `gearTableFingerprint`.
pub fn gear_table_fingerprint() -> String {
    let mut bytes = Vec::with_capacity(256 * 4);
    for entry in gear_table() {
        bytes.extend_from_slice(&entry.to_le_bytes());
    }
    hex(blake3::hash(&bytes).as_bytes())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/// Index of the first boundary at or after `MIN_CHUNK_BYTES`, or `data.len()`
/// when none is found before `MAX_CHUNK_BYTES`. Operates on a whole buffer;
/// [`chunk_reader`] feeds it successive windows.
///
/// The arithmetic is `u32` wrapping throughout because the TS side is: JS
/// `(x << 1) >>> 0` and `(a + b) >>> 0` are exactly `u32::wrapping_*` here,
/// and any widening would change which bytes are boundaries.
pub fn next_boundary(data: &[u8], start: usize) -> usize {
    let remaining = data.len() - start;
    if remaining <= MIN_CHUNK_BYTES {
        return data.len();
    }

    let hard_limit = start + remaining.min(MAX_CHUNK_BYTES);
    let normal_limit = start + remaining.min(AVG_CHUNK_BYTES);
    let gear = gear_table();
    let mut hash: u32 = 0;
    let mut i = start + MIN_CHUNK_BYTES;

    // Before the average size: the strict mask makes a cut unlikely.
    while i < normal_limit {
        hash = (hash << 1).wrapping_add(gear[data[i] as usize]);
        if hash & MASK_SMALL == 0 {
            return i + 1;
        }
        i += 1;
    }
    // Past the average: the loose mask makes a cut likely, bounding the tail.
    while i < hard_limit {
        hash = (hash << 1).wrapping_add(gear[data[i] as usize]);
        if hash & MASK_LARGE == 0 {
            return i + 1;
        }
        i += 1;
    }
    hard_limit
}

/// One chunk's address and placement. Field names are the TS ones — this
/// struct is serialized straight into the `Manifest` the control plane stores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    /// BLAKE3 of the chunk bytes, hex — the R2 object key and dedup identity.
    pub hash: String,
    pub offset: u64,
    pub length: u64,
}

/// Split a buffer into content-defined chunks with their content addresses.
pub fn chunk_buffer(data: &[u8]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let end = next_boundary(data, offset);
        let slice = &data[offset..end];
        chunks.push(Chunk {
            hash: hash_chunk(slice),
            offset: offset as u64,
            length: slice.len() as u64,
        });
        offset = end;
    }
    chunks
}

pub fn hash_chunk(data: &[u8]) -> String {
    hex(blake3::hash(data).as_bytes())
}

/* ------------------------------------------------------------------ *
 * Manifests
 * ------------------------------------------------------------------ */

/// A file as stored: an ordered list of chunk addresses. Mirrors
/// `ChunkManifest` in TS and `manifestSchema` in
/// `packages/protocol/src/files.ts`, so it can be sent to the control plane
/// verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// BLAKE3 of the whole file — identity, and what an integrity check
    /// compares against.
    pub file_hash: String,
    pub total_bytes: u64,
    pub chunks: Vec<Chunk>,
}

pub fn build_manifest(data: &[u8]) -> Manifest {
    Manifest {
        file_hash: hash_chunk(data),
        total_bytes: data.len() as u64,
        chunks: chunk_buffer(data),
    }
}

/// Chunks the destination is missing — the upload set after deduplication.
/// Mirrors `missingChunks`, including its de-duplication of repeats *within*
/// one file: a file built of a repeating unit uploads each distinct chunk once.
pub fn missing_chunks(manifest: &Manifest, has: impl Fn(&str) -> bool) -> Vec<&Chunk> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut missing = Vec::new();
    for chunk in &manifest.chunks {
        if seen.contains(chunk.hash.as_str()) || has(&chunk.hash) {
            continue;
        }
        seen.insert(chunk.hash.as_str());
        missing.push(chunk);
    }
    missing
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/// How much is read from the source at a time while topping up the window.
const READ_STEP: usize = 256 * 1024;

/// Chunk a stream without holding it all in memory, producing exactly the
/// manifest [`build_manifest`] would produce for the same bytes.
///
/// The equivalence rests on one property of [`next_boundary`]: once at least
/// `MAX_CHUNK_BYTES` are available from the current offset, the scan can never
/// look further, so a window holding that much decides the same boundary as
/// the whole file would. The window is therefore refilled to `MAX_CHUNK_BYTES`
/// before every decision, and only the final short window (at EOF) is allowed
/// to hold less — which is exactly the file's own tail. A `fetch.public` may
/// land 8 GB (`MAX_FETCH_BYTES`) on a Fly volume with no swap (§8.5); reading
/// that into a Vec to chunk it would be a self-inflicted OOM.
pub fn chunk_reader<R: Read>(mut reader: R) -> io::Result<Manifest> {
    let mut file_hasher = blake3::Hasher::new();
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut window: Vec<u8> = Vec::with_capacity(MAX_CHUNK_BYTES + READ_STEP);
    let mut scratch = vec![0u8; READ_STEP];
    let mut offset: u64 = 0;
    let mut eof = false;

    loop {
        while !eof && window.len() < MAX_CHUNK_BYTES {
            let n = reader.read(&mut scratch)?;
            if n == 0 {
                eof = true;
            } else {
                window.extend_from_slice(&scratch[..n]);
            }
        }
        if window.is_empty() {
            break;
        }
        let end = next_boundary(&window, 0);
        let slice = &window[..end];
        file_hasher.update(slice);
        chunks.push(Chunk {
            hash: hash_chunk(slice),
            offset,
            length: end as u64,
        });
        offset += end as u64;
        window.drain(..end);
    }

    Ok(Manifest {
        file_hash: hex(file_hasher.finalize().as_bytes()),
        total_bytes: offset,
        chunks,
    })
}

/// Chunk a file on disk. Used after `fetch.public` completes, so the control
/// plane can record which chunks the file is made of.
pub fn chunk_file(path: &Path) -> io::Result<Manifest> {
    let file = std::fs::File::open(path)?;
    chunk_reader(io::BufReader::with_capacity(READ_STEP, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS test's generator, byte for byte: `state * 1664525 + 1013904223`
    /// stays under 2^53 so JS computes it exactly, and `>>> 24` takes the top
    /// byte. Every vector below was produced by running the FROZEN TS module
    /// over these bytes.
    fn pseudo_random(length: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 24) as u8
            })
            .collect()
    }

    /// The single most important assertion in the crate: if this fingerprint
    /// drifts from the TS one, every boundary moves, every chunk address
    /// changes, and dedup silently stops working across languages.
    #[test]
    fn gear_table_fingerprint_matches_the_typescript_value() {
        assert_eq!(
            gear_table_fingerprint(),
            "40d8972af1692567f0448beee174599d93f7b302951651ddedf4732ba8551b31"
        );
        // Read out of the TS implementation, so a table that is merely
        // self-consistently wrong still fails here.
        assert_eq!(
            &gear_table()[0..4],
            &[3621715244u32, 875051506, 727303481, 2333224997]
        );
        assert_eq!(gear_table()[255], 22933100);
    }

    #[test]
    fn masks_and_sizes_match_the_typescript_constants() {
        // maskWithBits(22) and maskWithBits(18), evaluated the same way.
        assert_eq!(MASK_SMALL.count_ones(), 22);
        assert_eq!(MASK_LARGE.count_ones(), 18);
        assert_eq!(MASK_SMALL, mask_with_bits(22));
        assert_eq!(MASK_LARGE, mask_with_bits(18));
        assert_eq!(
            (MIN_CHUNK_BYTES, AVG_CHUNK_BYTES, MAX_CHUNK_BYTES),
            (262144, 1048576, 4194304)
        );
    }

    /// Boundary offsets and addresses produced by the TS `buildManifest` over
    /// `pseudoRandom(8 MiB, seed 1)`. Pinned literals, not a re-derivation:
    /// the point is to catch a Rust-side change that is internally consistent
    /// but no longer agrees with what R2 already holds.
    #[test]
    fn boundaries_match_the_typescript_implementation_byte_for_byte() {
        let data = pseudo_random(8 * 1024 * 1024, 1);
        let manifest = build_manifest(&data);

        assert_eq!(
            manifest.file_hash,
            "281c34d57b571a00872d3e8189801c15998e27957e6de061987d00199887b8bf"
        );
        assert_eq!(manifest.total_bytes, 8 * 1024 * 1024);
        let offsets: Vec<u64> = manifest.chunks.iter().map(|c| c.offset).collect();
        assert_eq!(
            offsets,
            vec![0, 1332946, 2450737, 4465962, 5600295, 6879113, 7613025]
        );
        let lengths: Vec<u64> = manifest.chunks.iter().map(|c| c.length).collect();
        assert_eq!(
            lengths,
            vec![1332946, 1117791, 2015225, 1134333, 1278818, 733912, 775583]
        );
        assert_eq!(
            manifest.chunks[0].hash,
            "a1a61d75f7ff315ca3cf19908bd60ee519b9e99572062c9bc1cad79da27a0614"
        );
        assert_eq!(
            manifest.chunks[6].hash,
            "d725af43f4d9fceb7a5b9a73bb70900a6d925c64b127f39f8991f7bc8dc08c5c"
        );
    }

    /// The three shapes the scan can end in, each pinned against TS:
    /// short input (no boundary sought), the hard limit (no boundary found),
    /// and a file of repeated content (the same address, repeatedly).
    #[test]
    fn degenerate_inputs_match_the_typescript_implementation() {
        // Empty: no chunks at all, and the BLAKE3 of nothing as the file hash.
        let empty = build_manifest(&[]);
        assert!(empty.chunks.is_empty());
        assert_eq!(
            empty.file_hash,
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );

        // Below MIN_CHUNK_BYTES: one chunk, never split.
        let small = pseudo_random(1024, 1);
        let chunks = chunk_buffer(&small);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].length, 1024);
        assert_eq!(
            chunks[0].hash,
            "47c32c22baa6200d4fbff837173a60b9ce081a92f50808b3b6f60901f1b0b40c"
        );
        // Exactly MIN is still one chunk: the scan needs *more* than MIN left.
        assert_eq!(chunk_buffer(&pseudo_random(262144, 9)).len(), 1);

        // Zero entropy: the rolling hash never satisfies either mask, so every
        // chunk is cut at MAX_CHUNK_BYTES by the hard limit.
        let zeros = vec![0u8; 10 * 1024 * 1024];
        let cut: Vec<(u64, u64)> = chunk_buffer(&zeros)
            .iter()
            .map(|c| (c.offset, c.length))
            .collect();
        assert_eq!(
            cut,
            vec![(0, 4194304), (4194304, 4194304), (8388608, 2097152)]
        );
    }

    /// Repeated content collapses to a handful of distinct addresses — the
    /// dedup property `missingChunks` exists to exploit — with the same
    /// boundaries TS finds.
    #[test]
    fn repeated_content_deduplicates_to_the_typescript_chunk_set() {
        let unit = pseudo_random(64 * 1024, 3);
        let mut repeated = vec![0u8; 8 * 1024 * 1024];
        for offset in (0..repeated.len()).step_by(unit.len()) {
            repeated[offset..offset + unit.len()].copy_from_slice(&unit);
        }
        let manifest = build_manifest(&repeated);

        let cut: Vec<(u64, u64)> = manifest
            .chunks
            .iter()
            .map(|c| (c.offset, c.length))
            .collect();
        assert_eq!(
            cut,
            vec![
                (0, 1065967),
                (1065967, 1114112),
                (2180079, 1114112),
                (3294191, 1114112),
                (4408303, 1114112),
                (5522415, 1114112),
                (6636527, 1114112),
                (7750639, 637969),
            ]
        );
        assert_eq!(
            manifest.file_hash,
            "dea4953ffb8f104133b9f379cc171e9aa58d1f232571bc93dc3575c64d57a6b9"
        );

        // 8 chunks, 3 distinct addresses: the upload set is the distinct ones,
        // each listed once.
        assert_eq!(manifest.chunks.len(), 8);
        let uploads = missing_chunks(&manifest, |_| false);
        assert_eq!(uploads.len(), 3);
        // And a destination that already holds one of them asks for the rest.
        let held = uploads[0].hash.clone();
        let uploads = missing_chunks(&manifest, |h| h == held);
        assert_eq!(uploads.len(), 2);
        assert!(uploads.iter().all(|c| c.hash != held));
    }

    /// The streaming path must not be a second algorithm. Odd read sizes and a
    /// source that returns short reads exercise the window refill.
    #[test]
    fn streaming_a_reader_gives_the_same_manifest_as_the_whole_buffer() {
        let data = pseudo_random(8 * 1024 * 1024, 1);
        let streamed = chunk_reader(ShortReader {
            data: &data,
            pos: 0,
            step: 7919, // prime, so no read lands on a chunk boundary
        })
        .unwrap();
        assert_eq!(streamed, build_manifest(&data));

        // A file whose tail is shorter than one read step, and an empty one.
        let odd = pseudo_random(300_000, 5);
        assert_eq!(chunk_reader(&odd[..]).unwrap(), build_manifest(&odd));
        assert_eq!(chunk_reader(&[][..]).unwrap(), build_manifest(&[]));
    }

    #[test]
    fn chunking_a_file_on_disk_matches_chunking_its_bytes() {
        let data = pseudo_random(5 * 1024 * 1024, 4);
        let path = std::env::temp_dir().join(format!(
            "suma-chunker-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, &data).unwrap();
        let from_disk = chunk_file(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(from_disk, build_manifest(&data));
    }

    /// The manifest is what crosses to the control plane, so it must serialize
    /// to the camelCase shape `manifestSchema` in files.ts validates.
    #[test]
    fn manifests_serialize_to_the_protocol_shape() {
        let manifest = build_manifest(b"suma");
        let json = serde_json::to_value(&manifest).unwrap();
        assert!(json["fileHash"].as_str().unwrap().len() == 64);
        assert_eq!(json["totalBytes"], 6);
        assert_eq!(json["chunks"][0]["offset"], 0);
        assert_eq!(json["chunks"][0]["length"], 6);
        assert_eq!(json["chunks"][0]["hash"], json["fileHash"]);
        // And round-trips, so the agent can read one back.
        let parsed: Manifest = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, manifest);
    }

    /// A reader that hands out `step` bytes at a time.
    struct ShortReader<'a> {
        data: &'a [u8],
        pos: usize,
        step: usize,
    }

    impl Read for ShortReader<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.step.min(buf.len()).min(self.data.len() - self.pos);
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }
}
