//! ctl wire shapes — a field-for-field mirror of the zod schemas in
//! `packages/protocol/src/agent.ts` (the source of truth). The `t` field is
//! the discriminator on both sides; field names are the TS camelCase names.
//! Change the TS module first, then this one — never the other way around.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Scrollback retained per PTY (§8.5) — persists independently of the memory
/// snapshot. Mirrors `PTY_SCROLLBACK_LINES` in agent.ts.
pub const PTY_SCROLLBACK_LINES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PtySignal {
    #[serde(rename = "TERM")]
    Term,
    #[serde(rename = "KILL")]
    Kill,
    #[serde(rename = "INT")]
    Int,
}

/// Whether a reattach found the live process or only its persisted context
/// (§8.5) — the client UI must surface which.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PtyRestoreKind {
    #[serde(rename = "resumed")]
    Resumed,
    #[serde(rename = "reconstructed")]
    Reconstructed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListeningPort {
    pub port: u16,
    /// Process command that opened it, best-effort.
    pub process: String,
    /// Bound to loopback only — safe to forward.
    pub loopback: bool,
}

/// One entry in a `pty.listing` response — mirror of `PtySessionEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionEntry {
    pub pty_id: String,
    pub cwd: String,
    /// The spawn command, when one was given (interactive shells have none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Live process vs. persisted context only — what attach would report.
    pub live: bool,
}

/// Requests on the `ctl` channel — mirror of `agentCtlRequestSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum AgentCtlRequest {
    #[serde(rename = "pty.spawn", rename_all = "camelCase")]
    PtySpawn {
        /// Client-chosen id so a reattach can name the PTY it wants.
        pty_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        cols: u16,
        rows: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        env: Option<BTreeMap<String, String>>,
    },
    #[serde(rename = "pty.resize", rename_all = "camelCase")]
    PtyResize {
        pty_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "pty.kill", rename_all = "camelCase")]
    PtyKill {
        pty_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<PtySignal>,
    },
    #[serde(rename = "pty.attach", rename_all = "camelCase")]
    PtyAttach {
        pty_id: String,
        /// Resume scrollback from this byte offset; 0 replays the whole buffer.
        #[serde(skip_serializing_if = "Option::is_none")]
        since_byte: Option<u64>,
    },
    /// Job Mode: mark this PTY's workload as "keep running" (§8.5).
    #[serde(rename = "job.set", rename_all = "camelCase")]
    JobSet {
        pty_id: String,
        enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Enumerate PTY sessions — live and persisted — so a second device can
    /// discover sessions it did not create (§8.5 M-2).
    #[serde(rename = "pty.list")]
    PtyList,
    #[serde(rename = "ports.list")]
    PortsList,
    /// Public or presigned URL only — no credentials ever cross into the VM
    /// (§8.6). There is deliberately no field for headers; see `fetch.rs`.
    ///
    /// `destPath` is a path *in Suma Files*, the same string the control
    /// plane stores on a transfer (`/Downloads/big.zip`), not a path on the
    /// VM's filesystem. It is resolved against `~/cloud` by
    /// `VfsRoot::resolve_new_file`, which is where traversal and symlink
    /// escapes are refused — the checks below only bound the string.
    #[serde(rename = "fetch.public", rename_all = "camelCase")]
    FetchPublic {
        fetch_id: String,
        url: String,
        dest_path: String,
    },
    /// Cancel a running (or queued) background fetch. Fire-and-forget, like
    /// pty.kill: no response frame — confirmation is the `fetch.failed`
    /// event carrying [`FETCH_CANCELLED_ERROR`]. Unknown ids and
    /// double-cancels are silent no-ops.
    #[serde(rename = "fetch.cancel", rename_all = "camelCase")]
    FetchCancel { fetch_id: String },
}

/// The exact `fetch.failed.error` a cancelled fetch reports — mirror of
/// `FETCH_CANCELLED_ERROR` in packages/protocol/src/agent.ts. The desktop
/// matches on it to show "cancelled" rather than "failed".
pub const FETCH_CANCELLED_ERROR: &str = "cancelled by the user";

fn validate_fetch_id(fetch_id: &str) -> Result<(), String> {
    if fetch_id.is_empty()
        || fetch_id.len() > 128
        || !fetch_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("fetchId must be 1..=128 URL-safe characters".to_string());
    }
    Ok(())
}

