import {
  encodeGatewayHeaderValue,
  GATEWAY_CREDENTIALS_HEADER,
  GATEWAY_RESPONSE_HEADER,
  GATEWAY_SPACE_HEADER,
  GATEWAY_TARGET_HEADER,
  GATEWAY_TOP_LEVEL_SITE_HEADER,
  GATEWAY_UPSTREAM_AUTH_HEADER,
  type GatewayCookieMutation,
} from "@suma/protocol";
import { describe, expect, it, vi } from "vitest";
import { GatewayCore } from "../src/gateway-core.js";
import { MemoryHubStorage } from "./helpers.js";

function gatewayRequest(
  target: string,
  options: {
    spaceId?: string;
    method?: string;
    topLevel?: string;
    headers?: HeadersInit;
    body?: BodyInit;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set(GATEWAY_SPACE_HEADER, options.spaceId ?? "space-main");
  headers.set(GATEWAY_TARGET_HEADER, encodeGatewayHeaderValue(target));
  headers.set(
    GATEWAY_TOP_LEVEL_SITE_HEADER,
    encodeGatewayHeaderValue(options.topLevel ?? new URL(target).origin),
  );
  headers.set(GATEWAY_CREDENTIALS_HEADER, "include");
  return new Request("https://session.example/v1/gateway/fetch", {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
}

describe("GatewayCore", () => {
  it("makes an HttpOnly login canonical and sends it on another device's request", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/login") {
        return new Response("signed in", {
          headers: { "set-cookie": "sid=account-session; HttpOnly; Secure; SameSite=Lax; Path=/" },
        });
      }
      return Response.json({ cookie: request.headers.get("cookie") });
    });
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });

    const login = await core.handleFetch(gatewayRequest("https://arbitrary.example/login"));
    expect(login.status).toBe(200);
    expect(login.headers.get(GATEWAY_RESPONSE_HEADER)).toBe("authoritative");

    // A second gateway request has no local Cookie header at all. The remote
    // per-user jar nevertheless authenticates it.
    const dashboard = await core.handleFetch(
      gatewayRequest("https://arbitrary.example/dashboard"),
    );
    expect(dashboard.headers.getSetCookie()).toContain(
      "sid=account-session; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
    await expect(dashboard.json()).resolves.toEqual({ cookie: "sid=account-session" });
  });

  it("honors credentials=omit for both the canonical jar and local mirror", async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      new Response("anonymous", { headers: { "set-cookie": "sid=must-not-stick; Path=/" } }),
    );
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });
    const request = gatewayRequest("https://arbitrary.example/anonymous");
    request.headers.set(GATEWAY_CREDENTIALS_HEADER, "omit");
    const response = await core.handleFetch(request);
    expect(response.headers.getSetCookie()).toEqual([]);

    const cookies = await core.handleCookies(
      new Request("https://session.example/v1/gateway/cookies", {
        headers: { [GATEWAY_SPACE_HEADER]: "space-main" },
      }),
    );
    await expect(cookies.json()).resolves.toEqual({ cookies: [], initialized: false });
  });

  it("works for unrelated origins without an allowlist and never crosses origin or space", async () => {
    const seen: Array<[string, string | null]> = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push([`${url.host}${url.pathname}`, request.headers.get("cookie")]);
      if (url.pathname === "/login") {
        return new Response("ok", {
          headers: { "set-cookie": `sid=${url.hostname}; Secure; HttpOnly; Path=/` },
        });
      }
      return new Response("ok");
    });
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });

    await core.handleFetch(gatewayRequest("https://first.example/login"));
    await core.handleFetch(gatewayRequest("https://second.test/login"));
    await core.handleFetch(gatewayRequest("https://first.example/account"));
    await core.handleFetch(gatewayRequest("https://second.test/account"));
    await core.handleFetch(
      gatewayRequest("https://first.example/account", { spaceId: "space-isolated" }),
    );

    expect(seen.at(-3)).toEqual(["first.example/account", "sid=first.example"]);
    expect(seen.at(-2)).toEqual(["second.test/account", "sid=second.test"]);
    expect(seen.at(-1)).toEqual(["first.example/account", null]);
  });

  it("restores destination Authorization but never forwards the Suma credential", async () => {
    const upstream = vi.fn<typeof fetch>(async (_input, init) =>
      Response.json({ authorization: new Headers(init?.headers).get("authorization") }),
    );
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });
    const response = await core.handleFetch(
      gatewayRequest("https://api.example/private", {
        headers: {
          authorization: "Bearer suma-device-secret",
          [GATEWAY_UPSTREAM_AUTH_HEADER]: "Basic destination-credential",
        },
      }),
    );
    await expect(response.json()).resolves.toEqual({
      authorization: "Basic destination-credential",
    });
  });

  it("mirrors document.cookie mutations while keeping outbound cookies authoritative", async () => {
    const upstream = vi.fn<typeof fetch>(async (_input, init) =>
      Response.json({ cookie: new Headers(init?.headers).get("cookie") }),
    );
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });
    const mutation: GatewayCookieMutation = {
      removed: false,
      cookie: {
        name: "theme",
        value: "dark",
        domain: "arbitrary.example",
        hostOnly: true,
        path: "/",
        secure: true,
        httpOnly: false,
        session: true,
        sameSite: "lax",
        partitionKey: null,
      },
    };
    await core.handleCookies(
      new Request("https://session.example/v1/gateway/cookies", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [GATEWAY_SPACE_HEADER]: "space-main",
        },
        body: JSON.stringify(mutation),
      }),
    );

    const snapshot = await core.handleCookies(
      new Request("https://session.example/v1/gateway/cookies", {
        headers: { [GATEWAY_SPACE_HEADER]: "space-main" },
      }),
    );
    expect((await snapshot.json()) as { cookies: unknown[]; initialized: boolean }).toMatchObject({
      initialized: true,
      cookies: [{ name: "theme", value: "dark", httpOnly: false }],
    });
    const response = await core.handleFetch(gatewayRequest("https://arbitrary.example/"));
    await expect(response.json()).resolves.toEqual({ cookie: "theme=dark" });
  });

  it("blocks private-network SSRF in production mode", async () => {
    const upstream = vi.fn<typeof fetch>();
    const core = new GatewayCore(new MemoryHubStorage(), { fetchImpl: upstream });
    for (const target of [
      "http://127.0.0.1/admin",
      "http://localhost/admin",
      "http://10.0.0.1/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const response = await core.handleFetch(gatewayRequest(target));
      expect(response.status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
