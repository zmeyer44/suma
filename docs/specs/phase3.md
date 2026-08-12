# Spec: Phase 3 — Files (M-3 Lite)

PRD §5 (M-3 Lite), §8.6, §7 data plane, §12 Phase 3. The shared contracts are
already built, verified, and FROZEN — read them first and use them rather than
reimplementing:

- `packages/chunking` — FastCDC boundaries + BLAKE3 addressing
  (`chunkBuffer`, `buildManifest`, `assembleFromChunks`, `missingChunks`,
  `hashChunk`, `gearTableFingerprint`, size constants). Cross-language
  identical: the gear table is derived from BLAKE3 of a domain string, and TS
  `@noble/hashes` and Rust `blake3 1.5.5` produce the same digests (verified).
- `packages/protocol/src/files.ts` — `cloudFetchEligibility` (**the §8.6
  security rule**), `FileEntry`, `Manifest`, `Transfer`, `checkQuota`,
  `PRO_QUOTA_BYTES`, `normalizeVfsPath`, `vfsRequestSchema`, `CLOUD_ROOT`.

## The rule that must not be weakened

§8.6 DELETED v1.0's "sealed one-shot request", which shipped the user's URL
and Cookie header into the VM to be decrypted there. Nothing in Phase 3 may
reintroduce a path that sends credentials — cookies, Authorization headers,
client certs, or userinfo in a URL — to the compute plane. `cloudFetchEligibility`
is the enforcement point and it fails closed. Only public and presigned URLs
are eligible. If you find yourself needing a header to make a fetch work, the
answer is that the download stays local.

Also honest-terminology (§8.6): only `~/cloud` is cloud-native (canonical in
R2). `$HOME` is a Fly volume with snapshots. Never present the whole home
directory as having one canonical cloud location. And `$HOME` is **not**
end-to-end encrypted in V1 — say so wherever it matters, don't imply otherwise.

---

## Stream A — control plane (`services/control`)

Extends the existing service (see docs/specs/control.md, phase1-control.md,
phase2-control.md). Assigned: `services/control/src/**`, `test/**`.

- Schema: `files` (id, userId, path unique per user, sizeBytes, fileHash,
  contentType, createdAt, updatedAt), `file_chunks` (fileId, idx, hash,
  offset, length), `chunks` (hash PK, sizeBytes, refCount, createdAt) for
  dedup accounting, `transfers` (per `Transfer` in protocol).
- Object store behind an interface, exactly like `SandboxProvider`:
  `src/providers/object-store.ts` with `ObjectStore` (put/get/head/delete/
  presignPut/presignGet) and an in-memory `StubObjectStore` for tests. The R2
  implementation is a thin S3-compatible adapter; if credentials are absent it
  must fail loudly at startup rather than silently no-op.
- Routes under `/v1/files`: list (prefix, paging), stat, create-from-manifest
  (accepts a `Manifest`, records chunk rows, returns which chunk hashes are
  MISSING so the client uploads only those — use `missingChunks` semantics),
  complete-upload, delete, and presigned put/get for individual chunks.
  Quota enforced with `checkQuota` on every write path; over quota → 413 with
  the soft-block explanation, never data deletion.
- Transfers: create (server records a queued transfer; the AGENT does the
  fetching), progress update (agent-authenticated, bounded like Phase 2's
  usage samples), list, cancel. `GET /v1/files/transfers` is what other
  devices poll to see progress — M-3 requires completion visible everywhere.
- Chunk refCount maintained on file create/delete so deleting one file cannot
  orphan or prematurely delete chunks another file shares.
