//! Egress routing decision — a faithful port of
//! `packages/egress-policy/src/index.ts` (PRD §8.4). That TypeScript module
//! is the source of truth: same branch order, same outcomes, same
//! explanation strings. If the rules change, change the TS module first and
//! re-mirror.
//!
//! The one subtlety worth naming: **IPv6 classification**. Any IPv6 literal
//! that is not unique-local (fc00::/7) or link-local (fe80::/10) is PUBLIC.
//! The check runs *before* the "bare hostname with no dot ⇒ LAN name"
//! heuristic, because IPv6 literals contain no dots — an earlier TS version
//! let that heuristic swallow them, classifying every public IPv6 address as
//! private and routing it direct, which leaks the real IP. The bug was found
//! and fixed on the TS side; the ordering here is deliberate and tested. Do
//! not "simplify" it.

/// Where one request goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressRoute {
    /// Tunnel via the identity egress gateway — the thing the product sells.
    Gateway,
    /// Bypass the gateway: local/private, media, VPN, explicit bypasses.
    Direct,
    /// Gateway down, no override accepted: fail closed (beta gate).
    Blocked,
}

/// Why — mirrors the TS `EgressReason` union; [`EgressReason::as_str`]
/// yields the exact TS strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressReason {
    SpaceDirect,
    Loopback,
    PrivateRange,
    VpnRoute,
    MediaBypass,
    SiteBypass,
    GatewayDownOverride,
    GatewayDownFailclosed,
    Identity,
}

