//! The `vfs` channel (PRD Appendix C, §8.6) — list/stat/read/write/append/
//! delete/mkdir/tree/rename under capability tokens, rooted at `~/cloud`.
//!
//! Request and response shapes mirror `vfsRequestSchema`/`vfsResponseSchema`
//! in `packages/protocol/src/files.ts` field for field. This module leads the
//! protocol package: a wire change lands here first and in files.ts in the
//! same commit. Names match the ctl convention (a past-tense or noun answer,
//! never the request's own `t`).
//!
//! Two things this module refuses, and why:
//!
//! 1. **Traversal.** `normalize_vfs_path` is a port of `normalizeVfsPath`, so
//!    the caller and the agent agree on what a path *means* before either acts
//!    on it — a `..` that walks off the root is `None`, not a clamped path.
//!    Silently rewriting `../../.ssh/id_ed25519` into something safe would
//!    hand back a file the caller never asked for; refusing says what
//!    happened. Only `~/cloud` is exposed here at all: it is the one
//!    cloud-native tree (canonical in R2). `$HOME` is a Fly volume with
//!    snapshots and is **not** end-to-end encrypted in V1 (§8.6) — it is not
//!    reachable through this channel.
//! 2. **Symlinks that leave the root.** A lexical check cannot see them: a
//!    link at `~/cloud/notes` pointing at `/etc` makes `notes/passwd` a
//!    perfectly well-formed relative path. Every resolved target is therefore
//!    checked against the canonical root, and a link that cannot be resolved
//!    at all is refused rather than followed.
//!
//! Sizes are bounded by the transport, not by taste: a response has to fit one
//! mux frame (`MAX_FRAME_LEN`, 16 MiB), and base64 inflates by 4/3, so reads
//! are capped below what `vfsRequestSchema` itself permits.
//!
//! [`VfsRoot`] is not this channel's private property: it is where the agent
//! keeps the rule "a path from a caller names a place inside `~/cloud`, or it
//! names nothing". `fetch.public` writes into the same tree from the `ctl`
//! channel and resolves its destination through [`VfsRoot::resolve_new_file`]
//! for that reason — one confinement, checked in one place, rather than a
//! second one that has to be remembered.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::caps::{check_capability, Capability, CapabilityClaims};

/// Display form of the root (§8.6 terminology). The real directory is
/// `$HOME/cloud`; this string is what a user-facing message should say.
pub const CLOUD_ROOT: &str = "~/cloud";

/// Largest `vfs.read` this agent will answer. `vfsRequestSchema` allows 64 MiB,
/// but a 64 MiB read base64-encodes to ~85 MiB and the mux caps a frame at
/// 16 MiB, so the larger request could only ever fail on the way out. Refusing
/// it up front says why; the caller pages.
pub const VFS_MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Largest single `vfs.write` payload, for the same frame-size reason.
pub const VFS_MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;

/// Entries returned by one `vfs.list`. A directory with more is answered with
/// `truncated: true` rather than an oversized frame or a silent short list.
pub const VFS_MAX_LIST_ENTRIES: usize = 5_000;

/// Paths returned by one `vfs.tree`, and how deep the walk goes. These mirror
/// the desktop IDE's old local-walk caps (`WorkspaceFsService`), which the
/// explorer's tree was designed around.
pub const VFS_MAX_TREE_ENTRIES: usize = 10_000;
pub const VFS_MAX_TREE_DEPTH: usize = 12;

/// Directories a `vfs.tree` walk does not descend into, and files it omits.
/// Keep in step with `VFS_TREE_SKIPPED_DIRS`/`VFS_TREE_SKIPPED_FILES` in
/// packages/protocol/src/files.ts and the sim's local-vfs.ts.
pub const VFS_TREE_SKIPPED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".suma",
    "node_modules",
    ".pnpm-store",
    ".npm",
    ".cache",
    ".cargo",
    ".rustup",
    ".Trash",
    "Library",
];
pub const VFS_TREE_SKIPPED_FILES: &[&str] = &[".DS_Store"];

/** Keeps conditional mutations and no-overwrite renames atomic in one agent. */
static VFS_MUTATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

/// Mirror of `vfsRequestSchema` (files.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum VfsRequest {
    #[serde(rename = "vfs.list")]
    List { path: String },
    #[serde(rename = "vfs.stat")]
    Stat { path: String },
    #[serde(rename = "vfs.read", rename_all = "camelCase")]
    Read {
        path: String,
        offset: u64,
        length: u64,
    },
    #[serde(rename = "vfs.write", rename_all = "camelCase")]
    Write {
        path: String,
        data_b64: String,
        #[serde(default)]
        expected_size_bytes: Option<u64>,
    },
    #[serde(rename = "vfs.append", rename_all = "camelCase")]
    Append {
        path: String,
        data_b64: String,
        #[serde(default)]
        expected_size_bytes: Option<u64>,
    },
    #[serde(rename = "vfs.replace", rename_all = "camelCase")]
    Replace {
        path: String,
        expected_data_b64: String,
        data_b64: String,
    },
    #[serde(rename = "vfs.delete")]
    Delete {
        path: String,
        #[serde(default)]
        recursive: bool,
    },
    #[serde(rename = "vfs.mkdir")]
    Mkdir { path: String },
    #[serde(rename = "vfs.tree")]
    Tree { path: String },
    #[serde(rename = "vfs.rename")]
    Rename { from: String, to: String },
}

impl VfsRequest {
    fn path(&self) -> &str {
        match self {
            VfsRequest::List { path }
            | VfsRequest::Stat { path }
            | VfsRequest::Read { path, .. }
            | VfsRequest::Write { path, .. }
            | VfsRequest::Append { path, .. }
            | VfsRequest::Replace { path, .. }
            | VfsRequest::Delete { path, .. }
            | VfsRequest::Mkdir { path }
            | VfsRequest::Tree { path } => path,
            // The destination is resolved separately in `handle`.
            VfsRequest::Rename { from, .. } => from,
        }
    }

