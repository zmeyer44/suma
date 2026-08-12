//! The CONNECT accept loop and tunnel splice.
//!
//! The request flow is deliberately short: parse the CONNECT head, verify the
//! bearer token, check target policy, resolve + re-check, dial, answer
//! `200 Connection Established`, then [`tokio::io::copy_bidirectional`] until
//! either side closes. Everything after the 200 is an opaque byte splice —
//! TLS remains end-to-end between the client and the site, which is the whole
//! point of a *blind* gateway (PRD §8.4). Anything that is not CONNECT gets a
//! 405: the gateway is not, and must never become, a plaintext HTTP proxy —
//! that would put user request contents in front of our code.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpListener, TcpStream};

use crate::auth::TokenVerifier;
use crate::metrics::{ConnectionSample, EgressMetrics};
use crate::policy::Policy;

/// Upper bound on a CONNECT head. A legitimate head is a request line plus a
/// handful of proxy headers; anything larger is malformed or hostile.
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// Deadlines that bound one connection's cost.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// Time to deliver a complete CONNECT head. A real head arrives in one or
    /// two packets; a client dribbling bytes for longer is stalled or running
    /// slowloris, and without this bound each such client costs a task and a
    /// socket indefinitely.
    pub head_read: Duration,
    /// Time a spliced tunnel may go with no bytes in *either* direction. The
    /// deadline is shared across directions on purpose: a large download is
    /// not idle just because the client is quiet.
    pub idle: Duration,
}

impl Default for Timeouts {
    /// Production values. `idle` is deliberately generous — a long-poll or an
    /// open websocket is legitimately silent for minutes, and cutting those
    /// would be a worse bug than the socket it reclaims.
    fn default() -> Self {
        Timeouts {
            head_read: Duration::from_secs(10),
            idle: Duration::from_secs(300),
        }
    }
}

/// Everything a running gateway needs. Built once at startup; immutable
/// afterwards — the gateway has no runtime configuration surface.
pub struct Gateway {
    pub verifier: Box<dyn TokenVerifier>,
    pub policy: Policy,
    pub metrics: EgressMetrics,
    pub timeouts: Timeouts,
}

/// The parsed CONNECT head: target plus the bearer token, nothing more. No
/// other header is ever looked at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub host: String,
    pub port: u16,
    pub bearer: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadError {
    /// Syntactically broken head → 400.
    Malformed,
    /// Well-formed HTTP, wrong method → 405 (CONNECT-only, by design).
    NotConnect,
}

/// Parse a CONNECT head (`CONNECT host:port HTTP/1.1` + headers). Only the
/// request line and `Proxy-Authorization` are consulted.
pub fn parse_connect_head(head: &str) -> Result<ConnectRequest, HeadError> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(HeadError::Malformed)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(HeadError::Malformed)?;
    let target = parts.next().ok_or(HeadError::Malformed)?;
    let version = parts.next().ok_or(HeadError::Malformed)?;
    if !version.starts_with("HTTP/") || parts.next().is_some() {
        return Err(HeadError::Malformed);
    }
    if !method.eq_ignore_ascii_case("CONNECT") {
        return Err(HeadError::NotConnect);
    }

    let (host, port) = split_authority(target).ok_or(HeadError::Malformed)?;

    let mut bearer = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(HeadError::Malformed);
        };
        if name.trim().eq_ignore_ascii_case("proxy-authorization") {
            let value = value.trim();
            if let Some((scheme, token)) = value.split_once(' ') {
                if scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty() {
                    bearer = Some(token.trim().to_string());
                }
            }
        }
    }

    Ok(ConnectRequest {
        host: host.to_string(),
        port,
        bearer,
    })
}

/// Split `host:port`, including the `[v6]:port` bracket form.
fn split_authority(target: &str) -> Option<(&str, u16)> {
    let (host, port_str) = if let Some(rest) = target.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        (host, rest.strip_prefix(':')?)
    } else {
        target.rsplit_once(':')?
    };
    if host.is_empty() {
        return None;
    }
    let port: u16 = port_str.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some((host, port))
}

