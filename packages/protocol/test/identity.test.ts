import { describe, expect, it } from "vitest";
import {
  canonicalIdentityBytes,
  computeOriginIdHex,
  computeRecordIdHex,
  deriveSpaceKeys,
  generateSpaceRootSecret,
  hostKeyIsHostOnly,
  normalizedHost,
  toHex,
  type CookieIdentity,
} from "../src/index.js";

const base: CookieIdentity = {
  spaceId: "space-1",
  hostKey: ".github.com",
  name: "user_session",
  path: "/",
  partitionKey: "",
  sourceScheme: "secure",
};

describe("cookie identity tuple (PRD §8.3 corrected identity)", () => {
  it("treats host-only vs domain scope as distinct identities", () => {
    const domainCookie = canonicalIdentityBytes(base);
    const hostOnly = canonicalIdentityBytes({ ...base, hostKey: "github.com" });
    expect(toHex(domainCookie)).not.toBe(toHex(hostOnly));
  });

  it("treats partition key (CHIPS) as part of identity", () => {
    const unpartitioned = canonicalIdentityBytes(base);
    const partitioned = canonicalIdentityBytes({ ...base, partitionKey: "https://embedder.example" });
    expect(toHex(unpartitioned)).not.toBe(toHex(partitioned));
  });

  it("treats source scheme as part of identity", () => {
    const secure = canonicalIdentityBytes(base);
    const nonsecure = canonicalIdentityBytes({ ...base, sourceScheme: "nonsecure" });
    expect(toHex(secure)).not.toBe(toHex(nonsecure));
  });

  it("length-prefixing prevents field-boundary collisions", () => {
    const a = canonicalIdentityBytes({ ...base, name: "ab", path: "c" });
    const b = canonicalIdentityBytes({ ...base, name: "a", path: "bc" });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("host-only helpers follow the leading-dot convention", () => {
    expect(hostKeyIsHostOnly("github.com")).toBe(true);
    expect(hostKeyIsHostOnly(".github.com")).toBe(false);
    expect(normalizedHost(".GitHub.com")).toBe("github.com");
  });
});

describe("pseudonymous ids", () => {
  it("record ids are deterministic per key and hide the identity", async () => {
    const root = generateSpaceRootSecret();
    const keys = await deriveSpaceKeys("space-1", root);
    const id1 = await computeRecordIdHex(keys.idKey, base);
    const id2 = await computeRecordIdHex(keys.idKey, base);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(id1).not.toContain("github");
  });

  it("different spaces yield unlinkable ids for the same cookie", async () => {
    const keysA = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const keysB = await deriveSpaceKeys("space-2", generateSpaceRootSecret());
    const a = await computeRecordIdHex(keysA.idKey, base);
    const b = await computeRecordIdHex(keysB.idKey, { ...base, spaceId: "space-2" });
    expect(a).not.toBe(b);
  });

  it("origin id groups domain and host-only cookies of one host", async () => {
    const keys = await deriveSpaceKeys("space-1", generateSpaceRootSecret());
    const a = await computeOriginIdHex(keys.idKey, "space-1", ".github.com");
    const b = await computeOriginIdHex(keys.idKey, "space-1", "github.com");
    expect(a).toBe(b);
    const other = await computeOriginIdHex(keys.idKey, "space-1", "linear.app");
    expect(a).not.toBe(other);
  });
});
