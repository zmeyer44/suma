import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  exportPublicKeyRaw,
  generateDeviceKeypair,
  generateTokenKeypair,
  signDeviceToken,
  toBase64,
  verifyDeviceToken,
  type DeviceKeypair,
} from "@suma/protocol";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { deviceLoginSigningBytes } from "../src/auth.js";
import { createSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

class FakeNotifier {
  calls: Array<{ userId: string; deviceId: string }> = [];
  behavior: "deliver" | "throw" | "unconfigured" = "deliver";

  notify = (userId: string, deviceId: string): Promise<boolean> => {
    this.calls.push({ userId, deviceId });
    if (this.behavior === "throw")
      return Promise.reject(new Error("hub unreachable"));
    return Promise.resolve(this.behavior === "deliver");
  };
}

let db: Db;
let app: ReturnType<typeof createApp>;
let signing: SigningKeys;
let publicKeyB64: string;
let otherSigning: SigningKeys;
const notifier = new FakeNotifier();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const pair = await generateTokenKeypair();
  signing = await createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
  publicKeyB64 = toBase64(pair.publicKeyRaw);
  const otherPair = await generateTokenKeypair();
  otherSigning = await createSigningKeys(
    otherPair.privateKeyPkcs8,
    otherPair.publicKeyRaw,
  );
  app = createApp(db, new StubSandboxProvider(), signing, notifier.notify);
});

beforeEach(() => {
  notifier.calls = [];
  notifier.behavior = "deliver";
});

