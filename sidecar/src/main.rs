//! sumad binary — binds the localhost CONNECT proxy and serves it. All
//! behaviour lives in the library crate; this is wiring.
//!
//! Transport note: the sumad↔gateway leg is TCP CONNECT in this phase;
//! the QUIC tunnel (mTLS device cert, connection migration) is the V2 path
//! per PRD §8.4, and the sumad↔agent mux likewise rides TCP until then.

use std::sync::Arc;

use sumad::proxy::{proxy_config_from_env, run_proxy, ProxyEnv};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();

    let listen =
        std::env::var("SUMA_PROXY_LISTEN").unwrap_or_else(|_| "127.0.0.1:7890".to_string());

    // Dev wiring: the gateway link comes from the environment. Real per-space
    // config arrives from the control plane in Phase 3. Whatever the source,
    // the daemon's default stays fail-closed — see `proxy_config_from_env`.
    let config = Arc::new(proxy_config_from_env(ProxyEnv {
        gateway_addr: std::env::var("SUMA_GATEWAY_ADDR").ok(),
        gateway_token: std::env::var("SUMA_GATEWAY_TOKEN").ok(),
        temporary_direct_override: std::env::var("SUMA_EGRESS_DIRECT_OVERRIDE")
            .is_ok_and(|v| v == "1"),
    }));

    let listener = TcpListener::bind(&listen).await?;
    if config.gateway.is_none() {
        tracing::warn!(
            "no identity gateway configured (SUMA_GATEWAY_ADDR / SUMA_GATEWAY_TOKEN): \
             proxied requests will be refused with 502 rather than dialed direct"
        );
    }
    tracing::info!(addr = %listener.local_addr()?, "sumad CONNECT proxy listening");
    run_proxy(listener, config).await?;
    Ok(())
}
