import { describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  deviceLoginSigningBytes,
  generateDeviceKeypair,
  generateTokenKeypair,
  importTokenSigningKey,
  importTokenVerifyKey,
  signDeviceToken,
  toHex,
  verifyDeviceToken,
  type DeviceTokenClaims,
} from "../src/index.js";

async function keys(): Promise<{ sign: CryptoKey; verify: CryptoKey }> {
  const kp = await generateTokenKeypair();
  return {
    sign: await importTokenSigningKey(kp.privateKeyPkcs8),
    verify: await importTokenVerifyKey(kp.publicKeyRaw),
  };
}

const now = 1_800_000_000;
const claims = (over: Partial<DeviceTokenClaims> = {}): DeviceTokenClaims => ({
  sub: "user-1",
  did: "device-1",
  iat: now,
  exp: now + DEVICE_TOKEN_TTL_SECONDS,
  jti: "token-1",
  ...over,
});

describe("device tokens (PRD §8.2)", () => {
  it("signs and verifies a fresh token", async () => {
    const { sign, verify } = await keys();
    const token = await signDeviceToken(sign, claims());
    const result = await verifyDeviceToken(verify, token, now + 60);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("user-1");
      expect(result.claims.did).toBe("device-1");
    }
  });

  it("rejects an expired token past the skew window", async () => {
    const { sign, verify } = await keys();
    const token = await signDeviceToken(sign, claims());
    const result = await verifyDeviceToken(verify, token, now + DEVICE_TOKEN_TTL_SECONDS + 120);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed by another key", async () => {
    const a = await keys();
    const b = await keys();
    const token = await signDeviceToken(a.sign, claims());
    expect(await verifyDeviceToken(b.verify, token, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload", async () => {
    const { sign, verify } = await keys();
    const token = await signDeviceToken(sign, claims());
    const [h, , s] = token.split(".");
    const forged = JSON.parse(
      Buffer.from((token.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    ) as DeviceTokenClaims;
    forged.did = "attacker-device";
    const payload = Buffer.from(JSON.stringify(forged))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = await verifyDeviceToken(verify, `${h}.${payload}.${s}`, now);
    expect(result.ok).toBe(false);
  });

  it("rejects structurally malformed tokens", async () => {
    const { verify } = await keys();
    expect(await verifyDeviceToken(verify, "not.a.jwt.at.all", now)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyDeviceToken(verify, "onlyonepart", now)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("device-login proof (PRD §8.2 — shared by control + desktop)", () => {
  it("is deterministic and depends on both deviceId and challenge", () => {
    const a = toHex(deviceLoginSigningBytes("dev-1", "chal-1"));
    expect(toHex(deviceLoginSigningBytes("dev-1", "chal-1"))).toBe(a);
    expect(toHex(deviceLoginSigningBytes("dev-2", "chal-1"))).not.toBe(a);
    expect(toHex(deviceLoginSigningBytes("dev-1", "chal-2"))).not.toBe(a);
    // Length-prefixing prevents field-boundary collisions.
    expect(toHex(deviceLoginSigningBytes("dev", "1chal-1"))).not.toBe(
      toHex(deviceLoginSigningBytes("dev1", "chal-1")),
    );
  });

  it("round-trips: a device signs the proof and the control side verifies it", async () => {
    // Mirrors the real flow: desktop signs deviceLoginSigningBytes with its
    // Ed25519 identity key; control verifies with the enrolled public key.
    const device = await generateDeviceKeypair();
    const bytes = deviceLoginSigningBytes("device-1", "challenge-xyz");
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", device.privateKey, bytes as BufferSource),
    );
    expect(
      await crypto.subtle.verify("Ed25519", device.publicKey, sig as BufferSource, bytes as BufferSource),
    ).toBe(true);
    // A signature over a different challenge does not verify.
    const other = deviceLoginSigningBytes("device-1", "challenge-abc");
    expect(
      await crypto.subtle.verify("Ed25519", device.publicKey, sig as BufferSource, other as BufferSource),
    ).toBe(false);
  });
});