    /// Bounds mirroring the zod schema (serde enforces types and presence).
    pub fn validate(&self) -> Result<(), String> {
        if self.path().len() > 4096 {
            return Err("path must be at most 4096 chars".to_string());
        }
        match self {
            VfsRequest::Read { length, .. } => {
                if *length == 0 || *length > 64 * 1024 * 1024 {
                    return Err("length must be 1..=67108864".to_string());
                }
                if *length > VFS_MAX_READ_BYTES {
                    return Err(format!(
                        "length must be at most {VFS_MAX_READ_BYTES} bytes: a larger read cannot fit one mux frame once base64-encoded"
                    ));
                }
                Ok(())
            }
            VfsRequest::Rename { to, .. } => {
                if to.len() > 4096 {
                    return Err("to must be at most 4096 chars".to_string());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VfsKind {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "dir")]
    Dir,
    /// Symlinks, sockets, devices. Listed so the tree is honest about what is
    /// there, but not presented as something to read.
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsEntry {
    /// Final path segment.
    pub name: String,
    /// Normalized path within the root, always starting with `/`.
    pub path: String,
    pub kind: VfsKind,
    pub size_bytes: u64,
    pub modified_at_ms: u64,
}

/// Answers on the `vfs` channel. `error` carries the same `{code, message}`
/// shape as the ctl channel's, so a client has one error type to handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum VfsResponse {
    #[serde(rename = "vfs.listing", rename_all = "camelCase")]
    Listing {
        path: String,
        entries: Vec<VfsEntry>,
        /// The directory held more than `VFS_MAX_LIST_ENTRIES`.
        truncated: bool,
    },
    #[serde(rename = "vfs.info")]
    Info { entry: VfsEntry },
    #[serde(rename = "vfs.data", rename_all = "camelCase")]
    Data {
        path: String,
        offset: u64,
        data_b64: String,
        /// The read reached the end of the file.
        eof: bool,
    },
    #[serde(rename = "vfs.wrote", rename_all = "camelCase")]
    Wrote { path: String, size_bytes: u64 },
    #[serde(rename = "vfs.deleted")]
    Deleted { path: String },
    #[serde(rename = "vfs.created")]
    Created { path: String },
    #[serde(rename = "vfs.renamed")]
    Renamed { from: String, to: String },
    #[serde(rename = "vfs.paths")]
    Paths {
        path: String,
        /// Every file under `path`, rooted, sorted; a directory that
        /// contributed nothing appears as `"{path}/"` so empty dirs survive.
        paths: Vec<String>,
        /// The walk hit `VFS_MAX_TREE_ENTRIES` or `VFS_MAX_TREE_DEPTH`.
        truncated: bool,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

fn error(code: &str, message: impl Into<String>) -> VfsResponse {
    VfsResponse::Error {
        code: code.to_string(),
        message: message.into(),
    }
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/// Port of `normalizeVfsPath`: collapse `.` and empty segments, apply `..`
/// against the accumulated path, and return `None` the moment one would escape
/// the root. Returns a rooted path (`/a/b`), `/` for the root itself.
pub fn normalize_vfs_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                // Escapes the root: refused, not clamped.
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(format!("/{}", parts.join("/")))
}

/// The `~/cloud` tree this channel exposes.
#[derive(Debug, Clone)]
pub struct VfsRoot {
    root: PathBuf,
}

impl VfsRoot {
    pub fn new(root: PathBuf) -> Self {
        VfsRoot { root }
    }

    /// `$HOME/cloud` — the on-disk form of [`CLOUD_ROOT`].
    pub fn default_root() -> PathBuf {
        let home = std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into());
        PathBuf::from(home).join("cloud")
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Normalize, join, and prove the result is inside the root.
    ///
    /// The refusal is a bare reason rather than a wire shape because more than
    /// one channel needs this rule: `vfs` wraps it in a [`VfsResponse`],
    /// `fetch.public` in a ctl error. A path is refused, never clamped — see
    /// the module docs.
    pub fn resolve_within(&self, path: &str) -> Result<(String, PathBuf), String> {
        let normalized = normalize_vfs_path(path)
            .ok_or_else(|| "path escapes the Files root or contains a NUL".to_string())?;
        let relative = normalized.trim_start_matches('/');
        let target = if relative.is_empty() {
            self.root.clone()
        } else {
            self.root.join(relative)
        };
        self.check_no_symlink_escape(&target)?;
        Ok((normalized, target))
    }

    /// Resolve a path a file is about to be *created* at, for a caller outside
    /// this channel (`fetch.public`).
    ///
    /// Confinement first, then the two refusals a destination has that a path
    /// in general does not: the root is a directory, and a missing parent is
    /// `vfs.mkdir`'s job. Both are answered here rather than by the eventual
    /// `File::create` so a fetch that could never land is refused before it
    /// dials anything.
    pub fn resolve_new_file(&self, path: &str) -> Result<(String, PathBuf), String> {
        let (normalized, target) = self.resolve_within(path)?;
        if normalized == "/" {
            return Err(format!("{CLOUD_ROOT} is a directory, not a destination"));
        }
        let parent = target
            .parent()
            .ok_or_else(|| "destination has no parent directory".to_string())?;
        if !parent.is_dir() {
            return Err(format!(
                "{normalized}: parent directory does not exist under {CLOUD_ROOT}"
            ));
        }
        Ok((normalized, target))
    }

    fn resolve(&self, path: &str) -> Result<(String, PathBuf), VfsResponse> {
        self.resolve_within(path)
            .map_err(|reason| error("vfs_path_refused", reason))
    }

    /// The check the lexical one cannot do: resolve the deepest part of the
    /// target that exists and require it to still be under the canonical root.
    /// A component that exists but cannot be resolved (a dangling or looping
    /// symlink) is refused rather than followed — following it is how a write
    /// lands outside `~/cloud`.
    fn check_no_symlink_escape(&self, target: &Path) -> Result<(), String> {
        // No root on disk yet means nothing inside it exists to link through.
        let Ok(root_real) = self.root.canonicalize() else {
            return Ok(());
        };
        let mut probe = target.to_path_buf();
        loop {
            if probe.symlink_metadata().is_ok() {
                let real = probe.canonicalize().map_err(|_| {
                    "path passes through a link that cannot be resolved".to_string()
                })?;
                return if real.starts_with(root_real) {
                    Ok(())
                } else {
                    Err(format!("path resolves outside {CLOUD_ROOT}"))
                };
            }
            // Nothing at `probe`; try its parent. The walk always terminates:
            // `target` starts at the root, which exists.
            if !probe.pop() {
                return Err("path has no resolvable parent".to_string());
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

/// Which capability each `vfs` operation needs. Kept here rather than in
/// `caps.rs` because that module mirrors the TS `CTL_CAPABILITY` table, which
/// covers the ctl channel only — the `vfs` channel has no TS table to mirror.
pub fn required_capability(request: &VfsRequest) -> Capability {
    match request {
        VfsRequest::List { .. }
        | VfsRequest::Stat { .. }
        | VfsRequest::Read { .. }
        | VfsRequest::Tree { .. } => Capability::FsRead,
        VfsRequest::Write { .. }
        | VfsRequest::Append { .. }
        | VfsRequest::Replace { .. }
        | VfsRequest::Delete { .. }
        | VfsRequest::Mkdir { .. }
        | VfsRequest::Rename { .. } => Capability::FsWrite,
    }
}

/* ------------------------------------------------------------------ *
 * Handling
 * ------------------------------------------------------------------ */

/// Handle one raw `vfs` frame payload. Every failure — unparseable JSON, a
/// denied capability, a refused path — comes back as an `error` response, so
/// the channel always answers and never silently drops a request.
pub async fn handle_frame(
    root: &VfsRoot,
    claims: &CapabilityClaims,
    machine_id: &str,
    now_seconds: i64,
    payload: &[u8],
) -> VfsResponse {
    let request: VfsRequest = match serde_json::from_slice(payload) {
        Ok(request) => request,
        Err(err) => return error("bad_request", format!("unparseable vfs payload: {err}")),
    };
    handle(root, claims, machine_id, now_seconds, request).await
}

/// Handle one `vfs` request. Capability first, always: nothing below the check
/// runs without a valid, in-window, machine-bound `fs.read`/`fs.write`.
pub async fn handle(
    root: &VfsRoot,
    claims: &CapabilityClaims,
    machine_id: &str,
    now_seconds: i64,
    request: VfsRequest,
) -> VfsResponse {
    let capability = required_capability(&request);
    if let Some(reason) = check_capability(claims, machine_id, capability, now_seconds) {
        return error("capability_denied", reason);
    }
    if let Err(reason) = request.validate() {
        return error("invalid_request", reason);
    }

    let (path, target) = match root.resolve(request.path()) {
        Ok(resolved) => resolved,
        Err(refusal) => return refusal,
    };

    match request {
        VfsRequest::List { .. } => list(&path, &target).await,
        VfsRequest::Stat { .. } => stat(&path, &target).await,
        VfsRequest::Read { offset, length, .. } => read(&path, &target, offset, length).await,
        VfsRequest::Write {
            data_b64,
            expected_size_bytes,
            ..
        } => write(&path, &target, &data_b64, expected_size_bytes).await,
        VfsRequest::Append {
            data_b64,
            expected_size_bytes,
            ..
        } => append(&path, &target, &data_b64, expected_size_bytes).await,
        VfsRequest::Replace {
            expected_data_b64,
            data_b64,
            ..
        } => replace(&path, &target, &expected_data_b64, &data_b64).await,
        VfsRequest::Delete { recursive, .. } => delete(root, &path, &target, recursive).await,
        VfsRequest::Mkdir { .. } => mkdir(&path, &target).await,
        VfsRequest::Tree { .. } => tree(&path, &target).await,
        VfsRequest::Rename { to, .. } => rename(root, &path, &target, &to).await,
    }
}

fn io_error(context: &str, err: std::io::Error) -> VfsResponse {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => "vfs_not_found",
        std::io::ErrorKind::PermissionDenied => "vfs_permission_denied",
        _ => "vfs_io_failed",
    };
    error(code, format!("{context}: {err}"))
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

async fn list(path: &str, target: &Path) -> VfsResponse {
    let mut dir = match tokio::fs::read_dir(target).await {
        Ok(dir) => dir,
        Err(err) => return io_error(&format!("listing {path}"), err),
    };
    let mut entries: Vec<VfsEntry> = Vec::new();
    let mut truncated = false;
    loop {
        let next = match dir.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(err) => return io_error(&format!("listing {path}"), err),
        };
        if entries.len() >= VFS_MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        // `file_type` here does not follow links, so a link out of the root is
        // reported as `other` instead of masquerading as a readable file.
        let file_type = match next.file_type().await {
            Ok(file_type) => file_type,
            Err(err) => return io_error(&format!("listing {path}"), err),
        };
        let metadata = next.metadata().await;
        let name = next.file_name().to_string_lossy().into_owned();
        entries.push(VfsEntry {
            path: join_path(path, &name),
            name,
            kind: if file_type.is_dir() {
                VfsKind::Dir
            } else if file_type.is_file() {
                VfsKind::File
            } else {
                VfsKind::Other
            },
            size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_at_ms: millis(metadata.and_then(|m| m.modified())),
        });
    }
    // Stable order: the caller renders a tree, and readdir order is arbitrary.
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    VfsResponse::Listing {
        path: path.to_string(),
        entries,
        truncated,
    }
}

async fn stat(path: &str, target: &Path) -> VfsResponse {
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) => metadata,
        Err(err) => return io_error(&format!("stat {path}"), err),
    };
    // Named from the normalized path, not from disk: the root's real directory
    // name is host detail the caller has no business seeing.
    let name = path
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("/")
        .to_string();
    VfsResponse::Info {
        entry: VfsEntry {
            name,
            path: path.to_string(),
            kind: if metadata.is_dir() {
                VfsKind::Dir
            } else if metadata.is_file() {
                VfsKind::File
            } else {
                VfsKind::Other
            },
            size_bytes: metadata.len(),
            modified_at_ms: millis(metadata.modified()),
        },
    }
}

async fn read(path: &str, target: &Path, offset: u64, length: u64) -> VfsResponse {
    let mut file = match tokio::fs::File::open(target).await {
        Ok(file) => file,
        Err(err) => return io_error(&format!("reading {path}"), err),
    };
    let size = match file.metadata().await {
        Ok(metadata) if metadata.is_dir() => {
            return error("vfs_is_a_directory", format!("{path} is a directory"))
        }
        Ok(metadata) => metadata.len(),
        Err(err) => return io_error(&format!("reading {path}"), err),
    };
    if offset > size {
        return error(
            "invalid_request",
            format!("offset {offset} is past the end of {path} ({size} bytes)"),
        );
    }
    if let Err(err) = file.seek(std::io::SeekFrom::Start(offset)).await {
        return io_error(&format!("reading {path}"), err);
    }
    let want = length.min(VFS_MAX_READ_BYTES).min(size - offset) as usize;
    let mut buf = vec![0u8; want];
    if let Err(err) = file.read_exact(&mut buf).await {
        return io_error(&format!("reading {path}"), err);
    }
    VfsResponse::Data {
        path: path.to_string(),
        offset,
        data_b64: b64::encode(&buf),
        eof: offset + want as u64 >= size,
    }
}

async fn write(
    path: &str,
    target: &Path,
    data_b64: &str,
    expected_size_bytes: Option<u64>,
) -> VfsResponse {
    // Reject before decoding: base64 is 4/3 of its payload, so the length of
    // the text bounds the bytes without allocating them.
    if data_b64.len() / 4 * 3 > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!("a single write is limited to {VFS_MAX_WRITE_BYTES} bytes"),
        );
    }
    let bytes = match b64::decode(data_b64) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return error(
                "invalid_request",
                format!("dataB64 is not base64: {reason}"),
            )
        }
    };
    if bytes.len() > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!("a single write is limited to {VFS_MAX_WRITE_BYTES} bytes"),
        );
    }
    let _mutation_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if let Some(expected) = expected_size_bytes {
        let metadata = match tokio::fs::symlink_metadata(target).await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return error(
                    "vfs_conflict",
                    format!("{path} no longer has the expected size {expected}: it is missing"),
                )
            }
            Err(err) => return io_error(&format!("checking {path} before writing"), err),
        };
        if !metadata.is_file() || metadata.len() != expected {
            return error(
                "vfs_conflict",
                format!("{path} no longer has the expected size {expected}"),
            );
        }
    }
    let Some(parent) = target.parent() else {
        return error("vfs_path_refused", "cannot write to the Files root itself");
    };
    if !parent.is_dir() {
        return error(
            "vfs_not_found",
            format!("{path}: parent directory does not exist (use vfs.mkdir first)"),
        );
    }
    // Write beside the destination and rename: a write that dies partway must
    // not leave a truncated file where a complete one used to be.
    let temp = parent.join(format!(
        ".suma-vfs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let size_bytes = bytes.len() as u64;
    match tokio::fs::File::create(&temp).await {
        Ok(mut file) => {
            let written = async {
                file.write_all(&bytes).await?;
                file.flush().await
            }
            .await;
            if let Err(err) = written {
                let _ = tokio::fs::remove_file(&temp).await;
                return io_error(&format!("writing {path}"), err);
            }
        }
        Err(err) => return io_error(&format!("writing {path}"), err),
    }
    if let Err(err) = tokio::fs::rename(&temp, target).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return io_error(&format!("writing {path}"), err);
    }
    VfsResponse::Wrote {
        path: path.to_string(),
        size_bytes,
    }
}