/// Accept loop. Runs until the listener errors; each connection is served on
/// its own task so a slow tunnel never blocks the accept path.
pub async fn serve(listener: TcpListener, gateway: Arc<Gateway>) -> std::io::Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let gw = Arc::clone(&gateway);
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, gw).await {
                tracing::debug!(%peer, error = %err, "tunnel closed with error");
            }
        });
    }
}

async fn handle_connection(mut client: TcpStream, gw: Arc<Gateway>) -> anyhow::Result<()> {
    let Ok(head_read) = tokio::time::timeout(gw.timeouts.head_read, read_head(&mut client)).await
    else {
        return respond(&mut client, "408 Request Timeout", "request head timed out").await;
    };
    let Some((head, leftover)) = head_read? else {
        return respond(&mut client, "400 Bad Request", "malformed request head").await;
    };

    let request = match parse_connect_head(&head) {
        Ok(req) => req,
        Err(HeadError::NotConnect) => {
            // CONNECT-only: refusing other methods is what keeps the gateway
            // blind — a GET handler would mean reading user request content.
            return respond(&mut client, "405 Method Not Allowed", "CONNECT only").await;
        }
        Err(HeadError::Malformed) => {
            return respond(&mut client, "400 Bad Request", "malformed request head").await;
        }
    };

    let user_id = match request
        .bearer
        .as_deref()
        .and_then(|t| gw.verifier.verify(t))
    {
        Some(user) => user,
        None => {
            return respond_407(&mut client).await;
        }
    };

    if let Err(refusal) = gw.policy.check_target(&request.host, request.port) {
        return respond(&mut client, "403 Forbidden", &refusal.to_string()).await;
    }

    // Resolve, then re-check every produced address: a public-looking name
    // must not be allowed to rebind into loopback/private space (SSRF).
    let addrs: Vec<_> = match lookup_host((request.host.as_str(), request.port)).await {
        Ok(addrs) => addrs
            .filter(|a| gw.policy.check_resolved(a.ip()).is_ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    if addrs.is_empty() {
        return respond(
            &mut client,
            "403 Forbidden",
            "target did not resolve to a permitted address",
        )
        .await;
    }

    let mut upstream = match connect_any(&addrs).await {
        Some(stream) => stream,
        None => {
            return respond(&mut client, "502 Bad Gateway", "could not reach target").await;
        }
    };

    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    // Bytes the client pipelined behind its CONNECT head (typically the TLS
    // ClientHello) must reach the target or the tunnel deadlocks.
    if !leftover.is_empty() {
        upstream.write_all(&leftover).await?;
    }

    let started = Instant::now();
    let (to_target, to_client) =
        splice_until_idle(&mut client, &mut upstream, gw.timeouts.idle).await;
    gw.metrics.record(
        &user_id,
        ConnectionSample {
            bytes_to_target: to_target + leftover.len() as u64,
            bytes_to_client: to_client,
            duration: started.elapsed(),
        },
    );
    Ok(())
}

/// [`tokio::io::copy_bidirectional`] plus an idle deadline, returning the byte
/// counts metrics needs however the tunnel ended. Still a blind splice: the
/// bytes are counted and forwarded, never inspected.
///
/// One shared deadline covers both directions — see [`Timeouts::idle`] — and
/// it resets on any traffic, so only a tunnel that is genuinely doing nothing
/// is reclaimed. Half-close is preserved: an EOF from one side shuts down the
/// other's write half and the remaining direction keeps flowing.
async fn splice_until_idle(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    idle: Duration,
) -> (u64, u64) {
    let mut to_target: u64 = 0;
    let mut to_client: u64 = 0;
    let mut from_client = vec![0u8; 16 * 1024];
    let mut from_upstream = vec![0u8; 16 * 1024];
    let mut client_done = false;
    let mut upstream_done = false;

    while !(client_done && upstream_done) {
        tokio::select! {
            // TcpStream::read is cancel-safe, so losing this branch to the
            // timeout or the other direction cannot swallow bytes.
            read = client.read(&mut from_client), if !client_done => match read {
                Ok(0) | Err(_) => {
                    client_done = true;
                    let _ = upstream.shutdown().await;
                }
                Ok(n) => {
                    if upstream.write_all(&from_client[..n]).await.is_err() {
                        break;
                    }
                    to_target += n as u64;
                }
            },
            read = upstream.read(&mut from_upstream), if !upstream_done => match read {
                Ok(0) | Err(_) => {
                    upstream_done = true;
                    let _ = client.shutdown().await;
                }
                Ok(n) => {
                    if client.write_all(&from_upstream[..n]).await.is_err() {
                        break;
                    }
                    to_client += n as u64;
                }
            },
            _ = tokio::time::sleep(idle) => {
                tracing::debug!("tunnel closed after idle timeout");
                break;
            }
        }
    }
    (to_target, to_client)
}

async fn connect_any(addrs: &[std::net::SocketAddr]) -> Option<TcpStream> {
    for addr in addrs {
        if let Ok(stream) = TcpStream::connect(addr).await {
            return Some(stream);
        }
    }
    None
}

/// Read up to the `\r\n\r\n` head terminator. Returns the head text and any
/// bytes read past it (which belong to the tunnel, not to us).
async fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<(String, Vec<u8>)>> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = find_head_end(&buf) {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let leftover = buf[end + 4..].to_vec();
            return Ok(Some((head, leftover)));
        }
        if buf.len() >= MAX_HEAD_BYTES {
            return Ok(None);
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> anyhow::Result<()> {
    let body = format!("{body}\n");
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    Ok(())
}

async fn respond_407(stream: &mut TcpStream) -> anyhow::Result<()> {
    let body = "proxy authentication required\n";
    let head = format!(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer realm=\"suma-egress\"\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_connect_head_with_bearer_token() {
        let head = "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Bearer sm-egress-v1.u1.sig\r\n";
        let req = parse_connect_head(head).unwrap();
        assert_eq!(req.host, "example.com");
        assert_eq!(req.port, 443);
        assert_eq!(req.bearer.as_deref(), Some("sm-egress-v1.u1.sig"));
    }

    #[test]
    fn parses_an_ipv6_bracketed_target() {
        let req = parse_connect_head("CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n").unwrap();
        assert_eq!(req.host, "2606:4700::1111");
        assert_eq!(req.port, 443);
    }

    #[test]
    fn a_missing_token_parses_as_bearer_none() {
        let req = parse_connect_head("CONNECT example.com:443 HTTP/1.1\r\n").unwrap();
        assert_eq!(req.bearer, None);
        // Basic (non-bearer) credentials are not a token either.
        let req = parse_connect_head(
            "CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic dXNlcjpwdw==\r\n",
        )
        .unwrap();
        assert_eq!(req.bearer, None);
    }

    #[test]
    fn non_connect_methods_are_rejected_as_not_connect() {
        for head in [
            "GET http://example.com/ HTTP/1.1\r\n",
            "POST example.com:443 HTTP/1.1\r\n",
        ] {
            assert_eq!(
                parse_connect_head(head),
                Err(HeadError::NotConnect),
                "{head}"
            );
        }
    }

    #[test]
    fn malformed_heads_are_rejected() {
        for head in [
            "",
            "CONNECT\r\n",
            "CONNECT example.com HTTP/1.1\r\n",       // no port
            "CONNECT example.com:0 HTTP/1.1\r\n",     // port zero
            "CONNECT example.com:99999 HTTP/1.1\r\n", // port overflow
            "CONNECT example.com:443 HTTP/1.1 extra\r\n",
            "CONNECT example.com:443 FTP/1.0\r\n",
            "CONNECT example.com:443 HTTP/1.1\r\nnot-a-header\r\n",
        ] {
            assert_eq!(
                parse_connect_head(head),
                Err(HeadError::Malformed),
                "{head:?}"
            );
        }
    }
}
