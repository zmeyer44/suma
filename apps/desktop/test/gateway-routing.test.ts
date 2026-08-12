import { describe, expect, it } from "vitest";
import {
  GatewayOriginRouter,
  isDeviceLocalCookieName,
  responseIsBrowserChallenge,
  routingDomainForHost,
  urlLooksLikeBrowserChallenge,
} from "../src/main/gateway/routing";

describe("GatewayOriginRouter", () => {
  it("keeps portable sites structured and starts assisted sites browser-native", () => {
    const router = new GatewayOriginRouter();
    expect(router.routeForHost("x.com")).toBe("structured");
    expect(router.routeForHost("app.example.test")).toBe("structured");
    expect(router.routeForHost("claude.ai")).toBe("native");
    expect(router.routeForHost("accounts.google.com")).toBe("native");
    expect(router.routeForHost("mail.google.com")).toBe("native");
    expect(router.routeForHost("gmail.com")).toBe("native");
  });

  it("promotes and restores an entire registrable domain", () => {
    const router = new GatewayOriginRouter();
    expect(router.promote("login.shop.example.co.uk")).toEqual({
      domain: "example.co.uk",
      changed: true,
    });
    expect(router.routeForHost("static.example.co.uk")).toBe("native");
    expect(
      new GatewayOriginRouter(router.promotedDomains()).routeForHost(
        "example.co.uk",
      ),
    ).toBe("native");
    expect(routingDomainForHost("login.service.example.com")).toBe(
      "example.com",
    );
  });
});

describe("browser challenge detection", () => {
  it("recognizes Cloudflare and Google challenge URLs", () => {
    expect(
      urlLooksLikeBrowserChallenge(
        "https://claude.ai/login?__cf_chl_rt_tk=proof",
      ),
    ).toBe(true);
    expect(
      urlLooksLikeBrowserChallenge(
        "https://claude.ai/cdn-cgi/challenge-platform/h/g/orchestrate",
      ),
    ).toBe(true);
    expect(
      urlLooksLikeBrowserChallenge(
        "https://www.google.com/sorry/index?continue=x",
      ),
    ).toBe(true);
    expect(urlLooksLikeBrowserChallenge("https://example.com/login")).toBe(
      false,
    );
  });

  it("uses the reliable response header and challenge redirects", () => {
    expect(
      responseIsBrowserChallenge(
        "https://example.com/",
        new Response("challenge", { headers: { "cf-mitigated": "challenge" } }),
      ),
    ).toBe(true);
    expect(
      responseIsBrowserChallenge(
        "https://example.com/",
        new Response(null, {
          status: 302,
          headers: { location: "/login?__cf_chl_rt_tk=proof" },
        }),
      ),
    ).toBe(true);
  });
});

describe("device-local challenge cookies", () => {
  it.each([
    "cf_clearance",
    "__cf_bm",
    "__cfseq",
    "cf_chl_rc_ni",
    "__cf_chl_tk",
    "GOOGLE_ABUSE_EXEMPTION",
    "AEC",
  ])("does not sync %s", (name) => {
    expect(isDeviceLocalCookieName(name)).toBe(true);
  });

  it("allows ordinary application sessions to sync", () => {
    expect(isDeviceLocalCookieName("sessionKey")).toBe(false);
    expect(isDeviceLocalCookieName("__Secure-1PSID")).toBe(false);
  });
});
