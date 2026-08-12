//! Durable PTY sessions (§8.5).
//!
//! The §8.5 contract is "cold boot loses the process but never the context":
//! Fly suspend can fail to restore its memory snapshot, so everything a user
//! would grieve — scrollback, working directory, command history — persists
//! to disk *independently* of the process. Each PTY owns a scrollback ring
//! (capped at [`PTY_SCROLLBACK_LINES`]) mirrored append-only into
//! `$HOME/.suma/pty/<id>/`, and `attach` reports honestly whether it found
//! the live process (`resumed`) or only the persisted context
//! (`reconstructed`) — the UI must show which, so we never fake liveness.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::proto::{PtyRestoreKind, PtySessionEntry, PtySignal, PTY_SCROLLBACK_LINES};

/* ------------------------------------------------------------------ *
 * Scrollback ring
 * ------------------------------------------------------------------ */

/// Line-capped scrollback with stable byte offsets. Offsets count from the
/// beginning of the PTY's whole output stream, so a client that saw byte N
/// can ask for "everything since N" across truncation: evicted bytes simply
/// move the readable window forward.
#[derive(Debug)]
pub struct Scrollback {
    lines: VecDeque<Vec<u8>>,
    /// Bytes of an unterminated final line.
    partial: Vec<u8>,
    /// Stream offset of the first retained byte (grows as lines are evicted).
    base_offset: u64,
    /// Total bytes ever pushed (== stream length).
    total_bytes: u64,
    max_lines: usize,
}

impl Scrollback {
    pub fn new(max_lines: usize) -> Self {
        Scrollback {
            lines: VecDeque::new(),
            partial: Vec::new(),
            base_offset: 0,
            total_bytes: 0,
            max_lines,
        }
    }

    /// Ring with the §8.5 production cap.
    pub fn with_default_cap() -> Self {
        Self::new(PTY_SCROLLBACK_LINES)
    }

    pub fn push(&mut self, data: &[u8]) {
        self.total_bytes += data.len() as u64;
        for chunk in data.split_inclusive(|&b| b == b'\n') {
            self.partial.extend_from_slice(chunk);
            if chunk.ends_with(b"\n") {
                self.lines.push_back(std::mem::take(&mut self.partial));
            }
        }
        while self.lines.len() > self.max_lines {
            let evicted = self.lines.pop_front().expect("len checked");
            self.base_offset += evicted.len() as u64;
        }
    }

    /// Bytes from stream offset `offset` (clamped to what is still retained)
    /// through the end of the buffer, partial line included.
    pub fn bytes_since(&self, offset: u64) -> Vec<u8> {
        let start = offset.max(self.base_offset).min(self.total_bytes);
        let mut out = Vec::new();
        let mut pos = self.base_offset;
        for line in self.lines.iter().chain(std::iter::once(&self.partial)) {
            let end = pos + line.len() as u64;
            if end > start {
                let skip = start.saturating_sub(pos) as usize;
                out.extend_from_slice(&line[skip..]);
            }
            pos = end;
        }
        out
    }

    /// Total stream length in bytes (including bytes already evicted).
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn base_offset(&self) -> u64 {
        self.base_offset
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}

/* ------------------------------------------------------------------ *
 * On-disk context
 * ------------------------------------------------------------------ */

/// The persisted context: what survives when the process does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyMeta {
    pub cwd: String,
    pub command: Option<String>,
    pub history: Vec<String>,
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

fn scrollback_path(dir: &Path) -> PathBuf {
    dir.join("scrollback.log")
}

pub fn persist_meta(dir: &Path, meta: &PtyMeta) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(meta)?;
    fs::write(meta_path(dir), json).context("writing pty meta")
}

pub fn append_scrollback(dir: &Path, data: &[u8]) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(scrollback_path(dir))?;
    f.write_all(data).context("appending pty scrollback")
}

/// Load a persisted context, if one exists.
pub fn load_context(dir: &Path) -> Option<(PtyMeta, Vec<u8>)> {
    let meta: PtyMeta = serde_json::from_slice(&fs::read(meta_path(dir)).ok()?).ok()?;
    let scrollback = fs::read(scrollback_path(dir)).unwrap_or_default();
    Some((meta, scrollback))
}

