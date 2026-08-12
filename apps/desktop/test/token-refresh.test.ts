import { describe, expect, it } from "vitest";
import {
  refreshDelayMs,
  shouldRefreshToken,
  TOKEN_REFRESH_LEEWAY_SECONDS,
  tokenExpSeconds,
} from "../src/main/auth-token";
import { ControlClient } from "../src/main/control-client";

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url(payload)}.c2ln`;
}

describe("tokenExpSeconds", () => {
  it("reads exp from a compact JWT", () => {
    expect(tokenExpSeconds(jwtWith({ sub: "u", exp: 1_700_000_600 }))).toBe(1_700_000_600);
  });

  it("returns null for opaque dev tokens", () => {
    expect(tokenExpSeconds("hbr_dev_9a1b2c3d-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for a JWT without a numeric exp", () => {
    expect(tokenExpSeconds(jwtWith({ sub: "u" }))).toBeNull();
    expect(tokenExpSeconds(jwtWith({ exp: "soon" }))).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    expect(tokenExpSeconds("a.!!!!.c")).toBeNull();
    expect(tokenExpSeconds("a.b")).toBeNull();
  });
});

describe("shouldRefreshToken", () => {
  const exp = 10_000;

  it("holds off outside the leeway window", () => {
    expect(shouldRefreshToken(exp, exp - TOKEN_REFRESH_LEEWAY_SECONDS - 1)).toBe(false);
  });

  it("refreshes exactly at exp - leeway (spec: schedule at exp - 60s)", () => {
    expect(shouldRefreshToken(exp, exp - TOKEN_REFRESH_LEEWAY_SECONDS)).toBe(true);
  });

  it("refreshes past expiry", () => {
    expect(shouldRefreshToken(exp, exp + 1)).toBe(true);
  });
});

describe("refreshDelayMs", () => {
  it("schedules for exp - leeway", () => {
    expect(refreshDelayMs(10_000, 1_000_000)).toBe(
      (10_000 - TOKEN_REFRESH_LEEWAY_SECONDS) * 1000 - 1_000_000,
    );
  });

  it("clamps to zero when already due", () => {
    expect(refreshDelayMs(100, 200_000_000)).toBe(0);
  });
});

/**
 * A rejected token must not be terminal. The scheduled pre-expiry refresh
 * cannot cover a token the server stops accepting EARLY — key rotation, clock
 * skew, or one that lapsed while the app was closed — and before this the
 * client sat permanently unauthorized with no way for the user to sign in
 * again (§8.2).
 */
describe("ControlClient re-auth on a rejected token", () => {
  const ok = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const unauthorized = (): Response => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  it("proves the device key once and retries the request", async () => {
    const calls: string[] = [];
    let accepted = false;
    const client = new ControlClient("http://control.test", async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${String(init?.method ?? "GET")} ${path}`);
      if (path === "/v1/devices") return accepted ? ok({ devices: [{ id: "d1" }] }) : unauthorized();
      throw new Error(`unexpected ${path}`);
    });
    client.setToken("stale");
    client.setReauth(async () => {
      accepted = true;
      return "fresh";
    });

    expect(await client.listDevices()).toEqual([{ id: "d1" }]);
    expect(calls).toEqual(["GET /v1/devices", "GET /v1/devices"]);
  });

  it("shares one device-login across concurrent 401s", async () => {
    let accepted = false;
    let proofs = 0;
    const client = new ControlClient("http://control.test", async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/devices") return accepted ? ok({ devices: [] }) : unauthorized();
      throw new Error(`unexpected ${path}`);
    });
    client.setToken("stale");
    client.setReauth(async () => {
      proofs += 1;
      await Promise.resolve();
      accepted = true;
      return "fresh";
    });

    await Promise.all([client.listDevices(), client.listDevices(), client.listDevices()]);
    expect(proofs).toBe(1);
  });

  it("only reports unauthorized when the proof itself fails — a revoked device", async () => {
    let unauthorizedSeen = 0;
    const client = new ControlClient(
      "http://control.test",
      async () => unauthorized(),
      () => {
        unauthorizedSeen += 1;
      },
    );
    client.setToken("stale");
    client.setReauth(async () => null); // revoked: no token can be minted

    await expect(client.listDevices()).rejects.toThrow(/unauthorized/);
    expect(unauthorizedSeen).toBe(1);
  });

  it("retries at most once, so a server that always 401s cannot loop", async () => {
    let requests = 0;
    let proofs = 0;
    const client = new ControlClient("http://control.test", async () => {
      requests += 1;
      return unauthorized();
    });
    client.setToken("stale");
    client.setReauth(async () => {
      proofs += 1;
      return "fresh-but-still-rejected";
    });

    await expect(client.listDevices()).rejects.toThrow(/unauthorized/);
    expect(requests).toBe(2);
    expect(proofs).toBe(1);
  });
});
