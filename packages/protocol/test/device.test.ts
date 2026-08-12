import { describe, expect, it } from "vitest";
import {
  exportPublicKeyRaw,
  generateDeviceKeypair,
  importPublicKeyRaw,
  signRecord,
  toBase64,
  verifyRecord,
  type SignableRecordFields,
} from "../src/index.js";

const fields: SignableRecordFields = {
  spaceId: "space-1",
  recordId: "ab".repeat(32),
  originId: "cd".repeat(32),
  sealedRecord: "c2VhbGVk",
  hlc: { physicalMs: 1_722_400_000_000, logical: 3, deviceId: "dev-a" },
  causalParent: null,
  cause: "WRITE",
};

describe("device-signed mutations (PRD §8.3)", () => {
  it("signs and verifies a record, including via exported public key", async () => {
    const pair = await generateDeviceKeypair();
    const sig = await signRecord(pair.privateKey, fields);
    expect(await verifyRecord(pair.publicKey, sig, fields)).toBe(true);
    const roundTripped = await importPublicKeyRaw(await exportPublicKeyRaw(pair.publicKey));
    expect(await verifyRecord(roundTripped, sig, fields)).toBe(true);
  });

  it("rejects any mutated field", async () => {
    const pair = await generateDeviceKeypair();
    const sig = await signRecord(pair.privateKey, fields);
    const mutations: SignableRecordFields[] = [
      { ...fields, cause: "EXPLICIT_DELETE" },
      { ...fields, hlc: { ...fields.hlc, logical: 4 } },
      { ...fields, sealedRecord: toBase64(new Uint8Array([1, 2, 3])) },
      { ...fields, causalParent: "ff".repeat(32) + "@1-0-dev-a" },
      { ...fields, spaceId: "space-2" },
    ];
    for (const m of mutations) {
      expect(await verifyRecord(pair.publicKey, sig, m)).toBe(false);
    }
  });

  it("rejects another device's signature", async () => {
    const a = await generateDeviceKeypair();
    const b = await generateDeviceKeypair();
    const sig = await signRecord(a.privateKey, fields);
    expect(await verifyRecord(b.publicKey, sig, fields)).toBe(false);
  });
});
