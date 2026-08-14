/**
 * Identity egress routing (PRD §8.4).
 *
 * Every request a proxied space makes gets one of three answers:
 *
 *   - **gateway** — tunnel to the identity egress gateway, exiting from the
 *     user's static IP. This is the thing the product sells.
 *   - **direct** — bypass the gateway. Local/private traffic, high-bandwidth
 *     media, and per-site bypasses go direct: routing them through the
 *     gateway burns money and adds nothing to identity stability.
 *   - **blocked** — the gateway is down and the user has not accepted
 *     browsing direct. Suma FAILS CLOSED; "zero silent fallback to direct"
 *     is a beta gate, so a degraded gateway must never quietly leak the real
 *     IP to a site the user believes is proxied.
 *
 * Pure and dependency-free so both the client sidecar and the tests can share
 * one implementation of the rules.
 */

import {
  HOSTED_CHECKOUT_RULES,
  MEDIA_BYPASS_DOMAINS,
  SEEDED_HOSTILE_DOMAINS,
} from "@suma/config";
import { normalizedHost } from "@suma/protocol";

export type EgressRoute = "gateway" | "direct" | "blocked";

export type EgressReason =
  | "space_direct"
  | "loopback"
  | "private_range"
  | "vpn_route"
  | "media_bypass"
  | "hosted_checkout"
  | "site_bypass"
  | "gateway_down_override"
  | "gateway_down_failclosed"
  | "identity";

export interface EgressDecision {
  route: EgressRoute;
  reason: EgressReason;
  /** Shown in the site controls / banner so the routing is never a mystery (§8.7). */
  explanation: string;
}

export type GatewayState = "up" | "down";

export interface SpaceEgressConfig {
  spaceId: string;
  /** Work → identity IP; Personal → direct (§8.4). */
  policy: "suma-ip" | "direct";
  /** Hosts the user (or challenge auto-suggest) pinned to direct. */
  siteBypass: ReadonlyArray<string>;
  /** High-bandwidth media bypass — on by default, configurable. */
  mediaBypass: boolean;
  /**
   * Hosted checkout bypass — on by default. Payment processors refuse proxied
   * requests outright rather than challenge them, so these pages are routed
   * direct automatically (see HOSTED_CHECKOUT_RULES).
   */
  checkoutBypass: boolean;
  /**
   * Merchant-branded checkout hosts recognised at runtime by their path shape
   * (`buy.example.com/checkouts/cn/…`). A host list cannot know these ahead of
   * time, so the client discovers them per navigation and holds them for the
   * session only — a checkout host is never permanently pinned to direct.
   */
  detectedCheckoutHosts: ReadonlyArray<string>;
  /**
   * One-click "browse direct for now" after a fail-closed banner. Resets on
   * reconnect — it is deliberately not sticky (§8.4).
   */
  temporaryDirectOverride: boolean;
}

export interface NetworkContext {
  gateway: GatewayState;
  /** Routes claimed by an active corporate VPN — never proxied (§8.4). */
  vpnRoutes: ReadonlyArray<string>;
  vpnActive: boolean;
}

export function defaultSpaceEgress(spaceId: string): SpaceEgressConfig {
  return {
    spaceId,
    policy: "direct",
    siteBypass: [],
    mediaBypass: true,
    checkoutBypass: true,
    detectedCheckoutHosts: [],
    temporaryDirectOverride: false,
  };
}

/* ------------------------------------------------------------------ *
 * Host classification
 * ------------------------------------------------------------------ */

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** RFC1918 / link-local / unique-local — private traffic never leaves the machine. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // Any other IPv6 literal is public — checked before the no-dot heuristic
  // below, which would otherwise swallow every IPv6 address (they have no
  // dots) and route public IPv6 traffic direct, leaking the real IP.
  if (h.includes(":")) return false;
  // Bare hostnames with no dot are LAN names (mDNS, corporate short names).
  if (!h.includes(".") && !isLoopbackHost(h)) return true;
  return false;
}

function hostMatches(host: string, suffix: string): boolean {
  const h = normalizedHost(host);
  const s = normalizedHost(suffix);
  return h === s || h.endsWith(`.${s}`);
}

