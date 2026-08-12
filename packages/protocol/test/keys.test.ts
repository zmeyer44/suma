import { describe, expect, it } from "vitest";
import {
  decodeCookiePlain,
  deriveKekFromPassphrase,
  deriveKekFromPrf,
  deriveKekFromRecoveryCode,
  deriveSpaceKeys,
  encodeCookiePlain,
  generateEnrollmentCode,
  generateRecoveryCode,
  generateSpaceRootSecret,
  lengthPrefixed,
  normalizeRecoveryCode,
  open,
  seal,
  unwrapRootSecret,
  utf8,
  wrapRootSecret,
  type CookiePlain,
} from "../src/index.js";

const plain: CookiePlain = {
  identity: {
    spaceId: "space-1",
    hostKey: ".github.com",
    name: "user_session",
    path: "/",
    partitionKey: "",
    sourceScheme: "secure",
  },
  attributes: {
    value: "secret-session-token",
    expiresMs: 1_800_000_000_000,
    persistent: true,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "high",
  },
  deleted: false,
};

describe("sealed records", () => {
  it("seals and opens a cookie record, hiding plaintext", async () => {
    const keys = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const aad = lengthPrefixed(["aad", "record-id"]);
    const sealed = await seal(keys.sealKey, encodeCookiePlain(plain), aad);
    const sealedStr = String.fromCharCode(...sealed);
    expect(sealedStr).not.toContain("github");
    expect(sealedStr).not.toContain("secret-session-token");
    const opened = decodeCookiePlain(await open(keys.sealKey, sealed, aad));
    expect(opened).toEqual(plain);
  });

  it("rejects tampered AAD (record id swap)", async () => {
    const keys = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const sealed = await seal(keys.sealKey, encodeCookiePlain(plain), utf8("record-a"));
    await expect(open(keys.sealKey, sealed, utf8("record-b"))).rejects.toThrow();
  });

  it("cannot open with another space's keys", async () => {
    const keysA = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const keysB = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const sealed = await seal(keysA.sealKey, encodeCookiePlain(plain), utf8("aad"));
    await expect(open(keysB.sealKey, sealed, utf8("aad"))).rejects.toThrow();
  });
});

describe("key hierarchy (PRD §8.2)", () => {
  it("wraps the root secret under a PRF-derived KEK and recovers it", async () => {
    const root = generateSpaceRootSecret();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    const kek = await deriveKekFromPrf(prfOutput, "credential-1");
    const wrapped = await wrapRootSecret(kek, root, "space-1");
    const kekAgain = await deriveKekFromPrf(prfOutput, "credential-1");
    expect(await unwrapRootSecret(kekAgain, wrapped, "space-1")).toEqual(root);
  });

  it("a wrapper for one credential cannot unwrap another credential's wrap", async () => {
    const root = generateSpaceRootSecret();
    const prfOutput = crypto.getRandomValues(new Uint8Array(32));
    const kek1 = await deriveKekFromPrf(prfOutput, "credential-1");
    const kek2 = await deriveKekFromPrf(prfOutput, "credential-2");
    const wrapped = await wrapRootSecret(kek1, root, "space-1");
    await expect(unwrapRootSecret(kek2, wrapped, "space-1")).rejects.toThrow();
  });

  it("recovery code round-trips through normalization and recovers the secret", async () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iterations = 1_000; // fast test path; production uses 600k
    const root = generateSpaceRootSecret();
    const kek = await deriveKekFromRecoveryCode(code, salt, iterations);
    const wrapped = await wrapRootSecret(kek, root, "space-1");
    const sloppy = code.toLowerCase().replace(/-/g, " ");
    const kekAgain = await deriveKekFromRecoveryCode(sloppy, salt, iterations);
    expect(await unwrapRootSecret(kekAgain, wrapped, "space-1")).toEqual(root);
  });

  it("normalization maps ambiguous characters", () => {
    expect(normalizeRecoveryCode("oOoO-Il1i-".repeat(4).slice(0, 39))).toHaveLength(32);
  });

  it("enrollment code carries a secret to another device and a wrong code cannot open it", async () => {
    // Exactly what AuthService.mintEnrollmentCode / signinWithCode do: seal the
    // account's space secret under a KEK derived from the enrollment code, then
    // recover it on the linked device from the same code (§8.2 key transfer).
    const code = generateEnrollmentCode();
    expect(code).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const secret = generateSpaceRootSecret();

    const mintKek = await deriveKekFromPassphrase(code, salt);
    const wrapped = await wrapRootSecret(mintKek, secret, "enroll:space-1");

    // Linked device, same code → same secret.
    const redeemKek = await deriveKekFromPassphrase(code, salt);
    expect(await unwrapRootSecret(redeemKek, wrapped, "enroll:space-1")).toEqual(secret);

    // Any other code cannot open it.
    const wrongKek = await deriveKekFromPassphrase(generateEnrollmentCode(), salt);
    await expect(unwrapRootSecret(wrongKek, wrapped, "enroll:space-1")).rejects.toThrow();
  });

  it("derived space keys are deterministic from the root secret", async () => {
    const root = generateSpaceRootSecret();
    const k1 = await deriveSpaceKeys("space-1", root);
    const k2 = await deriveSpaceKeys("space-1", root);
    const sealed = await seal(k1.sealKey, utf8("hello"), utf8("aad"));
    expect(await open(k2.sealKey, sealed, utf8("aad"))).toEqual(utf8("hello"));
  });
});