async fn delete(root: &VfsRoot, path: &str, target: &Path, recursive: bool) -> VfsResponse {
    let _mutation_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if target == root.path() {
        return error("vfs_path_refused", "the Files root cannot be deleted");
    }
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) => metadata,
        Err(err) => return io_error(&format!("deleting {path}"), err),
    };
    let result = if metadata.is_dir() {
        if recursive {
            // Erasing a subtree takes an explicit flag plus `fs.write`; a bare
            // delete still cannot do it, and the root is refused above.
            tokio::fs::remove_dir_all(target).await
        } else {
            // Non-recursive on purpose: one message must not be able to erase
            // a subtree. The caller deletes what it can see, entry by entry.
            tokio::fs::remove_dir(target).await
        }
    } else {
        tokio::fs::remove_file(target).await
    };
    match result {
        Ok(()) => VfsResponse::Deleted {
            path: path.to_string(),
        },
        // `ErrorKind::DirectoryNotEmpty` is unstable on this toolchain, so the
        // errno is what distinguishes "you asked me to erase a subtree" from a
        // real I/O failure.
        Err(err) if err.raw_os_error() == Some(libc::ENOTEMPTY) => error(
            "vfs_not_empty",
            format!("{path} is not empty: delete its entries first"),
        ),
        Err(err) => io_error(&format!("deleting {path}"), err),
    }
}

async fn mkdir(path: &str, target: &Path) -> VfsResponse {
    let _mutation_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    match tokio::fs::create_dir_all(target).await {
        Ok(()) => VfsResponse::Created {
            path: path.to_string(),
        },
        Err(err) => io_error(&format!("creating {path}"), err),
    }
}

async fn append(
    path: &str,
    target: &Path,
    data_b64: &str,
    expected_size_bytes: Option<u64>,
) -> VfsResponse {
    if data_b64.len() / 4 * 3 > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!("a single append is limited to {VFS_MAX_WRITE_BYTES} bytes"),
        );
    }
    let bytes = match b64::decode(data_b64) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return error(
                "invalid_request",
                format!("dataB64 is not base64: {reason}"),
            )
        }
    };
    if bytes.len() > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!("a single append is limited to {VFS_MAX_WRITE_BYTES} bytes"),
        );
    }
    let _mutation_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    // Append extends a file that already exists — creating one is `vfs.write`'s
    // job, so a typo'd path fails loudly instead of starting a stray file.
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) => metadata,
        Err(err) => return io_error(&format!("appending to {path}"), err),
    };
    if metadata.is_dir() {
        return error("vfs_is_a_directory", format!("{path} is a directory"));
    }
    if let Some(expected) = expected_size_bytes {
        if metadata.len() != expected {
            return error(
                "vfs_conflict",
                format!(
                    "{path} no longer has the expected size {expected} (now {})",
                    metadata.len()
                ),
            );
        }
    }
    let mut file = match tokio::fs::OpenOptions::new()
        .append(true)
        .open(target)
        .await
    {
        Ok(file) => file,
        Err(err) => return io_error(&format!("appending to {path}"), err),
    };
    let appended = async {
        file.write_all(&bytes).await?;
        file.flush().await
    }
    .await;
    if let Err(err) = appended {
        return io_error(&format!("appending to {path}"), err);
    }
    VfsResponse::Wrote {
        path: path.to_string(),
        size_bytes: metadata.len() + bytes.len() as u64,
    }
}