impl AgentCtlRequest {
    /// Bounds checks mirroring the zod schemas (serde enforces types and
    /// presence; zod's min/max constraints are enforced here).
    pub fn validate(&self) -> Result<(), String> {
        fn pty_id_ok(id: &str) -> Result<(), String> {
            if id.is_empty() || id.len() > 128 {
                return Err("ptyId must be 1..=128 chars".to_string());
            }
            Ok(())
        }
        fn dims_ok(cols: u16, rows: u16) -> Result<(), String> {
            if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
                return Err("cols/rows must be 1..=1000".to_string());
            }
            Ok(())
        }
        match self {
            AgentCtlRequest::PtySpawn {
                pty_id,
                cwd,
                command,
                cols,
                rows,
                env,
            } => {
                pty_id_ok(pty_id)?;
                dims_ok(*cols, *rows)?;
                for s in [cwd, command].into_iter().flatten() {
                    if s.len() > 4096 {
                        return Err("cwd/command too long".to_string());
                    }
                }
                if let Some(env) = env {
                    if env.values().any(|v| v.len() > 4096) {
                        return Err("env value too long".to_string());
                    }
                }
                Ok(())
            }
            AgentCtlRequest::PtyResize { pty_id, cols, rows } => {
                pty_id_ok(pty_id)?;
                dims_ok(*cols, *rows)
            }
            AgentCtlRequest::PtyKill { pty_id, .. } | AgentCtlRequest::PtyAttach { pty_id, .. } => {
                pty_id_ok(pty_id)
            }
            AgentCtlRequest::JobSet { pty_id, label, .. } => {
                pty_id_ok(pty_id)?;
                if label.as_deref().is_some_and(|l| l.len() > 200) {
                    return Err("label too long".to_string());
                }
                Ok(())
            }
            AgentCtlRequest::PtyList | AgentCtlRequest::PortsList => Ok(()),
            AgentCtlRequest::FetchPublic {
                fetch_id,
                url,
                dest_path,
            } => {
                validate_fetch_id(fetch_id)?;
                if url.len() > 8192 || !url.contains("://") {
                    return Err("url must be a URL of at most 8192 chars".to_string());
                }
                // Deliberately stricter than the current zod schema, and the
                // one place this file leads the TS module instead of following
                // it: a URL carrying CR/LF injects headers into the fetcher's
                // request line (see fetch.rs). Refusing here means a malformed
                // URL never reaches a handler at all. The zod schema needs the
                // same rule; until it has one, the divergence only ever
                // refuses more.
                if url.bytes().any(|b| b.is_ascii_control() || b == 0x7f) {
                    return Err("url must not contain control characters".to_string());
                }
                // RFC 3986 has no raw spaces either, and the request line is
                // space-delimited.
                if url.contains(' ') {
                    return Err("url must not contain spaces".to_string());
                }
                if dest_path.is_empty() || dest_path.len() > 4096 {
                    return Err("destPath must be 1..=4096 chars".to_string());
                }
                if dest_path.bytes().any(|b| b.is_ascii_control() || b == 0x7f) {
                    return Err("destPath must not contain control characters".to_string());
                }
                Ok(())
            }
            AgentCtlRequest::FetchCancel { fetch_id } => validate_fetch_id(fetch_id),
        }
    }
}

