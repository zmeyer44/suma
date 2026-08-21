//! ctl dispatch and the PTY data channel — where I-2 is enforced.
//!
//! Every ctl request follows the same shape: look up the required capability
//! in the authorization table ([`crate::caps::required_capability`]), check the
//! token, and **fail closed** — a refusal returns an `error` response before
//! any handler code runs, so there is no path on which an unauthorized
//! operation has a side effect. The check is per-request, not per-connection:
//! tokens are short-lived (300 s) and a long-lived mux connection must not
//! outlive the authority it connected with.
//!
//! PTY bytes do not travel on ctl — they have their own `pty/<id>` channel —
//! so gating [`dispatch`] alone would leave keystrokes ungated: anything that
//! reached the mux could type into every live shell with no capability at all.
//! [`pty_input`] is that channel's enforcement point, with the same per-frame
//! check against the same claims.

use crate::caps::{check_capability, required_capability, Capability, CapabilityClaims};
use crate::fetch::{fetch_public, FetchSpec};
use crate::jobs::JobRegistry;
use crate::ports::{list_ports, PortSource};
use crate::proto::{AgentCtlRequest, AgentCtlResponse, FETCH_CANCELLED_ERROR};
use crate::pty::{PtyManager, SpawnParams};
use crate::vfs::VfsRoot;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Notify, Semaphore};

/// Concurrent background fetches, agent-wide. Requests past the cap queue
/// fairly on the semaphore rather than being refused — a third download is
/// late, never lost.
static FETCH_SEMAPHORE: Semaphore = Semaphore::const_new(2);
static FETCH_STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A private sibling of the promised destination. The fetcher opens it with
/// `create_new`; completion hard-links it into place, which is an atomic
/// no-overwrite commit on every supported host filesystem.
fn fetch_staging_path(target: &std::path::Path) -> std::path::PathBuf {
    let sequence = FETCH_STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    target.with_file_name(format!(
        ".suma-fetch-{}-{nonce}-{sequence}.partial",
        std::process::id()
    ))
}

async fn commit_fetch(staging: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    let linked = tokio::fs::hard_link(staging, target).await;
    let _ = tokio::fs::remove_file(staging).await;
    linked
}

/// The connection's ctl event sender — how a handler (or a background task it
/// spawned) puts an UNSOLICITED frame on the wire. Clonable so a spawned
/// fetch outlives the dispatch call that started it.
///
/// Invariant: unsolicited frames must never be the `error` variant — the
/// desktop's ctl FIFO resolves its pending head on any `error`, so a stray
/// one would steal an unrelated request's response. Async failures use typed
/// events (`fetch.failed`). Send failures are ignored: a closed receiver
/// means the connection is gone, and there is no one left to tell.
#[derive(Clone)]
pub struct CtlEvents(pub tokio::sync::mpsc::UnboundedSender<AgentCtlResponse>);

impl CtlEvents {
    pub fn send(&self, response: AgentCtlResponse) {
        debug_assert!(
            !matches!(response, AgentCtlResponse::Error { .. }),
            "unsolicited ctl frames must never be `error` (FIFO invariant)"
        );
        let _ = self.0.send(response);
    }
}

/// Everything the ctl handlers operate on.
pub struct AgentState {
    pub ptys: PtyManager,
    pub jobs: JobRegistry,
    pub ports: Box<dyn PortSource>,
    /// Where a `fetch.public` is allowed to land. Held here because a fetch is
    /// a write into the Files tree and must obey the same root confinement as
    /// the `vfs` channel — the root is a path, so a second handle costs
    /// nothing and the `vfs` channel keeps its own outside the state mutex.
    pub vfs_root: VfsRoot,
}

fn error(code: &str, message: impl Into<String>) -> AgentCtlResponse {
    AgentCtlResponse::Error {
        code: code.to_string(),
        message: message.into(),
    }
}

/// Authorize use of a `pty/<id>` channel — **both directions**. Input frames
/// call this before reaching a PTY; an output subscription must call it before
/// the pump starts forwarding, because watching a shell is as sensitive as
/// typing into one.
///
/// `pty.io` is the capability the TS `CTL_CAPABILITY` table already assigns to
/// `pty.attach`, which is how a client asks for the same bytes over ctl. The
/// data channel cannot require less.
///
/// Returns the refusal reason, or `None` when allowed — callers fail closed.
pub fn check_pty_io(
    claims: &CapabilityClaims,
    machine_id: &str,
    now_seconds: i64,
) -> Option<String> {
    check_capability(claims, machine_id, Capability::PtyIo, now_seconds)
}

