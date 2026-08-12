//! suma-agent binary — accepts the mux connection from sumad and pumps
//! frames (PRD §8.5, Appendix C). All behaviour worth testing lives in the
//! library; this file is wiring.
//!
//! Transport is TCP + length-prefixed frames in this phase; MASQUE/QUIC with
//! per-channel streams is the V2 path (PRD §8.4).
//!
//! **There is no per-request token verification in this binary yet.** One
//! `CapabilityClaims` is read from the environment at startup and handed to
//! every inbound connection, whoever opened it: nothing is signed, nothing is
//! checked against an issuer, and no caller ever presents a token. What the
//! claims do provide is the *shape* of the enforcement — [`dispatch`] and the
//! `vfs`/`pty` channels refuse anything the claims do not name, and an
//! unconfigured agent names nothing — but a claims set that grants a
//! capability grants it to every connection that reaches this port. The real
//! thing (control-plane-issued short-lived signed tokens, verified per request
//! against the claims the caller presents) is still to be written; until it
//! is, the port itself is the trust boundary and this stand-in must not be
//! mistaken for authentication.

use std::collections::HashMap;
use std::sync::Arc;

use suma_agent::caps::CapabilityClaims;
use suma_agent::dispatch::{check_pty_io, dispatch, pty_input, AgentState};
use suma_agent::jobs::JobRegistry;
use suma_agent::mux::{parse_channel, read_frame, write_frame, Channel, Frame};
use suma_agent::ports::LsofSource;
use suma_agent::proto::{AgentCtlRequest, AgentCtlResponse};
use suma_agent::pty::PtyManager;
use suma_agent::vfs::{self, VfsRoot};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();

    let machine_id =
        std::env::var("SUMA_MACHINE_ID").unwrap_or_else(|_| "dev-machine".to_string());

    // Dev stand-in for token delivery: claims come from the environment and
    // are never verified — see the module docs for what that does and does not
    // buy. With no claims configured the agent still runs, and every
    // capability check refuses — on ctl requests *and* on `pty/<id>` frames,
    // the two paths that can reach a PTY — because an empty capability list
    // grants nothing.
    let claims: CapabilityClaims = match std::env::var("SUMA_AGENT_CLAIMS") {
        Ok(raw) => serde_json::from_str(&raw)?,
        Err(_) => CapabilityClaims {
            mid: machine_id.clone(),
            sub: "unconfigured".to_string(),
            caps: Vec::new(),
            iat: 0,
            exp: 0,
            jti: "unconfigured".to_string(),
        },
    };

    // The `vfs` channel is deliberately outside the state mutex: an 8 MiB read
    // must not block a keystroke on a PTY, and the root is just a path. ctl
    // holds its own handle to the same root so `fetch.public` lands inside it.
    let vfs_root = VfsRoot::new(VfsRoot::default_root());

    let state = Arc::new(Mutex::new(AgentState {
        ptys: PtyManager::new(PtyManager::default_base()),
        jobs: JobRegistry::default(),
        ports: Box::new(LsofSource),
        vfs_root: vfs_root.clone(),
    }));

    let listen = std::env::var("SUMA_AGENT_LISTEN").unwrap_or_else(|_| "127.0.0.1:0".to_string());
    let listener = TcpListener::bind(&listen).await?;
    tracing::info!(addr = %listener.local_addr()?, %machine_id, "suma-agent listening");

    loop {
        let (stream, peer) = listener.accept().await?;
        let state = Arc::clone(&state);
        let claims = claims.clone();
        let machine_id = machine_id.clone();
        let vfs_root = vfs_root.clone();
        tokio::spawn(async move {
            if let Err(err) = serve_connection(stream, state, claims, machine_id, vfs_root).await {
                tracing::debug!(%peer, error = %err, "mux connection closed");
            }
        });
    }
}

/// The write half, shared by the frame loop and every output pump on this
/// connection. Frames are whole under the lock, so a pump's PTY bytes can
/// never interleave into the middle of a ctl response.
type SharedWriter = Arc<Mutex<OwnedWriteHalf>>;