- Tests: quota soft-block, dedup (uploading the same content twice stores one
  chunk set and the second create reports zero missing), refCount across
  shared chunks, traversal-rejecting paths, transfer lifecycle, agent-bounded
  progress, and authorization (one user cannot read another's files).

## Stream B — Rust (`agent/`, `sidecar/`)

Assigned: `agent/**`, `sidecar/**`. `cargo test/clippy/fmt` must stay green.

- `agent/src/chunker.rs` — port `packages/chunking` EXACTLY: same gear table
  derivation (BLAKE3 of `suma.fastcdc.gear.v1` ‖ byte, little-endian u32),
  same masks (22/18 bits, spread by the same rule), same min/avg/max, same
  normalized two-stage scan. Pin these values as literals in a test so any
  drift fails loudly — they were read out of the TS implementation:
  - gear-table fingerprint (BLAKE3 of the 256 u32 entries, little-endian):
    `40d8972af1692567f0448beee174599d93f7b302951651ddedf4732ba8551b31`
  - `GEAR_TABLE[0..3]` = `3621715244, 875051506, 727303481, 2333224997`
  Also chunk a fixed pseudo-random buffer and assert the boundary offsets
  match what TS produces (generate the expected list once by adding a
  temporary print on the TS side, then pin it).
- `agent/src/vfs.rs` — the `vfs` channel: list/stat/read/write/delete/mkdir
  under capability tokens (`fs.read`/`fs.write`), rooted at `~/cloud`, with
  path traversal refused (mirror `normalizeVfsPath`).
- Extend `agent/src/fetch.rs`: after downloading, chunk the file and report
  the manifest, so the control plane can record it. Keep the existing
  no-header, control-character, private-range and size-cap protections.
- `sidecar/src/cache.rs` is already an LRU BLAKE3 cache — add hydration:
  given a manifest and a chunk source, assemble a file locally, verifying
  each chunk's hash and the whole-file hash (mirror `assembleFromChunks`).

## Stream C — `apps/files` (new workspace app)

Assigned: `apps/files/**`. Create the package (name `@suma/files`, React +
Vite + Tailwind v4, same versions as `apps/desktop` — copy its devDependency
versions exactly; do NOT add versions that aren't already in the lockfile).
Build output goes to `dist/`, and `turbo.json`'s build outputs already cover
`dist/**`.

The UI (§8.6): browse the tree, preview (text/image inline; everything else
gets a type + size), upload with progress, download, per-file delete, and a
quota meter showing used/limit with the soft-block state. Transfers list
showing cloud fetches with progress and origin device. Dark theme matching
`apps/desktop/src/renderer/src/styles.css` tokens.

It talks to the main process through a small typed bridge on `window.sumaFiles`
(the desktop stream defines and injects it) — define the interface you need in
`apps/files/src/bridge.ts` as types only, and code against it. Keep a
`MockBridge` for standalone `vite dev` so the app runs without Electron.

Include a `README.md` replacing the current placeholder, and pure unit tests
for anything non-trivial (path/tree building, size formatting, preview type
selection).

## Stream D — desktop (`apps/desktop`)

Assigned: `apps/desktop/src/main/files/**`, additions to `src/main/ipc.ts`,
`src/main/index.ts`, `src/main/privileged.ts`, `src/renderer/**`, `test/**`.
OFF-LIMITS: popup/permission code in `tabs.ts`/`spaces.ts`; `src/shared/ipc.ts`
is frozen EXCEPT that you may add the Phase-3 channels described below (it is
the contract, so add them carefully and keep `INVOKE_CHANNELS`/`EVENT_CHANNELS`
in sync — a script in the integrator's notes checks this).

- `will-download` intercept per space session: build a `DownloadContext` and
  call `cloudFetchEligibility`. Eligible ⇒ offer/route the cloud fetch (create
  a transfer via the control plane) and cancel the local download; ineligible
  ⇒ let the existing local DownloadManager handle it, and when the reason is
  `credentialed_request` surface the §8.6 explanation so the user learns why
  this one stayed local rather than assuming Suma is inconsistent.
- `suma://files` serving the built `apps/files` bundle in a hardened
  WebContents (no node integration, sandboxed, strict CSP, navigation locked
  to `suma://files`), with a preload exposing only `window.sumaFiles`.
  This is a real privileged page (§8.1) — unlike the terminal overlay. If you
  cannot get the built bundle wired, say so plainly rather than claiming it.
- New IPC: `files:list`, `files:stat`, `files:upload`, `files:download`,
  `files:delete`, `files:quota`, `transfers:list`, `transfers:cancel`, plus
  events `files:changed`, `transfers:updated`.
- Tests: `will-download` context construction (pure), the eligibility routing
  decision, tree building, and quota formatting.

## Verification (every stream)

TS: `pnpm --filter <pkg> check-types` and `test`. Rust:
`cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --check`. No installs; no new dependency versions beyond what the
lockfile already has. Never run watch modes or `electron-vite build`.
