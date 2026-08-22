//! Channel mux framing.
//!
//! Transport is a single TCP connection carrying length-prefixed frames; each
//! frame names its channel. MASQUE/QUIC (one stream per channel, connection
//! migration) is the V2 transport per PRD §8.4 — the framing here is the
//! stand-in that keeps channel semantics identical when that lands.
//!
//! Frame layout (all integers big-endian):
//!
//! ```text
//! u32 total_len           = 2 + channel_len + payload_len
//! u16 channel_len
//! [channel_len] channel   UTF-8 channel name ("ctl", "pty/<id>", ...)
//! [rest]        payload
//! ```
//!
//! Channel names mirror `parseChannel` in `packages/protocol/src/agent.ts`:
//! `ctl` | `pty/<id>` | `fwd/<port>` | `vfs` | `log`.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Refuse frames larger than this: the mux carries terminal I/O and control
/// JSON, not bulk transfer — an oversized frame is a bug or an attack.
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub channel: String,
    pub payload: Vec<u8>,
}

/// A parsed channel label (PRD Appendix C).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Channel {
    Auth,
    Ctl,
    Pty(String),
    Fwd {
        port: u16,
        /// Stream identity on transports where one connection carries many
        /// forward streams (the relay). Over per-connection TCP the bare
        /// form suffices — the connection IS the stream — and the id, when
        /// present, is accepted and ignored.
        stream: Option<String>,
    },
    Vfs,
    Log,
}

/// Mirror of the TS `parseChannel`, including its rejections: unknown heads,
/// a missing slash, an empty pty id, and out-of-range ports are all `None`.
/// Like the TS version (which splits on the *first* slash), a pty id may
/// itself contain `/`. Both sides parse the fwd port as STRICT decimal
/// digits (the TS side was tightened to match when stream ids landed —
/// `"fwd/80abc"` is a rejection everywhere). `fwd/<port>/<streamId>` names
/// one stream on a shared connection; the id is any non-empty suffix.
pub fn parse_channel(name: &str) -> Option<Channel> {
    match name {
        "auth" => return Some(Channel::Auth),
        "ctl" => return Some(Channel::Ctl),
        "vfs" => return Some(Channel::Vfs),
        "log" => return Some(Channel::Log),
        _ => {}
    }
    let (head, rest) = name.split_once('/')?;
    match head {
        "pty" if !rest.is_empty() => Some(Channel::Pty(rest.to_string())),
        "fwd" => {
            let (port_part, stream) = match rest.split_once('/') {
                Some((port_part, id)) if !id.is_empty() => (port_part, Some(id.to_string())),
                Some(_) => return None, // "fwd/3000/" — empty id refused
                None => (rest, None),
            };
            let port: u16 = port_part.parse().ok()?;
            if port == 0 {
                return None;
            }
            Some(Channel::Fwd { port, stream })
        }
        _ => None,
    }
}

/// The wire name for a channel — inverse of [`parse_channel`].
pub fn channel_name(channel: &Channel) -> String {
    match channel {
        Channel::Auth => "auth".to_string(),
        Channel::Ctl => "ctl".to_string(),
        Channel::Pty(id) => format!("pty/{id}"),
        Channel::Fwd { port, stream: None } => format!("fwd/{port}"),
        Channel::Fwd {
            port,
            stream: Some(id),
        } => format!("fwd/{port}/{id}"),
        Channel::Vfs => "vfs".to_string(),
        Channel::Log => "log".to_string(),
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &Frame) -> std::io::Result<()> {
    let channel = frame.channel.as_bytes();
    if channel.len() > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "channel name too long",
        ));
    }
    let total = 2 + channel.len() + frame.payload.len();
    if total > MAX_FRAME_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame exceeds MAX_FRAME_LEN",
        ));
    }
    w.write_u32(total as u32).await?;
    w.write_u16(channel.len() as u16).await?;
    w.write_all(channel).await?;
    w.write_all(&frame.payload).await?;
    Ok(())
}

/// Read one frame. `Ok(None)` is a clean end-of-stream (peer closed between
/// frames); a stream that dies mid-frame is an error.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Frame>> {
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
    let payload = buf[2 + channel_len..].to_vec();
    Ok(Some(Frame { channel, payload }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_singleton_channels() {
        assert_eq!(parse_channel("auth"), Some(Channel::Auth));
        assert_eq!(parse_channel("ctl"), Some(Channel::Ctl));
        assert_eq!(parse_channel("vfs"), Some(Channel::Vfs));
        assert_eq!(parse_channel("log"), Some(Channel::Log));
    }

    #[test]
    fn parses_pty_and_fwd_channels() {
        assert_eq!(parse_channel("pty/abc"), Some(Channel::Pty("abc".into())));
        // First-slash split, mirroring the TS indexOf("/") behaviour.
        assert_eq!(parse_channel("pty/a/b"), Some(Channel::Pty("a/b".into())));
        assert_eq!(
            parse_channel("fwd/8080"),
            Some(Channel::Fwd {
                port: 8080,
                stream: None
            })
        );
        assert_eq!(
            parse_channel("fwd/65535"),
            Some(Channel::Fwd {
                port: 65535,
                stream: None
            })
        );
        // Stream-id form for shared-connection transports (the relay).
        assert_eq!(
            parse_channel("fwd/8080/s-1"),
            Some(Channel::Fwd {
                port: 8080,
                stream: Some("s-1".into())
            })
        );
    }

    #[test]
    fn rejects_what_the_ts_parser_rejects() {
        for name in [
            "",
            "noslash",
            "pty/",
            "fwd/",
            "fwd/0",
            "fwd/65536",
            "fwd/abc",
            "fwd/-1",
            "fwd/8080/",
            "fwd/80abc/s-1",
            "web/1",
            "CTL",
            "ctl/x",
        ] {
            assert_eq!(parse_channel(name), None, "{name:?}");
        }
    }

    #[test]
    fn channel_names_round_trip() {
        for name in [
            "auth",
            "ctl",
            "vfs",
            "log",
            "pty/t-1",
            "fwd/3000",
            "fwd/3000/abc",
        ] {
            let ch = parse_channel(name).unwrap();
            assert_eq!(channel_name(&ch), name);
        }
    }

    #[tokio::test]
    async fn frames_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let frame = Frame {
            channel: "pty/t-1".into(),
            payload: vec![0, 159, 146, 150, b'\n'], // non-UTF-8 payload is fine
        };
        write_frame(&mut a, &frame).await.unwrap();
        drop(a);
        let read = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(read, frame);
        assert_eq!(read_frame(&mut b).await.unwrap(), None); // clean EOF
    }

    /// Pins the exact byte layout. sidecar/src/agent_client.rs carries the
    /// same vector — if either side changes framing, both tests must move.
    #[tokio::test]
    async fn frame_byte_layout_is_pinned() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let frame = Frame {
            channel: "ctl".into(),
            payload: b"{}".to_vec(),
        };
        write_frame(&mut a, &frame).await.unwrap();
        drop(a);
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut b, &mut bytes)
            .await
            .unwrap();
        assert_eq!(bytes, vec![0, 0, 0, 7, 0, 3, b'c', b't', b'l', b'{', b'}']);
    }
}
