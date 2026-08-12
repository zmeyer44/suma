//! Client end of the suma-agent mux — deliberately thin.
//!
//! sumad owns the transport; the desktop app talks to this API and never
//! to the agent directly. Payloads are `serde_json::Value` rather than typed
//! structs on purpose: the agent (and the TS protocol module behind it) owns
//! the ctl schema, and the sidecar forwarding layer should not need a
//! release to pass a new message through.
//!
//! Frame layout is defined by `agent/src/mux.rs` (u32 total length, u16
//! channel-name length, channel, payload — all big-endian). The
//! `frame_byte_layout_is_pinned` test below carries the same byte vector as
//! the agent's; if either side changes framing, both tests must move
//! together.

use anyhow::{bail, Context};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// Matches `MAX_FRAME_LEN` in agent/src/mux.rs.
const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

pub struct AgentClient {
    stream: TcpStream,
}

impl AgentClient {
    pub async fn connect(addr: &str) -> anyhow::Result<Self> {
        let stream = TcpStream::connect(addr)
            .await
            .with_context(|| format!("connecting to suma-agent at {addr}"))?;
        Ok(AgentClient { stream })
    }

    /// Send one ctl request and wait for the next ctl frame back. Progress
    /// events that arrive first (e.g. `fetch.progress`) are handed to
    /// `on_event`; the first frame carrying a different `t` than
    /// `fetch.progress` is returned as the terminal response.
    pub async fn ctl_request(
        &mut self,
        request: &serde_json::Value,
        on_event: &mut (dyn FnMut(serde_json::Value) + Send),
    ) -> anyhow::Result<serde_json::Value> {
        let payload = serde_json::to_vec(request)?;
        write_frame(&mut self.stream, "ctl", &payload).await?;
        loop {
            let Some((channel, payload)) = read_frame(&mut self.stream).await? else {
                bail!("agent closed the mux mid-request");
            };
            if channel != "ctl" {
                // Not ours to interpret; the pty/log pumps own other channels.
                continue;
            }
            let value: serde_json::Value = serde_json::from_slice(&payload)?;
            if value.get("t").and_then(|t| t.as_str()) == Some("fetch.progress") {
                on_event(value);
                continue;
            }
            return Ok(value);
        }
    }

    /// Raw bytes for a PTY's input channel (`pty/<id>`).
    pub async fn send_pty_input(&mut self, pty_id: &str, data: &[u8]) -> anyhow::Result<()> {
        write_frame(&mut self.stream, &format!("pty/{pty_id}"), data).await?;
        Ok(())
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    channel: &str,
    payload: &[u8],
) -> std::io::Result<()> {
    let channel = channel.as_bytes();
    let total = 2 + channel.len() + payload.len();
    if channel.len() > u16::MAX as usize || total > MAX_FRAME_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame too large",
        ));
    }
    w.write_u32(total as u32).await?;
    w.write_u16(channel.len() as u16).await?;
    w.write_all(channel).await?;
    w.write_all(payload).await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<(String, Vec<u8>)>> {
    let total = match r.read_u32().await {
        Ok(n) => n as usize,
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    };
    if !(2..=MAX_FRAME_LEN).contains(&total) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame length out of bounds",
        ));
    }
    let mut buf = vec![0u8; total];
    r.read_exact(&mut buf).await?;
    let channel_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
    if 2 + channel_len > total {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "channel length exceeds frame",
        ));
    }
    let channel = std::str::from_utf8(&buf[2..2 + channel_len])
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "channel not UTF-8"))?
        .to_string();
    Ok(Some((channel, buf[2 + channel_len..].to_vec())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_frame(&mut a, "pty/t-1", b"ls -la\n").await.unwrap();
        drop(a);
        let (channel, payload) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(channel, "pty/t-1");
        assert_eq!(payload, b"ls -la\n");
        assert_eq!(read_frame(&mut b).await.unwrap(), None);
    }

    /// Same pinned vector as agent/src/mux.rs — the two crates must agree on
    /// the wire, byte for byte.
    #[tokio::test]
    async fn frame_byte_layout_is_pinned() {
        let (mut a, mut b) = tokio::io::duplex(64);
        write_frame(&mut a, "ctl", b"{}").await.unwrap();
        drop(a);
        let mut bytes = Vec::new();
        b.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, vec![0, 0, 0, 7, 0, 3, b'c', b't', b'l', b'{', b'}']);
    }
}