async fn serve_connection(
    stream: TcpStream,
    state: Arc<Mutex<AgentState>>,
    claims: CapabilityClaims,
    machine_id: String,
    vfs_root: VfsRoot,
) -> anyhow::Result<()> {
    let (mut reader, write_half) = stream.into_split();
    let writer: SharedWriter = Arc::new(Mutex::new(write_half));
    // One pump per PTY this connection has attached to. Aborted on drop, so a
    // client that disconnects stops costing a task per shell it watched.
    let mut pumps: HashMap<String, PumpHandle> = HashMap::new();

    while let Some(frame) = read_frame(&mut reader).await? {
        match parse_channel(&frame.channel) {
            Some(Channel::Ctl) => {
                let responses = handle_ctl(&state, &claims, &machine_id, &frame.payload).await;
                for response in responses {
                    let payload = serde_json::to_vec(&response)?;
                    write_shared(
                        &writer,
                        &Frame {
                            channel: "ctl".to_string(),
                            payload,
                        },
                    )
                    .await?;
                }
            }
            Some(Channel::Pty(pty_id)) => {
                // An EMPTY frame is the subscription: the mux has no separate
                // "attach" frame, and with one connection per channel the agent
                // cannot otherwise know which socket wants this pty's output.
                // A zero-length payload carries no input, so it costs nothing
                // on the wire — and keeping it distinct from a keystroke means
                // a write-only client (sidecar `send_pty_input`) never gets a
                // pump writing to a socket it does not read, which would block
                // on backpressure while holding the connection's writer.
                if frame.payload.is_empty() {
                    if !pumps.contains_key(&pty_id) {
                        if let Some(pump) = start_pty_pump(
                            &state,
                            &claims,
                            &machine_id,
                            Arc::clone(&writer),
                            pty_id.clone(),
                        )
                        .await
                        {
                            pumps.insert(pty_id.clone(), pump);
                        }
                    }
                } else {
                    let mut st = state.lock().await;
                    if let Err(err) = pty_input(
                        &mut st,
                        &claims,
                        &machine_id,
                        now_seconds(),
                        &pty_id,
                        &frame.payload,
                    ) {
                        // Dropped, not answered: the pty channel has no response
                        // shape, and inventing an unsolicited ctl frame here would
                        // be a wire change. The refusal is what matters.
                        tracing::debug!(%pty_id, ?err, "pty input dropped");
                    }
                }
            }
            Some(Channel::Vfs) => {
                // Every outcome — including a denied capability or a refused
                // path — is a response frame, so the channel never leaves a
                // caller waiting on silence.
                let response = vfs::handle_frame(
                    &vfs_root,
                    &claims,
                    &machine_id,
                    now_seconds(),
                    &frame.payload,
                )
                .await;
                write_shared(
                    &writer,
                    &Frame {
                        channel: "vfs".to_string(),
                        payload: serde_json::to_vec(&response)?,
                    },
                )
                .await?;
            }
            // fwd/log pumps are still Phase 3+ wiring; frames are dropped, not
            // misrouted.
            Some(Channel::Fwd(_)) | Some(Channel::Log) => {
                tracing::debug!(channel = %frame.channel, "channel not wired yet");
            }
            None => {
                tracing::debug!(channel = %frame.channel, "unknown channel rejected");
            }
        }
    }
    Ok(())
}

/// A running output pump, aborted when the connection's frame loop ends.
struct PumpHandle(tokio::task::JoinHandle<()>);

impl Drop for PumpHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn write_shared(writer: &SharedWriter, frame: &Frame) -> std::io::Result<()> {
    write_frame(&mut *writer.lock().await, frame).await
}

