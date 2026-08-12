import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { concatBytes, generateTokenKeypair, toBase64, utf8, verifyDeviceToken } from "@suma/protocol";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { createSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";
import { toBase64Url } from "../src/webauthn.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let signing: SigningKeys;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const pair = await generateTokenKeypair();
  signing = await createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
  app = createApp(db, new StubSandboxProvider(), signing);
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

let emailCounter = 0;

async function signup(): Promise<{ userId: string; token: string }> {
  const email = `webauthn-${emailCounter++}@example.com`;
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const body = await res.json();
  return { userId: body.user.id, token: `hbr_dev_${body.user.id}` };
}

async function enrollDevice(token: string): Promise<string> {
  const devicePublicKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const res = await app.request(
    "/v1/devices/enroll",
    jsonInit("POST", { name: "MBP", platform: "darwin", devicePublicKey }, token),
  );
  expect(res.status).toBe(201);
  return (await res.json()).device.id;
}

/* ------------------------------------------------------------------ *
 * Tiny CBOR/COSE encoder — the mirror image of src/webauthn.ts's decoder,
 * only what a fabricated authenticator needs.
 * ------------------------------------------------------------------ */

function cborHead(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 256) return [m | 24, n];
  if (n < 65536) return [m | 25, n >> 8, n & 0xff];
  throw new Error("test encoder: length too large");
}

function cborInt(n: number): number[] {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}

function cborBytes(b: Uint8Array): number[] {
  return [...cborHead(2, b.length), ...b];
}

function cborText(s: string): number[] {
  const b = utf8(s);
  return [...cborHead(3, b.length), ...b];
}

function cborMap(entries: Array<[number | string, number[]]>): number[] {
  const out = cborHead(5, entries.length);
  for (const [key, value] of entries) {
    out.push(...(typeof key === "number" ? cborInt(key) : cborText(key)));
    out.push(...value);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const FLAGS_REG = 0x45; // UP | UV | AT
const FLAGS_LOGIN = 0x05; // UP | UV

async function makeAuthData(opts: {
  rpId?: string;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  coseKey?: Uint8Array;
}): Promise<Uint8Array> {
  const head = new Uint8Array(37);
  head.set(await sha256(utf8(opts.rpId ?? "localhost")), 0);
  head[32] = opts.flags;
  new DataView(head.buffer).setUint32(33, opts.signCount, false);
  if (!opts.credentialId || !opts.coseKey) return head;
  const credHeader = new Uint8Array(18); // aaguid(16) + credIdLen(2)
  new DataView(credHeader.buffer).setUint16(16, opts.credentialId.length, false);
  return concatBytes(head, credHeader, opts.credentialId, opts.coseKey);
}

function attestationObject(authData: Uint8Array): Uint8Array {
  return new Uint8Array(
    cborMap([
      ["fmt", cborText("none")],
      ["attStmt", cborMap([])],
      ["authData", cborBytes(authData)],
    ]),
  );
}

function clientDataJson(type: string, challenge: string, origin = "http://localhost"): Uint8Array {
  return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** WebCrypto emits raw r ‖ s; WebAuthn transports ES256 signatures as DER. */
function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const encodeInt = (bytes: Uint8Array): number[] => {
    let b = bytes;
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    const content = ((b[0] as number) & 0x80) !== 0 ? [0, ...b] : [...b];
    return [0x02, content.length, ...content];
  };
  const r = encodeInt(raw.subarray(0, 32));
  const s = encodeInt(raw.subarray(32, 64));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

interface FakeAuthenticator {
  credentialId: Uint8Array;
  coseKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

async function makeEd25519Authenticator(): Promise<FakeAuthenticator> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    coseKey: new Uint8Array(
      cborMap([
        [1, cborInt(1)], // kty: OKP
        [3, cborInt(-8)], // alg: EdDSA
        [-1, cborInt(6)], // crv: Ed25519
        [-2, cborBytes(raw)],
      ]),
    ),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes as BufferSource)),
  };
}