/// Authorize a `fwd/<port>` stream — dialing a loopback port inside this
/// machine reaches whatever the user is running there, so it takes the same
/// `ports.forward` capability the desktop's port UI already holds. Returns
/// the refusal reason, or `None` when allowed.
pub fn check_fwd(claims: &CapabilityClaims, machine_id: &str, now_seconds: i64) -> Option<String> {
    check_capability(claims, machine_id, Capability::PortsForward, now_seconds)
}

/// Write one `pty/<id>` frame's payload to its PTY, after the capability
/// check. Errors are the ctl `error` shape so a caller that has a response
/// path can forward them verbatim.
pub fn pty_input(
    state: &mut AgentState,
    claims: &CapabilityClaims,
    machine_id: &str,
    now_seconds: i64,
    pty_id: &str,
    data: &[u8],
) -> Result<(), Box<AgentCtlResponse>> {
    // I-2 enforcement point for the PTY channel. Nothing below this line runs
    // without a valid, in-window, machine-bound `pty.io` capability.
    if let Some(reason) = check_pty_io(claims, machine_id, now_seconds) {
        return Err(Box::new(error("capability_denied", reason)));
    }
    state
        .ptys
        .write_input(pty_id, data)
        .map_err(|e| Box::new(error("pty_write_failed", e.to_string())))
}

