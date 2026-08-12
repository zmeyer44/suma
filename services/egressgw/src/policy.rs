//! Target policy: which `host:port` pairs the gateway will tunnel to.
//!
//! Two refusal families, both fail-closed:
//!
//! * **Private/loopback targets.** The gateway sits inside Suma's own
//!   network; letting a tunnel reach loopback or RFC1918 space would turn the
//!   product into an SSRF pivot against our own control plane and every
//!   neighbouring service. Literal IPs are refused here, and resolved
//!   addresses are re-checked after DNS ([`Policy::check_resolved`]) so a
//!   public-looking hostname cannot rebind into private space.
//! * **Ports.** 443 and 80 plus an operator-configured allowlist. Port 25 is
//!   refused unconditionally — §9 names spam egress as an abuse channel, and
//!   "unconditionally" means even a misconfigured extra-ports list cannot
//!   reopen it.

use std::collections::BTreeSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Why a target was refused. Sent to the client as a terse 403 body; never
/// logged with more detail than this (no URLs exist at this layer anyway).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Port 25: spam-egress abuse control (§9). Never allowed.
    Smtp,
    /// Port outside 443/80/extra allowlist.
    PortNotAllowed(u16),
    /// Loopback, RFC1918, link-local, CGNAT, ULA, or a bare LAN name — the
    /// gateway must never reach into private address space.
    PrivateTarget,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Smtp => write!(f, "port 25 is never tunnelled"),
            Refusal::PortNotAllowed(p) => write!(f, "port {p} is not allowed"),
            Refusal::PrivateTarget => write!(f, "private or local targets are never tunnelled"),
        }
    }
}

/// Per-deployment tunnel policy. Constructed once at startup from control
/// plane config; there is intentionally no runtime mutation surface.
pub struct Policy {
    extra_ports: BTreeSet<u16>,
    /// Lifts the private-target refusal ONLY. Exists for tests and local
    /// development (loopback echo servers); production constructors never set
    /// it. Port rules — including the port-25 refusal — still apply.
    allow_private_targets: bool,
}

impl Policy {
    pub fn new(extra_ports: impl IntoIterator<Item = u16>) -> Self {
        Policy {
            extra_ports: extra_ports.into_iter().collect(),
            allow_private_targets: false,
        }
    }

    /// Test/local-dev policy: same port rules, but loopback targets allowed
    /// so an integration test can tunnel to an ephemeral local echo server.
    pub fn permissive_for_local(extra_ports: impl IntoIterator<Item = u16>) -> Self {
        Policy {
            extra_ports: extra_ports.into_iter().collect(),
            allow_private_targets: true,
        }
    }

    /// Check the literal target from the CONNECT line, before DNS.
    pub fn check_target(&self, host: &str, port: u16) -> Result<(), Refusal> {
        self.check_port(port)?;
        let bare = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        if let Ok(ip) = bare.parse::<IpAddr>() {
            return self.check_resolved(ip);
        }
        if self.allow_private_targets {
            return Ok(());
        }
        let h = bare.to_ascii_lowercase();
        // `localhost` names and bare no-dot hostnames are LAN/mDNS names —
        // they can only resolve somewhere the gateway must not go.
        if h == "localhost" || h.ends_with(".localhost") || !h.contains('.') {
            return Err(Refusal::PrivateTarget);
        }
        Ok(())
    }

    /// Re-check an address DNS actually produced. Splitting this from
    /// [`check_target`] is the anti-rebinding measure: we only ever dial
    /// addresses that passed this check, not whatever the name resolves to
    /// at connect time.
    pub fn check_resolved(&self, ip: IpAddr) -> Result<(), Refusal> {
        if self.allow_private_targets {
            return Ok(());
        }
        if ip_is_private(ip) {
            return Err(Refusal::PrivateTarget);
        }
        Ok(())
    }

