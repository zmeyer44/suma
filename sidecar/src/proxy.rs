//! The localhost CONNECT proxy Chromium points proxied spaces at (PRD §7,
//! §8.4).
//!
//! Every CONNECT is routed by [`plan`]: direct dial, tunnel via the identity
//! gateway, or **refuse**. The refuse arm answers `502` with a body that
//! names Suma and the reason — and it returns before any outbound socket
//! is opened. That structure is the point: "zero silent fallback to direct"
//! is a beta gate, and the only way to make "we never quietly leaked your
//! IP" trustworthy is for the blocked path to be incapable of dialing.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::policy::{
    decide_egress, default_space_egress, EgressDecision, EgressRoute, GatewayState, NetworkContext,
    SpaceEgressConfig, SpacePolicy,
};

const MAX_HEAD_BYTES: usize = 8 * 1024;

/// How to reach the identity egress gateway.
#[derive(Debug, Clone)]
pub struct GatewayLink {
    pub addr: String,
    /// Bearer token for the gateway's `Proxy-Authorization` (see
    /// services/egressgw/src/auth.rs).
    pub token: String,
}

pub struct ProxyConfig {
    pub space: SpaceEgressConfig,
    pub net: NetworkContext,
    pub gateway: Option<GatewayLink>,
}

/// Startup inputs for the local proxy. Passed in rather than read from
/// `std::env` inside [`proxy_config_from_env`] so the fail-closed default is
/// testable without mutating process-global state.
#[derive(Debug, Clone, Default)]
pub struct ProxyEnv {
    pub gateway_addr: Option<String>,
    pub gateway_token: Option<String>,
    /// The one-click "browse direct for now" override (§8.4). Not sticky: it
    /// lives for one daemon run and must be re-asked for after a restart.
    pub temporary_direct_override: bool,
}

/// Build the configuration sumad's local proxy runs with.
///
/// **The default is fail closed.** Chromium points a space at this proxy only
/// when the user asked that space to browse through the identity IP, so an
/// unconfigured daemon means "the gateway is missing", never "browse direct":
/// the effective policy is always `SumaIp`, and an absent or half-configured
/// gateway link is a `Down` gateway, which [`decide_egress`] turns into
/// Blocked ⇒ 502. The `direct` default of the TS `defaultSpaceEgress` belongs
/// to spaces that never reach this proxy at all — inheriting it here is what
/// would turn a missing gateway into a silent real-IP leak (§8.4 beta gate).
///
/// The explicit override still works: with it set, a gateway-down decision is
/// `gateway_down_override` ⇒ Direct, exactly as the banner promises.
pub fn proxy_config_from_env(env: ProxyEnv) -> ProxyConfig {
    let gateway = match (env.gateway_addr, env.gateway_token) {
        (Some(addr), Some(token)) if !addr.trim().is_empty() && !token.trim().is_empty() => {
            Some(GatewayLink { addr, token })
        }
        // A half-configured link is no link: an address we hold no token for
        // cannot carry a tunnel, and calling that state Up would hide the
        // missing credential behind a connection error.
        _ => None,
    };
    let space = SpaceEgressConfig {
        policy: SpacePolicy::SumaIp,
        temporary_direct_override: env.temporary_direct_override,
        ..default_space_egress("dev-space")
    };
    let net = NetworkContext {
        gateway: if gateway.is_some() {
            GatewayState::Up
        } else {
            GatewayState::Down
        },
        vpn_routes: Vec::new(),
        vpn_active: false,
    };
    ProxyConfig {
        space,
        net,
        gateway,
    }
}

/// What the proxy will do for one host — the routing decision mapped onto an
/// action. Kept separate from I/O so tests can prove the blocked arm never
/// reaches a dial.
#[derive(Debug, Clone, PartialEq)]
pub enum ProxyAction {
    DialDirect,
    TunnelViaGateway,
    Refuse(EgressDecision),
}

pub fn plan(host: &str, config: &ProxyConfig) -> (EgressDecision, ProxyAction) {
    let decision = decide_egress(host, &config.space, &config.net);
    let action = match decision.route {
        EgressRoute::Direct => ProxyAction::DialDirect,
        EgressRoute::Gateway => ProxyAction::TunnelViaGateway,
        EgressRoute::Blocked => ProxyAction::Refuse(decision.clone()),
    };
    (decision, action)
}

/// Accept loop. Each connection is served on its own task.
pub async fn run_proxy(listener: TcpListener, config: Arc<ProxyConfig>) -> std::io::Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let config = Arc::clone(&config);
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, &config).await {
                tracing::debug!(error = %err, "proxy connection closed");
            }
        });
    }
}