/// Handle one ctl request. Unsolicited events (`fetch.progress`,
/// `fetch.done`, `fetch.failed`, `vfs.changed`) go through `events` — a
/// clonable sender, because a background fetch outlives this call; the
/// returned value, if any, is the request's terminal response. `pty.resize`
/// and `pty.kill` return nothing on success.
pub async fn dispatch(
    state: &mut AgentState,
    claims: &CapabilityClaims,
    machine_id: &str,
    now_seconds: i64,
    request: AgentCtlRequest,
    events: &CtlEvents,
) -> Option<AgentCtlResponse> {
    // I-2 enforcement point. Nothing below this line runs without a valid,
    // in-window, machine-bound capability naming this exact operation.
    let cap = required_capability(&request);
    if let Some(reason) = check_capability(claims, machine_id, cap, now_seconds) {
        return Some(error("capability_denied", reason));
    }
    if let Err(reason) = request.validate() {
        return Some(error("invalid_request", reason));
    }

    match request {
        AgentCtlRequest::PtySpawn {
            pty_id,
            cwd,
            command,
            cols,
            rows,
            env,
        } => {
            let result = state.ptys.spawn(SpawnParams {
                pty_id: pty_id.clone(),
                cwd,
                command,
                cols,
                rows,
                env,
            });
            Some(match result {
                Ok(()) => AgentCtlResponse::PtySpawned { pty_id },
                Err(e) => error("pty_spawn_failed", e.to_string()),
            })
        }
        AgentCtlRequest::PtyResize { pty_id, cols, rows } => {
            match state.ptys.resize(&pty_id, cols, rows) {
                Ok(()) => None,
                Err(e) => Some(error("pty_resize_failed", e.to_string())),
            }
        }
        AgentCtlRequest::PtyKill { pty_id, signal } => match state.ptys.kill(&pty_id, signal) {
            Ok(()) => None,
            Err(e) => Some(error("pty_kill_failed", e.to_string())),
        },
        AgentCtlRequest::PtyAttach {
            pty_id,
            since_byte,
            cols,
            rows,
        } => {
            let size = cols.zip(rows);
            match state.ptys.attach(&pty_id, since_byte.unwrap_or(0), size) {
                Ok(attach) => Some(AgentCtlResponse::PtyAttached {
                    pty_id,
                    restore: attach.restore,
                    scrollback_bytes: attach.scrollback_bytes,
                    cwd: attach.cwd,
                }),
                Err(e) => Some(error("pty_attach_failed", e.to_string())),
            }
        }
        AgentCtlRequest::JobSet {
            pty_id,
            enabled,
            label,
        } => {
            let (pty_id, enabled) = state.jobs.set_job_mode(&pty_id, enabled, label);
            Some(AgentCtlResponse::JobAck { pty_id, enabled })
        }
        AgentCtlRequest::PtyList => Some(AgentCtlResponse::PtyListing {
            sessions: state.ptys.list(),
        }),
        AgentCtlRequest::PortsList => Some(match list_ports(state.ports.as_ref()) {
            Ok(ports) => AgentCtlResponse::Ports { ports },
            Err(e) => error("ports_list_failed", e.to_string()),
        }),
        AgentCtlRequest::FetchPublic {
            fetch_id,
            url,
            dest_path,
        } => {
            // `destPath` names a place in Suma Files (`/Downloads/big.zip`),
            // exactly as the control plane records it for a transfer, so it is
            // resolved against `~/cloud` with the traversal and symlink checks
            // every `vfs` path gets. Handing the raw string to `File::create`
            // — which is what happened before — made a `fetch.public` token a
            // write primitive over the whole volume, `~/.ssh/authorized_keys`
            // included, without any `fs.write` capability. Only `~/cloud` is
            // reachable through this agent at all (§8.6).
            let (path, target) = match state.vfs_root.resolve_new_file(&dest_path) {
                Ok(resolved) => resolved,
                Err(reason) => return Some(error("vfs_path_refused", reason)),
            };
            let staging = fetch_staging_path(&target);
            let spec = FetchSpec {
                fetch_id: fetch_id.clone(),
                url: url.clone(),
                dest_path: staging.clone(),
            };
            // The fetch runs as a background task: an 8 GiB download must not
            // hold the state lock (it would freeze every connection's ctl and
            // pty input), and the caller gets `fetch.started` NOW — awaiting
            // `fetch.done` here would desync the client's ctl FIFO the moment
            // a later request was answered first. Completion and failure are
            // unsolicited events, correlated by fetchId.
            let Some(cancel) = register_fetch(&fetch_id) else {
                return Some(error(
                    "fetch_exists",
                    format!("fetch {fetch_id} is already active"),
                ));
            };
            let events = events.clone();
            let event_path = path.clone();
            tokio::spawn(async move {
                let mut emit = |resp: AgentCtlResponse| events.send(resp);
                // select! wraps BOTH the queue wait and the download, so a
                // cancel lands while the fetch is still waiting on a permit
                // as readily as mid-transfer.
                let run = async {
                    let _permit = FETCH_SEMAPHORE
                        .acquire()
                        .await
                        .expect("static semaphore is never closed");
                    fetch_public(&spec, &mut emit).await
                };
                tokio::select! {
                    outcome = run => match outcome {
                        Ok(outcome) => match commit_fetch(&staging, &target).await {
                            Ok(()) => {
                                events.send(AgentCtlResponse::FetchDone {
                                    fetch_id: spec.fetch_id.clone(),
                                    url: spec.url.clone(),
                                    // The Files path the caller asked for, not the host
                                    // path it landed on: where `~/cloud` sits in the VM is
                                    // not the caller's business, and a Files path is what
                                    // a client can do something with.
                                    path: event_path,
                                    bytes: outcome.bytes,
                                    // The manifest rides along so the control plane can
                                    // record the file's chunks without a second round
                                    // trip (§8.6).
                                    manifest: Some(outcome.manifest),
                                });
                            }
                            Err(e) => {
                                events.send(AgentCtlResponse::FetchFailed {
                                    fetch_id: spec.fetch_id.clone(),
                                    url: spec.url.clone(),
                                    path: event_path,
                                    error: format!("committing fetched file: {e}"),
                                });
                            }
                        },
                        Err(e) => {
                            // Remove only this fetch's private staging name, never
                            // the promised destination (which may predate us).
                            let _ = tokio::fs::remove_file(&staging).await;
                            events.send(AgentCtlResponse::FetchFailed {
                                fetch_id: spec.fetch_id.clone(),
                                url: spec.url.clone(),
                                path: event_path,
                                error: e.to_string(),
                            });
                        }
                    },
                    _ = cancel.notified() => {
                        // The download future is dropped mid-await; only its
                        // private staging name needs cleaning.
                        let _ = tokio::fs::remove_file(&staging).await;
                        events.send(AgentCtlResponse::FetchFailed {
                            fetch_id: spec.fetch_id.clone(),
                            url: spec.url.clone(),
                            path: event_path,
                            error: FETCH_CANCELLED_ERROR.to_string(),
                        });
                    }
                }
                unregister_fetch(&spec.fetch_id, &cancel);
            });
            Some(AgentCtlResponse::FetchStarted {
                fetch_id,
                url,
                path,
            })
        }
        AgentCtlRequest::FetchCancel { fetch_id } => {
            // Fire-and-forget, like pty.kill: no response frame. Unknown ids
            // and double-cancels are silent no-ops — the caller learns the
            // outcome from the fetch.failed(cancelled) event, or from the
            // fetch having already settled.
            cancel_fetch(&fetch_id);
            None
        }
    }
}