    fn check_port(&self, port: u16) -> Result<(), Refusal> {
        if port == 25 {
            return Err(Refusal::Smtp);
        }
        if port == 443 || port == 80 || self.extra_ports.contains(&port) {
            return Ok(());
        }
        Err(Refusal::PortNotAllowed(port))
    }
}

fn ipv4_is_private(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64.0.0/10
}

fn ipv6_is_private(ip: Ipv6Addr) -> bool {
    if let Some(v4) = v4_mapped(ip) {
        return ipv4_is_private(v4);
    }
    let seg0 = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || (seg0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
}

/// `::ffff:a.b.c.d` — must be judged as its embedded IPv4 address, or the
/// mapped form becomes a trivial bypass of every IPv4 refusal above.
fn v4_mapped(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = ip.segments();
    if seg[..5] == [0, 0, 0, 0, 0] && seg[5] == 0xffff {
        let [_, _, _, _, _, _, s6, s7] = seg;
        Some(Ipv4Addr::new(
            (s6 >> 8) as u8,
            (s6 & 0xff) as u8,
            (s7 >> 8) as u8,
            (s7 & 0xff) as u8,
        ))
    } else {
        None
    }
}

fn ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_private(v4),
        IpAddr::V6(v6) => ipv6_is_private(v6),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strict() -> Policy {
        Policy::new([8443])
    }

    #[test]
    fn refuses_loopback_targets() {
        for host in [
            "127.0.0.1",
            "127.5.4.3",
            "::1",
            "[::1]",
            "localhost",
            "dev.localhost",
        ] {
            assert_eq!(
                strict().check_target(host, 443),
                Err(Refusal::PrivateTarget),
                "{host}"
            );
        }
    }

    #[test]
    fn refuses_private_link_local_cgnat_and_ula_ranges() {
        for host in [
            "10.0.0.1",
            "192.168.1.10",
            "172.16.4.4",
            "172.31.255.255",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "fd12:3456::1",
            "fe80::1",
            "[fe80::1]",
            "::ffff:10.0.0.1", // v4-mapped smuggling
            "build-server",    // bare LAN name
        ] {
            assert_eq!(
                strict().check_target(host, 443),
                Err(Refusal::PrivateTarget),
                "{host}"
            );
        }
    }

    #[test]
    fn allows_public_targets_on_allowed_ports() {
        for host in ["8.8.8.8", "172.32.0.1", "example.com", "2606:4700::1111"] {
            assert_eq!(strict().check_target(host, 443), Ok(()), "{host}");
        }
        assert_eq!(strict().check_target("example.com", 80), Ok(()));
        assert_eq!(strict().check_target("example.com", 8443), Ok(()));
    }

    #[test]
    fn refuses_port_25_unconditionally() {
        assert_eq!(strict().check_target("example.com", 25), Err(Refusal::Smtp));
        // Even an extra-ports list naming 25 cannot reopen it.
        let p = Policy::new([25]);
        assert_eq!(p.check_target("example.com", 25), Err(Refusal::Smtp));
        // Even the permissive local policy keeps it shut.
        let p = Policy::permissive_for_local([25]);
        assert_eq!(p.check_target("127.0.0.1", 25), Err(Refusal::Smtp));
    }

    #[test]
    fn refuses_unlisted_ports() {
        assert_eq!(
            strict().check_target("example.com", 4444),
            Err(Refusal::PortNotAllowed(4444))
        );
    }

    #[test]
    fn rechecks_resolved_addresses_for_dns_rebinding() {
        assert_eq!(
            strict().check_resolved("10.1.2.3".parse().unwrap()),
            Err(Refusal::PrivateTarget)
        );
        assert_eq!(strict().check_resolved("1.1.1.1".parse().unwrap()), Ok(()));
    }

    #[test]
    fn permissive_policy_admits_loopback_for_tests() {
        let p = Policy::permissive_for_local([9999]);
        assert_eq!(p.check_target("127.0.0.1", 9999), Ok(()));
    }
}