async fn handle_connection(mut client: TcpStream, config: &ProxyConfig) -> anyhow::Result<()> {
    let Some((head, leftover)) = read_head(&mut client).await? else {
        return respond(&mut client, "400 Bad Request", "Suma: malformed request").await;
    };
    let Some((host, port)) = parse_connect_target(&head) else {
        // Not CONNECT (or no parsable target): sumad tunnels TCP only.
        return respond(
            &mut client,
            "405 Method Not Allowed",
            "Suma: CONNECT only",
        )
        .await;
    };

    let (decision, action) = plan(&host, config);
    // The host is deliberately absent from this record, at every log level.
    // §9 promises no browsing-content telemetry, and a daemon log listing
    // every hostname a space visited *is* a browsing history — one sitting in
    // plaintext on the user's disk. The reason is what operators need to
    // debug routing; the host adds nothing they cannot get from the user.
    tracing::debug!(reason = decision.reason.as_str(), "routed");

    match action {
        ProxyAction::Refuse(decision) => {
            // Fail closed: no outbound socket exists on this path, so a
            // gateway outage can never silently become a direct dial.
            respond(
                &mut client,
                "502 Bad Gateway",
                &format!("Suma blocked this request: {}", decision.explanation),
            )
            .await
        }
        ProxyAction::DialDirect => {
            let mut upstream = match TcpStream::connect((host.as_str(), port)).await {
                Ok(s) => s,
                Err(_) => {
                    return respond(
                        &mut client,
                        "502 Bad Gateway",
                        &format!("Suma: could not reach {host}"),
                    )
                    .await;
                }
            };
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
            if !leftover.is_empty() {
                upstream.write_all(&leftover).await?;
            }
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            Ok(())
        }
        ProxyAction::TunnelViaGateway => {
            // The decision said "gateway", so only the gateway may carry it.
            // Any failure from here on is a 502, never a direct dial — a
            // dying tunnel must not demote itself to a leak.
            let Some(link) = config.gateway.as_ref() else {
                return respond(
                    &mut client,
                    "502 Bad Gateway",
                    "Suma: no identity gateway configured; refusing to browse direct",
                )
                .await;
            };
            let mut upstream = match TcpStream::connect(link.addr.as_str()).await {
                Ok(s) => s,
                Err(_) => {
                    return respond(
                        &mut client,
                        "502 Bad Gateway",
                        "Suma: identity gateway unreachable; refusing to browse direct",
                    )
                    .await;
                }
            };
            let connect = format!(
                "CONNECT {host}:{port} HTTP/1.1\r\nProxy-Authorization: Bearer {}\r\n\r\n",
                link.token
            );
            upstream.write_all(connect.as_bytes()).await?;
            let Some((gw_head, gw_leftover)) = read_head_from(&mut upstream).await? else {
                return respond(&mut client, "502 Bad Gateway", "Suma: gateway hung up").await;
            };
            if !gw_head.starts_with("HTTP/1.1 200") {
                return respond(
                    &mut client,
                    "502 Bad Gateway",
                    "Suma: identity gateway refused the tunnel",
                )
                .await;
            }
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
            if !leftover.is_empty() {
                upstream.write_all(&leftover).await?;
            }
            if !gw_leftover.is_empty() {
                client.write_all(&gw_leftover).await?;
            }
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            Ok(())
        }
    }
}

/// Extract `host:port` from a CONNECT request line; `None` for anything that
/// is not a CONNECT.
pub fn parse_connect_target(head: &str) -> Option<(String, u16)> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let target = parts.next()?;
    let (host, port_str) = if let Some(rest) = target.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        (host, rest.strip_prefix(':')?)
    } else {
        target.rsplit_once(':')?
    };
    let port: u16 = port_str.parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<(String, Vec<u8>)>> {
    read_head_from(stream).await
}

