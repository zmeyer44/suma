import { describe, expect, it } from "vitest";
import { hostKeyIsHostOnly, type CookiePlain, type SameSite } from "@suma/protocol";
import {
  attributesForCookie,
  cookieUrlFor,
  identityForCookie,
  removeTargetFor,
  sameSiteFromChromium,
  sameSiteToChromium,
  setDetailsForPlain,
  type ElectronCookie,
} from "../src/main/sync/cookie-map";

const SPACE = "space-1";

function cookie(overrides: Partial<ElectronCookie> = {}): ElectronCookie {
  return {
    name: "sid",
    value: "v1",
    domain: ".github.com",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    expirationDate: 1_900_000_000,
    sameSite: "lax",
    ...overrides,
  };
}

function plainFor(identity: Partial<CookiePlain["identity"]>, attributes: Partial<NonNullable<CookiePlain["attributes"]>> = {}): CookiePlain {
  return {
    identity: {
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/",
      partitionKey: "",
      sourceScheme: "secure",
      ...identity,
    },
    attributes: {
      value: "v1",
      expiresMs: 1_900_000_000_000,
      persistent: true,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      priority: "medium",
      ...attributes,
    },
    deleted: false,
  };
}

describe("identityForCookie", () => {
  it("preserves the leading dot of a domain cookie", () => {
    const identity = identityForCookie(SPACE, cookie({ domain: ".github.com" }));
    expect(identity.hostKey).toBe(".github.com");
    expect(hostKeyIsHostOnly(identity.hostKey)).toBe(false);
  });

  it("keeps host-only cookies dotless", () => {
    const identity = identityForCookie(SPACE, cookie({ domain: "github.com" }));
    expect(identity.hostKey).toBe("github.com");
    expect(hostKeyIsHostOnly(identity.hostKey)).toBe(true);
  });

  it("maps the rest of the tuple: space, path, unpartitioned, source scheme", () => {
    const identity = identityForCookie(SPACE, cookie({ path: "/app", secure: true }));
    expect(identity).toEqual({
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/app",
      partitionKey: "",
      sourceScheme: "secure",
    });
    expect(identityForCookie(SPACE, cookie({ secure: false })).sourceScheme).toBe("nonsecure");
  });
});

describe("attributesForCookie", () => {
  it("treats a missing expirationDate as a session cookie", () => {
    const c = cookie();
    delete c.expirationDate;
    const attrs = attributesForCookie(c);
    expect(attrs.expiresMs).toBeNull();
    expect(attrs.persistent).toBe(false);
  });

  it("converts expirationDate seconds to expiresMs", () => {
    const attrs = attributesForCookie(cookie({ expirationDate: 1_900_000_000 }));
    expect(attrs.expiresMs).toBe(1_900_000_000_000);
    expect(attrs.persistent).toBe(true);
  });

  it("carries value, secure, httpOnly, sameSite", () => {
    const attrs = attributesForCookie(cookie({ sameSite: "strict" }));
    expect(attrs.value).toBe("v1");
    expect(attrs.secure).toBe(true);
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("strict");
  });
});

describe("sameSite mapping", () => {
  const values: SameSite[] = ["unspecified", "no_restriction", "lax", "strict"];

  it("round-trips every value in both directions", () => {
    for (const value of values) {
      expect(sameSiteFromChromium(sameSiteToChromium(value))).toBe(value);
      expect(sameSiteToChromium(sameSiteFromChromium(value))).toBe(value);
    }
  });

  it("falls back to unspecified for unknown or missing input", () => {
    expect(sameSiteFromChromium(undefined)).toBe("unspecified");
    expect(sameSiteFromChromium("weird")).toBe("unspecified");
  });
});

describe("url reconstruction", () => {
  it("strips the leading dot and picks https for secure cookies", () => {
    const plain = plainFor({ hostKey: ".github.com" });
    expect(setDetailsForPlain(plain).url).toBe("https://github.com/");
  });

  it("uses http for nonsecure host-only cookies", () => {
    const plain = plainFor(
      { hostKey: "internal.example", sourceScheme: "nonsecure", path: "/x" },
      { secure: false },
    );
    expect(setDetailsForPlain(plain).url).toBe("http://internal.example/x");
  });

  it("removal targets rebuild the url from identity alone", () => {
    const target = removeTargetFor({
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/",
      partitionKey: "",
      sourceScheme: "secure",
    });
    expect(target).toEqual({ url: "https://github.com/", name: "sid" });
  });

  it("cookieUrlFor honors the secure flag even for nonsecure source schemes", () => {
    const identity = {
      spaceId: SPACE,
      hostKey: "example.com",
      name: "a",
      path: "/",
      partitionKey: "",
      sourceScheme: "nonsecure" as const,
    };
    expect(cookieUrlFor(identity, true)).toBe("https://example.com/");
    expect(cookieUrlFor(identity, false)).toBe("http://example.com/");
  });
});

describe("setDetailsForPlain", () => {
  it("includes domain for domain cookies and converts expiry to seconds", () => {
    const details = setDetailsForPlain(plainFor({ hostKey: ".github.com" }));
    expect(details.domain).toBe(".github.com");
    expect(details.expirationDate).toBe(1_900_000_000);
    expect(details.secure).toBe(true);
    expect(details.httpOnly).toBe(true);
    expect(details.sameSite).toBe("lax");
  });

  it("omits domain for host-only cookies", () => {
    const details = setDetailsForPlain(plainFor({ hostKey: "github.com" }));
    expect(details.domain).toBeUndefined();
  });

  it("omits expirationDate for session cookies", () => {
    const details = setDetailsForPlain(
      plainFor({}, { expiresMs: null, persistent: false }),
    );
    expect(details.expirationDate).toBeUndefined();
  });

  it("refuses tombstones", () => {
    const tombstone: CookiePlain = { ...plainFor({}), attributes: null, deleted: true };
    expect(() => setDetailsForPlain(tombstone)).toThrow();
  });
});