async function makeEs256Authenticator(): Promise<FakeAuthenticator> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)); // 04 ‖ x ‖ y
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(20)),
    coseKey: new Uint8Array(
      cborMap([
        [1, cborInt(2)], // kty: EC2
        [3, cborInt(-7)], // alg: ES256
        [-1, cborInt(1)], // crv: P-256
        [-2, cborBytes(raw.subarray(1, 33))],
        [-3, cborBytes(raw.subarray(33, 65))],
      ]),
    ),
    sign: async (bytes) =>
      ecdsaRawToDer(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            pair.privateKey,
            bytes as BufferSource,
          ),
        ),
      ),
  };
}

async function beginRegistration(token: string): Promise<{ challenge: string }> {
  const res = await app.request("/v1/auth/webauthn/register/begin", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const options = await res.json();
  expect(options.rp.id).toBe("localhost");
  expect(options.attestation).toBe("none");
  expect(options.pubKeyCredParams).toEqual([
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -8 },
  ]);
  return options;
}

async function registerPasskey(
  token: string,
  authenticator: FakeAuthenticator,
  opts: { deviceId?: string; prfEnabled?: boolean; origin?: string; credentialIdOverride?: string } = {},
): Promise<Response> {
  const { challenge } = await beginRegistration(token);
  const authData = await makeAuthData({
    flags: FLAGS_REG,
    signCount: 0,
    credentialId: authenticator.credentialId,
    coseKey: authenticator.coseKey,
  });
  const credential = {
    id: opts.credentialIdOverride ?? toBase64Url(authenticator.credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toBase64Url(clientDataJson("webauthn.create", challenge, opts.origin)),
      attestationObject: toBase64Url(attestationObject(authData)),
    },
    clientExtensionResults: { prf: { enabled: opts.prfEnabled ?? true } },
  };
  return app.request(
    "/v1/auth/webauthn/register/finish",
    jsonInit("POST", { credential, ...(opts.deviceId ? { deviceId: opts.deviceId } : {}) }, token),
  );
}