async fn replace(
    path: &str,
    target: &Path,
    expected_data_b64: &str,
    data_b64: &str,
) -> VfsResponse {
    if (expected_data_b64.len() + data_b64.len()) / 4 * 3 > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!(
                "a single replace is limited to {VFS_MAX_WRITE_BYTES} bytes across both payloads"
            ),
        );
    }
    let expected = match b64::decode(expected_data_b64) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return error(
                "invalid_request",
                format!("expectedDataB64 is not base64: {reason}"),
            )
        }
    };
    let bytes = match b64::decode(data_b64) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return error(
                "invalid_request",
                format!("dataB64 is not base64: {reason}"),
            )
        }
    };
    if expected.len() + bytes.len() > VFS_MAX_WRITE_BYTES {
        return error(
            "vfs_too_large",
            format!(
                "a single replace is limited to {VFS_MAX_WRITE_BYTES} bytes across both payloads"
            ),
        );
    }
    let _mutation_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let metadata = match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            return error(
                "vfs_conflict",
                format!("{path} no longer contains the expected data"),
            )
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return error(
                "vfs_conflict",
                format!("{path} no longer contains the expected data"),
            )
        }
        Err(err) => return io_error(&format!("checking {path} before replacing"), err),
    };
    if metadata.len() != expected.len() as u64 {
        return error(
            "vfs_conflict",
            format!("{path} no longer contains the expected data"),
        );
    }
    let current = match tokio::fs::read(target).await {
        Ok(current) => current,
        Err(err) => return io_error(&format!("checking {path} before replacing"), err),
    };
    if current != expected {
        return error(
            "vfs_conflict",
            format!("{path} no longer contains the expected data"),
        );
    }
    let Some(parent) = target.parent() else {
        return error("vfs_path_refused", "cannot replace the Files root itself");
    };
    let temp = parent.join(format!(
        ".suma-vfs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    let size_bytes = bytes.len() as u64;
    match tokio::fs::File::create(&temp).await {
        Ok(mut file) => {
            let written = async {
                file.write_all(&bytes).await?;
                file.flush().await
            }
            .await;
            if let Err(err) = written {
                let _ = tokio::fs::remove_file(&temp).await;
                return io_error(&format!("replacing {path}"), err);
            }
        }
        Err(err) => return io_error(&format!("replacing {path}"), err),
    }
    if let Err(err) = tokio::fs::rename(&temp, target).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return io_error(&format!("replacing {path}"), err);
    }
    VfsResponse::Wrote {
        path: path.to_string(),
        size_bytes,
    }
}

async fn tree(path: &str, target: &Path) -> VfsResponse {
    match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) if !metadata.is_dir() => {
            return error("vfs_io_failed", format!("{path} is not a directory"))
        }
        Ok(_) => {}
        Err(err) => return io_error(&format!("walking {path}"), err),
    }
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    // Iterative DFS; depth counts from the requested path. Unreadable
    // directories are skipped, not fatal — the tree stays honest about what it
    // could see without one bad directory hiding the rest.
    let mut stack: Vec<(PathBuf, String, usize)> =
        vec![(target.to_path_buf(), path.to_string(), 0)];
    while let Some((dir, dir_rel, depth)) = stack.pop() {
        if paths.len() >= VFS_MAX_TREE_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        let mut contributed = false;
        while let Ok(Some(next)) = entries.next_entry().await {
            if paths.len() >= VFS_MAX_TREE_ENTRIES {
                truncated = true;
                break;
            }
            // Does not follow links: a link out of the root never enters the
            // walk, matching list()'s treatment of `other` kinds.
            let Ok(file_type) = next.file_type().await else {
                continue;
            };
            let name = next.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if VFS_TREE_SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if depth + 1 > VFS_MAX_TREE_DEPTH {
                    truncated = true;
                    continue;
                }
                stack.push((next.path(), join_path(&dir_rel, &name), depth + 1));
                contributed = true;
            } else if file_type.is_file() {
                if VFS_TREE_SKIPPED_FILES.contains(&name.as_str()) {
                    continue;
                }
                paths.push(join_path(&dir_rel, &name));
                contributed = true;
            }
            // Symlinks/sockets/devices are omitted entirely.
        }
        if !contributed && !truncated && dir_rel != *path {
            // A directory that contributed nothing survives as an empty-dir row.
            paths.push(format!("{dir_rel}/"));
        }
    }
    paths.sort();
    VfsResponse::Paths {
        path: path.to_string(),
        paths,
        truncated,
    }
}

async fn rename(root: &VfsRoot, from: &str, from_target: &Path, to: &str) -> VfsResponse {
    let (to_path, to_target) = match root.resolve_within(to) {
        Ok(resolved) => resolved,
        Err(reason) => return error("vfs_path_refused", reason),
    };
    if from_target == root.path() {
        return error("vfs_path_refused", "the Files root cannot be renamed");
    }
    if to_path == "/" {
        return error(
            "vfs_path_refused",
            format!("{CLOUD_ROOT} is a directory, not a destination"),
        );
    }
    // `rename(2)` replaces an existing destination. Serialize the fallback
    // check+rename path, and on Linux additionally ask the kernel for an
    // atomic no-replace operation so another process cannot win the race.
    let _rename_guard = VFS_MUTATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if tokio::fs::symlink_metadata(from_target).await.is_err() {
        return error("vfs_not_found", format!("{from}: no such path"));
    }
    // Never overwrite: rename is not a delete in disguise. The caller deletes
    // the destination first if replacing is what it means.
    if tokio::fs::symlink_metadata(&to_target).await.is_ok() {
        return error(
            "vfs_already_exists",
            format!("{to_path} already exists: rename must not overwrite"),
        );
    }
    let Some(parent) = to_target.parent() else {
        return error("vfs_path_refused", "destination has no parent directory");
    };
    if !parent.is_dir() {
        return error(
            "vfs_not_found",
            format!("{to_path}: parent directory does not exist (use vfs.mkdir first)"),
        );
    }
    #[cfg(target_os = "linux")]
    let rename_result = rename_no_replace(from_target, &to_target);
    #[cfg(not(target_os = "linux"))]
    let rename_result = tokio::fs::rename(from_target, &to_target).await;

    match rename_result {
        Ok(()) => VfsResponse::Renamed {
            from: from.to_string(),
            to: to_path,
        },
        Err(err)
            if err.kind() == std::io::ErrorKind::AlreadyExists
                || err.raw_os_error() == Some(libc::EEXIST)
                || err.raw_os_error() == Some(libc::ENOTEMPTY) =>
        {
            error(
                "vfs_already_exists",
                format!("{to_path} already exists: rename must not overwrite"),
            )
        }
        Err(err) => io_error(&format!("renaming {from}"), err),
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "source contains NUL")
    })?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "destination contains NUL")
    })?;
    // SAFETY: both C strings are owned for the duration of the syscall and
    // are NUL-terminated; AT_FDCWD makes their absolute paths self-contained.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/* ------------------------------------------------------------------ *
 * base64
 * ------------------------------------------------------------------ */

