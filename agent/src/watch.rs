//! Files-root change detection — the producer behind unsolicited
//! `vfs.changed` ctl events.
//!
//! No OS watcher crate: the workspace's Rust 1.79 toolchain makes every new
//! dependency a negotiation (see the blake3 pin), and a 2-second poll over a
//! tree already bounded by the vfs caps is cheap where it runs — a VM whose
//! whole job is this user's files. The scan digests every entry's name,
//! kind, length, and mtime into one blake3 hash; a changed digest means
//! "something changed", and that is all the event says (`paths: None`) —
//! diffing two capped scans to name the paths buys little when the client's
//! answer is a re-list either way.
//!
//! Zero-subscriber scans are skipped entirely: an idle agent (no desktop
//! connected, or none that sent a ctl frame) does not touch the disk. The
//! first scan after a subscriber appears only PRIMES the digest — emitting
//! on it would fire a spurious "changed" at every agent boot.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::proto::AgentCtlResponse;
use crate::vfs::{
    VfsRoot, VFS_MAX_TREE_DEPTH, VFS_MAX_TREE_ENTRIES, VFS_TREE_SKIPPED_DIRS,
    VFS_TREE_SKIPPED_FILES,
};

/// How often the root is re-scanned while anyone is subscribed.
pub const WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// Buffered events per subscriber. Watch events are collapsible — a lagged
/// subscriber that missed three "changed" signals needs exactly one re-list —
/// so a tiny buffer is correct, not stingy.
pub const WATCH_BUS_CAPACITY: usize = 16;

/// Run the watcher forever: scan on an interval, publish `vfs.changed` on
/// digest change. Spawn once per agent process.
pub async fn run(root: VfsRoot, bus: broadcast::Sender<AgentCtlResponse>) {
    let mut interval = tokio::time::interval(WATCH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut previous: Option<[u8; 32]> = None;
    loop {
        interval.tick().await;
        if bus.receiver_count() == 0 {
            // Nobody listening ⇒ nothing scanned, and the digest is dropped:
            // the first scan after a subscriber returns must PRIME, not
            // emit, or a change that happened while idle fires an event
            // nobody asked about into a fresh subscriber's initial list.
            previous = None;
            continue;
        }
        let path = root.path().to_path_buf();
        let digest = match tokio::task::spawn_blocking(move || scan_digest(&path)).await {
            Ok(digest) => digest,
            Err(_) => continue, // scan task panicked/cancelled — skip the tick
        };
        let changed = previous.is_some_and(|prev| prev != digest);
        previous = Some(digest);
        if changed {
            let _ = bus.send(AgentCtlResponse::VfsChanged { paths: None });
        }
    }
}

/// One deterministic digest of the tree's metadata, bounded by the vfs tree
/// caps so a runaway directory cannot turn the watcher into a disk scan.
/// A missing root digests as empty — the root may be created later.
pub fn scan_digest(root: &Path) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    let mut entries: usize = 0;
    // Sorted DFS: readdir order is arbitrary, and an order-sensitive digest
    // would "change" without anything changing.
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if entries >= VFS_MAX_TREE_ENTRIES {
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            // Unreadable (or missing) directory — skipped, like the tree
            // walk, but still closed with the boundary marker so a missing
            // root and an empty root digest identically.
            hasher.update(b"\0");
            continue;
        };
        let mut names: Vec<(String, PathBuf)> = read
            .filter_map(|entry| entry.ok())
            .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
            .collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path) in names {
            if entries >= VFS_MAX_TREE_ENTRIES {
                break;
            }
            // symlink_metadata: links are hashed as their own entry, never
            // followed — same rule as the tree walk.
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            let file_type = metadata.file_type();
            if file_type.is_dir() {
                if VFS_TREE_SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                entries += 1;
                hasher.update(name.as_bytes());
                hasher.update(b"/d");
                if depth + 1 <= VFS_MAX_TREE_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if file_type.is_file() {
                if VFS_TREE_SKIPPED_FILES.contains(&name.as_str()) {
                    continue;
                }
                entries += 1;
                hasher.update(name.as_bytes());
                hasher.update(b"/f");
                hasher.update(&metadata.len().to_le_bytes());
                hasher.update(&mtime_millis(&metadata).to_le_bytes());
            }
            // Sockets/devices/symlinks: omitted, matching vfs.tree.
        }
        // Directory boundary marker, so `a/b` + `c` never hashes like
        // `a` + `b/c`.
        hasher.update(b"\0");
    }
    *hasher.finalize().as_bytes()
}

