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
use suma_agent::dispatch::{check_fwd, check_pty_io, dispatch, pty_input, AgentState, CtlEvents};
use suma_agent::fwd::FwdSession;
use suma_agent::jobs::JobRegistry;
use suma_agent::mux::{parse_channel, read_frame, write_frame, Channel, Frame};
use suma_agent::ports::ProcSource;
use suma_agent::proto::{AgentCtlRequest, AgentCtlResponse};
use suma_agent::pty::PtyManager;
use suma_agent::vfs::{self, VfsRoot};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();

    let machine_id = std::env::var("SUMA_MACHINE_ID").unwrap_or_else(|_| "dev-machine".to_string());

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
        ports: Box::new(ProcSource),
        vfs_root: vfs_root.clone(),
    }));

    // The Files-root watcher: one process-wide bus, scans only while some
    // connection is subscribed (watch.rs). Connections subscribe on their
    // first ctl frame — pty/vfs-only clients never hear from it.
    let (watch_bus, _) =
        broadcast::channel::<AgentCtlResponse>(suma_agent::watch::WATCH_BUS_CAPACITY);
    tokio::spawn(suma_agent::watch::run(vfs_root.clone(), watch_bus.clone()));
    tokio::spawn(run_exit_pump(Arc::clone(&state), watch_bus.clone()));

    let listen = std::env::var("SUMA_AGENT_LISTEN").unwrap_or_else(|_| "127.0.0.1:0".to_string());
    let listener = TcpListener::bind(&listen).await?;
    tracing::info!(addr = %listener.local_addr()?, %machine_id, "suma-agent listening");

    loop {
        let (stream, peer) = listener.accept().await?;
        let state = Arc::clone(&state);
        let claims = claims.clone();
        let machine_id = machine_id.clone();
        let vfs_root = vfs_root.clone();
        let watch_bus = watch_bus.clone();
        tokio::spawn(async move {
            if let Err(err) =
                serve_connection(stream, state, claims, machine_id, vfs_root, watch_bus).await
            {
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
    watch_bus: broadcast::Sender<AgentCtlResponse>,
) -> anyhow::Result<()> {
    let (mut reader, write_half) = stream.into_split();
    let writer: SharedWriter = Arc::new(Mutex::new(write_half));
    // One pump per PTY this connection has attached to. Aborted on drop, so a
    // client that disconnects stops costing a task per shell it watched.
    let mut pumps: HashMap<String, PumpHandle> = HashMap::new();

    // The connection's ctl writer: EVERY ctl frame — request responses and
    // unsolicited events alike — goes through this one queue, so a background
    // fetch's progress can stream while the frame loop sits in read_frame,
    // and ordering is exactly send order. The forwarder aborts with the
    // connection (PumpHandle drop), which also closes the queue for any
    // still-running background task — its sends become silent no-ops.
    let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<AgentCtlResponse>();
    let ctl_events = CtlEvents(ctl_tx);
    let _ctl_pump = {
        let writer = Arc::clone(&writer);
        PumpHandle(tokio::spawn(async move {
            while let Some(response) = ctl_rx.recv().await {
                let payload = match serde_json::to_vec(&response) {
                    Ok(payload) => payload,
                    Err(_) => continue,
                };
                let frame = Frame {
                    channel: "ctl".to_string(),
                    payload,
                };
                if write_shared(&writer, &frame).await.is_err() {
                    return;
                }
            }
        }))
    };

    // Watch subscription, armed by this connection's FIRST ctl frame: a
    // client that speaks ctl is a UI that renders the file tree; pty- and
    // vfs-only connections never subscribe. Events are re-gated on fs.read
    // per delivery so an expired claims window stops the stream.
    let mut watch_pump: Option<PumpHandle> = None;

    // A port forward makes this connection dedicated to one stream: the
    // first fwd frame dials the port, the rest are that stream's bytes, and
    // connection teardown ends it (dropping the session aborts its pump).
    let mut fwd: Option<(String, FwdSession)> = None;

    while let Some(frame) = read_frame(&mut reader).await? {
        match parse_channel(&frame.channel) {
            Some(Channel::Ctl) => {
                if watch_pump.is_none() {
                    watch_pump = Some(start_event_pump(
                        &watch_bus,
                        ctl_events.clone(),
                        claims.clone(),
                        machine_id.clone(),
                    ));
                }
                handle_ctl(&state, &claims, &machine_id, &frame.payload, &ctl_events).await;
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
            Some(Channel::Fwd { port, .. }) => {
                match &mut fwd {
                    // Already forwarding: a mismatched channel string on a
                    // dedicated connection is a protocol error — close it.
                    Some((channel, session)) if *channel == frame.channel => {
                        if frame.payload.is_empty() {
                            // Empty after OPEN = the desktop closed the
                            // stream. The connection is dedicated, so end it.
                            return Ok(());
                        }
                        if session.write(&frame.payload).await.is_err() {
                            return Ok(()); // upstream gone — tear down
                        }
                    }
                    Some(_) => return Ok(()), // different fwd channel — protocol error
                    None => {
                        // First fwd frame: authorize, then dial. Any refusal
                        // closes the connection — the desktop's socket pair
                        // destroys on the disconnect, a prompt honest failure
                        // (there is no error payload on a fwd stream).
                        if let Some(reason) = check_fwd(&claims, &machine_id, now_seconds()) {
                            tracing::debug!(%reason, "fwd denied");
                            return Ok(());
                        }
                        match FwdSession::open(frame.channel.clone(), port, Arc::clone(&writer))
                            .await
                        {
                            Ok(mut session) => {
                                // Tolerate data-first (OPEN is normally empty,
                                // but a client that sends bytes immediately is
                                // fine): write a non-empty first payload.
                                if !frame.payload.is_empty()
                                    && session.write(&frame.payload).await.is_err()
                                {
                                    return Ok(());
                                }
                                fwd = Some((frame.channel.clone(), session));
                            }
                            Err(err) => {
                                tracing::debug!(port, %err, "fwd dial failed");
                                return Ok(());
                            }
                        }
                    }
                }
            }
            // The log channel is parsed but unwired on all transports.
            Some(Channel::Log) => {
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

/// Forward shared-bus events onto this connection's ctl queue, re-checking
/// the event's required capability per delivery (see `watch::event_capability`)
/// — so an expired or under-scoped claims set hears nothing, and a `pty.io`
/// connection gets `pty.exited` while an `fs.read`-only one gets `vfs.changed`.
/// Lagged receivers skip ahead: `vfs.changed` is collapsible, and a missed
/// `pty.exited` self-corrects on the next `pty.list`/attach.
fn start_event_pump(
    bus: &broadcast::Sender<AgentCtlResponse>,
    events: CtlEvents,
    claims: CapabilityClaims,
    machine_id: String,
) -> PumpHandle {
    let mut rx = bus.subscribe();
    PumpHandle(tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let allowed = match suma_agent::watch::event_capability(&event) {
                        Some(cap) => suma_agent::caps::check_capability(
                            &claims,
                            &machine_id,
                            cap,
                            now_seconds(),
                        )
                        .is_none(),
                        None => true,
                    };
                    if allowed {
                        events.send(event);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }))
}

/// The PTY exit reaper: broadcast `pty.exited` for every shell that has
/// exited since the last tick. Structured like `watch::run` — a 2 s poll
/// that idles at zero subscribers (nothing to tell, nobody to tell) — because
/// portable-pty offers no async exit signal, only `try_wait`.
async fn run_exit_pump(
    state: std::sync::Arc<Mutex<AgentState>>,
    bus: broadcast::Sender<AgentCtlResponse>,
) {
    let mut interval = tokio::time::interval(suma_agent::watch::WATCH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if bus.receiver_count() == 0 {
            continue;
        }
        let exits = {
            let mut st = state.lock().await;
            st.ptys.collect_new_exits()
        };
        for (pty_id, code) in exits {
            let _ = bus.send(AgentCtlResponse::PtyExited { pty_id, code });
        }
    }
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

/// Parse and dispatch one ctl payload. Everything it produces — the terminal
/// response and any unsolicited events a handler spawned — flows through the
/// connection's ctl pump; this function returns nothing.
///
/// The terminal response is sent through the SAME queue as events, so a
/// response enqueued here and an event from a background task keep their
/// relative order on the wire.
async fn handle_ctl(
    state: &Arc<Mutex<AgentState>>,
    claims: &CapabilityClaims,
    machine_id: &str,
    payload: &[u8],
    events: &CtlEvents,
) {
    let request: AgentCtlRequest = match serde_json::from_slice(payload) {
        Ok(req) => req,
        Err(err) => {
            // A direct send, not CtlEvents::send — this IS a response (to an
            // unparseable request), and responses may be errors.
            let _ = events.0.send(AgentCtlResponse::Error {
                code: "bad_request".to_string(),
                message: format!("unparseable ctl payload: {err}"),
            });
            return;
        }
    };
    let now = now_seconds();

    let mut st = state.lock().await;
    let response = dispatch(&mut st, claims, machine_id, now, request, events).await;
    drop(st);
    if let Some(response) = response {
        // Responses go through the raw sender: `error` is a legitimate
        // terminal response, and CtlEvents::send debug-asserts against it.
        let _ = events.0.send(response);
    }
}