/* ------------------------------------------------------------------ *
 * Live sessions
 * ------------------------------------------------------------------ */

pub struct SpawnParams {
    pub pty_id: String,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<BTreeMap<String, String>>,
}

/* ------------------------------------------------------------------ *
 * Live output fan-out
 * ------------------------------------------------------------------ */

/// How many output chunks a subscriber may fall behind before the broadcast
/// drops the oldest. Lag is *recoverable*, not data loss: every chunk carries
/// the stream offset it ends at, so a lagging pump re-reads the gap from the
/// scrollback ring ([`PtyManager::replay`]) and continues in order.
pub const PTY_OUTPUT_LAG_CAPACITY: usize = 1024;

/// One chunk of PTY output, tagged with its position in the stream.
#[derive(Clone, Debug)]
pub struct PtyOutput {
    /// Stream offset one past this chunk's last byte. `data` therefore spans
    /// `end_offset - data.len() .. end_offset`, which is what lets a
    /// subscriber detect overlap with a replay it has already written and
    /// resynchronise after falling behind.
    pub end_offset: u64,
    pub data: Arc<Vec<u8>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    ring: Arc<Mutex<Scrollback>>,
    /// Live output to every attached mux connection. Held by the session, so
    /// dropping the session closes every subscriber's receiver.
    output: broadcast::Sender<PtyOutput>,
    cwd: String,
    command: Option<String>,
}

pub struct AttachResult {
    pub restore: PtyRestoreKind,
    /// Replay bytes from the requested offset. The bytes a client actually
    /// receives flow on `pty/<id>` when it opens that channel
    /// ([`PtyManager::replay`] / [`PtyManager::persisted_replay`]); `ctl`
    /// carries only the metadata of `pty.attached`. This field is the same
    /// ring slice, kept as the tested statement of that contract.
    pub scrollback: Vec<u8>,
    /// Total stream length — the `scrollbackBytes` field of `pty.attached`.
    pub scrollback_bytes: u64,
    pub cwd: String,
}

