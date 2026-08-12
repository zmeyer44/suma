import {
  GATEWAY_COOKIES_PATH,
  GATEWAY_FETCH_PATH,
  GATEWAY_UPSTREAM_AUTH_HEADER,
  generateTokenKeypair,
  importTokenSigningKey,
  signDeviceToken,
  toBase64,
  type DeviceTokenClaims,
} from "@suma/protocol";
import { describe, expect, it } from "vitest";
import { authenticate, parseDeviceToken } from "../src/auth.js";
import worker, { type Env } from "../src/index.js";

const NOW = 1_700_000_000;

async function mintKit(): Promise<{ publicKey: string; signingKey: CryptoKey }> {
  const pair = await generateTokenKeypair();
  return {
    publicKey: toBase64(pair.publicKeyRaw),
    signingKey: await importTokenSigningKey(pair.privateKeyPkcs8),
  };
}

function claims(overrides: Partial<DeviceTokenClaims> = {}): DeviceTokenClaims {
  return {
    sub: "user-1",
    did: "device-1",
    iat: NOW - 60,
    exp: NOW + 540,
    jti: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("parseDeviceToken", () => {
  it("extracts the userId from a well-formed dev token", () => {
    expect(parseDeviceToken("Bearer hbr_dev_alice")).toBe("alice");
    expect(parseDeviceToken("bearer hbr_dev_u-123_x")).toBe("u-123_x");
  });

  it("extracts the userId from a device-bound enrollment token", () => {
    expect(parseDeviceToken("Bearer hbr_dev_alice.device-1")).toBe("alice");
    expect(parseDeviceToken("Bearer hbr_dev_u-123_x.9f8e7d6c")).toBe("u-123_x");
  });

  it("rejects missing or malformed headers", () => {
    expect(parseDeviceToken(null)).toBeNull();
    expect(parseDeviceToken("hbr_dev_alice")).toBeNull();
    expect(parseDeviceToken("Basic hbr_dev_alice")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_prod_alice")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_dev_")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_dev_al ice")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_dev_al/ice")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_dev_alice.")).toBeNull();
    expect(parseDeviceToken("Bearer hbr_dev_alice.dev.extra")).toBeNull();
    expect(parseDeviceToken("Bearer")).toBeNull();
  });
});

describe("authenticate", () => {
  it("verifies a control-plane-signed device token when CONTROL_PUBLIC_KEY is set", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims());
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: kit.publicKey },
      NOW,
    );
    expect(result).toEqual({ userId: "user-1", deviceId: "device-1" });
  });

  it("rejects an expired token", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims({ exp: NOW - 120 }));
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: kit.publicKey },
      NOW,
    );
    expect(result).toEqual({ error: "expired" });
  });

  it("rejects a token signed with the wrong key", async () => {
    const signer = await mintKit();
    const verifier = await mintKit();
    const token = await signDeviceToken(signer.signingKey, claims());
    const result = await authenticate(
      `Bearer ${token}`,
      { CONTROL_PUBLIC_KEY: verifier.publicKey },
      NOW,
    );
    expect(result).toEqual({ error: "bad_signature" });
  });

  it("rejects stub tokens once a public key is configured", async () => {
    const kit = await mintKit();
    const env = { CONTROL_PUBLIC_KEY: kit.publicKey };
    expect(await authenticate("Bearer hbr_dev_alice", env, NOW)).toEqual({
      error: "unauthorized",
    });
    expect(await authenticate("Bearer hbr_dev_alice.device-1", env, NOW)).toEqual({
      error: "unauthorized",
    });
  });

  it("accepts stub tokens while no public key is configured", async () => {
    expect(await authenticate("Bearer hbr_dev_alice", {}, NOW)).toEqual({
      userId: "alice",
      deviceId: null,
    });
    // Stub deviceIds are unverified — identity binds at the hello frame.
    expect(await authenticate("Bearer hbr_dev_alice.device-1", {}, NOW)).toEqual({
      userId: "alice",
      deviceId: null,
    });
    expect(await authenticate("Bearer nope", {}, NOW)).toEqual({ error: "unauthorized" });
    expect(await authenticate(null, {}, NOW)).toEqual({ error: "unauthorized" });
  });

  it("rejects a signed token while no public key is configured", async () => {
    const kit = await mintKit();
    const token = await signDeviceToken(kit.signingKey, claims());
    expect(await authenticate(`Bearer ${token}`, {}, NOW)).toEqual({ error: "unauthorized" });
  });
});

function fakeEnv(
  onFetch: (userId: string, request: Request) => Response,
  extra: Partial<Env> = {},
): Env {
  return {
    SESSION_HUB: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: (request: Request) => Promise.resolve(onFetch(id.name, request)),
      }),
    },
    ...extra,
  } as unknown as Env;
}