function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function authedInit(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

let emailCounter = 0;

async function signup(): Promise<{
  userId: string;
  spaceId: string;
  token: string;
  bootstrapToken: string;
}> {
  const email = `auth-${emailCounter++}@example.com`;
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const body = await res.json();
  return {
    userId: body.user.id,
    spaceId: body.space.id,
    token: `hbr_dev_${body.user.id}`,
    bootstrapToken: body.bootstrapToken,
  };
}

async function enrollDevice(
  token: string,
): Promise<{ deviceId: string; pair: DeviceKeypair; publicKey: string }> {
  const pair = await generateDeviceKeypair();
  const publicKey = toBase64(await exportPublicKeyRaw(pair.publicKey));
  const res = await app.request(
    "/v1/devices/enroll",
    jsonInit(
      "POST",
      { name: "MBP", platform: "darwin", devicePublicKey: publicKey },
      token,
    ),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  return { deviceId: body.device.id, pair, publicKey };
}

async function deviceChallenge(deviceId: string): Promise<string> {
  const res = await app.request(
    "/v1/auth/device-challenge",
    jsonInit("POST", { deviceId }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).challenge;
}

async function signChallenge(
  pair: DeviceKeypair,
  deviceId: string,
  challenge: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    deviceLoginSigningBytes(deviceId, challenge) as BufferSource,
  );
  return toBase64(new Uint8Array(sig));
}

async function deviceLogin(
  pair: DeviceKeypair,
  deviceId: string,
): Promise<{ deviceToken: string; exp: number }> {
  const challenge = await deviceChallenge(deviceId);
  const signature = await signChallenge(pair, deviceId, challenge);
  const res = await app.request(
    "/v1/auth/device-login",
    jsonInit("POST", { deviceId, signature }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("GET /v1/auth/jwks", () => {
  it("serves the base64 signing public key without auth", async () => {
    const res = await app.request("/v1/auth/jwks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicKey).toBe(publicKeyB64);
    expect(body.alg).toBe("EdDSA");
  });
});

describe("device-credential registration and login", () => {
  it("registers the device key and issues a verifiable device token", async () => {
    const { userId, token } = await signup();
    const { deviceId, pair, publicKey } = await enrollDevice(token);

    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(pair, deviceId, challenge);
    const res = await app.request(
      "/v1/auth/device-credential",
      jsonInit("POST", { deviceId, devicePublicKey: publicKey, signature }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.credentialKind).toBe("device-key");

    const verified = await verifyDeviceToken(
      signing.verifyKey,
      body.deviceToken,
      nowSeconds(),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.did).toBe(deviceId);
    expect(verified.claims.exp - verified.claims.iat).toBe(
      DEVICE_TOKEN_TTL_SECONDS,
    );
    expect(body.exp).toBe(verified.claims.exp);

    const audits = await (
      await app.request("/v1/audit", authedInit(token))
    ).json();
    expect(audits.events.map((e: { type: string }) => e.type)).toContain(
      "auth.device_credential_registered",
    );
  });

  it("rejects a registration whose public key does not match the enrolled one", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const otherKey = toBase64(
      await exportPublicKeyRaw((await generateDeviceKeypair()).publicKey),
    );
    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(pair, deviceId, challenge);
    const res = await app.request(
      "/v1/auth/device-credential",
      jsonInit("POST", { deviceId, devicePublicKey: otherKey, signature }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("key_mismatch");
  });

  it("logs in with a signed challenge and authenticates via the minted token", async () => {
    const { userId, token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const { deviceToken } = await deviceLogin(pair, deviceId);

    const me = await app.request("/v1/me", authedInit(deviceToken));
    expect(me.status).toBe(200);
    expect((await me.json()).user.id).toBe(userId);
  });

  it("rejects a signature from the wrong key", async () => {
    const { token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const stranger = await generateDeviceKeypair();
    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(stranger, deviceId, challenge);
    const res = await app.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId, signature }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("bad_signature");
  });

  it("consumes challenges: a second login with the same proof fails", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(pair, deviceId, challenge);
    const first = await app.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId, signature }),
    );
    expect(first.status).toBe(200);
    const replay = await app.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId, signature }),
    );
    expect(replay.status).toBe(401);
    expect((await replay.json()).reason).toBe("challenge_expired");
  });

  it("refuses login for a revoked device", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(pair, deviceId, challenge);
    const res = await app.request(
      "/v1/auth/device-login",
      jsonInit("POST", { deviceId, signature }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("device_revoked");
  });
});

describe("POST /v1/auth/token/refresh", () => {
  it("re-mints a signup bootstrap until the first device enrolls", async () => {
    const { userId, bootstrapToken } = await signup();

    const res = await app.request("/v1/auth/token/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()).deviceToken;
    const verified = await verifyDeviceToken(
      signing.verifyKey,
      refreshed,
      nowSeconds(),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.did).toBe(userId);

    await enrollDevice(refreshed);
  });

  it("refuses a bootstrap refresh after a device enrolls", async () => {
    const { token, bootstrapToken } = await signup();
    await enrollDevice(token);

    const res = await app.request("/v1/auth/token/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("bootstrap_consumed");
  });

  it("re-mints from a currently-valid device token", async () => {
    const { userId, token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const { deviceToken } = await deviceLogin(pair, deviceId);

    const res = await app.request("/v1/auth/token/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const verified = await verifyDeviceToken(
      signing.verifyKey,
      body.deviceToken,
      nowSeconds(),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.did).toBe(deviceId);
  });

  it("re-mints from a device-login proof", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const challenge = await deviceChallenge(deviceId);
    const signature = await signChallenge(pair, deviceId, challenge);
    const res = await app.request(
      "/v1/auth/token/refresh",
      jsonInit("POST", { deviceId, signature }),
    );
    expect(res.status).toBe(200);
    const verified = await verifyDeviceToken(
      signing.verifyKey,
      (await res.json()).deviceToken,
      nowSeconds(),
    );
    expect(verified.ok).toBe(true);
  });

  it("is refused after the device is revoked, even with an unexpired token", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const { deviceToken } = await deviceLogin(pair, deviceId);
    await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );

    const res = await app.request("/v1/auth/token/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("device_not_active");
  });

  it("401s with neither a token nor a proof", async () => {
    const res = await app.request("/v1/auth/token/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("bearer middleware device-token path", () => {
  it("accepts a freshly minted device token on protected routes", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const { deviceToken } = await deviceLogin(pair, deviceId);
    expect(
      (await app.request("/v1/devices", authedInit(deviceToken))).status,
    ).toBe(200);
    expect(
      (await app.request("/v1/machine", authedInit(deviceToken))).status,
    ).toBe(200);
  });

  it("rejects an expired token", async () => {
    const { userId, token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const iat = nowSeconds() - DEVICE_TOKEN_TTL_SECONDS - 120;
    const expired = await signDeviceToken(signing.signingKey, {
      sub: userId,
      did: deviceId,
      iat,
      exp: iat + DEVICE_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    });
    expect((await app.request("/v1/me", authedInit(expired))).status).toBe(401);
  });

  it("rejects a token signed by a different key", async () => {
    const { userId, token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const iat = nowSeconds();
    const forged = await signDeviceToken(otherSigning.signingKey, {
      sub: userId,
      did: deviceId,
      iat,
      exp: iat + DEVICE_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    });
    expect((await app.request("/v1/me", authedInit(forged))).status).toBe(401);
  });

  it("rejects a valid token once the device is revoked", async () => {
    const { token } = await signup();
    const { deviceId, pair } = await enrollDevice(token);
    const { deviceToken } = await deviceLogin(pair, deviceId);
    await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect((await app.request("/v1/me", authedInit(deviceToken))).status).toBe(
      401,
    );
  });
});

describe("revocation propagation to the hub", () => {
  it("calls the injected notifier exactly once with the right ids", async () => {
    const { userId, token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const res = await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).hubNotified).toBe(true);
    expect(notifier.calls).toEqual([{ userId, deviceId }]);

    // Revoking again is a no-op: no second notification.
    const again = await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect(again.status).toBe(200);
    expect((await again.json()).hubNotified).toBe(false);
    expect(notifier.calls).toHaveLength(1);
  });

  it("writes an outbox row when the notifier throws", async () => {
    notifier.behavior = "throw";
    const { userId, token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const res = await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).hubNotified).toBe(false);

    const outbox = await app.request(
      "/v1/admin/revocation-outbox",
      authedInit(token),
    );
    expect(outbox.status).toBe(200);
    const rows = (await outbox.json()).outbox;
    const row = rows.find((r: { deviceId: string }) => r.deviceId === deviceId);
    expect(row).toMatchObject({
      userId,
      deviceId,
      attempts: 1,
      deliveredAt: null,
    });
  });

  it("queues a pending outbox row when no hub is configured yet", async () => {
    notifier.behavior = "unconfigured";
    const { userId, token } = await signup();
    const { deviceId } = await enrollDevice(token);
    const res = await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect((await res.json()).hubNotified).toBe(false);
    // A row is queued (attempts unburned) so the revocation still propagates
    // once an admin URL is configured — silently dropping it would leave a
    // revoked device able to sync (§8.2).
    const rows = (
      await (
        await app.request("/v1/admin/revocation-outbox", authedInit(token))
      ).json()
    ).outbox;
    const row = rows.find((r: { deviceId: string }) => r.deviceId === deviceId);
    expect(row).toMatchObject({
      userId,
      deviceId,
      attempts: 0,
      deliveredAt: null,
    });
  });

  it("drains a previously-failed revocation once the hub recovers", async () => {
    notifier.behavior = "throw";
    const { deviceId } = await enrollDevice((await signup()).token);
    await app.request(
      `/v1/devices/${deviceId}/revoke`,
      jsonInit("POST", {}, (await signup()).token),
    );
    // The notifier recovers; a subsequent revoke's opportunistic drain delivers
    // the backlog, including the earlier failed row.
    notifier.behavior = "deliver";
    const second = await signup();
    const other = await enrollDevice(second.token);
    await app.request(
      `/v1/devices/${other.deviceId}/revoke`,
      jsonInit("POST", {}, second.token),
    );
    const rows = (
      await (
        await app.request(
          "/v1/admin/revocation-outbox",
          authedInit(second.token),
        )
      ).json()
    ).outbox;
    const drained = rows.find(
      (r: { deviceId: string }) => r.deviceId === deviceId,
    );
    expect(drained?.deliveredAt).not.toBeNull();
  });
});

describe("recovery wrapper", () => {
  it("stores, audits, and updates the recovery-code wrapper", async () => {
    const { spaceId, token } = await signup();
    const saltB64 = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const wrappedB64 = toBase64(crypto.getRandomValues(new Uint8Array(61)));

    const res = await app.request(
      `/v1/spaces/${spaceId}/recovery`,
      jsonInit("POST", { saltB64, wrappedB64 }, token),
    );
    expect(res.status).toBe(200);
    const wrapper = (await res.json()).wrapper;
    expect(wrapper).toMatchObject({
      kind: "recovery-code",
      credentialId: "recovery",
      salt: saltB64,
      wrapped: wrappedB64,
    });

    const audits = await (
      await app.request("/v1/audit", authedInit(token))
    ).json();
    expect(audits.events.map((e: { type: string }) => e.type)).toContain(
      "keys.recovery_set",
    );

    // Re-setting rotates in place rather than adding a second wrapper.
    const rewrapped = toBase64(crypto.getRandomValues(new Uint8Array(61)));
    const updated = await app.request(
      `/v1/spaces/${spaceId}/recovery`,
      jsonInit("POST", { saltB64, wrappedB64: rewrapped }, token),
    );
    expect((await updated.json()).wrapper).toMatchObject({
      id: wrapper.id,
      wrapped: rewrapped,
    });
  });

  it("filters the wrapper list by kind", async () => {
    const { spaceId, token } = await signup();
    await app.request(
      `/v1/spaces/${spaceId}/recovery`,
      jsonInit(
        "POST",
        { saltB64: toBase64(new Uint8Array(16)), wrappedB64: "AAAA" },
        token,
      ),
    );
    await app.request(
      `/v1/spaces/${spaceId}/wrappers`,
      jsonInit(
        "POST",
        { kind: "passkey-prf", credentialId: "cred-1", wrapped: "AAAA" },
        token,
      ),
    );

    const all = await (
      await app.request(`/v1/spaces/${spaceId}/wrappers`, authedInit(token))
    ).json();
    expect(all.wrappers).toHaveLength(2);
    const recovery = await (
      await app.request(
        `/v1/spaces/${spaceId}/wrappers?kind=recovery-code`,
        authedInit(token),
      )
    ).json();
    expect(recovery.wrappers).toHaveLength(1);
    expect(recovery.wrappers[0].kind).toBe("recovery-code");
  });

  it("404s a foreign space", async () => {
    const { spaceId } = await signup();
    const other = await signup();
    const res = await app.request(
      `/v1/spaces/${spaceId}/recovery`,
      jsonInit("POST", { saltB64: "", wrappedB64: "AAAA" }, other.token),
    );
    expect(res.status).toBe(404);
  });
});

describe("production mode: unsigned stub rejected, signed bootstrap token accepted", () => {
  let prodApp: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const pair = await generateTokenKeypair();
    // envProvided=true simulates CONTROL_TOKEN_SK/PK from the environment.
    const prodSigning = await createSigningKeys(
      pair.privateKeyPkcs8,
      pair.publicKeyRaw,
      true,
    );
    prodApp = createApp(
      db,
      new StubSandboxProvider(),
      prodSigning,
      notifier.notify,
    );
  });

  async function prodSignup(): Promise<{
    userId: string;
    bootstrapToken: string;
  }> {
    const email = `prod-${emailCounter++}@example.com`;
    const res = await prodApp.request(
      "/v1/accounts",
      jsonInit("POST", { email }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.bootstrapToken).toBe("string");
    return { userId: body.user.id, bootstrapToken: body.bootstrapToken };
  }

  it("rejects the unsigned hbr_dev_ stub once real signing keys are configured", async () => {
    const { userId } = await prodSignup();
    const res = await prodApp.request(
      "/v1/me",
      authedInit(`hbr_dev_${userId}`),
    );
    expect(res.status).toBe(401);
    const bound = await prodApp.request(
      "/v1/me",
      authedInit(`hbr_dev_${userId}.${crypto.randomUUID()}`),
    );
    expect(bound.status).toBe(401);
  });

  it("accepts the signed bootstrap token for enrollment", async () => {
    const { bootstrapToken } = await prodSignup();
    const me = await prodApp.request("/v1/me", authedInit(bootstrapToken));
    expect(me.status).toBe(200);
    const pair = await generateDeviceKeypair();
    const publicKey = toBase64(await exportPublicKeyRaw(pair.publicKey));
    const enroll = await prodApp.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        { name: "MBP", platform: "darwin", devicePublicKey: publicKey },
        bootstrapToken,
      ),
    );
    expect(enroll.status).toBe(201);
  });

  it("a bootstrap token for one user cannot act as another user", async () => {
    const a = await prodSignup();
    const b = await prodSignup();
    // b's bootstrap token authenticates as b, not a — /me returns b's account.
    const me = await (
      await prodApp.request("/v1/me", authedInit(b.bootstrapToken))
    ).json();
    expect(me.user.id).toBe(b.userId);
    expect(me.user.id).not.toBe(a.userId);
  });
});
