//! suma-egressgw binary. All behaviour lives in the library crate
//! ([`suma_egressgw`]); this entrypoint only resolves startup config and
//! runs the accept loop. There is deliberately nothing else to configure — the
//! gateway is non-programmable by design (PRD §8.4).
//!
//! Startup can fail before a socket exists: [`suma_egressgw::startup`] has
//! no configuration that serves traffic with an unverifying token verifier on
//! a routable address. The insecure dev path exists, but only behind an
//! explicit opt-in that pins the listener to loopback.

use std::sync::Arc;

use suma_egressgw::metrics::EgressMetrics;
use suma_egressgw::policy::Policy;
use suma_egressgw::server::{serve, Gateway, Timeouts};
use suma_egressgw::startup::{self, StartupEnv};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();

    let config = startup::resolve(StartupEnv::from_process_env())?;
    if config.dev_insecure {
        tracing::warn!(
            "{}=1: tokens are NOT authenticated; loopback-only listener",
            startup::DEV_INSECURE_VAR
        );
    }

    let gateway = Arc::new(Gateway {
        verifier: config.verifier,
        policy: Policy::new(config.extra_ports),
        metrics: EgressMetrics::default(),
        timeouts: Timeouts::default(),
    });

    let listener = TcpListener::bind(&config.listen).await?;
    tracing::info!(addr = %listener.local_addr()?, "egress gateway listening (CONNECT only)");
    serve(listener, gateway).await?;
    Ok(())
}
