import {
  decodeGatewayHeaderValue,
  GATEWAY_COOKIES_PATH,
  GATEWAY_FETCH_PATH,
  GATEWAY_RESPONSE_HEADER,
  GATEWAY_TARGET_HEADER,
  type GatewayCookieSnapshot,
} from "@suma/protocol";
import type { Cookie, Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { GatewayBackedService } from "../src/main/gateway/service";

type ProtocolHandler = (request: Request) => Promise<Response>;

function fakeSession(nativeBody = "native") {
  const handlers = new Map<string, ProtocolHandler>();
  const cookieListeners: Array<
    (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void
  > = [];
  const set = vi.fn(async (_details: Electron.CookiesSetDetails) => undefined);
  const nativeFetch = vi.fn(async () => new Response(nativeBody));
  const session = {
    protocol: {
      handle: (scheme: string, handler: ProtocolHandler) =>
        handlers.set(scheme, handler),
      unhandle: (scheme: string) => handlers.delete(scheme),
    },
    cookies: {
      get: vi.fn(async () => []),
      set,
      on: (_event: string, listener: (typeof cookieListeners)[number]) =>
        cookieListeners.push(listener),
      removeListener: vi.fn(),
    },
    fetch: nativeFetch,
  } as unknown as Session;
  return {
    session,
    handlers,
    nativeFetch,
    set,
    emitCookie: (value: Cookie, cause = "explicit", removed = false) => {
      for (const listener of cookieListeners)
        listener({}, value, cause, removed);
    },
  };
}

function cookie(name: string, domain = "claude.ai"): GatewayCookieSnapshot {
  return {
    name,
    value: "value",
    domain,
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
    partitionKey: null,
  };
}

describe("GatewayBackedService origin routing", () => {
  it("promotes a challenged structured origin and replays safe requests natively", async () => {
    const promoted: string[] = [];
    const gatewayFetch = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path === GATEWAY_COOKIES_PATH)
        return Response.json({ cookies: [], initialized: true });
      if (path === GATEWAY_FETCH_PATH) {
        return new Response("challenge", {
          headers: {
            [GATEWAY_RESPONSE_HEADER]: "authoritative",
            "cf-mitigated": "challenge",
          },
        });
      }
      throw new Error(`unexpected gateway request: ${path}`);
    });
    const fake = fakeSession("browser response");
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
      onNativePromoted: (domain) => promoted.push(domain),
    });
    service.attachTo(fake.session, "space-1");

    const handler = fake.handlers.get("https");
    expect(handler).toBeDefined();
    const request = new Request("https://login.unknown-example.test/start");
    const first = await handler!(request);
    expect(await first.text()).toBe("browser response");
    expect(promoted).toEqual(["unknown-example.test"]);
    expect(fake.nativeFetch).toHaveBeenCalledTimes(1);
    expect(fake.nativeFetch).toHaveBeenNthCalledWith(1, request, {
      bypassCustomProtocolHandlers: true,
      redirect: "manual",
    });

    const structuredCalls = gatewayFetch.mock.calls.filter(([input]) =>
      new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname.endsWith("/fetch"),
    ).length;
    await handler!(new Request("https://static.unknown-example.test/app.js"));
    expect(fake.nativeFetch).toHaveBeenCalledTimes(2);
    expect(
      gatewayFetch.mock.calls.filter(([input]) =>
        new URL(
          input instanceof Request ? input.url : input.toString(),
        ).pathname.endsWith("/fetch"),
      ),
    ).toHaveLength(structuredCalls);
  });

  it("starts Claude natively without importing cookies from the structured jar", async () => {
    const gatewayFetch = vi.fn<typeof fetch>(async (input) => {
      throw new Error(`Claude must not use the gateway: ${String(input)}`);
    });
    const fake = fakeSession();
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");

    await fake.handlers.get("https")!(new Request("https://claude.ai/login"));
    expect(fake.nativeFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });

  it("keeps dependencies of a native identity page on Chromium's network path", async () => {
    const gatewayFetch = vi.fn<typeof fetch>(async (input) => {
      throw new Error(
        `native page dependency must not use the gateway: ${String(input)}`,
      );
    });
    const fake = fakeSession("asset");
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");

    const response = await fake.handlers.get("https")!(
      new Request("https://static.example.test/google-logo.svg", {
        headers: { referer: "https://accounts.google.com/" },
      }),
    );

    expect(await response.text()).toBe("asset");
    expect(fake.nativeFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("mirrors only structured-origin cookies during gateway hydration", async () => {
    const gatewayFetch = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path === GATEWAY_COOKIES_PATH) {
        return Response.json({
          initialized: true,
          cookies: [cookie("sessionKey"), cookie("auth_token", "x.com")],
        });
      }
      if (path === GATEWAY_FETCH_PATH) {
        return new Response("ok", {
          headers: { [GATEWAY_RESPONSE_HEADER]: "authoritative" },
        });
      }
      throw new Error(`unexpected gateway request: ${path}`);
    });
    const fake = fakeSession();
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");

    await fake.handlers.get("https")!(new Request("https://x.com/home"));
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(fake.set.mock.calls[0]?.[0]).toMatchObject({
      name: "auth_token",
      url: "https://x.com/",
    });
  });

  it("publishes only structured application cookies to the canonical jar", async () => {
    const mutations: unknown[] = [];
    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path === GATEWAY_COOKIES_PATH && init?.method === "PUT") {
        mutations.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      if (path === GATEWAY_COOKIES_PATH)
        return Response.json({ cookies: [], initialized: true });
      throw new Error(`unexpected gateway request: ${path}`);
    });
    const fake = fakeSession();
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");

    const base = {
      value: "value",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      session: true,
      sameSite: "lax" as const,
    };
    fake.emitCookie({
      ...base,
      name: "cf_clearance",
      domain: "x.com",
    } as Cookie);
    fake.emitCookie({
      ...base,
      name: "sessionKey",
      domain: "claude.ai",
    } as Cookie);
    fake.emitCookie({ ...base, name: "auth_token", domain: "x.com" } as Cookie);

    await vi.waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({
      cookie: { name: "auth_token", domain: "x.com" },
    });
  });

  it("keeps the workspace navigation fence closed until gateway mutations commit", async () => {
    let releaseMutation: (() => void) | undefined;
    let noteMutationStarted: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationStarted = new Promise<void>((resolve) => {
      noteMutationStarted = resolve;
    });
    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path === GATEWAY_COOKIES_PATH && init?.method === "PUT") {
        noteMutationStarted?.();
        await mutationGate;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected gateway request: ${path}`);
    });
    const fake = fakeSession();
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");
    fake.emitCookie({
      name: "auth_token",
      value: "ready",
      domain: "x.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      session: true,
      sameSite: "lax",
    } as Cookie);
    await mutationStarted;

    let settled = false;
    const fence = service.flushSessionState().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseMutation?.();
    await expect(fence).resolves.toBe(true);
  });

  it("commits a local OAuth transaction cookie before the immediate exchange", async () => {
    let releaseMutation: (() => void) | undefined;
    let mutationStarted: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationObserved = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    let transactionCanonical = false;
    let exchangeBody = "";
    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      if (path === GATEWAY_COOKIES_PATH && init?.method === "PUT") {
        mutationStarted?.();
        await mutationGate;
        transactionCanonical = true;
        return new Response(null, { status: 204 });
      }
      if (path === GATEWAY_COOKIES_PATH) {
        return Response.json({ cookies: [], initialized: true });
      }
      if (path === GATEWAY_FETCH_PATH) {
        if (init?.body instanceof Uint8Array) {
          exchangeBody = new TextDecoder().decode(init.body);
        }
        const target = new URL(
          decodeGatewayHeaderValue(
            new Headers(init?.headers).get(GATEWAY_TARGET_HEADER) ?? "",
          ),
        );
        const exchange = target.pathname === "/oauth/exchange";
        return new Response(
          exchange && !transactionCanonical ? "rejected" : "authenticated",
          {
            status: exchange && !transactionCanonical ? 409 : 200,
            headers: { [GATEWAY_RESPONSE_HEADER]: "authoritative" },
          },
        );
      }
      throw new Error(`unexpected gateway request: ${path}`);
    });
    const fake = fakeSession();
    const service = new GatewayBackedService({
      getToken: async () => "token",
      gatewayUrl: "https://session.example",
      fetchImpl: gatewayFetch,
    });
    service.attachTo(fake.session, "space-1");
    const handler = fake.handlers.get("https");
    expect(handler).toBeDefined();
    await handler!(new Request("https://x.com/login"));

    fake.emitCookie({
      name: "oauth_transaction",
      value: "ready",
      domain: "x.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
    } as Cookie);
    await mutationObserved;

    const request = new Request("https://x.com/oauth/exchange", {
      method: "POST",
      body: new Blob(["signed-token"]),
    });
    const exchange = handler!(request);
    // A protocol Request's Blob body is owned by the renderer. It must be
    // consumed before waiting for the cookie mutation, because an unload-time
    // beacon can destroy that renderer while the mutation is still in flight.
    expect(request.body?.locked).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseMutation?.();

    expect((await exchange).status).toBe(200);
    expect(exchangeBody).toBe("signed-token");
  });
});