/// Start streaming a live PTY's output onto this connection.
///
/// Subscribing happens before the replay is read, so bytes written in between
/// arrive on the subscription instead of vanishing between the two reads; the
/// pump then drops whatever the replay already covered. Returns `None` when
/// the capability is refused or the pty has no live session — a reconstructed
/// session's bytes come back through `pty.attach` on ctl, not from here.
async fn start_pty_pump(
    state: &Arc<Mutex<AgentState>>,
    claims: &CapabilityClaims,
    machine_id: &str,
    writer: SharedWriter,
    pty_id: String,
) -> Option<PumpHandle> {
    // Watching a shell is as sensitive as typing into one, so the output
    // subscription fails closed on the same capability as input.
    if let Some(reason) = check_pty_io(claims, machine_id, now_seconds()) {
        tracing::debug!(%pty_id, %reason, "pty output subscription denied");
        return None;
    }

    let subscription = {
        let st = state.lock().await;
        match st.ptys.subscribe(&pty_id) {
            Some(rx) => st
                .ptys
                .replay(&pty_id, 0)
                .map(|(bytes, total)| (rx, bytes, total)),
            // No live process. If the context outlived it, the persisted
            // scrollback is the whole of what this channel will ever carry —
            // send it and start no pump, because nothing more is coming.
            None => {
                let bytes = st.ptys.persisted_replay(&pty_id)?;
                drop(st);
                let frame = Frame {
                    channel: format!("pty/{pty_id}"),
                    payload: bytes,
                };
                let _ = write_shared(&writer, &frame).await;
                return None;
            }
        }
    };
    let (mut rx, replay, mut delivered) = subscription?;

    let channel = format!("pty/{pty_id}");
    if !replay.is_empty() {
        let frame = Frame {
            channel: channel.clone(),
            payload: replay,
        };
        if write_shared(&writer, &frame).await.is_err() {
            return None;
        }
    }

    let state = Arc::clone(state);
    Some(PumpHandle(tokio::spawn(async move {
        loop {
            let chunk = match rx.recv().await {
                Ok(chunk) => chunk,
                // The session is gone (exit, kill, or manager drop). Output
                // ends here; `pty.exited` is the ctl event that reports it.
                Err(broadcast::error::RecvError::Closed) => return,
                // Fell behind the ring buffer of chunks. The scrollback still
                // holds the bytes, so resync from the last offset written
                // rather than serving the client a silent hole.
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(%pty_id, skipped, "pty output subscriber lagged; resyncing");
                    let caught_up = {
                        let st = state.lock().await;
                        st.ptys.replay(&pty_id, delivered)
                    };
                    match caught_up {
                        Some((bytes, total)) => {
                            if !bytes.is_empty() {
                                let frame = Frame {
                                    channel: channel.clone(),
                                    payload: bytes,
                                };
                                if write_shared(&writer, &frame).await.is_err() {
                                    return;
                                }
                            }
                            delivered = total;
                        }
                        None => return,
                    }
                    continue;
                }
            };

            // Skip what the replay (or a resync) already wrote. A chunk can
            // straddle the boundary, so trim rather than drop it whole.
            if chunk.end_offset <= delivered {
                continue;
            }
            let start = chunk.end_offset - chunk.data.len() as u64;
            let skip = delivered.saturating_sub(start) as usize;
            let frame = Frame {
                channel: channel.clone(),
                payload: chunk.data[skip..].to_vec(),
            };
            if write_shared(&writer, &frame).await.is_err() {
                return;
            }
            delivered = chunk.end_offset;
        }
    })))
}

/// Wall-clock seconds, the units capability windows are expressed in.
///
/// An unreadable clock reads as "after every expiry", so every token is
/// refused. Resumed machines can wake with skewed clocks (§8.5), and the safe
/// reading of "I don't know what time it is" is "this token is not valid" —
/// the previous `0` fallback said the opposite, accepting everything.
fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX)
}

/// Parse and dispatch one ctl payload; returns the frames to write back
/// (progress events first, terminal response last).
async fn handle_ctl(
    state: &Arc<Mutex<AgentState>>,
    claims: &CapabilityClaims,
    machine_id: &str,
    payload: &[u8],
) -> Vec<AgentCtlResponse> {
    let request: AgentCtlRequest = match serde_json::from_slice(payload) {
        Ok(req) => req,
        Err(err) => {
            return vec![AgentCtlResponse::Error {
                code: "bad_request".to_string(),
                message: format!("unparseable ctl payload: {err}"),
            }];
        }
    };
    let now = now_seconds();

    let mut events: Vec<AgentCtlResponse> = Vec::new();
    let mut st = state.lock().await;
    let mut emit = |resp: AgentCtlResponse| events.push(resp);
    let response = dispatch(&mut st, claims, machine_id, now, request, &mut emit).await;
    drop(st);
    if let Some(response) = response {
        events.push(response);
    }
    events
}