/// Sessions keyed by ptyId, plus the persistence root.
pub struct PtyManager {
    base_dir: PathBuf,
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        PtyManager {
            base_dir: base_dir.into(),
            sessions: HashMap::new(),
        }
    }

    /// The persistence root, exposed for tests that plant persisted contexts.
    #[cfg(test)]
    pub fn base_dir_for_tests(&self) -> &Path {
        &self.base_dir
    }

    /// `$HOME/.suma/pty` — the production persistence root (§8.5).
    pub fn default_base() -> PathBuf {
        let home = std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into());
        PathBuf::from(home).join(".suma").join("pty")
    }

    fn dir_for(&self, pty_id: &str) -> PathBuf {
        self.base_dir.join(pty_id)
    }

    /// PTY ids become directory names, so anything path-ambiguous is refused
    /// before it can escape the persistence root.
    fn check_id(pty_id: &str) -> anyhow::Result<()> {
        let ok = !pty_id.is_empty()
            && pty_id.len() <= 128
            && pty_id != "."
            && pty_id != ".."
            && pty_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if ok {
            Ok(())
        } else {
            bail!("invalid pty id");
        }
    }

    pub fn spawn(&mut self, params: SpawnParams) -> anyhow::Result<()> {
        Self::check_id(&params.pty_id)?;
        if self.sessions.contains_key(&params.pty_id) {
            bail!("pty {} already exists", params.pty_id);
        }

        let cwd = params
            .cwd
            .clone()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let pair = native_pty_system().openpty(PtySize {
            rows: params.rows,
            cols: params.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        if let Some(command) = &params.command {
            cmd.args(["-c", command]);
        }
        cmd.cwd(&cwd);
        if let Some(env) = &params.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;

        // Persist context immediately: the whole point is surviving an
        // unplanned cold boot, so nothing waits for a graceful shutdown.
        let dir = self.dir_for(&params.pty_id);
        let mut history = Vec::new();
        if let Some(command) = &params.command {
            history.push(command.clone());
        }
        persist_meta(
            &dir,
            &PtyMeta {
                cwd: cwd.clone(),
                command: params.command.clone(),
                history,
            },
        )?;

        let ring = Arc::new(Mutex::new(Scrollback::with_default_cap()));
        let ring_writer = Arc::clone(&ring);
        let (output, _) = broadcast::channel(PTY_OUTPUT_LAG_CAPACITY);
        let output_writer = output.clone();
        // portable-pty readers are blocking; a dedicated OS thread pumps
        // output into the ring, the append-only on-disk mirror, and every
        // attached mux connection. The thread ends when the master side closes
        // (kill/exit/manager drop).
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // The ring is updated first so `end_offset` is read
                        // under the same lock that assigned it: two chunks can
                        // never be published with offsets that disagree with
                        // the order they entered the scrollback.
                        let end_offset = {
                            let mut ring = ring_writer.lock().expect("scrollback lock poisoned");
                            ring.push(&buf[..n]);
                            ring.total_bytes()
                        };
                        let _ = append_scrollback(&dir, &buf[..n]);
                        // Err simply means nobody is attached right now — the
                        // bytes are already durable in the ring and on disk,
                        // and the next attach replays them.
                        let _ = output_writer.send(PtyOutput {
                            end_offset,
                            data: Arc::new(buf[..n].to_vec()),
                        });
                    }
                }
            }
        });

        self.sessions.insert(
            params.pty_id,
            PtySession {
                master: pair.master,
                child,
                writer,
                ring,
                output,
                cwd,
                command: params.command,
            },
        );
        Ok(())
    }

    pub fn write_input(&mut self, pty_id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get_mut(pty_id)
            .ok_or_else(|| anyhow!("unknown pty {pty_id}"))?;
        session.writer.write_all(data)?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, pty_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get_mut(pty_id)
            .ok_or_else(|| anyhow!("unknown pty {pty_id}"))?;
        session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&mut self, pty_id: &str, signal: Option<PtySignal>) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get_mut(pty_id)
            .ok_or_else(|| anyhow!("unknown pty {pty_id}"))?;
        let signal = signal.unwrap_or(PtySignal::Term);
        match session.child.process_id() {
            Some(pid) => {
                let sig = match signal {
                    PtySignal::Term => libc::SIGTERM,
                    PtySignal::Kill => libc::SIGKILL,
                    PtySignal::Int => libc::SIGINT,
                };
                // Safety: sending a signal to a pid we spawned; worst case the
                // pid is already gone and kill(2) returns ESRCH.
                let rc = unsafe { libc::kill(pid as i32, sig) };
                if rc != 0 {
                    session.child.kill()?;
                }
            }
            None => session.child.kill()?,
        }
        Ok(())
    }

    /// Reattach. `resumed` when the live process is still in the table (and
    /// still alive); `reconstructed` when only the persisted context was
    /// found. Never pretends a dead process is running — an exited session is
    /// reaped and reported as reconstructed, because that is what it is.
    pub fn attach(&mut self, pty_id: &str, since_byte: u64) -> anyhow::Result<AttachResult> {
        Self::check_id(pty_id)?;

        let exited = match self.sessions.get_mut(pty_id) {
            Some(session) => session.child.try_wait()?.is_some(),
            None => false,
        };
        if exited {
            self.sessions.remove(pty_id);
        }

        if let Some(session) = self.sessions.get(pty_id) {
            let ring = session.ring.lock().expect("scrollback lock poisoned");
            return Ok(AttachResult {
                restore: PtyRestoreKind::Resumed,
                scrollback: ring.bytes_since(since_byte),
                scrollback_bytes: ring.total_bytes(),
                cwd: session.cwd.clone(),
            });
        }

        let dir = self.dir_for(pty_id);
        let (meta, bytes) = load_context(&dir).ok_or_else(|| {
            anyhow!("unknown pty {pty_id}: no live session, no persisted context")
        })?;
        // Rebuild the ring from the on-disk stream; the cap applies exactly
        // as it would have live, so offsets line up with what a client saw.
        let mut ring = Scrollback::with_default_cap();
        ring.push(&bytes);
        Ok(AttachResult {
            restore: PtyRestoreKind::Reconstructed,
            scrollback: ring.bytes_since(since_byte),
            scrollback_bytes: ring.total_bytes(),
            cwd: meta.cwd,
        })
    }

    /// Every session this agent knows about: live ones, then persisted
    /// contexts a cold boot (or exit) left behind. This is the discovery
    /// primitive for a second device (§8.5 M-2) — without it, a ptyId exists
    /// only in the spawning desktop's memory.
    ///
    /// Exited-but-still-tabled sessions are reaped first, exactly as `attach`
    /// would, so `live` never claims a dead process. Sorted by ptyId so two
    /// devices render the same order.
    pub fn list(&mut self) -> Vec<PtySessionEntry> {
        let mut exited: Vec<String> = Vec::new();
        for (id, session) in self.sessions.iter_mut() {
            if matches!(session.child.try_wait(), Ok(Some(_))) {
                exited.push(id.clone());
            }
        }
        for id in &exited {
            self.sessions.remove(id);
        }

        let mut entries: Vec<PtySessionEntry> = self
            .sessions
            .iter()
            .map(|(id, session)| PtySessionEntry {
                pty_id: id.clone(),
                cwd: session.cwd.clone(),
                command: session.command.clone(),
                live: true,
            })
            .collect();

        // Persisted contexts: every id-named directory with readable meta
        // that has no live session. Unreadable entries are skipped, not
        // errors — a half-written meta.json from a crash must not take the
        // whole listing down.
        if let Ok(dir) = fs::read_dir(&self.base_dir) {
            for entry in dir.flatten() {
                let Ok(pty_id) = entry.file_name().into_string() else {
                    continue;
                };
                if Self::check_id(&pty_id).is_err() || self.sessions.contains_key(&pty_id) {
                    continue;
                }
                let Some((meta, _)) = load_context(&entry.path()) else {
                    continue;
                };
                entries.push(PtySessionEntry {
                    pty_id,
                    cwd: meta.cwd,
                    command: meta.command,
                    live: false,
                });
            }
        }

        entries.sort_by(|a, b| a.pty_id.cmp(&b.pty_id));
        entries
    }

    /// Subscribe to a live session's output. Subscribe *before* reading the
    /// replay: the receiver buffers from this moment, so anything written
    /// between the two calls arrives as a chunk rather than falling in the gap
    /// (the caller discards chunks the replay already covered by
    /// [`PtyOutput::end_offset`]).
    pub fn subscribe(&self, pty_id: &str) -> Option<broadcast::Receiver<PtyOutput>> {
        Some(self.sessions.get(pty_id)?.output.subscribe())
    }

    /// Retained bytes from `since` plus the stream length they run to — the
    /// initial replay for a newly attached channel, and the resync path after
    /// a subscriber falls behind the broadcast. Live sessions only; a
    /// reconstructed session's bytes come back through [`Self::attach`].
    pub fn replay(&self, pty_id: &str, since: u64) -> Option<(Vec<u8>, u64)> {
        let ring = self.sessions.get(pty_id)?.ring.lock().ok()?;
        Some((ring.bytes_since(since), ring.total_bytes()))
    }

    /// Replay for a session whose process is gone but whose context survived.
    /// There is no stream to subscribe to, so this is all a reconstructed
    /// channel will ever receive — the honest counterpart to `reconstructed`
    /// on `pty.attached`. `None` when the session is live (subscribe instead)
    /// or was never persisted.
    pub fn persisted_replay(&self, pty_id: &str) -> Option<Vec<u8>> {
        if self.sessions.contains_key(pty_id) {
            return None;
        }
        Self::check_id(pty_id).ok()?;
        let (_, bytes) = load_context(&self.dir_for(pty_id))?;
        // Through the ring so the cap applies exactly as it did live, and the
        // client sees the same window it would have seen before the boot.
        let mut ring = Scrollback::with_default_cap();
        ring.push(&bytes);
        Some(ring.bytes_since(0))
    }

    pub fn contains(&self, pty_id: &str) -> bool {
        self.sessions.contains_key(pty_id)
    }

    /// `(ptyId, spawn command)` for every live session — the raw material of
    /// the process-tree snapshot in `jobs.rs`.
    pub fn live_entries(&self) -> Vec<(String, Option<String>)> {
        let mut entries: Vec<_> = self
            .sessions
            .iter()
            .map(|(id, s)| (id.clone(), s.command.clone()))
            .collect();
        entries.sort();
        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "suma-agent-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn ring_truncates_by_lines_and_keeps_offsets_stable() {
        let mut ring = Scrollback::new(5);
        for i in 0..20 {
            ring.push(format!("line-{i:02}\n").as_bytes());
        }
        assert_eq!(ring.line_count(), 5);
        // 20 lines of 8 bytes each; 15 evicted.
        assert_eq!(ring.total_bytes(), 160);
        assert_eq!(ring.base_offset(), 120);
        let text = String::from_utf8(ring.bytes_since(0)).unwrap();
        assert_eq!(text, "line-15\nline-16\nline-17\nline-18\nline-19\n");
        // An offset inside the retained window slices mid-stream.
        let tail = String::from_utf8(ring.bytes_since(152)).unwrap();
        assert_eq!(tail, "line-19\n");
        // An offset past the end yields nothing.
        assert!(ring.bytes_since(160).is_empty());
    }

    #[test]
    fn ring_keeps_partial_lines_and_split_pushes() {
        let mut ring = Scrollback::new(10);
        ring.push(b"hel");
        ring.push(b"lo\nwor");
        assert_eq!(ring.bytes_since(0), b"hello\nwor");
        assert_eq!(ring.total_bytes(), 9);
    }

    #[test]
    fn production_cap_is_100k_lines() {
        // §8.5 names the number; the constant and the TS side must agree.
        assert_eq!(PTY_SCROLLBACK_LINES, 100_000);
        assert_eq!(Scrollback::with_default_cap().max_lines, 100_000);
    }

    #[test]
    fn persisted_context_round_trips() {
        let dir = test_dir("persist");
        let meta = PtyMeta {
            cwd: "/home/u/project".into(),
            command: Some("npm run build".into()),
            history: vec!["npm run build".into()],
        };
        persist_meta(&dir, &meta).unwrap();
        append_scrollback(&dir, b"compiling...\n").unwrap();
        append_scrollback(&dir, b"done in 3.2s\n").unwrap();

        let (loaded, bytes) = load_context(&dir).unwrap();
        assert_eq!(loaded, meta);
        assert_eq!(bytes, b"compiling...\ndone in 3.2s\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn attach_reconstructs_from_disk_when_no_process_exists() {
        let base = test_dir("reconstruct");
        let dir = base.join("term-1");
        persist_meta(
            &dir,
            &PtyMeta {
                cwd: "/home/u".into(),
                command: None,
                history: vec![],
            },
        )
        .unwrap();
        append_scrollback(&dir, b"$ echo hello\nhello\n").unwrap();

        // A fresh manager — as after a cold boot — has no live sessions.
        let mut mgr = PtyManager::new(&base);
        let attach = mgr.attach("term-1", 0).unwrap();
        assert_eq!(attach.restore, PtyRestoreKind::Reconstructed);
        assert_eq!(attach.cwd, "/home/u");
        assert_eq!(attach.scrollback, b"$ echo hello\nhello\n");
        assert_eq!(attach.scrollback_bytes, 19);

        // since_byte replays only the missing suffix.
        let attach = mgr.attach("term-1", 13).unwrap();
        assert_eq!(attach.scrollback, b"hello\n");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn attach_resumes_a_live_session() {
        let base = test_dir("resume");
        let mut mgr = PtyManager::new(&base);
        mgr.spawn(SpawnParams {
            pty_id: "live-1".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            // cat blocks on its pty stdin forever: alive until killed.
            command: Some("cat".into()),
            cols: 80,
            rows: 24,
            env: None,
        })
        .unwrap();

        let attach = mgr.attach("live-1", 0).unwrap();
        assert_eq!(attach.restore, PtyRestoreKind::Resumed);

        mgr.kill("live-1", Some(PtySignal::Kill)).unwrap();
        // Reap: after the child exits, attach must stop claiming "resumed".
        let mut reaped = false;
        for _ in 0..200 {
            let a = mgr.attach("live-1", 0).unwrap();
            if a.restore == PtyRestoreKind::Reconstructed {
                reaped = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(reaped, "killed pty must eventually attach as reconstructed");
        fs::remove_dir_all(&base).unwrap();
    }

    /// Poll a blocking-thread-fed condition; PTY output crosses an OS thread,
    /// so there is nothing to await in a sync test.
    fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
        for _ in 0..400 {
            if let Some(v) = f() {
                return v;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("condition never held");
    }

    #[test]
    fn subscribers_receive_live_output_tagged_with_stream_offsets() {
        let base = test_dir("subscribe");
        let mut mgr = PtyManager::new(&base);
        mgr.spawn(SpawnParams {
            pty_id: "live-out".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            command: Some("cat".into()),
            cols: 80,
            rows: 24,
            env: None,
        })
        .unwrap();

        // Subscribe first: the receiver only carries what is published after it
        // exists, which is precisely why the pump subscribes before replaying.
        let mut rx = mgr.subscribe("live-out").unwrap();
        mgr.write_input("live-out", b"ping\n").unwrap();

        let mut seen = Vec::new();
        let chunk = wait_for(|| {
            while let Ok(chunk) = rx.try_recv() {
                // Every chunk's offset must account for its own bytes.
                assert!(chunk.end_offset >= chunk.data.len() as u64);
                seen.extend_from_slice(&chunk.data);
                if seen.windows(4).any(|w| w == b"ping") {
                    return Some(chunk);
                }
            }
            None
        });
        // The offset is the stream length, so it covers everything seen so far.
        assert!(chunk.end_offset >= seen.len() as u64);

        mgr.kill("live-out", Some(PtySignal::Kill)).unwrap();
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn replay_returns_retained_bytes_and_the_stream_length() {
        let base = test_dir("replay");
        let mut mgr = PtyManager::new(&base);
        mgr.spawn(SpawnParams {
            pty_id: "replay-1".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            command: Some("echo hello".into()),
            cols: 80,
            rows: 24,
            env: None,
        })
        .unwrap();

        let (bytes, total) = wait_for(|| {
            let (bytes, total) = mgr.replay("replay-1", 0)?;
            bytes
                .windows(5)
                .any(|w| w == b"hello")
                .then_some((bytes, total))
        });
        // Nothing evicted at this size, so a replay from 0 is the whole stream.
        assert_eq!(total, bytes.len() as u64);

        // A mid-stream offset yields only the suffix — the resync path after a
        // subscriber lags.
        let (suffix, _) = mgr.replay("replay-1", 2).unwrap();
        assert_eq!(suffix, &bytes[2..]);

        assert!(mgr.replay("no-such-pty", 0).is_none());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn persisted_replay_serves_reconstructed_sessions_only() {
        let base = test_dir("persisted-replay");
        let dir = base.join("cold-1");
        persist_meta(
            &dir,
            &PtyMeta {
                cwd: "/home/u".into(),
                command: None,
                history: vec![],
            },
        )
        .unwrap();
        append_scrollback(&dir, b"$ echo hello\nhello\n").unwrap();

        // Fresh manager, as after a cold boot: no live session to subscribe to,
        // so the persisted bytes are the whole of what the channel can carry.
        let mut mgr = PtyManager::new(&base);
        assert_eq!(
            mgr.persisted_replay("cold-1").unwrap(),
            b"$ echo hello\nhello\n"
        );
        assert!(mgr.subscribe("cold-1").is_none());

        // A live session is served by the subscription instead, so this path
        // must decline rather than serve a stale duplicate.
        mgr.spawn(SpawnParams {
            pty_id: "live-2".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            command: Some("cat".into()),
            cols: 80,
            rows: 24,
            env: None,
        })
        .unwrap();
        assert!(mgr.persisted_replay("live-2").is_none());

        assert!(mgr.persisted_replay("never-existed").is_none());
        assert!(mgr.persisted_replay("../escape").is_none());

        mgr.kill("live-2", Some(PtySignal::Kill)).unwrap();
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn attach_of_a_never_seen_pty_fails() {
        let base = test_dir("missing");
        let mut mgr = PtyManager::new(base);
        assert!(mgr.attach("nope", 0).is_err());
    }

    #[test]
    fn path_escaping_pty_ids_are_refused() {
        let base = test_dir("escape");
        let mut mgr = PtyManager::new(base);
        for id in ["../evil", "a/b", "..", ".", "", "a b"] {
            assert!(
                mgr.spawn(SpawnParams {
                    pty_id: id.into(),
                    cwd: None,
                    command: Some("true".into()),
                    cols: 80,
                    rows: 24,
                    env: None,
                })
                .is_err(),
                "{id:?} must be refused"
            );
            assert!(mgr.attach(id, 0).is_err(), "{id:?} must be refused");
        }
    }
}