/* ------------------------------------------------------------------ *
 * Running-fetch registry (cancellation)
 * ------------------------------------------------------------------ */

/// fetchId → cancel signal for every in-flight (or queued) fetch. A std
/// Mutex, never held across an await — entries are inserted before the task
/// spawns and removed on any terminal outcome.
static FETCHES: std::sync::Mutex<Option<HashMap<String, Arc<Notify>>>> =
    std::sync::Mutex::new(None);

fn register_fetch(fetch_id: &str) -> Option<Arc<Notify>> {
    let cancel = Arc::new(Notify::new());
    let mut fetches = FETCHES.lock().expect("fetch registry poisoned");
    let map = fetches.get_or_insert_with(HashMap::new);
    if map.contains_key(fetch_id) {
        return None;
    }
    map.insert(fetch_id.to_string(), Arc::clone(&cancel));
    Some(cancel)
}

fn unregister_fetch(fetch_id: &str, cancel: &Arc<Notify>) {
    let mut fetches = FETCHES.lock().expect("fetch registry poisoned");
    if let Some(map) = fetches.as_mut() {
        if map
            .get(fetch_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, cancel))
        {
            map.remove(fetch_id);
        }
    }
}

fn cancel_fetch(fetch_id: &str) {
    let fetches = FETCHES.lock().expect("fetch registry poisoned");
    if let Some(cancel) = fetches.as_ref().and_then(|map| map.get(fetch_id)) {
        // notify_waiters would miss a task not yet parked on notified();
        // notify_one leaves a permit, so the signal is never lost.
        cancel.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caps::{Capability, CapabilityClaims};
    use crate::ports::tests::FixtureSource;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "suma-dispatch-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn state() -> AgentState {
        let files = temp_dir("files");
        std::fs::create_dir_all(&files).unwrap();
        AgentState {
            ptys: PtyManager::new(temp_dir("pty")),
            jobs: JobRegistry::default(),
            ports: Box::new(FixtureSource),
            vfs_root: VfsRoot::new(files),
        }
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

    /// A CtlEvents whose receiver the test can drain; `no_events()` keeps the
    /// receiver alive so an unexpected send is observable rather than lost.
    fn events() -> (
        CtlEvents,
        tokio::sync::mpsc::UnboundedReceiver<AgentCtlResponse>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (CtlEvents(tx), rx)
    }

    fn no_events() -> CtlEvents {
        // The receiver is dropped on purpose: sends become no-ops, and the
        // tests using this helper assert on the RETURNED response only.
        events().0
    }

    #[tokio::test]
    async fn denied_capability_is_an_error_and_has_no_side_effect() {
        let mut st = state();
        let c = claims(vec![]); // nothing granted
        let req: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"job.set","ptyId":"t1","enabled":true}"#).unwrap();
        let resp = dispatch(&mut st, &c, "m-1", 1_100, req, &no_events())
            .await
            .unwrap();
        match resp {
            AgentCtlResponse::Error { code, message } => {
                assert_eq!(code, "capability_denied");
                assert_eq!(message, "capability pty.spawn not granted");
            }
            other => panic!("expected error, got {other:?}"),
        }
        // Fail closed means *no side effect*: the registry never saw the set.
        assert!(!st.jobs.get("t1").job_mode);
    }

    #[tokio::test]
    async fn wrong_machine_and_expired_tokens_are_refused() {
        let mut st = state();
        let c = claims(vec![Capability::PortsList]);
        let req: AgentCtlRequest = serde_json::from_str(r#"{"t":"ports.list"}"#).unwrap();

        let resp = dispatch(
            &mut st,
            &c,
            "other-machine",
            1_100,
            req.clone(),
            &no_events(),
        )
        .await
        .unwrap();
        assert!(matches!(
            resp,
            AgentCtlResponse::Error { ref message, .. }
                if message == "token is bound to a different machine"
        ));

        let resp = dispatch(&mut st, &c, "m-1", 9_999, req, &no_events())
            .await
            .unwrap();
        assert!(matches!(
            resp,
            AgentCtlResponse::Error { ref message, .. } if message == "capability token expired"
        ));
    }

    #[tokio::test]
    async fn granted_capability_executes_the_operation() {
        let mut st = state();
        let c = claims(vec![Capability::PortsList]);
        let req: AgentCtlRequest = serde_json::from_str(r#"{"t":"ports.list"}"#).unwrap();
        let resp = dispatch(&mut st, &c, "m-1", 1_100, req, &no_events())
            .await
            .unwrap();
        match resp {
            AgentCtlResponse::Ports { ports } => {
                assert!(ports.iter().any(|p| p.port == 3000 && p.loopback));
            }
            other => panic!("expected ports, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pty_list_reports_live_and_persisted_sessions_and_is_gated_on_pty_io() {
        let mut st = state();

        // A persisted context with no live process — what a cold boot leaves.
        let dead_dir = st.ptys.base_dir_for_tests().join("dead-1");
        crate::pty::persist_meta(
            &dead_dir,
            &crate::pty::PtyMeta {
                cwd: "/root/old".into(),
                command: Some("npm run build".into()),
                history: vec![],
            },
        )
        .unwrap();

        // And a live shell, spawned through dispatch like a client would.
        let spawn: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"pty.spawn","ptyId":"live-1","cwd":"/","cols":80,"rows":24}"#,
        )
        .unwrap();
        let c = claims(vec![Capability::PtySpawn, Capability::PtyIo]);
        let spawned = dispatch(&mut st, &c, "m-1", 1_100, spawn, &no_events())
            .await
            .unwrap();
        assert!(matches!(spawned, AgentCtlResponse::PtySpawned { .. }));

        let list: AgentCtlRequest = serde_json::from_str(r#"{"t":"pty.list"}"#).unwrap();
        let resp = dispatch(&mut st, &c, "m-1", 1_100, list.clone(), &no_events())
            .await
            .unwrap();
        match resp {
            AgentCtlResponse::PtyListing { sessions } => {
                assert_eq!(sessions.len(), 2);
                // Sorted by ptyId: dead-1 then live-1.
                assert_eq!(sessions[0].pty_id, "dead-1");
                assert!(!sessions[0].live);
                assert_eq!(sessions[0].command.as_deref(), Some("npm run build"));
                assert_eq!(sessions[1].pty_id, "live-1");
                assert!(sessions[1].live);
            }
            other => panic!("expected pty.listing, got {other:?}"),
        }

        // Listing reveals what attach reveals, so it requires what attach
        // requires — pty.io, which these claims lack.
        let weak = claims(vec![Capability::PtySpawn]);
        let denied = dispatch(&mut st, &weak, "m-1", 1_100, list, &no_events())
            .await
            .unwrap();
        assert!(
            matches!(denied, AgentCtlResponse::Error { ref code, .. } if code == "capability_denied")
        );
    }

    #[tokio::test]
    async fn job_set_acks_with_the_wire_shape() {
        let mut st = state();
        let c = claims(vec![Capability::PtySpawn]);
        let req: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"job.set","ptyId":"t1","enabled":true,"label":"run"}"#)
                .unwrap();
        let resp = dispatch(&mut st, &c, "m-1", 1_100, req, &no_events())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&resp).unwrap(),
            r#"{"t":"job.ack","ptyId":"t1","enabled":true}"#
        );
        assert!(st.jobs.get("t1").job_mode);
    }

    /// The `pty/<id>` channel gate, in the four outcomes of `check_capability`
    /// — the hole this closes was that PTY frames reached `write_input` with
    /// no check at all, so any of the first three still typed into the shell.
    #[tokio::test]
    async fn pty_channel_input_is_capability_gated_in_all_four_outcomes() {
        let mut st = state();
        st.ptys
            .spawn(SpawnParams {
                pty_id: "live-1".into(),
                cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                // `cat` blocks on its pty stdin forever: alive until killed.
                command: Some("cat".into()),
                cols: 80,
                rows: 24,
                env: None,
            })
            .unwrap();

        /// Attempt a keystroke and return the refusal reason, insisting the
        /// refusal is the capability one and not an incidental failure.
        fn denied(st: &mut AgentState, c: &CapabilityClaims, mid: &str, now: i64) -> String {
            match pty_input(st, c, mid, now, "live-1", b"whoami\n") {
                Err(err) => match *err {
                    AgentCtlResponse::Error { code, message } => {
                        assert_eq!(code, "capability_denied");
                        message
                    }
                    other => panic!("expected capability_denied, got {other:?}"),
                },
                other => panic!("expected capability_denied, got {other:?}"),
            }
        }

        // 1. Capability not granted — including the unconfigured agent, whose
        //    claims list is empty.
        let c = claims(vec![Capability::PtySpawn, Capability::PtyResize]);
        assert_eq!(
            denied(&mut st, &c, "m-1", 1_100),
            "capability pty.io not granted"
        );
        assert_eq!(
            denied(&mut st, &claims(vec![]), "m-1", 1_100),
            "capability pty.io not granted"
        );

        // 2. Token bound to a different machine.
        let c = claims(vec![Capability::PtyIo]);
        assert_eq!(
            denied(&mut st, &c, "other-machine", 1_100),
            "token is bound to a different machine"
        );

        // 3. Expired token — a live mux connection must not outlive its
        //    authority just because the bytes stopped going through ctl.
        assert_eq!(
            denied(&mut st, &c, "m-1", 9_999),
            "capability token expired"
        );

        // 4. Granted, in window, right machine: the keystrokes land.
        assert!(pty_input(&mut st, &c, "m-1", 1_100, "live-1", b"whoami\n").is_ok());

        // And a granted capability is still not a wildcard over the PTY table.
        match pty_input(&mut st, &c, "m-1", 1_100, "no-such-pty", b"x") {
            Err(err) => match *err {
                AgentCtlResponse::Error { code, .. } => assert_eq!(code, "pty_write_failed"),
                other => panic!("expected pty_write_failed, got {other:?}"),
            },
            other => panic!("expected pty_write_failed, got {other:?}"),
        }

        st.ptys.kill("live-1", None).unwrap();
    }

    /// A `fetch.public` destination is a Files path, and every way of writing
    /// one that leaves `~/cloud` is refused — the escapes are refused, never
    /// clamped, and nothing outside the root is touched on the way to finding
    /// out. The hole this closes: `destPath` used to reach `File::create`
    /// unresolved, so a token granting only `fetch.public` — no `fs.write`,
    /// no `vfs` channel — could write attacker-chosen bytes to any path the
    /// agent could open, `~/.ssh/authorized_keys` included.
    #[tokio::test]
    async fn fetch_destinations_cannot_escape_the_files_root() {
        let mut st = state();
        let root = st.vfs_root.path().to_path_buf();
        let c = claims(vec![Capability::FetchPublic]);

        // A file outside the root, plus a link inside the root that points at
        // the directory holding it — the escape a `..` check cannot see.
        let outside_dir = temp_dir("outside");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join("authorized_keys");
        std::fs::write(&outside, b"original").unwrap();
        std::os::unix::fs::symlink(&outside_dir, root.join("escape")).unwrap();
        let outside_name = outside_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        for dest in [
            // Traversal, rooted and relative.
            format!("../{outside_name}/authorized_keys"),
            format!("/../{outside_name}/authorized_keys"),
            // An absolute path naming a host location outside the root: read
            // as the Files path it is, it names nothing that exists under
            // `~/cloud`, and it can never mean the host file.
            outside.to_string_lossy().into_owned(),
            // Lexically clean, but through a symlink that leaves the root.
            "/escape/authorized_keys".to_string(),
            // The root itself is a directory, not a destination.
            "/".to_string(),
        ] {
            let req = AgentCtlRequest::FetchPublic {
                fetch_id: "fetch-path-test".into(),
                // Loopback, which the fetcher refuses before opening a socket:
                // the path refusal is what this asserts, and a destination
                // that slipped through would still touch no network.
                url: "http://127.0.0.1:9/payload".into(),
                dest_path: dest.clone(),
            };
            let resp = dispatch(&mut st, &c, "m-1", 1_100, req, &no_events())
                .await
                .unwrap();
            assert!(
                matches!(&resp, AgentCtlResponse::Error { code, .. } if code == "vfs_path_refused"),
                "{dest}: {resp:?}"
            );
        }
        assert_eq!(std::fs::read(&outside).unwrap(), b"original");
        assert!(!outside_dir.join("payload").exists());

        // And a destination that stays inside the root gets past the path
        // check: the response is `fetch.started`, and the fetcher's own
        // refusal of this URL arrives as an async `fetch.failed` event.
        std::fs::create_dir_all(root.join("Downloads")).unwrap();
        let (tx, mut rx) = events();
        let resp = dispatch(
            &mut st,
            &c,
            "m-1",
            1_100,
            AgentCtlRequest::FetchPublic {
                fetch_id: "fetch-inside-test".into(),
                url: "http://127.0.0.1:9/payload".into(),
                dest_path: "/Downloads/big.zip".into(),
            },
            &tx,
        )
        .await
        .unwrap();
        assert!(
            matches!(&resp, AgentCtlResponse::FetchStarted { path, .. } if path == "/Downloads/big.zip"),
            "{resp:?}"
        );
        let failed = rx.recv().await.expect("a fetch.failed event");
        assert!(
            matches!(&failed, AgentCtlResponse::FetchFailed { path, .. } if path == "/Downloads/big.zip"),
            "{failed:?}"
        );
        assert!(!root.join("Downloads/big.zip").exists());

        std::fs::remove_dir_all(&outside_dir).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn fetch_commit_preserves_an_existing_destination() {
        let dir = temp_dir("fetch-commit");
        std::fs::create_dir_all(&dir).unwrap();
        let staging = dir.join(".partial");
        let target = dir.join("result.bin");
        std::fs::write(&staging, b"incoming").unwrap();
        std::fs::write(&target, b"original").unwrap();

        assert!(commit_fetch(&staging, &target).await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert!(
            !staging.exists(),
            "only the private staging file is cleaned up"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The cancel registry directly: `register_fetch` hands out a Notify,
    /// `cancel_fetch` fires it (and survives arriving before the task parks —
    /// notify_one leaves a permit), and unknown/removed ids are silent no-ops.
    /// The full fetch→cancel→sentinel path over a real socket lives in the
    /// desktop sim-fetch/relay tests, where a loopback target is permitted;
    /// the shipped agent refuses loopback before a fetch could park.
    #[tokio::test]
    async fn cancel_registry_signals_once_and_ignores_unknowns() {
        let cancel = register_fetch("f-1").expect("first registration succeeds");
        assert!(
            register_fetch("f-1").is_none(),
            "duplicate active id refused"
        );
        // Signal before the task parks: notify_one stores a permit, so the
        // later notified() returns immediately.
        cancel_fetch("f-1");
        tokio::time::timeout(std::time::Duration::from_millis(200), cancel.notified())
            .await
            .expect("a pre-parked cancel is still delivered");

        // Unknown id: no panic, no effect.
        cancel_fetch("never-existed");
        unregister_fetch("f-1", &cancel);
        // Double-unregister and post-unregister cancel are no-ops.
        unregister_fetch("f-1", &cancel);
        cancel_fetch("f-1");
    }

    #[tokio::test]
    async fn invalid_requests_are_refused_after_authz() {
        let mut st = state();
        let c = claims(vec![Capability::PtyResize]);
        let req: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.resize","ptyId":"t1","cols":5000,"rows":24}"#)
                .unwrap();
        let resp = dispatch(&mut st, &c, "m-1", 1_100, req, &no_events())
            .await
            .unwrap();
        assert!(matches!(
            resp,
            AgentCtlResponse::Error { ref code, .. } if code == "invalid_request"
        ));
    }
}