/// RFC 4648 base64 with padding — the encoding `toBase64`/`fromBase64` in
/// `packages/protocol/src/encoding.ts` produce (they wrap `btoa`/`atob`).
/// Hand-rolled because the workspace has no base64 crate and adding a
/// dependency for 40 lines of table lookup is a worse trade than owning them.
mod b64 {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(data: &[u8]) -> String {
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for group in data.chunks(3) {
            let b0 = group[0] as u32;
            let b1 = *group.get(1).unwrap_or(&0) as u32;
            let b2 = *group.get(2).unwrap_or(&0) as u32;
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
            out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
            out.push(if group.len() > 1 {
                ALPHABET[(triple >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if group.len() > 2 {
                ALPHABET[triple as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    /// Strict about structure (canonical padding, alphabet only, no
    /// whitespace) because a malformed payload is a bug or an attack, not
    /// something to guess at. Like `atob`, leftover low bits in the final
    /// group are discarded rather than rejected.
    pub fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
        let bytes = text.as_bytes();
        if bytes.len() % 4 != 0 {
            return Err("length is not a multiple of 4");
        }
        let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
        for (index, group) in bytes.chunks(4).enumerate() {
            let last = index == bytes.len() / 4 - 1;
            let pad = group.iter().filter(|b| **b == b'=').count();
            if pad > 0 && (!last || group[0] == b'=' || group[1] == b'=' || pad > 2) {
                return Err("misplaced padding");
            }
            if pad == 1 && group[2] == b'=' {
                return Err("misplaced padding");
            }
            let mut triple = 0u32;
            for byte in group.iter().take(4 - pad) {
                triple = (triple << 6) | value(*byte).ok_or("character outside the alphabet")?;
            }
            triple <<= 6 * pad;
            out.push((triple >> 16) as u8);
            if pad < 2 {
                out.push((triple >> 8) as u8);
            }
            if pad < 1 {
                out.push(triple as u8);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> VfsRoot {
        let path = std::env::temp_dir().join(format!(
            "suma-vfs-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        VfsRoot::new(path)
    }

    fn claims(caps: Vec<Capability>) -> CapabilityClaims {
        CapabilityClaims {
            mid: "m-1".into(),
            sub: "u-1".into(),
            caps,
            iat: 1_000,
            exp: 1_300,
            jti: "j".into(),
        }
    }

    fn both() -> CapabilityClaims {
        claims(vec![Capability::FsRead, Capability::FsWrite])
    }

    async fn run(root: &VfsRoot, claims: &CapabilityClaims, request: VfsRequest) -> VfsResponse {
        handle(root, claims, "m-1", 1_100, request).await
    }

    /// Mirror of the `normalizeVfsPath` cases, including the ones that return
    /// null: a caller and the agent must agree on what a path means.
    #[test]
    fn normalizes_paths_exactly_as_the_typescript_does() {
        assert_eq!(normalize_vfs_path("/a/b").as_deref(), Some("/a/b"));
        assert_eq!(normalize_vfs_path("a/b").as_deref(), Some("/a/b"));
        assert_eq!(normalize_vfs_path("/a//b/").as_deref(), Some("/a/b"));
        assert_eq!(normalize_vfs_path("/a/./b").as_deref(), Some("/a/b"));
        assert_eq!(normalize_vfs_path("/a/c/../b").as_deref(), Some("/a/b"));
        assert_eq!(normalize_vfs_path("/").as_deref(), Some("/"));
        assert_eq!(normalize_vfs_path(".").as_deref(), Some("/"));

        // Escapes are refused, never clamped to the root.
        assert_eq!(normalize_vfs_path(".."), None);
        assert_eq!(normalize_vfs_path("/.."), None);
        assert_eq!(normalize_vfs_path("a/../.."), None);
        assert_eq!(normalize_vfs_path("../../.ssh/id_ed25519"), None);
        assert_eq!(normalize_vfs_path(""), None);
        assert_eq!(normalize_vfs_path("a\0b"), None);
        assert_eq!(normalize_vfs_path(&"a".repeat(4097)), None);
    }

    #[tokio::test]
    async fn traversal_is_refused_and_touches_nothing() {
        let root = temp_root("traversal");
        let outside = root.path().parent().unwrap().join("suma-vfs-outside.txt");
        std::fs::write(&outside, b"secret").unwrap();

        for path in ["../suma-vfs-outside.txt", "/../suma-vfs-outside.txt"] {
            let resp = run(
                &root,
                &both(),
                VfsRequest::Read {
                    path: path.into(),
                    offset: 0,
                    length: 6,
                },
            )
            .await;
            assert!(
                matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
                "{path}: {resp:?}"
            );
            // And a write on the same path cannot land outside either.
            let resp = run(
                &root,
                &both(),
                VfsRequest::Write {
                    path: path.into(),
                    data_b64: b64::encode(b"clobbered"),
                    expected_size_bytes: None,
                },
            )
            .await;
            assert!(
                matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
                "{path}: {resp:?}"
            );
        }
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
        std::fs::remove_file(&outside).unwrap();
        std::fs::remove_dir_all(root.path()).unwrap();
    }

    /// A lexically clean path can still leave the root through a link. The
    /// symlink guard is what a `..` check cannot do.
    #[tokio::test]
    async fn a_symlink_out_of_the_root_is_refused() {
        let root = temp_root("symlink");
        let outside_dir = root.path().parent().unwrap().join(format!(
            "suma-vfs-outside-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("secret.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside_dir, root.path().join("escape")).unwrap();

        let resp = run(
            &root,
            &both(),
            VfsRequest::Read {
                path: "/escape/secret.txt".into(),
                offset: 0,
                length: 6,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
            "{resp:?}"
        );
        // Writing *through* the link is the dangerous direction, and is
        // refused before the file is created.
        let resp = run(
            &root,
            &both(),
            VfsRequest::Write {
                path: "/escape/planted.txt".into(),
                data_b64: b64::encode(b"x"),
                expected_size_bytes: None,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
            "{resp:?}"
        );
        assert!(!outside_dir.join("planted.txt").exists());
        // A link *within* the root is still usable.
        std::fs::write(root.path().join("real.txt"), b"inside").unwrap();
        std::os::unix::fs::symlink(root.path().join("real.txt"), root.path().join("link.txt"))
            .unwrap();
        let resp = run(
            &root,
            &both(),
            VfsRequest::Read {
                path: "/link.txt".into(),
                offset: 0,
                length: 6,
            },
        )
        .await;
        assert!(matches!(&resp, VfsResponse::Data { .. }), "{resp:?}");

        std::fs::remove_dir_all(&outside_dir).unwrap();
        std::fs::remove_dir_all(root.path()).unwrap();
    }

    /// The resolver `fetch.public` shares with this channel: a destination
    /// resolves to a path under the root or not at all, and the caller is told
    /// which — the root confinement is not the `vfs` channel's private rule.
    #[test]
    fn a_new_file_destination_resolves_under_the_root_or_is_refused() {
        let root = temp_root("dest");
        std::fs::create_dir_all(root.path().join("Downloads")).unwrap();

        assert_eq!(
            root.resolve_new_file("/Downloads/big.zip").unwrap(),
            (
                "/Downloads/big.zip".to_string(),
                root.path().join("Downloads/big.zip")
            )
        );
        // Both spellings a client might send for the same place.
        assert_eq!(
            root.resolve_new_file("Downloads/./big.zip").unwrap().1,
            root.path().join("Downloads/big.zip")
        );

        assert!(root.resolve_new_file("../escape.bin").is_err());
        assert!(root
            .resolve_new_file("/Downloads/../../escape.bin")
            .is_err());
        // No such directory under the root — refused here rather than by a
        // `File::create` after a fetch has already opened a socket.
        let refusal = root.resolve_new_file("/etc/cron.d/suma").unwrap_err();
        assert!(refusal.contains("parent directory"), "{refusal}");
        let refusal = root.resolve_new_file("/").unwrap_err();
        assert!(
            refusal.contains("directory, not a destination"),
            "{refusal}"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn write_read_stat_list_delete_round_trip() {
        let root = temp_root("roundtrip");
        let c = both();

        assert!(matches!(
            run(
                &root,
                &c,
                VfsRequest::Mkdir {
                    path: "/notes/2026".into()
                }
            )
            .await,
            VfsResponse::Created { .. }
        ));

        let body = b"suma files, one frame at a time".to_vec();
        let wrote = run(
            &root,
            &c,
            VfsRequest::Write {
                path: "/notes/2026/a.txt".into(),
                data_b64: b64::encode(&body),
                expected_size_bytes: None,
            },
        )
        .await;
        assert_eq!(
            wrote,
            VfsResponse::Wrote {
                path: "/notes/2026/a.txt".into(),
                size_bytes: body.len() as u64
            }
        );

        let read = run(
            &root,
            &c,
            VfsRequest::Read {
                path: "/notes/2026/a.txt".into(),
                offset: 0,
                length: 1024,
            },
        )
        .await;
        match read {
            VfsResponse::Data {
                data_b64,
                eof,
                path,
                ..
            } => {
                assert_eq!(b64::decode(&data_b64).unwrap(), body);
                assert!(eof);
                assert_eq!(path, "/notes/2026/a.txt");
            }
            other => panic!("expected data, got {other:?}"),
        }

        // A partial read reports eof: false and the offset it answered from.
        let read = run(
            &root,
            &c,
            VfsRequest::Read {
                path: "/notes/2026/a.txt".into(),
                offset: 5,
                length: 5,
            },
        )
        .await;
        match read {
            VfsResponse::Data {
                data_b64,
                eof,
                offset,
                ..
            } => {
                assert_eq!(b64::decode(&data_b64).unwrap(), b"files");
                assert!(!eof);
                assert_eq!(offset, 5);
            }
            other => panic!("expected data, got {other:?}"),
        }

        match run(
            &root,
            &c,
            VfsRequest::Stat {
                path: "/notes/2026/a.txt".into(),
            },
        )
        .await
        {
            VfsResponse::Info { entry } => {
                assert_eq!(entry.name, "a.txt");
                assert_eq!(entry.path, "/notes/2026/a.txt");
                assert_eq!(entry.kind, VfsKind::File);
                assert_eq!(entry.size_bytes, body.len() as u64);
            }
            other => panic!("expected info, got {other:?}"),
        }

        match run(&root, &c, VfsRequest::List { path: "/".into() }).await {
            VfsResponse::Listing {
                entries,
                truncated,
                path,
            } => {
                assert_eq!(path, "/");
                assert!(!truncated);
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].name, "notes");
                assert_eq!(entries[0].path, "/notes");
                assert_eq!(entries[0].kind, VfsKind::Dir);
            }
            other => panic!("expected listing, got {other:?}"),
        }

        // A non-empty directory is not silently emptied.
        let resp = run(
            &root,
            &c,
            VfsRequest::Delete {
                path: "/notes".into(),
                recursive: false,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_not_empty"),
            "{resp:?}"
        );

        assert!(matches!(
            run(
                &root,
                &c,
                VfsRequest::Delete {
                    path: "/notes/2026/a.txt".into(),
                    recursive: false,
                }
            )
            .await,
            VfsResponse::Deleted { .. }
        ));
        let resp = run(
            &root,
            &c,
            VfsRequest::Stat {
                path: "/notes/2026/a.txt".into(),
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_not_found"),
            "{resp:?}"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    /// Fail closed on every operation: `fs.read` never implies `fs.write`, an
    /// expired token stops working, and a refusal has no side effect.
    #[tokio::test]
    async fn every_operation_is_capability_gated() {
        let root = temp_root("caps");
        let read_only = claims(vec![Capability::FsRead]);

        for request in [
            VfsRequest::Write {
                path: "/x.txt".into(),
                data_b64: b64::encode(b"x"),
                expected_size_bytes: None,
            },
            VfsRequest::Replace {
                path: "/x.txt".into(),
                expected_data_b64: b64::encode(b"old"),
                data_b64: b64::encode(b"new"),
            },
            VfsRequest::Delete {
                path: "/x.txt".into(),
                recursive: false,
            },
            VfsRequest::Mkdir { path: "/x".into() },
        ] {
            let resp = run(&root, &read_only, request.clone()).await;
            assert_eq!(
                resp,
                error("capability_denied", "capability fs.write not granted"),
                "{request:?}"
            );
        }
        // Nothing was created by the refused writes.
        assert!(!root.path().join("x.txt").exists());
        assert!(!root.path().join("x").exists());

        let no_caps = claims(vec![]);
        let resp = run(&root, &no_caps, VfsRequest::List { path: "/".into() }).await;
        assert_eq!(
            resp,
            error("capability_denied", "capability fs.read not granted")
        );

        // Right capability, wrong machine / expired window.
        let c = both();
        assert_eq!(
            handle(
                &root,
                &c,
                "other-machine",
                1_100,
                VfsRequest::List { path: "/".into() }
            )
            .await,
            error("capability_denied", "token is bound to a different machine")
        );
        assert_eq!(
            handle(
                &root,
                &c,
                "m-1",
                9_999,
                VfsRequest::List { path: "/".into() }
            )
            .await,
            error("capability_denied", "capability token expired")
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn oversized_reads_and_writes_are_refused_before_the_frame_is_built() {
        let root = temp_root("bounds");
        let c = both();

        // Larger than one mux frame can carry, though the zod schema allows it.
        let resp = run(
            &root,
            &c,
            VfsRequest::Read {
                path: "/a.txt".into(),
                offset: 0,
                length: 32 * 1024 * 1024,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, message }
                if code == "invalid_request" && message.contains("mux frame")),
            "{resp:?}"
        );
        // Beyond the zod bound entirely.
        let resp = run(
            &root,
            &c,
            VfsRequest::Read {
                path: "/a.txt".into(),
                offset: 0,
                length: 0,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "invalid_request"),
            "{resp:?}"
        );

        let resp = run(
            &root,
            &c,
            VfsRequest::Write {
                path: "/big.bin".into(),
                data_b64: "A".repeat((VFS_MAX_WRITE_BYTES + 1024) / 3 * 4),
                expected_size_bytes: None,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_too_large"),
            "{resp:?}"
        );
        assert!(!root.path().join("big.bin").exists());

        // A write into a directory that does not exist yet says so rather than
        // conjuring the tree — `vfs.mkdir` exists for that.
        let resp = run(
            &root,
            &c,
            VfsRequest::Write {
                path: "/nope/a.txt".into(),
                data_b64: b64::encode(b"x"),
                expected_size_bytes: None,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_not_found"),
            "{resp:?}"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn requests_parse_from_the_typescript_wire_shape() {
        let root = temp_root("wire");
        let c = both();

        // Exactly what `vfsRequestSchema` produces.
        let write: VfsRequest =
            serde_json::from_str(r#"{"t":"vfs.write","path":"/a.txt","dataB64":"aGVsbG8="}"#)
                .unwrap();
        assert_eq!(
            write,
            VfsRequest::Write {
                path: "/a.txt".into(),
                data_b64: "aGVsbG8=".into(),
                expected_size_bytes: None,
            }
        );
        let read: VfsRequest =
            serde_json::from_str(r#"{"t":"vfs.read","path":"/a.txt","offset":0,"length":16}"#)
                .unwrap();
        assert_eq!(
            read,
            VfsRequest::Read {
                path: "/a.txt".into(),
                offset: 0,
                length: 16
            }
        );
        assert!(serde_json::from_str::<VfsRequest>(r#"{"t":"vfs.exec","path":"/"}"#).is_err());

        // Frame in, frame out — including the error shape for junk.
        assert!(matches!(
            handle_frame(
                &root,
                &c,
                "m-1",
                1_100,
                br#"{"t":"vfs.write","path":"/a.txt","dataB64":"aGVsbG8="}"#
            )
            .await,
            VfsResponse::Wrote { .. }
        ));
        let resp = handle_frame(&root, &c, "m-1", 1_100, b"not json").await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "bad_request"),
            "{resp:?}"
        );

        // Responses carry the camelCase names a TS client will read.
        let listing =
            handle_frame(&root, &c, "m-1", 1_100, br#"{"t":"vfs.list","path":"/"}"#).await;
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["t"], "vfs.listing");
        assert_eq!(json["entries"][0]["name"], "a.txt");
        assert_eq!(json["entries"][0]["sizeBytes"], 5);
        assert!(json["entries"][0]["modifiedAtMs"].is_number());
        let data = handle_frame(
            &root,
            &c,
            "m-1",
            1_100,
            br#"{"t":"vfs.read","path":"/a.txt","offset":0,"length":16}"#,
        )
        .await;
        let json = serde_json::to_value(data).unwrap();
        assert_eq!(json["t"], "vfs.data");
        assert_eq!(json["dataB64"], "aGVsbG8=");
        assert_eq!(json["eof"], true);

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn tree_walks_skips_and_truncates() {
        let root = temp_root("tree");
        let base = root.path().to_path_buf();
        std::fs::create_dir_all(base.join("src/lib")).unwrap();
        std::fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(base.join(".git/objects")).unwrap();
        std::fs::create_dir_all(base.join("empty")).unwrap();
        std::fs::write(base.join("src/main.ts"), "x").unwrap();
        std::fs::write(base.join("src/lib/util.ts"), "x").unwrap();
        std::fs::write(base.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::write(base.join(".DS_Store"), "x").unwrap();
        std::fs::write(base.join("README.md"), "x").unwrap();
        std::os::unix::fs::symlink("/etc", base.join("outside")).unwrap();

        let resp = run(&root, &both(), VfsRequest::Tree { path: "/".into() }).await;
        match resp {
            VfsResponse::Paths {
                path,
                paths,
                truncated,
            } => {
                assert_eq!(path, "/");
                assert!(!truncated);
                // Sorted, rooted, skip-listed dirs and files gone, symlink
                // omitted, empty dir kept as a trailing-slash row.
                assert_eq!(
                    paths,
                    vec![
                        "/README.md".to_string(),
                        "/empty/".to_string(),
                        "/src/lib/util.ts".to_string(),
                        "/src/main.ts".to_string(),
                    ]
                );
            }
            other => panic!("expected paths, got {other:?}"),
        }

        // A subtree request roots its paths at the requested directory's
        // normalized form, not at "/".
        let resp = run(
            &root,
            &both(),
            VfsRequest::Tree {
                path: "/src".into(),
            },
        )
        .await;
        match resp {
            VfsResponse::Paths { paths, .. } => {
                assert_eq!(
                    paths,
                    vec!["/src/lib/util.ts".to_string(), "/src/main.ts".to_string()]
                );
            }
            other => panic!("expected paths, got {other:?}"),
        }

        // Depth is bounded: a chain deeper than VFS_MAX_TREE_DEPTH reports
        // truncated instead of walking forever.
        let mut deep = base.clone();
        for i in 0..(VFS_MAX_TREE_DEPTH + 2) {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("bottom.txt"), "x").unwrap();
        let resp = run(&root, &both(), VfsRequest::Tree { path: "/".into() }).await;
        match resp {
            VfsResponse::Paths {
                paths, truncated, ..
            } => {
                assert!(truncated);
                assert!(!paths.iter().any(|p| p.ends_with("bottom.txt")));
            }
            other => panic!("expected paths, got {other:?}"),
        }

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn tree_is_read_gated_and_confined() {
        let root = temp_root("tree-gate");
        let write_only = claims(vec![Capability::FsWrite]);
        let resp = run(&root, &write_only, VfsRequest::Tree { path: "/".into() }).await;
        assert_eq!(
            resp,
            error("capability_denied", "capability fs.read not granted")
        );

        let resp = run(
            &root,
            &both(),
            VfsRequest::Tree {
                path: "/../".into(),
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
            "{resp:?}"
        );

        // A file is not a walkable tree.
        std::fs::write(root.path().join("f.txt"), "x").unwrap();
        let resp = run(
            &root,
            &both(),
            VfsRequest::Tree {
                path: "/f.txt".into(),
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_io_failed"),
            "{resp:?}"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn rename_round_trip_and_refusals() {
        let root = temp_root("rename");
        let c = both();
        std::fs::create_dir_all(root.path().join("dir")).unwrap();
        std::fs::write(root.path().join("a.txt"), "hello").unwrap();
        std::fs::write(root.path().join("b.txt"), "other").unwrap();

        // File rename round-trips; the old path is gone.
        let resp = run(
            &root,
            &c,
            VfsRequest::Rename {
                from: "/a.txt".into(),
                to: "/dir/a2.txt".into(),
            },
        )
        .await;
        assert_eq!(
            resp,
            VfsResponse::Renamed {
                from: "/a.txt".into(),
                to: "/dir/a2.txt".into()
            }
        );
        assert!(matches!(
            run(
                &root,
                &c,
                VfsRequest::Stat {
                    path: "/a.txt".into()
                }
            )
            .await,
            VfsResponse::Error { .. }
        ));

        // Directory rename carries its contents.
        let resp = run(
            &root,
            &c,
            VfsRequest::Rename {
                from: "/dir".into(),
                to: "/dir2".into(),
            },
        )
        .await;
        assert!(matches!(resp, VfsResponse::Renamed { .. }), "{resp:?}");
        assert!(root.path().join("dir2/a2.txt").exists());

        // Never overwrites, never escapes, never invents parents, and the
        // root is not a party to it.
        let cases = [
            ("/dir2/a2.txt", "/b.txt", "vfs_already_exists"),
            ("/b.txt", "/../x", "vfs_path_refused"),
            ("/b.txt", "/missing/x", "vfs_not_found"),
            ("/", "/x", "vfs_path_refused"),
            ("/b.txt", "/", "vfs_path_refused"),
            ("/ghost.txt", "/x", "vfs_not_found"),
        ];
        for (from, to, want) in cases {
            let resp = run(
                &root,
                &c,
                VfsRequest::Rename {
                    from: from.into(),
                    to: to.into(),
                },
            )
            .await;
            assert!(
                matches!(&resp, VfsResponse::Error { code, .. } if code == want),
                "{from} -> {to}: {resp:?}"
            );
        }
        assert!(root.path().join("b.txt").exists());

        // Read-only claims cannot move anything.
        let read_only = claims(vec![Capability::FsRead]);
        let resp = run(
            &root,
            &read_only,
            VfsRequest::Rename {
                from: "/b.txt".into(),
                to: "/c.txt".into(),
            },
        )
        .await;
        assert_eq!(
            resp,
            error("capability_denied", "capability fs.write not granted")
        );
        assert!(root.path().join("b.txt").exists());

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn concurrent_renames_cannot_overwrite_the_winner() {
        let root = temp_root("rename-race");
        let c = both();
        std::fs::write(root.path().join("a.txt"), "a").unwrap();
        std::fs::write(root.path().join("b.txt"), "b").unwrap();

        let (a, b) = tokio::join!(
            run(
                &root,
                &c,
                VfsRequest::Rename {
                    from: "/a.txt".into(),
                    to: "/winner.txt".into(),
                },
            ),
            run(
                &root,
                &c,
                VfsRequest::Rename {
                    from: "/b.txt".into(),
                    to: "/winner.txt".into(),
                },
            ),
        );

        let responses = [&a, &b];
        assert_eq!(
            responses
                .iter()
                .filter(|response| matches!(response, VfsResponse::Renamed { .. }))
                .count(),
            1,
            "{responses:?}"
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| {
                    matches!(response, VfsResponse::Error { code, .. } if code == "vfs_already_exists")
                })
                .count(),
            1,
            "{responses:?}"
        );
        let winner = std::fs::read_to_string(root.path().join("winner.txt")).unwrap();
        assert!(winner == "a" || winner == "b");
        assert_eq!(
            ["a.txt", "b.txt"]
                .iter()
                .filter(|name| root.path().join(name).exists())
                .count(),
            1
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn recursive_delete_erases_subtree_only_when_asked() {
        let root = temp_root("rdelete");
        let c = both();
        std::fs::create_dir_all(root.path().join("sub/deep")).unwrap();
        std::fs::write(root.path().join("sub/deep/f.txt"), "x").unwrap();

        // The bare delete still refuses a populated directory.
        let resp = run(
            &root,
            &c,
            VfsRequest::Delete {
                path: "/sub".into(),
                recursive: false,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_not_empty"),
            "{resp:?}"
        );

        // Recursive needs fs.write like any other mutation.
        let read_only = claims(vec![Capability::FsRead]);
        let resp = run(
            &root,
            &read_only,
            VfsRequest::Delete {
                path: "/sub".into(),
                recursive: true,
            },
        )
        .await;
        assert_eq!(
            resp,
            error("capability_denied", "capability fs.write not granted")
        );
        assert!(root.path().join("sub/deep/f.txt").exists());

        // The root is refused even recursively.
        let resp = run(
            &root,
            &c,
            VfsRequest::Delete {
                path: "/".into(),
                recursive: true,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_path_refused"),
            "{resp:?}"
        );

        // With the flag and the capability, the subtree goes.
        let resp = run(
            &root,
            &c,
            VfsRequest::Delete {
                path: "/sub".into(),
                recursive: true,
            },
        )
        .await;
        assert!(matches!(resp, VfsResponse::Deleted { .. }), "{resp:?}");
        assert!(!root.path().join("sub").exists());

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn append_extends_existing_files_only() {
        let root = temp_root("append");
        let c = both();

        // Appending to a file that does not exist is refused — creation is
        // vfs.write's job.
        let resp = run(
            &root,
            &c,
            VfsRequest::Append {
                path: "/log.txt".into(),
                data_b64: b64::encode(b"one"),
                expected_size_bytes: None,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_not_found"),
            "{resp:?}"
        );

        std::fs::write(root.path().join("log.txt"), "one").unwrap();
        let resp = run(
            &root,
            &c,
            VfsRequest::Append {
                path: "/log.txt".into(),
                data_b64: b64::encode(b" two"),
                expected_size_bytes: None,
            },
        )
        .await;
        assert_eq!(
            resp,
            VfsResponse::Wrote {
                path: "/log.txt".into(),
                size_bytes: 7
            }
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("log.txt")).unwrap(),
            "one two"
        );

        let stale_write = run(
            &root,
            &c,
            VfsRequest::Write {
                path: "/log.txt".into(),
                data_b64: b64::encode(b"replacement"),
                expected_size_bytes: Some(3),
            },
        )
        .await;
        assert!(
            matches!(&stale_write, VfsResponse::Error { code, .. } if code == "vfs_conflict"),
            "{stale_write:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("log.txt")).unwrap(),
            "one two"
        );

        // A size precondition turns allocation into one atomic claim across
        // concurrent client connections.
        let (first, second) = tokio::join!(
            run(
                &root,
                &c,
                VfsRequest::Append {
                    path: "/log.txt".into(),
                    data_b64: b64::encode(b" A"),
                    expected_size_bytes: Some(7),
                },
            ),
            run(
                &root,
                &c,
                VfsRequest::Append {
                    path: "/log.txt".into(),
                    data_b64: b64::encode(b" B"),
                    expected_size_bytes: Some(7),
                },
            ),
        );
        let responses = [first, second];
        assert_eq!(
            responses
                .iter()
                .filter(|response| matches!(response, VfsResponse::Wrote { .. }))
                .count(),
            1
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| matches!(response, VfsResponse::Error { code, .. } if code == "vfs_conflict"))
                .count(),
            1
        );
        assert_eq!(std::fs::read(root.path().join("log.txt")).unwrap().len(), 9);

        // A directory is not appendable, and fs.write is required.
        std::fs::create_dir_all(root.path().join("d")).unwrap();
        let resp = run(
            &root,
            &c,
            VfsRequest::Append {
                path: "/d".into(),
                data_b64: b64::encode(b"x"),
                expected_size_bytes: None,
            },
        )
        .await;
        assert!(
            matches!(&resp, VfsResponse::Error { code, .. } if code == "vfs_is_a_directory"),
            "{resp:?}"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn replace_compares_exact_contents_before_writing() {
        let root = temp_root("replace");
        let c = both();
        std::fs::write(root.path().join("a.txt"), "one").unwrap();

        let stale = run(
            &root,
            &c,
            VfsRequest::Replace {
                path: "/a.txt".into(),
                expected_data_b64: b64::encode(b"two"),
                data_b64: b64::encode(b"bad"),
            },
        )
        .await;
        assert!(
            matches!(&stale, VfsResponse::Error { code, .. } if code == "vfs_conflict"),
            "{stale:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "one"
        );

        let wrote = run(
            &root,
            &c,
            VfsRequest::Replace {
                path: "/a.txt".into(),
                expected_data_b64: b64::encode(b"one"),
                data_b64: b64::encode(b"after"),
            },
        )
        .await;
        assert_eq!(
            wrote,
            VfsResponse::Wrote {
                path: "/a.txt".into(),
                size_bytes: 5,
            }
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "after"
        );

        std::fs::remove_dir_all(root.path()).unwrap();
    }

    #[tokio::test]
    async fn new_ops_parse_from_the_typescript_wire_shape() {
        // Exactly what the extended `vfsRequestSchema` produces.
        let tree: VfsRequest = serde_json::from_str(r#"{"t":"vfs.tree","path":"/"}"#).unwrap();
        assert_eq!(tree, VfsRequest::Tree { path: "/".into() });
        let rename: VfsRequest =
            serde_json::from_str(r#"{"t":"vfs.rename","from":"/a","to":"/b"}"#).unwrap();
        assert_eq!(
            rename,
            VfsRequest::Rename {
                from: "/a".into(),
                to: "/b".into()
            }
        );
        let append: VfsRequest = serde_json::from_str(
            r#"{"t":"vfs.append","path":"/a","dataB64":"aGk=","expectedSizeBytes":7}"#,
        )
        .unwrap();
        assert_eq!(
            append,
            VfsRequest::Append {
                path: "/a".into(),
                data_b64: "aGk=".into(),
                expected_size_bytes: Some(7),
            }
        );
        let replace: VfsRequest = serde_json::from_str(
            r#"{"t":"vfs.replace","path":"/a","expectedDataB64":"b2xk","dataB64":"bmV3"}"#,
        )
        .unwrap();
        assert_eq!(
            replace,
            VfsRequest::Replace {
                path: "/a".into(),
                expected_data_b64: "b2xk".into(),
                data_b64: "bmV3".into(),
            }
        );
        // The old delete shape (no flag) still parses, defaulting to false.
        let bare: VfsRequest = serde_json::from_str(r#"{"t":"vfs.delete","path":"/d"}"#).unwrap();
        assert_eq!(
            bare,
            VfsRequest::Delete {
                path: "/d".into(),
                recursive: false
            }
        );
        let recursive: VfsRequest =
            serde_json::from_str(r#"{"t":"vfs.delete","path":"/d","recursive":true}"#).unwrap();
        assert_eq!(
            recursive,
            VfsRequest::Delete {
                path: "/d".into(),
                recursive: true
            }
        );

        // Responses serialize to the names `vfsResponseSchema` reads.
        let renamed = serde_json::to_value(VfsResponse::Renamed {
            from: "/a".into(),
            to: "/b".into(),
        })
        .unwrap();
        assert_eq!(renamed["t"], "vfs.renamed");
        assert_eq!(renamed["from"], "/a");
        assert_eq!(renamed["to"], "/b");
        let paths = serde_json::to_value(VfsResponse::Paths {
            path: "/".into(),
            paths: vec!["/a.txt".into(), "/empty/".into()],
            truncated: false,
        })
        .unwrap();
        assert_eq!(paths["t"], "vfs.paths");
        assert_eq!(paths["paths"][1], "/empty/");
        assert_eq!(paths["truncated"], false);
    }

    #[test]
    fn base64_matches_btoa_and_refuses_malformed_input() {
        // Vectors from RFC 4648, which is what btoa/atob implement.
        for (bytes, text) in [
            (&b""[..], ""),
            (&b"f"[..], "Zg=="),
            (&b"fo"[..], "Zm8="),
            (&b"foo"[..], "Zm9v"),
            (&b"foob"[..], "Zm9vYg=="),
            (&b"fooba"[..], "Zm9vYmE="),
            (&b"foobar"[..], "Zm9vYmFy"),
        ] {
            assert_eq!(b64::encode(bytes), text);
            assert_eq!(b64::decode(text).unwrap(), bytes);
        }
        // Full byte range round-trips, including the +/ alphabet entries.
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64::decode(&b64::encode(&all)).unwrap(), all);

        for bad in ["Zg=", "Zg", "Z g=", "Zm9v!", "=g==", "Z===", "Zg==Zg=="] {
            assert!(b64::decode(bad).is_err(), "{bad:?} must be refused");
        }
    }
}
