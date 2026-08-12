/**
 * §8.4 required-test list, as executable tests. The beta gates being defended
 * here are "zero silent egress fallback to direct" and "local/private traffic
 * never proxied".
 */

import { describe, expect, it } from "vitest";
import {
  decideEgress,
  defaultSpaceEgress,
  isLoopbackHost,
  isPrivateHost,
  proxyConfigFor,
  suggestBypassOnChallenge,
  type NetworkContext,
  type SpaceEgressConfig,
} from "../src/index.js";

const workSpace = (over: Partial<SpaceEgressConfig> = {}): SpaceEgressConfig => ({
  ...defaultSpaceEgress("work"),
  policy: "suma-ip",
  ...over,
});

const net = (over: Partial<NetworkContext> = {}): NetworkContext => ({
  gateway: "up",
  vpnRoutes: [],
  vpnActive: false,
  ...over,
});

describe("per-space policy", () => {
  it("routes a work space through the identity IP and a personal space direct", () => {
    expect(decideEgress("github.com", workSpace(), net()).route).toBe("gateway");
    expect(decideEgress("github.com", defaultSpaceEgress("personal"), net()).route).toBe("direct");
  });
});

describe("local and private traffic is never proxied", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["localhost", "dev.localhost", "127.0.0.1", "127.10.0.5", "::1"]) {
      expect(isLoopbackHost(h)).toBe(true);
      expect(decideEgress(h, workSpace(), net()).route).toBe("direct");
    }
  });

  it("classifies RFC1918, CGNAT, link-local and IPv6 private ranges", () => {
    const priv = [
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
    for (const h of priv) {
      expect(isPrivateHost(h), h).toBe(true);
      expect(decideEgress(h, workSpace(), net()).route, h).toBe("direct");
    }
  });

  it("does not misclassify public addresses as private", () => {
    for (const h of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "github.com", "2606:4700::1111"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
    expect(decideEgress("8.8.8.8", workSpace(), net()).route).toBe("gateway");
  });

  it("keeps corporate VPN routes off the gateway and says so", () => {
    const context = net({ vpnActive: true, vpnRoutes: ["corp.example.com"] });
    const d = decideEgress("wiki.corp.example.com", workSpace(), context);
    expect(d.route).toBe("direct");
    expect(d.reason).toBe("vpn_route");
    expect(d.explanation).toContain("direct on this network");
    // A non-VPN host in the same session still uses the identity IP.
    expect(decideEgress("github.com", workSpace(), context).route).toBe("gateway");
  });
});

describe("fail-closed behavior (beta gate: zero silent fallback)", () => {
  it("blocks rather than silently going direct when the gateway is down", () => {
    const d = decideEgress("github.com", workSpace(), net({ gateway: "down" }));
    expect(d.route).toBe("blocked");
    expect(d.reason).toBe("gateway_down_failclosed");
    expect(d.explanation).toContain("rather than reveal your real IP");
  });

  it("goes direct only after the explicit one-click override", () => {
    const d = decideEgress(
      "github.com",
      workSpace({ temporaryDirectOverride: true }),
      net({ gateway: "down" }),
    );
    expect(d.route).toBe("direct");
    expect(d.reason).toBe("gateway_down_override");
    expect(d.explanation).toContain("at your request");
  });

  it("still serves local and media traffic while the gateway is down", () => {
    const down = net({ gateway: "down" });
    expect(decideEgress("localhost", workSpace(), down).route).toBe("direct");
    expect(decideEgress("youtube.com", workSpace(), down).route).toBe("direct");
  });
});

describe("media and per-site bypass", () => {
  it("bypasses high-bandwidth media by default and honors disabling it", () => {
    expect(decideEgress("googlevideo.com", workSpace(), net()).reason).toBe("media_bypass");
    expect(decideEgress("r1---sn-x.googlevideo.com", workSpace(), net()).reason).toBe("media_bypass");
    expect(decideEgress("googlevideo.com", workSpace({ mediaBypass: false }), net()).route).toBe(
      "gateway",
    );
  });

  it("honors an explicit per-site bypass including subdomains", () => {
    const space = workSpace({ siteBypass: ["ticketmaster.com"] });
    expect(decideEgress("ticketmaster.com", space, net()).reason).toBe("site_bypass");
    expect(decideEgress("www.ticketmaster.com", space, net()).reason).toBe("site_bypass");
    expect(decideEgress("ticketmaster.com.evil.test", space, net()).route).toBe("gateway");
  });
});

describe("challenge detection suggests, never auto-applies", () => {
  it("suggests a bypass on challenge status codes and for known-hostile origins", () => {
    expect(suggestBypassOnChallenge("shop.example", 403, workSpace())?.host).toBe("shop.example");
    expect(suggestBypassOnChallenge("shop.example", 429, workSpace())).not.toBeNull();
    expect(suggestBypassOnChallenge("nike.com", 200, workSpace())?.reason).toContain(
      "known to challenge",
    );
  });

  it("stays quiet for healthy responses, direct spaces, and already-bypassed sites", () => {
    expect(suggestBypassOnChallenge("shop.example", 200, workSpace())).toBeNull();
    expect(suggestBypassOnChallenge("shop.example", 403, defaultSpaceEgress("personal"))).toBeNull();
    expect(
      suggestBypassOnChallenge("shop.example", 403, workSpace({ siteBypass: ["shop.example"] })),
    ).toBeNull();
  });
});

describe("Chromium proxy config (QUIC leak guard)", () => {
  it("disables QUIC whenever traffic is proxied", () => {
    const cfg = proxyConfigFor(workSpace(), 8123, net());
    expect(cfg.disableQuic).toBe(true);
    expect(cfg.proxyRules).toContain("127.0.0.1:8123");
  });

  it("leaves a direct space unproxied with QUIC intact", () => {
    const cfg = proxyConfigFor(defaultSpaceEgress("personal"), 8123, net());
    expect(cfg.proxyRules).toBe("direct://");
    expect(cfg.disableQuic).toBe(false);
  });

  it("bypasses local ranges, media, and VPN routes at the network stack", () => {
    const cfg = proxyConfigFor(
      workSpace({ siteBypass: ["bank.example"] }),
      8123,
      net({ vpnActive: true, vpnRoutes: ["corp.example.com"] }),
    );
    expect(cfg.proxyBypassRules).toContain("127.0.0.1/8");
    expect(cfg.proxyBypassRules).toContain("192.168.0.0/16");
    expect(cfg.proxyBypassRules).toContain("bank.example");
    expect(cfg.proxyBypassRules).toContain("corp.example.com");
    expect(cfg.proxyBypassRules).toContain("googlevideo.com");
  });
});