fn mtime_millis(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "suma-watch-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn digest_is_stable_across_noop_rescans_and_moves_on_change() {
        let root = temp_root("digest");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "one").unwrap();

        let first = scan_digest(&root);
        assert_eq!(first, scan_digest(&root), "no-op rescan must be stable");

        // Content change (same length would still move mtime; use both).
        std::fs::write(root.join("src/a.txt"), "twoo").unwrap();
        let second = scan_digest(&root);
        assert_ne!(first, second, "a modified file must change the digest");

        // Create.
        std::fs::write(root.join("src/b.txt"), "x").unwrap();
        let third = scan_digest(&root);
        assert_ne!(second, third);

        // Delete.
        std::fs::remove_file(root.join("src/b.txt")).unwrap();
        // (May equal `second` — same tree shape; the mtimes of a.txt differ
        // from `first`, so compare against third only.)
        assert_ne!(third, scan_digest(&root));

        // Rename.
        std::fs::rename(root.join("src/a.txt"), root.join("src/c.txt")).unwrap();
        let renamed = scan_digest(&root);
        assert_ne!(renamed, third);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skipped_dirs_and_files_do_not_affect_the_digest() {
        let root = temp_root("skips");
        std::fs::write(root.join("kept.txt"), "x").unwrap();
        let before = scan_digest(&root);

        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "junk").unwrap();
        std::fs::write(root.join(".DS_Store"), "junk").unwrap();
        assert_eq!(before, scan_digest(&root));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_root_digests_as_empty_and_caps_bound_the_walk() {
        let missing = std::env::temp_dir().join("suma-watch-missing-never-created");
        let empty = temp_root("empty");
        assert_eq!(scan_digest(&missing), scan_digest(&empty));

        // A chain deeper than the cap stops descending instead of walking it.
        let deep = temp_root("deep");
        let mut cursor = deep.clone();
        for i in 0..(VFS_MAX_TREE_DEPTH + 3) {
            cursor = cursor.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&cursor).unwrap();
        std::fs::write(cursor.join("bottom.txt"), "x").unwrap();
        let capped = scan_digest(&deep);
        // Changing the file BELOW the cap does not move the digest.
        std::fs::write(cursor.join("bottom.txt"), "yy").unwrap();
        assert_eq!(capped, scan_digest(&deep));

        std::fs::remove_dir_all(&empty).unwrap();
        std::fs::remove_dir_all(&deep).unwrap();
    }

    #[tokio::test]
    async fn run_skips_scans_with_no_subscribers_and_emits_on_change() {
        tokio::time::pause();
        let root_dir = temp_root("run");
        let root = VfsRoot::new(root_dir.clone());
        let (bus, _keepalive) = broadcast::channel::<AgentCtlResponse>(WATCH_BUS_CAPACITY);
        // _keepalive is dropped immediately below so receiver_count is 0.
        drop(_keepalive);
        let bus_for_task = bus.clone();
        let task = tokio::spawn(run(root, bus_for_task));

        // No subscribers: ticks pass, nothing scanned or sent (observable as
        // "a change made while idle produces no event once we subscribe").
        tokio::time::advance(WATCH_INTERVAL * 3).await;
        std::fs::write(root_dir.join("made-while-idle.txt"), "x").unwrap();
        tokio::time::advance(WATCH_INTERVAL).await;

        let mut rx = bus.subscribe();
        // First scan after subscribing primes the digest — no event yet.
        tokio::time::advance(WATCH_INTERVAL * 2).await;
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        // A real change now emits.
        std::fs::write(root_dir.join("fresh.txt"), "y").unwrap();
        let event = loop {
            tokio::time::advance(WATCH_INTERVAL).await;
            tokio::task::yield_now().await;
            match rx.try_recv() {
                Ok(event) => break event,
                Err(broadcast::error::TryRecvError::Empty) => continue,
                Err(other) => panic!("{other:?}"),
            }
        };
        assert!(matches!(event, AgentCtlResponse::VfsChanged { paths: None }));

        task.abort();
        std::fs::remove_dir_all(&root_dir).unwrap();
    }
}
