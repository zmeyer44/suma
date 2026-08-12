//! Turning the environment into a running gateway — or refusing to run.
//!
//! The gateway holds the user's static browsing identity, and §9 assumes a
//! rooted VM may sit on the same network. So the startup contract is: the
//! process must never serve traffic on a routable address with a verifier that
//! does not verify. Two ways in, and no third:
//!
//! * `SUMA_EGRESS_TOKEN_SECRET` — a real (MAC-checking) verifier. Binds
//!   whatever `SUMA_EGRESSGW_LISTEN` says, `0.0.0.0:8443` by default.
//! * `SUMA_EGRESS_DEV_INSECURE=1` — the shape-check-only
//!   [`DevTokenVerifier`], and *only* on a loopback address. Anything else is
//!   a startup error, not a warning: a warning is something an operator
//!   scrolls past, and the failure mode here is an open proxy on the user's
//!   identity IP.
//!
//! Neither configured is also a startup error. There is deliberately no
//! default that serves.
//!
//! TLS/mTLS is not terminated here — see the README. The listener speaks
//! cleartext HTTP CONNECT and must sit behind an edge that terminates client
//! authentication, or on a network where only that edge can reach it.

use std::net::SocketAddr;

use anyhow::{bail, Context};

use crate::auth::{DevTokenVerifier, SharedSecretVerifier, TokenVerifier};

pub const LISTEN_VAR: &str = "SUMA_EGRESSGW_LISTEN";
pub const EXTRA_PORTS_VAR: &str = "SUMA_EGRESSGW_EXTRA_PORTS";
pub const SECRET_VAR: &str = "SUMA_EGRESS_TOKEN_SECRET";
pub const DEV_INSECURE_VAR: &str = "SUMA_EGRESS_DEV_INSECURE";

/// Where a real deployment binds. Cleartext CONNECT: an edge in front of it
/// terminates TLS/mTLS (README).
pub const DEFAULT_LISTEN: &str = "0.0.0.0:8443";
/// Where the dev-insecure mode binds when nothing is specified. Loopback, and
/// [`resolve`] refuses to move it off loopback.
pub const DEFAULT_DEV_LISTEN: &str = "127.0.0.1:8443";

/// The startup-relevant environment. Read once by
/// [`StartupEnv::from_process_env`]; taken as a value by [`resolve`] so the
/// refusals below are testable without mutating process-global state.
#[derive(Debug, Clone, Default)]
pub struct StartupEnv {
    pub listen: Option<String>,
    pub extra_ports: Option<String>,
    pub shared_secret_hex: Option<String>,
    pub dev_insecure: Option<String>,
}

impl StartupEnv {
    pub fn from_process_env() -> Self {
        fn var(name: &str) -> Option<String> {
            std::env::var(name).ok().filter(|v| !v.trim().is_empty())
        }
        StartupEnv {
            listen: var(LISTEN_VAR),
            extra_ports: var(EXTRA_PORTS_VAR),
            shared_secret_hex: var(SECRET_VAR),
            dev_insecure: var(DEV_INSECURE_VAR),
        }
    }
}

/// A resolved, serve-able configuration. Constructing one is the only way to
/// get a verifier into [`crate::server::Gateway`] from the binary.
pub struct Startup {
    pub listen: String,
    pub verifier: Box<dyn TokenVerifier>,
    pub extra_ports: Vec<u16>,
    /// True only on the explicit opt-in path; the caller logs it loudly.
    pub dev_insecure: bool,
}

/// Hand-written so no formatting of a [`Startup`] can ever reach into the
/// verifier and print key material.
impl std::fmt::Debug for Startup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Startup")
            .field("listen", &self.listen)
            .field("extra_ports", &self.extra_ports)
            .field("dev_insecure", &self.dev_insecure)
            .finish_non_exhaustive()
    }
}

pub fn resolve(env: StartupEnv) -> anyhow::Result<Startup> {
    let extra_ports = parse_extra_ports(env.extra_ports.as_deref());
    let dev_insecure = env.dev_insecure.as_deref() == Some("1");

    if env.dev_insecure.is_some() && !dev_insecure {
        bail!("{DEV_INSECURE_VAR} is set to something other than \"1\"; unset it or set it to 1");
    }

    match (dev_insecure, env.shared_secret_hex) {
        (true, Some(_)) => {
            // Ambiguous intent about the one thing that must not be ambiguous.
            bail!(
                "{DEV_INSECURE_VAR}=1 and {SECRET_VAR} are both set; \
                 refusing to guess which verifier you meant — unset one"
            )
        }
        (true, None) => {
            let listen = env.listen.unwrap_or_else(|| DEFAULT_DEV_LISTEN.to_string());
            require_loopback(&listen)?;
            Ok(Startup {
                listen,
                verifier: Box::new(DevTokenVerifier),
                extra_ports,
                dev_insecure: true,
            })
        }
        (false, Some(secret)) => Ok(Startup {
            listen: env.listen.unwrap_or_else(|| DEFAULT_LISTEN.to_string()),
            verifier: Box::new(
                SharedSecretVerifier::from_hex(&secret)
                    .with_context(|| format!("reading {SECRET_VAR}"))?,
            ),
            extra_ports,
            dev_insecure: false,
        }),
        (false, None) => bail!(
            "no token verifier configured: set {SECRET_VAR} to 64 hex characters \
             (the shared secret the control plane mints egress tokens with), or \
             {DEV_INSECURE_VAR}=1 to run the unauthenticated dev verifier on loopback"
        ),
    }
}