export function isMediaHost(host: string): boolean {
  return MEDIA_BYPASS_DOMAINS.some((d) => hostMatches(host, d));
}

/** Origins known to challenge datacenter IPs — bypass is auto-suggested (§8.4). */
export function isKnownHostileToDatacenterIps(host: string): boolean {
  return SEEDED_HOSTILE_DOMAINS.some((d) => hostMatches(host, d));
}

/* ------------------------------------------------------------------ *
 * Hosted checkout detection
 * ------------------------------------------------------------------ */

/** Checkout hosts known by name — these can be bypassed before any request. */
export const HOSTED_CHECKOUT_DOMAINS: ReadonlyArray<string> = HOSTED_CHECKOUT_RULES.filter(
  (rule) => rule.host !== undefined && rule.path === undefined,
).map((rule) => rule.host as string);

export interface HostedCheckoutMatch {
  /** The host to route direct, normalized. */
  host: string;
  /** Which processor was recognised, for the notice shown to the user. */
  label: string;
}

/**
 * Does this URL look like a hosted checkout page? Matches the processors' own
 * domains and — the case a host list cannot cover — merchant-branded checkout
 * domains identified by their path shape.
 *
 * Returns the match rather than a boolean so the caller can name the processor
 * when it tells the user the page is browsing direct.
 */
export function matchHostedCheckout(url: string): HostedCheckoutMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  for (const rule of HOSTED_CHECKOUT_RULES) {
    if (rule.host !== undefined && !hostMatches(parsed.hostname, rule.host)) continue;
    if (rule.path !== undefined && !rule.path.test(parsed.pathname)) continue;
    if (rule.host === undefined && rule.path === undefined) continue;
    return { host: normalizedHost(parsed.hostname), label: rule.label };
  }
  return null;
}

export function isHostedCheckoutHost(host: string): boolean {
  return HOSTED_CHECKOUT_DOMAINS.some((d) => hostMatches(host, d));
}

function matchesVpnRoute(host: string, routes: ReadonlyArray<string>): boolean {
  return routes.some((r) => hostMatches(host, r));
}

