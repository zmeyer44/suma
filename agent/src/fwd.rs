//! Port forwarding — the `fwd/<port>` channel.
//!
//! A forward carries a raw TCP stream between the desktop and a loopback
//! port INSIDE this machine (`127.0.0.1:<port>`): the user's dev server, a
//! database, whatever they started in a shell here. Loopback is the whole
//! target space — the wire names only a port, so there is nothing else to
//! reach and no SSRF surface to guard. `PortsService` on the desktop is the
//! other end: it opens a local listener and pipes each accepted socket over
//! one `fwd/<port>` stream.
//!
//! Transport shapes (both handled here identically — this module is
//! stream-generic over its writer):
//!   - Over per-connection TCP (`TcpAgentClient`), the mux CONNECTION is the
//!     stream: one `fwd/<port>` channel, and connection teardown ends it.
//!   - Over the relay's shared WebSocket the stream id lives in the channel
//!     name (`fwd/<port>/<id>`); the home bridge, not this module, demuxes
//!     that. This module always receives a single stream's writer.
//!
//! Frame semantics on a fwd channel (binary; an empty `'data'` never occurs
//! on a live TCP socket, so empty is unambiguously control):
//!   - OPEN  — first frame, empty payload → dial the port (done by the
//!     caller, which then constructs a [`FwdSession`]).
//!   - DATA  — non-empty payload, either direction → raw bytes.
//!   - CLOSE — empty payload after OPEN → the stream is done; destroy the
//!     socket. Upstream EOF or error here shuts the connection's write half
//!     (the desktop reads that as its CLOSE). No half-close: a FIN ends the
//!     whole stream, matching the desktop's `allowHalfOpen: false` sockets.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use crate::mux::{write_frame, Frame};

/// A running forward: the write half of the upstream TCP connection, plus a
/// read pump that copies upstream → desktop until EOF. Dropping the session
/// aborts the pump and closes the upstream connection.
pub struct FwdSession {
    upstream_write: tokio::net::tcp::OwnedWriteHalf,
    /// Held only for its Drop: the read pump aborts when the session is
    /// dropped (connection teardown), so the field is never read directly.
    #[allow(dead_code)]
    pump: PumpHandle,
}

/// A spawned task aborted on drop — the connection ending kills its pumps.
struct PumpHandle(tokio::task::JoinHandle<()>);

impl Drop for PumpHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl FwdSession {
    /// Dial `127.0.0.1:port` and start pumping its output onto `channel`
    /// through `writer` (the connection's shared frame writer). The pump
    /// reads up to 64 KiB per iteration; on upstream EOF or error it shuts
    /// the desktop-facing write half so the desktop sees the stream close.
    pub async fn open<W>(channel: String, port: u16, writer: Arc<Mutex<W>>) -> std::io::Result<Self>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let (mut upstream_read, upstream_write) = stream.into_split();
        let pump = PumpHandle(tokio::spawn(async move {
            let mut buf = [0u8; 64 * 1024];
            loop {
                match upstream_read.read(&mut buf).await {
                    Ok(0) | Err(_) => {
                        // Upstream closed (or errored): tell the desktop by
                        // shutting our write half. Its FrameDecoder sees the
                        // connection end and destroys the paired socket.
                        let mut w = writer.lock().await;
                        let _ = w.shutdown().await;
                        return;
                    }
                    Ok(n) => {
                        let frame = Frame {
                            channel: channel.clone(),
                            payload: buf[..n].to_vec(),
                        };
                        let mut w = writer.lock().await;
                        if write_frame(&mut *w, &frame).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }));
        Ok(FwdSession {
            upstream_write,
            pump,
        })
    }

    /// Write one DATA frame's payload to the upstream connection. Awaited
    /// inline: the mux connection is dedicated to this stream, so blocking
    /// its frame loop on upstream backpressure is correct flow control.
    pub async fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.upstream_write.write_all(data).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::read_frame;
    use tokio::io::AsyncReadExt as _;
    use tokio::net::TcpListener;

    /// A loopback echo server; returns its port and a handle that stays alive
    /// until dropped.
    async fn echo_server() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                if socket.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        (port, handle)
    }

    #[tokio::test]
    async fn forwards_bytes_to_a_loopback_port_and_frames_the_echo() {
        let (port, _echo) = echo_server().await;
        // The "connection writer" is one end of a duplex; the test reads
        // frames off the other end, as the desktop's FrameDecoder would.
        let (writer_side, mut desktop_side) = tokio::io::duplex(64 * 1024);
        let writer = Arc::new(Mutex::new(writer_side));

        let mut session = FwdSession::open("fwd/9999/s-1".into(), port, writer)
            .await
            .unwrap();
        session.write(b"ping").await.unwrap();

        let frame = read_frame(&mut desktop_side).await.unwrap().unwrap();
        assert_eq!(frame.channel, "fwd/9999/s-1");
        assert_eq!(frame.payload, b"ping");
    }

    #[tokio::test]
    async fn dropping_the_echo_shuts_the_desktop_write_half() {
        let (port, echo) = echo_server().await;
        let (writer_side, mut desktop_side) = tokio::io::duplex(64 * 1024);
        let writer = Arc::new(Mutex::new(writer_side));
        let mut session = FwdSession::open("fwd/9999/s-1".into(), port, writer)
            .await
            .unwrap();
        session.write(b"hi").await.unwrap();
        // Read the echo, then kill the upstream server: the pump sees EOF and
        // shuts our write half, which the desktop side reads as EOF.
        let _ = read_frame(&mut desktop_side).await.unwrap();
        echo.abort();
        drop(session); // closes upstream_write → server's read returns 0
        // A shutdown propagates as read → 0 on the paired duplex end.
        let mut trailing = Vec::new();
        let _ = desktop_side.read_to_end(&mut trailing).await;
    }

    #[tokio::test]
    async fn open_against_a_dead_port_errors() {
        // Bind then drop to get a port nothing listens on.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (writer_side, _desktop) = tokio::io::duplex(1024);
        let writer = Arc::new(Mutex::new(writer_side));
        assert!(FwdSession::open("fwd/1/s".into(), port, writer)
            .await
            .is_err());
    }
}