async function loginWithPasskey(
  userId: string,
  deviceId: string,
  authenticator: FakeAuthenticator,
  signCount: number,
  opts: { origin?: string; tamperChallenge?: boolean; credentialIdOverride?: string } = {},
): Promise<Response> {
  const begin = await app.request("/v1/auth/webauthn/login/begin", jsonInit("POST", { userId }));
  expect(begin.status).toBe(200);
  const options = await begin.json();
  const challenge: string = opts.tamperChallenge
    ? toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    : options.challenge;
  const authenticatorData = await makeAuthData({ flags: FLAGS_LOGIN, signCount });
  const cdj = clientDataJson("webauthn.get", challenge, opts.origin);
  const signature = await authenticator.sign(concatBytes(authenticatorData, await sha256(cdj)));
  const credential = {
    id: opts.credentialIdOverride ?? toBase64Url(authenticator.credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toBase64Url(cdj),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(signature),
    },
  };
  return app.request(
    "/v1/auth/webauthn/login/finish",
    jsonInit("POST", { userId, deviceId, credential }),
  );
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("passkey registration", () => {
  it("requires auth to begin", async () => {
    const res = await app.request("/v1/auth/webauthn/register/begin", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("registers an Ed25519 passkey and records PRF capability", async () => {
    const { token } = await signup();
    const authenticator = await makeEd25519Authenticator();
    const res = await registerPasskey(token, authenticator);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.credentialKind).toBe("webauthn");
    expect(body.passkey.id).toBe(toBase64Url(authenticator.credentialId));
    expect(body.passkey.prfCapable).toBe(true);
    expect(body.passkey.signCount).toBe(0);
    expect(body.passkey.publicKey).toBe(toBase64(authenticator.coseKey));

    const audits = await (
      await app.request("/v1/audit", { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(audits.events.map((e: { type: string }) => e.type)).toContain("auth.passkey_registered");
  });

  it("issues a device token from registration when bound to an enrolled device", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const res = await registerPasskey(token, await makeEd25519Authenticator(), { deviceId });
    expect(res.status).toBe(201);
    const body = await res.json();
    const verified = await verifyDeviceToken(signing.verifyKey, body.deviceToken, nowSeconds());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.did).toBe(deviceId);
  });

  it("rejects a wrong origin", async () => {
    const { token } = await signup();
    const res = await registerPasskey(token, await makeEd25519Authenticator(), {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("origin_mismatch");
  });

  it("rejects a credential id that does not match the attested one", async () => {
    const { token } = await signup();
    const res = await registerPasskey(token, await makeEd25519Authenticator(), {
      credentialIdOverride: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("credential_id_mismatch");
  });

  it("rejects a reused challenge", async () => {
    const { token } = await signup();
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);
    // finish again without a fresh begin: the challenge was consumed.
    const authData = await makeAuthData({
      flags: FLAGS_REG,
      signCount: 0,
      credentialId: authenticator.credentialId,
      coseKey: authenticator.coseKey,
    });
    const credential = {
      id: toBase64Url(authenticator.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJson("webauthn.create", "whatever")),
        attestationObject: toBase64Url(attestationObject(authData)),
      },
    };
    const res = await app.request(
      "/v1/auth/webauthn/register/finish",
      jsonInit("POST", { credential }, token),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("challenge_expired");
  });
});

describe("passkey login", () => {
  it("verifies an Ed25519 assertion and issues a verifiable device token", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);

    const res = await loginWithPasskey(userId, deviceId, authenticator, 1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentialKind).toBe("webauthn");
    const verified = await verifyDeviceToken(signing.verifyKey, body.deviceToken, nowSeconds());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.did).toBe(deviceId);

    // The middleware accepts the minted token.
    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${body.deviceToken}` } });
    expect(me.status).toBe(200);
  });

  it("verifies an ES256 assertion", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEs256Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);
    const res = await loginWithPasskey(userId, deviceId, authenticator, 1);
    expect(res.status).toBe(200);
    expect(
      (await verifyDeviceToken(signing.verifyKey, (await res.json()).deviceToken, nowSeconds())).ok,
    ).toBe(true);
  });

  it("rejects a signCount regression and accepts the next increment", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);
    expect((await loginWithPasskey(userId, deviceId, authenticator, 3)).status).toBe(200);

    const replayed = await loginWithPasskey(userId, deviceId, authenticator, 3);
    expect(replayed.status).toBe(401);
    expect((await replayed.json()).reason).toBe("sign_count_regression");

    expect((await loginWithPasskey(userId, deviceId, authenticator, 4)).status).toBe(200);
  });

  it("allows counterless authenticators that always report zero", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);
    expect((await loginWithPasskey(userId, deviceId, authenticator, 0)).status).toBe(200);
    expect((await loginWithPasskey(userId, deviceId, authenticator, 0)).status).toBe(200);
  });

  it("rejects wrong origin, tampered challenge, and unknown credentials", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);

    const badOrigin = await loginWithPasskey(userId, deviceId, authenticator, 1, {
      origin: "https://evil.example",
    });
    expect(badOrigin.status).toBe(401);
    expect((await badOrigin.json()).reason).toBe("origin_mismatch");

    const tampered = await loginWithPasskey(userId, deviceId, authenticator, 2, {
      tamperChallenge: true,
    });
    expect(tampered.status).toBe(401);
    expect((await tampered.json()).reason).toBe("challenge_mismatch");

    const unknown = await loginWithPasskey(userId, deviceId, authenticator, 2, {
      credentialIdOverride: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    });
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).reason).toBe("unknown_credential");
  });

  it("rejects an assertion signed by the wrong key", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);

    const impostor = await makeEd25519Authenticator();
    const res = await loginWithPasskey(userId, deviceId, { ...impostor, credentialId: authenticator.credentialId }, 1);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("bad_signature");
  });

  it("refuses to bind the token to a revoked or foreign device", async () => {
    const { userId, token } = await signup();
    const deviceId = await enrollDevice(token);
    const authenticator = await makeEd25519Authenticator();
    expect((await registerPasskey(token, authenticator)).status).toBe(201);

    await app.request(`/v1/devices/${deviceId}/revoke`, jsonInit("POST", {}, token));
    const revoked = await loginWithPasskey(userId, deviceId, authenticator, 1);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).reason).toBe("device_not_active");

    const other = await signup();
    const foreignDevice = await enrollDevice(other.token);
    const foreign = await loginWithPasskey(userId, foreignDevice, authenticator, 2);
    expect(foreign.status).toBe(401);
    expect((await foreign.json()).reason).toBe("device_not_active");
  });
});