describe("worker routing", () => {
  it("returns 401 for hub routes without a valid token", async () => {
    const env = fakeEnv(() => new Response("should not be reached"));
    for (const path of [
      "/v1/hub/ws",
      "/v1/hub/hydrate",
      GATEWAY_FETCH_PATH,
      GATEWAY_COOKIES_PATH,
    ]) {
      const bare = await worker.fetch(new Request(`https://hub.test${path}`), env);
      expect(bare.status).toBe(401);
      const bad = await worker.fetch(
        new Request(`https://hub.test${path}`, {
          headers: { authorization: "Bearer nope" },
        }),
        env,
      );
      expect(bad.status).toBe(401);
    }
  });

  it("routes authenticated requests to the user's DO", async () => {
    let seen: string | null = null;
    const env = fakeEnv((userId) => {
      seen = userId;
      return new Response(JSON.stringify({ routed: true }));
    });
    const res = await worker.fetch(
      new Request("https://hub.test/v1/hub/hydrate", {
        method: "POST",
        headers: { authorization: "Bearer hbr_dev_alice" },
        body: JSON.stringify({ spaceId: "s1", sinceHlc: null }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(seen).toBe("alice");
  });

  it("routes gateway requests but strips the Suma bearer before the upstream actor", async () => {
    let sumaAuthorization: string | null = "unset";
    let upstreamAuthorization: string | null = null;
    const env = fakeEnv((_userId, request) => {
      sumaAuthorization = request.headers.get("authorization");
      upstreamAuthorization = request.headers.get(GATEWAY_UPSTREAM_AUTH_HEADER);
      return new Response("ok");
    });
    const response = await worker.fetch(
      new Request(`https://hub.test${GATEWAY_FETCH_PATH}`, {
        headers: {
          authorization: "Bearer hbr_dev_alice",
          [GATEWAY_UPSTREAM_AUTH_HEADER]: "Basic destination-credential",
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(sumaAuthorization).toBeNull();
    expect(upstreamAuthorization).toBe("Basic destination-credential");
  });

  it("accepts the token from ?access_token= for the WS upgrade (no header possible)", async () => {
    const kit = await mintKit();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signDeviceToken(
      kit.signingKey,
      claims({ iat: nowSeconds, exp: nowSeconds + 600 }),
    );
    let seen: string | null = null;
    let device: string | null = null;
    const env = fakeEnv(
      (userId, request) => {
        seen = userId;
        device = request.headers.get("x-suma-device");
        return new Response("{}");
      },
      { CONTROL_PUBLIC_KEY: kit.publicKey },
    );
    const res = await worker.fetch(
      new Request(`https://hub.test/v1/hub/ws?access_token=${encodeURIComponent(token)}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(seen).toBe("user-1");
    // The edge-verified deviceId still reaches the DO via the query-param path.
    expect(device).toBe("device-1");
  });

  it("still 401s a WS upgrade with a bad ?access_token=", async () => {
    const env = fakeEnv(() => new Response("should not be reached"));
    const res = await worker.fetch(
      new Request("https://hub.test/v1/hub/ws?access_token=nope"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("forwards the verified deviceId and strips spoofed device headers", async () => {
    const kit = await mintKit();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signDeviceToken(
      kit.signingKey,
      claims({ iat: nowSeconds, exp: nowSeconds + 600 }),
    );
    let device: string | null = null;
    const env = fakeEnv(
      (_, request) => {
        device = request.headers.get("x-suma-device");
        return new Response("{}");
      },
      { CONTROL_PUBLIC_KEY: kit.publicKey },
    );
    const res = await worker.fetch(
      new Request("https://hub.test/v1/hub/hydrate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-suma-device": "mallory-device",
        },
        body: JSON.stringify({ spaceId: "s1", sinceHlc: null }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(device).toBe("device-1");
  });

  it("strips client device headers in stub mode", async () => {
    let device: string | null = "unset";
    const env = fakeEnv((_, request) => {
      device = request.headers.get("x-suma-device");
      return new Response("{}");
    });
    await worker.fetch(
      new Request("https://hub.test/v1/hub/hydrate", {
        method: "POST",
        headers: {
          authorization: "Bearer hbr_dev_alice",
          "x-suma-device": "mallory-device",
        },
        body: JSON.stringify({ spaceId: "s1", sinceHlc: null }),
      }),
      env,
    );
    expect(device).toBeNull();
  });

  it("enforces methods per route", async () => {
    const env = fakeEnv(() => new Response("should not be reached"));
    const postWs = await worker.fetch(
      new Request("https://hub.test/v1/hub/ws", {
        method: "POST",
        headers: { authorization: "Bearer hbr_dev_alice" },
      }),
      env,
    );
    expect(postWs.status).toBe(405);
    const getHydrate = await worker.fetch(
      new Request("https://hub.test/v1/hub/hydrate", {
        headers: { authorization: "Bearer hbr_dev_alice" },
      }),
      env,
    );
    expect(getHydrate.status).toBe(405);
    const postCookies = await worker.fetch(
      new Request(`https://hub.test${GATEWAY_COOKIES_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer hbr_dev_alice" },
      }),
      env,
    );
    expect(postCookies.status).toBe(405);
  });

  it("serves healthz without auth and 404s elsewhere", async () => {
    const env = fakeEnv(() => new Response("should not be reached"));
    const health = await worker.fetch(new Request("https://hub.test/healthz"), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const missing = await worker.fetch(new Request("https://hub.test/nope"), env);
    expect(missing.status).toBe(404);
  });
});