/// Read up to `\r\n\r\n`, returning the head and any bytes past it (they
/// belong to the tunnel).
async fn read_head_from(stream: &mut TcpStream) -> std::io::Result<Option<(String, Vec<u8>)>> {
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            return Ok(Some((head, buf[end + 4..].to_vec())));
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

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> anyhow::Result<()> {
    let body = format!("{body}\n");
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nX-Suma-Proxy: sumad\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{default_space_egress, GatewayState, SpacePolicy};

    fn work_config(gateway_state: GatewayState, link: Option<GatewayLink>) -> ProxyConfig {
        ProxyConfig {
            space: SpaceEgressConfig {
                policy: SpacePolicy::SumaIp,
                ..default_space_egress("work")
            },
            net: NetworkContext {
                gateway: gateway_state,
                vpn_routes: Vec::new(),
                vpn_active: false,
            },
            gateway: link,
        }
    }

    #[test]
    fn parses_connect_targets_and_rejects_other_methods() {
        assert_eq!(
            parse_connect_target("CONNECT example.com:443 HTTP/1.1\r\n"),
            Some(("example.com".to_string(), 443))
        );
        assert_eq!(
            parse_connect_target("CONNECT [::1]:8080 HTTP/1.1\r\n"),
            Some(("::1".to_string(), 8080))
        );
        assert_eq!(
            parse_connect_target("GET http://example.com/ HTTP/1.1\r\n"),
            None
        );
        assert_eq!(
            parse_connect_target("CONNECT example.com HTTP/1.1\r\n"),
            None
        );
    }

    /// The structural fail-closed proof: a blocked decision maps to Refuse —
    /// an action with no address in it, so the I/O layer has nothing it
    /// *could* dial.
    #[test]
    fn a_blocked_decision_maps_to_refuse_not_to_a_dial() {
        let config = work_config(GatewayState::Down, None);
        let (decision, action) = plan("github.com", &config);
        assert_eq!(decision.route, EgressRoute::Blocked);
        assert!(matches!(action, ProxyAction::Refuse(_)));

        // And gateway-up maps to the tunnel, never a direct dial.
        let config = work_config(GatewayState::Up, None);
        let (_, action) = plan("github.com", &config);
        assert_eq!(action, ProxyAction::TunnelViaGateway);

        // Loopback goes direct regardless of gateway state.
        let (_, action) = plan("127.0.0.1", &work_config(GatewayState::Down, None));
        assert_eq!(action, ProxyAction::DialDirect);
    }

    /// An unconfigured sumad is the dangerous case: it is exactly what a
    /// desktop that failed to deliver gateway config leaves running, and the
    /// spaces pointed at it are the ones that asked *not* to browse direct.
    #[test]
    fn an_unconfigured_daemon_plans_refuse_not_a_direct_dial() {
        let config = proxy_config_from_env(ProxyEnv::default());
        assert_eq!(config.space.policy, SpacePolicy::SumaIp);
        assert_eq!(config.net.gateway, GatewayState::Down);
        let (decision, action) = plan("github.com", &config);
        assert_eq!(
            decision.reason,
            crate::policy::EgressReason::GatewayDownFailclosed
        );
        assert!(matches!(action, ProxyAction::Refuse(_)));

        // Half-configured is still unconfigured.
        let half = proxy_config_from_env(ProxyEnv {
            gateway_addr: Some("gw.suma.test:8443".into()),
            ..ProxyEnv::default()
        });
        assert!(half.gateway.is_none());
        assert_eq!(
            plan("github.com", &half).1,
            ProxyAction::Refuse(decide_egress("github.com", &half.space, &half.net))
        );

        // A fully configured link tunnels, and the explicit override — the
        // only sanctioned way to browse direct — still works.
        let up = proxy_config_from_env(ProxyEnv {
            gateway_addr: Some("gw.suma.test:8443".into()),
            gateway_token: Some("sm-egress-v1.u.sig".into()),
            temporary_direct_override: false,
        });
        assert_eq!(plan("github.com", &up).1, ProxyAction::TunnelViaGateway);
        let overridden = proxy_config_from_env(ProxyEnv {
            temporary_direct_override: true,
            ..ProxyEnv::default()
        });
        let (decision, action) = plan("github.com", &overridden);
        assert_eq!(
            decision.reason,
            crate::policy::EgressReason::GatewayDownOverride
        );
        assert_eq!(action, ProxyAction::DialDirect);
    }

    async fn start_echo() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
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
        addr
    }

    async fn start_proxy(config: ProxyConfig) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = run_proxy(listener, Arc::new(config)).await;
        });
        addr
    }

    async fn read_response_head(stream: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            match stream.read(&mut byte).await {
                Ok(0) | Err(_) => break,
                Ok(_) => head.push(byte[0]),
            }
        }
        String::from_utf8_lossy(&head).into_owned()
    }

    #[tokio::test]
    async fn connect_to_a_local_echo_server_succeeds() {
        let echo = start_echo().await;
        // Default (personal) space: loopback is direct anyway.
        let proxy = start_proxy(ProxyConfig {
            space: default_space_egress("personal"),
            net: NetworkContext {
                gateway: GatewayState::Up,
                vpn_routes: Vec::new(),
                vpn_active: false,
            },
            gateway: None,
        })
        .await;

        let mut client = TcpStream::connect(proxy).await.unwrap();
        let connect = format!("CONNECT 127.0.0.1:{} HTTP/1.1\r\n\r\n", echo.port());
        client.write_all(connect.as_bytes()).await.unwrap();
        let head = read_response_head(&mut client).await;
        assert!(head.starts_with("HTTP/1.1 200"), "got: {head}");

        client.write_all(b"suma echo test").await.unwrap();
        let mut echoed = [0u8; 16];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"suma echo test");
    }

    #[tokio::test]
    async fn blocked_returns_502_identifying_suma_and_never_opens_a_socket() {
        // A "gateway" that must never be reached: count its accepts.
        let gw_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw_addr = gw_listener.local_addr().unwrap();
        let (accepted_tx, mut accepted_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        tokio::spawn(async move {
            while let Ok(_conn) = gw_listener.accept().await {
                let _ = accepted_tx.send(());
            }
        });

        // Gateway is DOWN by policy, but a link is configured — if the
        // blocked arm ever touched the network, this listener would see it.
        let proxy = start_proxy(work_config(
            GatewayState::Down,
            Some(GatewayLink {
                addr: gw_addr.to_string(),
                token: "sm-egress-v1.u.sig".to_string(),
            }),
        ))
        .await;

        let mut client = TcpStream::connect(proxy).await.unwrap();
        client
            .write_all(b"CONNECT github.com:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let head = read_response_head(&mut client).await;
        assert!(head.starts_with("HTTP/1.1 502"), "got: {head}");

        let mut body = String::new();
        client.read_to_string(&mut body).await.unwrap();
        assert!(body.contains("Suma blocked this request"), "got: {body}");
        assert!(
            body.contains("rather than reveal your real IP"),
            "got: {body}"
        );

        // The 502 has been fully delivered, so the request is over — and the
        // fake gateway never saw a connection.
        assert!(
            accepted_rx.try_recv().is_err(),
            "blocked request must not open any outbound socket"
        );
    }

    /// The same guarantee end to end, entered through the daemon's own
    /// startup path: no gateway environment at all, and nothing leaves the
    /// machine.
    #[tokio::test]
    async fn with_no_gateway_env_a_public_connect_is_502_and_dials_nothing() {
        // Canary listener. `127.1` is a *public* host to the policy — only the
        // dotted-quad `127.a.b.c` form is loopback, mirroring the TS regex —
        // yet getaddrinfo expands it to 127.0.0.1. So it is a host the Direct
        // arm would really dial, and this listener would really see.
        let canary = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let canary_port = canary.local_addr().unwrap().port();
        let (accepted_tx, mut accepted_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        tokio::spawn(async move {
            while let Ok(_conn) = canary.accept().await {
                let _ = accepted_tx.send(());
            }
        });

        let proxy = start_proxy(proxy_config_from_env(ProxyEnv::default())).await;

        for target in ["github.com:443".to_string(), format!("127.1:{canary_port}")] {
            let mut client = TcpStream::connect(proxy).await.unwrap();
            client
                .write_all(format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let head = read_response_head(&mut client).await;
            assert!(head.starts_with("HTTP/1.1 502"), "{target}: got {head}");
            let mut body = String::new();
            client.read_to_string(&mut body).await.unwrap();
            // The fail-closed body is unreachable from the Direct arm, whose
            // only answers are 200 or "could not reach <host>".
            assert!(
                body.contains("rather than reveal your real IP"),
                "{target}: got {body}"
            );
        }

        // Both requests are fully answered and closed by now.
        assert!(
            accepted_rx.try_recv().is_err(),
            "an unconfigured sumad must not open any outbound socket"
        );
    }

    #[tokio::test]
    async fn gateway_route_tunnels_through_the_gateway() {
        let echo = start_echo().await;

        // A miniature gateway: accepts one CONNECT, answers 200, splices to
        // the echo server (ignoring the stated target — this test only cares
        // that sumad speaks the gateway leg correctly).
        let gw_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw_addr = gw_listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = gw_listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let mut head = Vec::new();
            loop {
                let n = stream.read(&mut buf).await.unwrap();
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head_text = String::from_utf8_lossy(&head);
            assert!(head_text.starts_with("CONNECT github.com:443"));
            assert!(head_text.contains("Proxy-Authorization: Bearer sm-egress-v1.u.sig"));
            let mut upstream = TcpStream::connect(echo).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        });

        let proxy = start_proxy(work_config(
            GatewayState::Up,
            Some(GatewayLink {
                addr: gw_addr.to_string(),
                token: "sm-egress-v1.u.sig".to_string(),
            }),
        ))
        .await;

        let mut client = TcpStream::connect(proxy).await.unwrap();
        client
            .write_all(b"CONNECT github.com:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let head = read_response_head(&mut client).await;
        assert!(head.starts_with("HTTP/1.1 200"), "got: {head}");

        client.write_all(b"via-gateway").await.unwrap();
        let mut echoed = [0u8; 11];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"via-gateway");
    }
}
