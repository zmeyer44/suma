import { describe, expect, it } from "vitest";
import {
  NativeRequestHeaderBridge,
  isNavigationRequest,
  navigationCookieHeader,
  responseMustBeBodyless,
  stripRedirectBodyHeaders,
} from "../src/main/gateway/native-request-headers";

describe("NativeRequestHeaderBridge", () => {
  it("restores the renderer's Fetch Metadata and removes its private marker", () => {
    const bridge = new NativeRequestHeaderBridge();
    const id = bridge.prepare(
      new Headers({
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document",
      }),
    );
    const outgoing = bridge.mark(
      {
        Accept: "text/html",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "empty",
      },
      id,
    );

    expect(bridge.rewrite(outgoing)).toEqual({
      Accept: "text/html",
      "sec-fetch-site": "none",
      "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1",
      "sec-fetch-dest": "document",
    });
  });

  it("strips an unknown marker without accepting forged metadata", () => {
    const bridge = new NativeRequestHeaderBridge();
    const outgoing = bridge.mark(
      {
        Accept: "application/json",
        "Sec-Fetch-Mode": "cors",
      },
      "not-a-pending-request",
    );

    expect(bridge.rewrite(outgoing)).toEqual({
      Accept: "application/json",
      "Sec-Fetch-Mode": "cors",
    });
  });

  it("replaces a replay-generated Cookie with the navigation jar", () => {
    const bridge = new NativeRequestHeaderBridge();
    const id = bridge.prepare(
      new Headers({ "sec-fetch-mode": "navigate" }),
      "mail_binding=bound-to-browser",
    );

    expect(
      bridge.rewrite(
        bridge.mark(
          { Cookie: "wrong_origin=1", "Sec-Fetch-Mode": "no-cors" },
          id,
        ),
      ),
    ).toEqual({
      Cookie: "mail_binding=bound-to-browser",
      "sec-fetch-mode": "navigate",
    });
  });

  it("fills missing redirect metadata without replacing explicit values", () => {
    const bridge = new NativeRequestHeaderBridge();
    const id = bridge.prepare(
      new Headers({ "sec-fetch-site": "same-site" }),
      undefined,
      {
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "cross-site",
      },
    );

    expect(bridge.rewrite(bridge.mark({}, id))).toEqual({
      "sec-fetch-site": "same-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
  });
});

describe("navigationCookieHeader", () => {
  const cookies = [
    { name: "strict", value: "1", sameSite: "strict" as const },
    { name: "lax", value: "1", sameSite: "lax" as const },
    { name: "legacy", value: "1", sameSite: "unspecified" as const },
    { name: "none", value: "1", sameSite: "no_restriction" as const },
  ];

  it("keeps Lax and None cookies on a safe cross-site navigation", () => {
    expect(
      navigationCookieHeader(
        {
          method: "GET",
          mode: "navigate",
          headers: new Headers({
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
          }),
        },
        cookies,
      ),
    ).toBe("lax=1; legacy=1; none=1");
  });

  it("keeps only None cookies on a cross-site form POST", () => {
    expect(
      navigationCookieHeader(
        {
          method: "POST",
          mode: "navigate",
          headers: new Headers({
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
          }),
        },
        cookies,
      ),
    ).toBe("none=1");
  });

  it("does not alter subresource credential handling", () => {
    expect(
      navigationCookieHeader(
        {
          method: "GET",
          mode: "cors",
          headers: new Headers({ "sec-fetch-mode": "cors" }),
        },
        cookies,
      ),
    ).toBeUndefined();
  });

  it("recognizes Electron's stripped redirect-navigation shape", () => {
    expect(
      isNavigationRequest({
        mode: "cors",
        headers: new Headers({
          accept: "text/html,application/xhtml+xml",
          "upgrade-insecure-requests": "1",
        }),
      }),
    ).toBe(true);
  });
});

describe("responseMustBeBodyless", () => {
  it("drops identity-provider redirect bodies regardless of Electron event order", () => {
    const redirectHeaders = new Headers({
      location: "https://accounts.example.test/oauth/complete",
      "content-security-policy": "script-src 'nonce-header-value'",
    });

    expect(responseMustBeBodyless("GET", 302, redirectHeaders)).toBe(true);
    expect(responseMustBeBodyless("POST", 303, redirectHeaders)).toBe(true);
    expect(responseMustBeBodyless("POST", 307, redirectHeaders)).toBe(true);
  });

  it("keeps ordinary response bodies and handles status-defined empty bodies", () => {
    expect(responseMustBeBodyless("GET", 200, new Headers())).toBe(false);
    expect(responseMustBeBodyless("GET", 300, new Headers())).toBe(false);
    expect(responseMustBeBodyless("HEAD", 200, new Headers())).toBe(true);
    expect(responseMustBeBodyless("GET", 204, new Headers())).toBe(true);
    expect(responseMustBeBodyless("GET", 304, new Headers())).toBe(true);
  });
});

describe("stripRedirectBodyHeaders", () => {
  it("drops policy for a discarded redirect body without losing navigation state", () => {
    const headers = new Headers({
      location: "https://accounts.example.test/oauth/complete",
      "set-cookie": "handoff=ready; Secure; HttpOnly",
      "content-type": "text/html",
      "content-length": "123",
      "content-security-policy": "script-src 'nonce-redirect-body'",
    });

    stripRedirectBodyHeaders(302, headers);

    expect(headers.get("location")).toBe(
      "https://accounts.example.test/oauth/complete",
    );
    expect(headers.get("set-cookie")).toBe("handoff=ready; Secure; HttpOnly");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    expect(headers.has("content-security-policy")).toBe(false);
  });

  it("leaves non-redirect response policy intact", () => {
    const headers = new Headers({
      "content-security-policy": "script-src 'self'",
    });

    stripRedirectBodyHeaders(200, headers);

    expect(headers.get("content-security-policy")).toBe("script-src 'self'");
  });
});