/// Responses on the `ctl` channel — mirror of `agentCtlResponseSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum AgentCtlResponse {
    #[serde(rename = "pty.spawned", rename_all = "camelCase")]
    PtySpawned { pty_id: String },
    #[serde(rename = "pty.attached", rename_all = "camelCase")]
    PtyAttached {
        pty_id: String,
        /// Whether the live process survived, or only its context did (§8.5).
        restore: PtyRestoreKind,
        scrollback_bytes: u64,
        cwd: String,
    },
    #[serde(rename = "pty.exited", rename_all = "camelCase")]
    PtyExited { pty_id: String, code: i32 },
    #[serde(rename = "pty.listing")]
    PtyListing { sessions: Vec<PtySessionEntry> },
    #[serde(rename = "job.ack", rename_all = "camelCase")]
    JobAck { pty_id: String, enabled: bool },
    #[serde(rename = "ports")]
    Ports { ports: Vec<ListeningPort> },
    /// Terminal response to `fetch.public`: the fetch now runs as a
    /// background task, and everything after this frame — `fetch.progress`,
    /// `fetch.done`, `fetch.failed` — arrives as an UNSOLICITED event
    /// correlated by `fetchId`.
    ///
    /// FIFO invariant: the desktop ctl client resolves its pending head on
    /// the expected response type OR on any `error` frame, so unsolicited
    /// events must NEVER use the `error` variant. Async fetch failures are
    /// the typed `fetch.failed`.
    #[serde(rename = "fetch.started", rename_all = "camelCase")]
    FetchStarted {
        fetch_id: String,
        url: String,
        path: String,
    },
    #[serde(rename = "fetch.progress", rename_all = "camelCase")]
    FetchProgress {
        fetch_id: String,
        url: String,
        received: u64,
        total: u64,
    },
    #[serde(rename = "fetch.done", rename_all = "camelCase")]
    FetchDone {
        fetch_id: String,
        url: String,
        path: String,
        bytes: u64,
        /// Chunk manifest of the downloaded file (§8.6), so the control plane
        /// can record which chunks the file is made of and ask only for the
        /// ones R2 lacks. This field is an *addition* to the TS `fetch.done`
        /// shape rather than a mirror of it: `agentCtlResponseSchema` is a
        /// plain (non-strict) zod union, so a Phase-2 client parses this frame
        /// unchanged and drops the extra key. It is optional in both
        /// directions — omitted entirely when absent — so nothing on the wire
        /// changes for a reader that predates it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        manifest: Option<crate::chunker::Manifest>,
    },
    /// Unsolicited: a background fetch failed. Carries the same identifiers
    /// as `fetch.done` so a client can settle the matching row.
    #[serde(rename = "fetch.failed", rename_all = "camelCase")]
    FetchFailed {
        fetch_id: String,
        url: String,
        path: String,
        error: String,
    },
    /// Unsolicited-only: something under the Files root changed (a shell
    /// wrote a file, a fetch landed). `paths` lists rooted wire paths when
    /// the emitter knows them and they are few; absent means "something
    /// changed — re-list". Never a response to any request.
    #[serde(rename = "vfs.changed")]
    VfsChanged {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        paths: Option<Vec<String>>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Literal JSON strings as the TS side emits them (see agent.ts schemas).
    /// If any of these stop parsing, the wire has broken.
    #[test]
    fn requests_deserialize_from_ts_emitted_json() {
        let spawn: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"pty.spawn","ptyId":"term-1","cwd":"/home/u","command":"npm run build","cols":120,"rows":32,"env":{"CI":"1"}}"#,
        )
        .unwrap();
        match &spawn {
            AgentCtlRequest::PtySpawn {
                pty_id,
                cwd,
                command,
                cols,
                rows,
                env,
            } => {
                assert_eq!(pty_id, "term-1");
                assert_eq!(cwd.as_deref(), Some("/home/u"));
                assert_eq!(command.as_deref(), Some("npm run build"));
                assert_eq!((*cols, *rows), (120, 32));
                assert_eq!(env.as_ref().unwrap()["CI"], "1");
            }
            other => panic!("wrong variant: {other:?}"),
        }
        assert!(spawn.validate().is_ok());

        let resize: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.resize","ptyId":"term-1","cols":80,"rows":24}"#)
                .unwrap();
        assert_eq!(
            resize,
            AgentCtlRequest::PtyResize {
                pty_id: "term-1".into(),
                cols: 80,
                rows: 24
            }
        );

        let kill: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.kill","ptyId":"term-1","signal":"TERM"}"#).unwrap();
        assert_eq!(
            kill,
            AgentCtlRequest::PtyKill {
                pty_id: "term-1".into(),
                signal: Some(PtySignal::Term)
            }
        );

        let attach: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.attach","ptyId":"term-1","sinceByte":0}"#).unwrap();
        assert_eq!(
            attach,
            AgentCtlRequest::PtyAttach {
                pty_id: "term-1".into(),
                since_byte: Some(0)
            }
        );

        let job: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"job.set","ptyId":"term-1","enabled":true,"label":"training run"}"#,
        )
        .unwrap();
        assert_eq!(
            job,
            AgentCtlRequest::JobSet {
                pty_id: "term-1".into(),
                enabled: true,
                label: Some("training run".into())
            }
        );

        let ports: AgentCtlRequest = serde_json::from_str(r#"{"t":"ports.list"}"#).unwrap();
        assert_eq!(ports, AgentCtlRequest::PortsList);

        let fetch: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"https://example.com/data.tar.gz?sig=abc","destPath":"/home/u/data.tar.gz"}"#,
        )
        .unwrap();
        assert_eq!(
            fetch,
            AgentCtlRequest::FetchPublic {
                fetch_id: "fetch-1".into(),
                url: "https://example.com/data.tar.gz?sig=abc".into(),
                dest_path: "/home/u/data.tar.gz".into()
            }
        );

        let cancel: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"fetch.cancel","fetchId":"fetch-1"}"#).unwrap();
        assert_eq!(
            cancel,
            AgentCtlRequest::FetchCancel {
                fetch_id: "fetch-1".into()
            }
        );
        assert!(cancel.validate().is_ok());
        // Same fetchId bounds as fetch.public.
        assert!(serde_json::from_str::<AgentCtlRequest>(r#"{"t":"fetch.cancel","fetchId":""}"#)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn unknown_discriminators_fail_to_parse() {
        assert!(serde_json::from_str::<AgentCtlRequest>(r#"{"t":"fs.exec","path":"/"}"#).is_err());
        assert!(serde_json::from_str::<AgentCtlRequest>(r#"{"ptyId":"x"}"#).is_err());
    }

    #[test]
    fn responses_serialize_to_the_ts_wire_shape() {
        let attached = AgentCtlResponse::PtyAttached {
            pty_id: "term-1".into(),
            restore: PtyRestoreKind::Reconstructed,
            scrollback_bytes: 4096,
            cwd: "/home/u/project".into(),
        };
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"t":"pty.attached","ptyId":"term-1","restore":"reconstructed","scrollbackBytes":4096,"cwd":"/home/u/project"}"#,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(attached).unwrap(), expected);

        let spawned = AgentCtlResponse::PtySpawned {
            pty_id: "term-1".into(),
        };
        assert_eq!(
            serde_json::to_string(&spawned).unwrap(),
            r#"{"t":"pty.spawned","ptyId":"term-1"}"#
        );

        let ports = AgentCtlResponse::Ports {
            ports: vec![ListeningPort {
                port: 3000,
                process: "node".into(),
                loopback: true,
            }],
        };
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"t":"ports","ports":[{"port":3000,"process":"node","loopback":true}]}"#,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(ports).unwrap(), expected);

        let progress = AgentCtlResponse::FetchProgress {
            fetch_id: "fetch-1".into(),
            url: "https://example.com/f".into(),
            received: 10,
            total: 100,
        };
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"t":"fetch.progress","fetchId":"fetch-1","url":"https://example.com/f","received":10,"total":100}"#,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(progress).unwrap(), expected);
    }

    /// The async-fetch and watch frames pin to the exact strings
    /// `agentCtlResponseSchema` parses.
    #[test]
    fn fetch_lifecycle_and_watch_frames_pin_the_ts_wire() {
        let started = AgentCtlResponse::FetchStarted {
            fetch_id: "fetch-1".into(),
            url: "https://example.com/f".into(),
            path: "/Downloads/f".into(),
        };
        assert_eq!(
            serde_json::to_string(&started).unwrap(),
            r#"{"t":"fetch.started","fetchId":"fetch-1","url":"https://example.com/f","path":"/Downloads/f"}"#
        );

        let failed = AgentCtlResponse::FetchFailed {
            fetch_id: "fetch-1".into(),
            url: "https://example.com/f".into(),
            path: "/Downloads/f".into(),
            error: "fetch truncated: got 5 of 10 bytes".into(),
        };
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"t":"fetch.failed","fetchId":"fetch-1","url":"https://example.com/f","path":"/Downloads/f","error":"fetch truncated: got 5 of 10 bytes"}"#
        );

        let quiet = AgentCtlResponse::VfsChanged { paths: None };
        assert_eq!(
            serde_json::to_string(&quiet).unwrap(),
            r#"{"t":"vfs.changed"}"#
        );
        let listed = AgentCtlResponse::VfsChanged {
            paths: Some(vec!["/notes/a.txt".into(), "/empty/".into()]),
        };
        assert_eq!(
            serde_json::to_string(&listed).unwrap(),
            r#"{"t":"vfs.changed","paths":["/notes/a.txt","/empty/"]}"#
        );
        // And the TS-emitted forms parse back.
        assert_eq!(
            serde_json::from_str::<AgentCtlResponse>(r#"{"t":"vfs.changed"}"#).unwrap(),
            quiet
        );
    }

    /// `fetch.done` still serializes to the exact TS shape when there is no
    /// manifest, and merely *adds* a key when there is — the property that
    /// lets a Phase-2 client (non-strict zod, unknown keys stripped) keep
    /// parsing frames from a Phase-3 agent.
    #[test]
    fn fetch_done_carries_the_manifest_without_breaking_the_phase_2_shape() {
        let bare = AgentCtlResponse::FetchDone {
            fetch_id: "fetch-1".into(),
            url: "http://example.com/f".into(),
            path: "/home/u/f".into(),
            bytes: 3,
            manifest: None,
        };
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"t":"fetch.done","fetchId":"fetch-1","url":"http://example.com/f","path":"/home/u/f","bytes":3}"#
        );
        // A TS-emitted frame with no manifest field still parses here.
        assert_eq!(
            serde_json::from_str::<AgentCtlResponse>(
                r#"{"t":"fetch.done","fetchId":"fetch-1","url":"http://example.com/f","path":"/home/u/f","bytes":3}"#
            )
            .unwrap(),
            bare
        );

        let with_manifest = AgentCtlResponse::FetchDone {
            fetch_id: "fetch-1".into(),
            url: "http://example.com/f".into(),
            path: "/home/u/f".into(),
            bytes: 3,
            manifest: Some(crate::chunker::build_manifest(b"abc")),
        };
        let json = serde_json::to_value(&with_manifest).unwrap();
        assert_eq!(json["t"], "fetch.done");
        assert_eq!(json["bytes"], 3);
        assert_eq!(json["manifest"]["totalBytes"], 3);
        assert_eq!(json["manifest"]["chunks"][0]["length"], 3);
        assert_eq!(
            serde_json::from_value::<AgentCtlResponse>(json).unwrap(),
            with_manifest
        );
    }

    #[test]
    fn responses_deserialize_from_ts_emitted_json() {
        let exited: AgentCtlResponse =
            serde_json::from_str(r#"{"t":"pty.exited","ptyId":"term-1","code":0}"#).unwrap();
        assert_eq!(
            exited,
            AgentCtlResponse::PtyExited {
                pty_id: "term-1".into(),
                code: 0
            }
        );
        let err: AgentCtlResponse = serde_json::from_str(
            r#"{"t":"error","code":"capability_denied","message":"capability pty.kill not granted"}"#,
        )
        .unwrap();
        assert_eq!(
            err,
            AgentCtlResponse::Error {
                code: "capability_denied".into(),
                message: "capability pty.kill not granted".into()
            }
        );
    }

    #[test]
    fn validate_enforces_the_zod_bounds() {
        let too_big: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.resize","ptyId":"a","cols":1001,"rows":24}"#)
                .unwrap();
        assert!(too_big.validate().is_err());
        let empty_id: AgentCtlRequest =
            serde_json::from_str(r#"{"t":"pty.attach","ptyId":""}"#).unwrap();
        assert!(empty_id.validate().is_err());
        let bad_url: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"not a url","destPath":"/tmp/f"}"#,
        )
        .unwrap();
        assert!(bad_url.validate().is_err());
    }

    /// A URL is a URL, not a request head: a `fetch.public` carrying CRLF is
    /// refused before dispatch ever sees it.
    #[test]
    fn fetch_urls_carrying_control_characters_are_refused() {
        let injected: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"http://example.com/a\r\nCookie: session=stolen\r\n\r\nGET /second HTTP/1.1\r\nHost: x\r\n\r\n","destPath":"/tmp/f"}"#,
        )
        .unwrap();
        assert_eq!(
            injected.validate(),
            Err("url must not contain control characters".to_string())
        );

        for raw in [
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"http://example.com/a\nX: 1","destPath":"/tmp/f"}"#,
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"http://example.com/a ","destPath":"/tmp/f"}"#,
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"http://example.com/a","destPath":"/tmp/f\r\n"}"#,
        ] {
            let req: AgentCtlRequest = serde_json::from_str(raw).unwrap();
            assert!(req.validate().is_err(), "{raw}");
        }

        // Percent-encoded, which is not an injection, still validates.
        let encoded: AgentCtlRequest = serde_json::from_str(
            r#"{"t":"fetch.public","fetchId":"fetch-1","url":"http://example.com/a%0d%0ab","destPath":"/tmp/f"}"#,
        )
        .unwrap();
        assert!(encoded.validate().is_ok());
    }
}
