//! Loopback integration tests: a real gateway on an ephemeral port, a real
//! echo server behind it. The splice test is the executable form of the
//! "blind by construction" claim — bytes (including non-UTF-8 binary) cross
//! the tunnel unmodified in both directions, because the gateway has no code
//! path that could look at them.

use std::sync::Arc;
use std::time::Duration;

use suma_egressgw::auth::DevTokenVerifier;
use suma_egressgw::metrics::EgressMetrics;
use suma_egressgw::policy::Policy;
use suma_egressgw::server::{serve, Gateway, Timeouts};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Millisecond deadlines so the timeout tests finish in milliseconds; the
/// production values live in `Timeouts::default`.
fn fast_timeouts() -> Timeouts {
    Timeouts {
        head_read: Duration::from_millis(150),
        idle: Duration::from_millis(150),
    }
}

/// Echo server on an ephemeral loopback port; echoes every byte back.
async fn start_echo() -> std::io::Result<std::net::SocketAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            if stream.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
    });
    Ok(addr)
}

/// Gateway on an ephemeral port, with a policy permitting the loopback echo
/// target (production policy never does; see Policy::permissive_for_local).
async fn start_gateway(extra_port: u16) -> std::io::Result<std::net::SocketAddr> {
    start_gateway_with(extra_port, Timeouts::default()).await
}

async fn start_gateway_with(
    extra_port: u16,
    timeouts: Timeouts,
) -> std::io::Result<std::net::SocketAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let gateway = Arc::new(Gateway {
        verifier: Box::new(DevTokenVerifier),
        policy: Policy::permissive_for_local([extra_port]),
        metrics: EgressMetrics::default(),
        timeouts,
    });
    tokio::spawn(async move {
        let _ = serve(listener, gateway).await;
    });
    Ok(addr)
}

async fn read_response_head(stream: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let n = stream.read(&mut byte).await.expect("read response head");
        if n == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}

#[tokio::test]
async fn tunnel_is_a_blind_splice() {
    let echo = start_echo().await.unwrap();
    let gw = start_gateway(echo.port()).await.unwrap();

    let mut client = TcpStream::connect(gw).await.unwrap();
    let connect = format!(
        "CONNECT 127.0.0.1:{} HTTP/1.1\r\nProxy-Authorization: Bearer sm-egress-v1.tester.sig\r\n\r\n",
        echo.port()
    );
    client.write_all(connect.as_bytes()).await.unwrap();

    let head = read_response_head(&mut client).await;
    assert!(
        head.starts_with("HTTP/1.1 200"),
        "expected 200, got: {head}"
    );

    // Binary payload, deliberately not valid UTF-8 and not HTTP-shaped: the
    // tunnel must carry it untouched.
    let payload: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
    for _ in 0..3 {
        client.write_all(&payload).await.unwrap();
        let mut echoed = vec![0u8; payload.len()];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed, payload, "bytes must cross the tunnel unmodified");
    }
}

#[tokio::test]
async fn non_connect_requests_get_405() {
    let gw = start_gateway(1).await.unwrap();
    let mut client = TcpStream::connect(gw).await.unwrap();
    client
        .write_all(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
        .await
        .unwrap();
    let head = read_response_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 405"), "got: {head}");
}

#[tokio::test]
async fn missing_token_gets_407() {
    let echo = start_echo().await.unwrap();
    let gw = start_gateway(echo.port()).await.unwrap();
    let mut client = TcpStream::connect(gw).await.unwrap();
    let connect = format!("CONNECT 127.0.0.1:{} HTTP/1.1\r\n\r\n", echo.port());
    client.write_all(connect.as_bytes()).await.unwrap();
    let head = read_response_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 407"), "got: {head}");
    assert!(head.contains("Proxy-Authenticate: Bearer"), "got: {head}");
}

#[tokio::test]
async fn policy_refusal_gets_403_with_a_strict_gateway() {
    // Strict (production-shaped) policy: loopback target refused even with a
    // valid token — the gateway must not be an SSRF pivot.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let gateway = Arc::new(Gateway {
        verifier: Box::new(DevTokenVerifier),
        policy: Policy::new([]),
        metrics: EgressMetrics::default(),
        timeouts: Timeouts::default(),
    });
    tokio::spawn(async move {
        let _ = serve(listener, gateway).await;
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    client
        .write_all(
            b"CONNECT 127.0.0.1:443 HTTP/1.1\r\nProxy-Authorization: Bearer sm-egress-v1.tester.sig\r\n\r\n",
        )
        .await
        .unwrap();
    let head = read_response_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 403"), "got: {head}");
}

/// Slowloris: a head that never terminates must not hold a task and a socket
/// forever.
#[tokio::test]
async fn a_stalled_request_head_times_out() {
    let gw = start_gateway_with(1, fast_timeouts()).await.unwrap();
    let mut client = TcpStream::connect(gw).await.unwrap();
    client.write_all(b"CONNECT exa").await.unwrap();

    let head = read_response_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 408"), "got: {head}");
}

/// An established tunnel with no traffic in either direction is reclaimed.
#[tokio::test]
async fn an_idle_tunnel_is_closed() {
    let echo = start_echo().await.unwrap();
    let gw = start_gateway_with(echo.port(), fast_timeouts())
        .await
        .unwrap();

    let mut client = TcpStream::connect(gw).await.unwrap();
    let connect = format!(
        "CONNECT 127.0.0.1:{} HTTP/1.1\r\nProxy-Authorization: Bearer sm-egress-v1.tester.sig\r\n\r\n",
        echo.port()
    );
    client.write_all(connect.as_bytes()).await.unwrap();
    let head = read_response_head(&mut client).await;
    assert!(head.starts_with("HTTP/1.1 200"), "got: {head}");

    // Traffic keeps it alive across more than one idle window...
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(60)).await;
        client.write_all(b"tick").await.unwrap();
        let mut echoed = [0u8; 4];
        client.read_exact(&mut echoed).await.unwrap();
    }

    // ...and silence ends it. The gateway drops both sockets, so the client's
    // next read is a clean EOF rather than a hang.
    let mut buf = [0u8; 1];
    let n = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
        .await
        .expect("idle tunnel must be closed, not left hanging")
        .unwrap();
    assert_eq!(n, 0, "expected EOF after the idle timeout");
}