/** A known checkout domain, or one recognised by path earlier this session. */
function isCheckoutBypassHost(host: string, space: SpaceEgressConfig): boolean {
  if (isHostedCheckoutHost(host)) return true;
  return space.detectedCheckoutHosts.some((h) => hostMatches(host, h));
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * Route one request. Order matters: local/private and VPN rules win over
 * everything (they must never be tunnelled), then explicit bypasses, and only
 * then the gateway — whose availability decides between proxying and failing
 * closed.
 */
export function decideEgress(
  host: string,
  space: SpaceEgressConfig,
  net: NetworkContext,
): EgressDecision {
  if (isLoopbackHost(host)) {
    return { route: "direct", reason: "loopback", explanation: "Local address — never proxied." };
  }
  if (isPrivateHost(host)) {
    return {
      route: "direct",
      reason: "private_range",
      explanation: "Private network address — never proxied.",
    };
  }
  if (net.vpnActive && matchesVpnRoute(host, net.vpnRoutes)) {
    return {
      route: "direct",
      reason: "vpn_route",
      explanation: "Routed by your active VPN — browsing direct on this network.",
    };
  }
  if (space.policy === "direct") {
    return {
      route: "direct",
      reason: "space_direct",
      explanation: "This space browses direct.",
    };
  }
  if (space.siteBypass.some((s) => hostMatches(host, s))) {
    return {
      route: "direct",
      reason: "site_bypass",
      explanation: "You chose to browse this site direct.",
    };
  }
  // Not a silent fallback: this is a policy rule with the same standing as
  // the media bypass, it is reported by explain(), and the user is told the
  // first time a checkout host is routed direct.
  if (space.checkoutBypass && isCheckoutBypassHost(host, space)) {
    return {
      route: "direct",
      reason: "hosted_checkout",
      explanation:
        "Hosted checkout pages refuse proxied requests, so this payment page browses direct.",
    };
  }
  if (space.mediaBypass && isMediaHost(host)) {
    return {
      route: "direct",
      reason: "media_bypass",
      explanation: "High-bandwidth media bypasses the identity gateway by default.",
    };
  }
  if (net.gateway === "down") {
    if (space.temporaryDirectOverride) {
      return {
        route: "direct",
        reason: "gateway_down_override",
        explanation: "Identity gateway unreachable — browsing direct for now, at your request.",
      };
    }
    // Fail closed. Never silently fall back to direct (beta gate).
    return {
      route: "blocked",
      reason: "gateway_down_failclosed",
      explanation:
        "Identity gateway unreachable. Suma blocked this request rather than reveal your real IP.",
    };
  }
  return {
    route: "gateway",
    reason: "identity",
    explanation: "Browsing through your Suma identity IP.",
  };
}

/* ------------------------------------------------------------------ *
 * Client wiring helpers
 * ------------------------------------------------------------------ */

/**
 * Chromium proxy config for a space. A CONNECT proxy tunnels TCP only, so
 * QUIC must be disabled on proxied spaces or Chromium races UDP straight past
 * the proxy and leaks the real IP (§8.4). Bypass entries keep local traffic
 * off the proxy at the network stack, not just in our policy.
 */
export interface ChromiumProxyConfig {
  proxyRules: string;
  proxyBypassRules: string;
  /** Must be true whenever any traffic is proxied — the QUIC leak guard. */
  disableQuic: boolean;
}

/**
 * Chromium matches a bare hostname in proxyBypassRules EXACTLY — `stripe.com`
 * does not cover `checkout.stripe.com`. `hostMatches` above is a suffix match,
 * so emit both forms or the network stack and the policy module disagree about
 * which hosts are bypassed.
 */
function bypassPatternsFor(hosts: ReadonlyArray<string>): string[] {
  return hosts.flatMap((h) => [h, `*.${h}`]);
}

export const LOCAL_BYPASS_RULES = "<local>;localhost;127.0.0.1/8;::1;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;169.254.0.0/16;fc00::/7;fe80::/10";

export function proxyConfigFor(
  space: SpaceEgressConfig,
  localProxyPort: number,
  net: NetworkContext,
): ChromiumProxyConfig {
  if (space.policy === "direct") {
    return { proxyRules: "direct://", proxyBypassRules: "", disableQuic: false };
  }
  const bypass = [LOCAL_BYPASS_RULES, ...space.siteBypass];
  if (space.mediaBypass) bypass.push(...MEDIA_BYPASS_DOMAINS);
  if (space.checkoutBypass) {
    // Known processor domains need no detection; the detected list carries the
    // merchant-branded ones found by path this session.
    bypass.push(
      ...bypassPatternsFor([...HOSTED_CHECKOUT_DOMAINS, ...space.detectedCheckoutHosts]),
    );
  }
  if (net.vpnActive) bypass.push(...net.vpnRoutes);
  return {
    proxyRules: `https=127.0.0.1:${localProxyPort};http=127.0.0.1:${localProxyPort}`,
    proxyBypassRules: bypass.join(";"),
    // QUIC must be off for the whole session whenever anything is proxied.
    disableQuic: true,
  };
}

/**
 * A site challenged us in a way that suggests datacenter-IP hostility.
 * Returns a suggestion the UI can offer — never an automatic change, since
 * silently moving a site off the identity IP would undermine the promise.
 */
export interface BypassSuggestion {
  host: string;
  reason: string;
}

export function suggestBypassOnChallenge(
  host: string,
  httpStatus: number,
  space: SpaceEgressConfig,
): BypassSuggestion | null {
  if (space.policy !== "suma-ip") return null;
  if (space.siteBypass.some((s) => hostMatches(host, s))) return null;
  const challenged = httpStatus === 403 || httpStatus === 429 || httpStatus === 503;
  if (!challenged && !isKnownHostileToDatacenterIps(host)) return null;
  return {
    host: normalizedHost(host),
    reason: isKnownHostileToDatacenterIps(host)
      ? "This site is known to challenge datacenter IP addresses."
      : `This site returned ${httpStatus}, which often means it is challenging the IP address.`,
  };
}