impl EgressReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EgressReason::SpaceDirect => "space_direct",
            EgressReason::Loopback => "loopback",
            EgressReason::PrivateRange => "private_range",
            EgressReason::VpnRoute => "vpn_route",
            EgressReason::MediaBypass => "media_bypass",
            EgressReason::SiteBypass => "site_bypass",
            EgressReason::GatewayDownOverride => "gateway_down_override",
            EgressReason::GatewayDownFailclosed => "gateway_down_failclosed",
            EgressReason::Identity => "identity",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressDecision {
    pub route: EgressRoute,
    pub reason: EgressReason,
    /// Shown in the site controls / banner so the routing is never a mystery
    /// (§8.7). Strings match the TS module verbatim.
    pub explanation: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayState {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpacePolicy {
    /// Work → identity IP (§8.4).
    SumaIp,
    /// Personal → direct (§8.4).
    Direct,
}

#[derive(Debug, Clone)]
pub struct SpaceEgressConfig {
    pub space_id: String,
    pub policy: SpacePolicy,
    /// Hosts the user (or challenge auto-suggest) pinned to direct.
    pub site_bypass: Vec<String>,
    /// High-bandwidth media bypass — on by default, configurable.
    pub media_bypass: bool,
    /// One-click "browse direct for now" after a fail-closed banner. Resets
    /// on reconnect — deliberately not sticky (§8.4).
    pub temporary_direct_override: bool,
}

pub fn default_space_egress(space_id: &str) -> SpaceEgressConfig {
    SpaceEgressConfig {
        space_id: space_id.to_string(),
        policy: SpacePolicy::Direct,
        site_bypass: Vec::new(),
        media_bypass: true,
        temporary_direct_override: false,
    }
}

#[derive(Debug, Clone)]
pub struct NetworkContext {
    pub gateway: GatewayState,
    /// Routes claimed by an active corporate VPN — never proxied (§8.4).
    pub vpn_routes: Vec<String>,
    pub vpn_active: bool,
}

/// Mirrors `MEDIA_BYPASS_DOMAINS` in `packages/config/src/corpus.ts`:
/// domains whose traffic bypasses the identity gateway by default (§8.4) —
/// video through the gateway burns money and adds nothing to identity
/// stability.
pub const MEDIA_BYPASS_DOMAINS: [&str; 10] = [
    "youtube.com",
    "googlevideo.com",
    "netflix.com",
    "nflxvideo.net",
    "spotify.com",
    "scdn.co",
    "twitch.tv",
    "ttvnw.net",
    "vimeo.com",
    "cloudfront.net",
];

/// Mirrors `SEEDED_HOSTILE_DOMAINS` in `packages/config/src/corpus.ts`:
/// origins known to challenge datacenter IPs (§8.4).
pub const SEEDED_HOSTILE_DOMAINS: [&str; 5] = [
    "ticketmaster.com",
    "nike.com",
    "bestbuy.com",
    "walmart.com",
    "target.com",
];

/* ------------------------------------------------------------------ *
 * Host classification
 * ------------------------------------------------------------------ */

pub fn is_loopback_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if h == "::1" || h == "[::1]" {
        return true;
    }
    // TS: /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| is_short_digits(p))
}

/// RFC1918 / link-local / unique-local — private traffic never leaves the
/// machine.
pub fn is_private_host(host: &str) -> bool {
    let mut h = host.to_ascii_lowercase();
    // TS strips one leading '[' and one trailing ']'.
    if let Some(stripped) = h.strip_prefix('[') {
        h = stripped.to_string();
    }
    if let Some(stripped) = h.strip_suffix(']') {
        h = stripped.to_string();
    }
    if let Some((a, b)) = dotted_quad_prefix(&h) {
        if a == 10 {
            return true;
        }
        if a == 192 && b == 168 {
            return true;
        }
        if a == 172 && (16..=31).contains(&b) {
            return true;
        }
        if a == 169 && b == 254 {
            return true; // link-local
        }
        if a == 100 && (64..=127).contains(&b) {
            return true; // CGNAT
        }
        return false;
    }
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    if is_ipv6_unique_local(&h) || is_ipv6_link_local(&h) {
        return true;
    }
    // Any other IPv6 literal is public — checked BEFORE the no-dot heuristic
    // below, which would otherwise swallow every IPv6 address (they have no
    // dots) and route public IPv6 traffic direct, leaking the real IP.
    if h.contains(':') {
        return false;
    }
    // Bare hostnames with no dot are LAN names (mDNS, corporate short names).
    if !h.contains('.') && !is_loopback_host(&h) {
        return true;
    }
    false
}

fn is_short_digits(s: &str) -> bool {
    (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// The TS v4 regex `^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`, reduced to
/// the first two octets (the only ones the range checks read).
fn dotted_quad_prefix(h: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 || !parts.iter().all(|p| is_short_digits(p)) {
        return None;
    }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?))
}

/// TS: /^f[cd][0-9a-f]{2}:/ (input already lowercased).
fn is_ipv6_unique_local(h: &str) -> bool {
    let b = h.as_bytes();
    b.len() >= 5
        && b[0] == b'f'
        && (b[1] == b'c' || b[1] == b'd')
        && b[2].is_ascii_hexdigit()
        && b[3].is_ascii_hexdigit()
        && b[4] == b':'
}

/// TS: /^fe[89ab][0-9a-f]:/ (input already lowercased).
fn is_ipv6_link_local(h: &str) -> bool {
    let b = h.as_bytes();
    b.len() >= 5
        && b[0] == b'f'
        && b[1] == b'e'
        && matches!(b[2], b'8' | b'9' | b'a' | b'b')
        && b[3].is_ascii_hexdigit()
        && b[4] == b':'
}

/// Host with any leading dot stripped, lowercased — mirrors `normalizedHost`
/// in `packages/protocol/src/cookie.ts`.
fn normalized_host(host: &str) -> String {
    let h = host.to_ascii_lowercase();
    match h.strip_prefix('.') {
        Some(stripped) => stripped.to_string(),
        None => h,
    }
}

fn host_matches(host: &str, suffix: &str) -> bool {
    let h = normalized_host(host);
    let s = normalized_host(suffix);
    h == s || h.ends_with(&format!(".{s}"))
}

pub fn is_media_host(host: &str) -> bool {
    MEDIA_BYPASS_DOMAINS.iter().any(|d| host_matches(host, d))
}

/// Origins known to challenge datacenter IPs — bypass is auto-suggested
/// (§8.4).
pub fn is_known_hostile_to_datacenter_ips(host: &str) -> bool {
    SEEDED_HOSTILE_DOMAINS.iter().any(|d| host_matches(host, d))
}

fn matches_vpn_route(host: &str, routes: &[String]) -> bool {
    routes.iter().any(|r| host_matches(host, r))
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/// Route one request. Order matters and mirrors the TS `decideEgress`:
/// local/private and VPN rules win over everything (they must never be
/// tunnelled), then explicit bypasses, and only then the gateway — whose
/// availability decides between proxying and failing closed.
pub fn decide_egress(
    host: &str,
    space: &SpaceEgressConfig,
    net: &NetworkContext,
) -> EgressDecision {
    if is_loopback_host(host) {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::Loopback,
            explanation: "Local address — never proxied.",
        };
    }
    if is_private_host(host) {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::PrivateRange,
            explanation: "Private network address — never proxied.",
        };
    }
    if net.vpn_active && matches_vpn_route(host, &net.vpn_routes) {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::VpnRoute,
            explanation: "Routed by your active VPN — browsing direct on this network.",
        };
    }
    if space.policy == SpacePolicy::Direct {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::SpaceDirect,
            explanation: "This space browses direct.",
        };
    }
    if space.site_bypass.iter().any(|s| host_matches(host, s)) {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::SiteBypass,
            explanation: "You chose to browse this site direct.",
        };
    }
    if space.media_bypass && is_media_host(host) {
        return EgressDecision {
            route: EgressRoute::Direct,
            reason: EgressReason::MediaBypass,
            explanation: "High-bandwidth media bypasses the identity gateway by default.",
        };
    }
    if net.gateway == GatewayState::Down {
        if space.temporary_direct_override {
            return EgressDecision {
                route: EgressRoute::Direct,
                reason: EgressReason::GatewayDownOverride,
                explanation:
                    "Identity gateway unreachable — browsing direct for now, at your request.",
            };
        }
        // Fail closed. Never silently fall back to direct (beta gate).
        return EgressDecision {
            route: EgressRoute::Blocked,
            reason: EgressReason::GatewayDownFailclosed,
            explanation:
                "Identity gateway unreachable. Suma blocked this request rather than reveal your real IP.",
        };
    }
    EgressDecision {
        route: EgressRoute::Gateway,
        reason: EgressReason::Identity,
        explanation: "Browsing through your Suma identity IP.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test names mirror packages/egress-policy/test/egress.test.ts.

    fn work_space() -> SpaceEgressConfig {
        SpaceEgressConfig {
            policy: SpacePolicy::SumaIp,
            ..default_space_egress("work")
        }
    }

    fn net() -> NetworkContext {
        NetworkContext {
            gateway: GatewayState::Up,
            vpn_routes: Vec::new(),
            vpn_active: false,
        }
    }

    fn net_down() -> NetworkContext {
        NetworkContext {
            gateway: GatewayState::Down,
            ..net()
        }
    }

    #[test]
    fn routes_a_work_space_through_the_identity_ip_and_a_personal_space_direct() {
        assert_eq!(
            decide_egress("github.com", &work_space(), &net()).route,
            EgressRoute::Gateway
        );
        assert_eq!(
            decide_egress("github.com", &default_space_egress("personal"), &net()).route,
            EgressRoute::Direct
        );
    }

    #[test]
    fn classifies_loopback_hosts() {
        for h in [
            "localhost",
            "dev.localhost",
            "127.0.0.1",
            "127.10.0.5",
            "::1",
        ] {
            assert!(is_loopback_host(h), "{h}");
            assert_eq!(
                decide_egress(h, &work_space(), &net()).route,
                EgressRoute::Direct,
                "{h}"
            );
        }
    }

    #[test]
    fn classifies_rfc1918_cgnat_link_local_and_ipv6_private_ranges() {
        let private = [
            "10.0.0.1",
            "192.168.1.10",
            "172.16.4.4",
            "172.31.255.255",
            "169.254.1.1",
            "100.64.0.1",
            "fd12:3456::1",
            "fe80::1",
            "build-server", // bare LAN hostname
        ];
        for h in private {
            assert!(is_private_host(h), "{h}");
            assert_eq!(
                decide_egress(h, &work_space(), &net()).route,
                EgressRoute::Direct,
                "{h}"
            );
        }
    }

    #[test]
    fn does_not_misclassify_public_addresses_as_private() {
        for h in [
            "8.8.8.8",
            "172.32.0.1",
            "172.15.0.1",
            "github.com",
            "2606:4700::1111",
        ] {
            assert!(!is_private_host(h), "{h}");
        }
        assert_eq!(
            decide_egress("8.8.8.8", &work_space(), &net()).route,
            EgressRoute::Gateway
        );
    }

    /// The regression the spec calls out: public IPv6 literals have no dots,
    /// and must NOT fall into the bare-hostname LAN heuristic.
    #[test]
    fn ipv6_literals_outside_ula_and_link_local_are_public() {
        for h in [
            "2606:4700::1111",
            "[2606:4700::1111]",
            "2001:db8::1",
            "2a00:1450:4009:81f::200e",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_private_host(h), "{h} must be public");
            assert_eq!(
                decide_egress(h, &work_space(), &net()).route,
                EgressRoute::Gateway,
                "{h} must route via the gateway, not leak direct"
            );
        }
        // And the private IPv6 families stay private, brackets included.
        for h in ["fc00::1", "fd12:3456::1", "fe80::1", "[fe80::1]", "FE80::1"] {
            assert!(is_private_host(h), "{h} must be private");
        }
    }

    #[test]
    fn keeps_corporate_vpn_routes_off_the_gateway_and_says_so() {
        let context = NetworkContext {
            vpn_active: true,
            vpn_routes: vec!["corp.example.com".to_string()],
            ..net()
        };
        let d = decide_egress("wiki.corp.example.com", &work_space(), &context);
        assert_eq!(d.route, EgressRoute::Direct);
        assert_eq!(d.reason, EgressReason::VpnRoute);
        assert!(d.explanation.contains("direct on this network"));
        // A non-VPN host in the same session still uses the identity IP.
        assert_eq!(
            decide_egress("github.com", &work_space(), &context).route,
            EgressRoute::Gateway
        );
    }

    #[test]
    fn blocks_rather_than_silently_going_direct_when_the_gateway_is_down() {
        let d = decide_egress("github.com", &work_space(), &net_down());
        assert_eq!(d.route, EgressRoute::Blocked);
        assert_eq!(d.reason, EgressReason::GatewayDownFailclosed);
        assert!(d.explanation.contains("rather than reveal your real IP"));
    }

    #[test]
    fn goes_direct_only_after_the_explicit_one_click_override() {
        let space = SpaceEgressConfig {
            temporary_direct_override: true,
            ..work_space()
        };
        let d = decide_egress("github.com", &space, &net_down());
        assert_eq!(d.route, EgressRoute::Direct);
        assert_eq!(d.reason, EgressReason::GatewayDownOverride);
        assert!(d.explanation.contains("at your request"));
    }

    #[test]
    fn still_serves_local_and_media_traffic_while_the_gateway_is_down() {
        assert_eq!(
            decide_egress("localhost", &work_space(), &net_down()).route,
            EgressRoute::Direct
        );
        assert_eq!(
            decide_egress("youtube.com", &work_space(), &net_down()).route,
            EgressRoute::Direct
        );
    }

    #[test]
    fn bypasses_high_bandwidth_media_by_default_and_honors_disabling_it() {
        assert_eq!(
            decide_egress("googlevideo.com", &work_space(), &net()).reason,
            EgressReason::MediaBypass
        );
        assert_eq!(
            decide_egress("r1---sn-x.googlevideo.com", &work_space(), &net()).reason,
            EgressReason::MediaBypass
        );
        let no_media = SpaceEgressConfig {
            media_bypass: false,
            ..work_space()
        };
        assert_eq!(
            decide_egress("googlevideo.com", &no_media, &net()).route,
            EgressRoute::Gateway
        );
    }

    #[test]
    fn honors_an_explicit_per_site_bypass_including_subdomains() {
        let space = SpaceEgressConfig {
            site_bypass: vec!["ticketmaster.com".to_string()],
            ..work_space()
        };
        assert_eq!(
            decide_egress("ticketmaster.com", &space, &net()).reason,
            EgressReason::SiteBypass
        );
        assert_eq!(
            decide_egress("www.ticketmaster.com", &space, &net()).reason,
            EgressReason::SiteBypass
        );
        // A suffix trick is not a match.
        assert_eq!(
            decide_egress("ticketmaster.com.evil.test", &space, &net()).route,
            EgressRoute::Gateway
        );
    }

    #[test]
    fn reason_strings_match_the_ts_union() {
        assert_eq!(
            EgressReason::GatewayDownFailclosed.as_str(),
            "gateway_down_failclosed"
        );
        assert_eq!(EgressReason::SpaceDirect.as_str(), "space_direct");
        assert_eq!(EgressReason::Identity.as_str(), "identity");
    }
}