/// The dev verifier authenticates nothing, so the only acceptable blast radius
/// is the machine it runs on.
fn require_loopback(listen: &str) -> anyhow::Result<()> {
    let addr: SocketAddr = listen.parse().with_context(|| {
        format!("{DEV_INSECURE_VAR}=1 requires {LISTEN_VAR} to be a literal loopback socket address (got {listen:?})")
    })?;
    if !addr.ip().is_loopback() {
        bail!(
            "{DEV_INSECURE_VAR}=1 binds loopback only (got {listen}); \
             the dev verifier accepts any token, so exposing it publishes an open proxy \
             on the user's identity IP"
        );
    }
    Ok(())
}

/// Extra tunnel ports beyond 443/80, comma-separated. Port 25 stays refused no
/// matter what appears here — [`crate::policy::Policy`] enforces that.
fn parse_extra_ports(raw: Option<&str>) -> Vec<u16> {
    raw.unwrap_or_default()
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_hex() -> String {
        "ab".repeat(32)
    }

    /// No configuration must mean no listener — not a default that serves.
    #[test]
    fn refuses_to_start_with_no_verifier_configured() {
        let err = resolve(StartupEnv::default()).unwrap_err().to_string();
        assert!(err.contains(SECRET_VAR), "{err}");
        assert!(err.contains(DEV_INSECURE_VAR), "{err}");
    }

    /// The dev verifier is not reachable by accident, and never off loopback.
    #[test]
    fn the_dev_verifier_needs_the_opt_in_and_binds_loopback_only() {
        // Opt-in absent: the dev verifier is simply not an option.
        assert!(resolve(StartupEnv {
            listen: Some("0.0.0.0:8443".into()),
            ..StartupEnv::default()
        })
        .is_err());

        // Opt-in present: loopback default, loopback allowed.
        let s = resolve(StartupEnv {
            dev_insecure: Some("1".into()),
            ..StartupEnv::default()
        })
        .unwrap();
        assert_eq!(s.listen, DEFAULT_DEV_LISTEN);
        assert!(s.dev_insecure);
        assert!(resolve(StartupEnv {
            dev_insecure: Some("1".into()),
            listen: Some("127.0.0.1:0".into()),
            ..StartupEnv::default()
        })
        .is_ok());

        // Opt-in present, routable listener: refuse.
        for listen in ["0.0.0.0:8443", "[::]:8443", "192.168.1.20:8443", "gw:8443"] {
            let err = resolve(StartupEnv {
                dev_insecure: Some("1".into()),
                listen: Some(listen.into()),
                ..StartupEnv::default()
            })
            .unwrap_err()
            .to_string();
            assert!(err.contains(DEV_INSECURE_VAR), "{listen}: {err}");
        }

        // A typo in the opt-in value is an error, not a silent "off" that
        // then fails for an unrelated-looking reason.
        assert!(resolve(StartupEnv {
            dev_insecure: Some("true".into()),
            ..StartupEnv::default()
        })
        .is_err());

        // Both configured: refuse rather than pick.
        assert!(resolve(StartupEnv {
            dev_insecure: Some("1".into()),
            shared_secret_hex: Some(secret_hex()),
            ..StartupEnv::default()
        })
        .is_err());
    }

    /// A configured secret produces a verifier that actually checks, on the
    /// default public listener.
    #[test]
    fn a_configured_secret_yields_a_verifier_that_rejects_forged_tokens() {
        let s = resolve(StartupEnv {
            shared_secret_hex: Some(secret_hex()),
            extra_ports: Some("8443, 9000".into()),
            ..StartupEnv::default()
        })
        .unwrap();
        assert_eq!(s.listen, DEFAULT_LISTEN);
        assert!(!s.dev_insecure);
        assert_eq!(s.extra_ports, vec![8443, 9000]);
        // The token the dev verifier used to wave through.
        assert_eq!(s.verifier.verify("sm-egress-v1.attacker.devsig"), None);
        let minted = SharedSecretVerifier::from_hex(&secret_hex())
            .unwrap()
            .mint("user_1");
        assert_eq!(s.verifier.verify(&minted), Some("user_1".to_string()));
    }

    #[test]
    fn a_malformed_secret_is_a_startup_error() {
        let err = resolve(StartupEnv {
            shared_secret_hex: Some("not-hex".into()),
            ..StartupEnv::default()
        })
        .unwrap_err();
        assert!(format!("{err:#}").contains("hex"), "{err:#}");
    }
}
