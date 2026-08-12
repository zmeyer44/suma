import { describe, expect, it } from "vitest";
import type { CookieIdentity } from "@suma/protocol";
import {
  collateralFor,
  lostCollateral,
  matchesTarget,
  restoreDetailsFor,
} from "../src/main/sync/collateral";
import type { ElectronCookie } from "../src/main/sync/cookie-map";

const SPACE = "space-1";

function identity(overrides: Partial<CookieIdentity> = {}): CookieIdentity {
  return {
    spaceId: SPACE,
    hostKey: "github.com",
    name: "sid",
    path: "/",
    partitionKey: "",
    sourceScheme: "secure",
    ...overrides,
  };
}

function cookie(overrides: Partial<ElectronCookie> = {}): ElectronCookie {
  return {
    name: "sid",
    value: "v1",
    domain: "github.com",
    path: "/",
    secure: true,
    httpOnly: false,
    session: false,
    expirationDate: 1_900_000_000,
    sameSite: "lax",
    ...overrides,
  };
}

describe("matchesTarget", () => {
  it("matches the exact host key, name, and path", () => {
    expect(matchesTarget(identity(), cookie())).toBe(true);
  });

  it("distinguishes host-only from domain scope (dot preserved)", () => {
    expect(matchesTarget(identity({ hostKey: "github.com" }), cookie({ domain: ".github.com" }))).toBe(false);
    expect(matchesTarget(identity({ hostKey: ".github.com" }), cookie({ domain: "github.com" }))).toBe(false);
    expect(matchesTarget(identity({ hostKey: ".github.com" }), cookie({ domain: ".github.com" }))).toBe(true);
  });

  it("distinguishes paths", () => {
    expect(matchesTarget(identity({ path: "/" }), cookie({ path: "/app" }))).toBe(false);
    expect(matchesTarget(identity({ path: "/app" }), cookie({ path: "/app" }))).toBe(true);
  });

  it("applies the same defaults as the identity mapping (missing domain/path)", () => {
    const bare: ElectronCookie = { name: "sid", value: "v1" };
    expect(matchesTarget(identity({ hostKey: "", path: "/" }), bare)).toBe(true);
    expect(matchesTarget(identity({ hostKey: "github.com", path: "/" }), bare)).toBe(false);
  });
});

describe("collateralFor", () => {
  it("flags a domain sibling when the target is host-only", () => {
    const target = identity({ hostKey: "github.com" });
    const hostOnly = cookie({ domain: "github.com" });
    const domainWide = cookie({ domain: ".github.com", value: "v2" });
    expect(collateralFor(target, [hostOnly, domainWide])).toEqual([domainWide]);
  });

  it("flags a host-only sibling when the target is domain-scoped", () => {
    const target = identity({ hostKey: ".github.com" });
    const hostOnly = cookie({ domain: "github.com" });
    const domainWide = cookie({ domain: ".github.com" });
    expect(collateralFor(target, [hostOnly, domainWide])).toEqual([hostOnly]);
  });

  it("flags path siblings", () => {
    const target = identity({ path: "/" });
    const root = cookie({ path: "/" });
    const scoped = cookie({ path: "/app" });
    expect(collateralFor(target, [root, scoped])).toEqual([scoped]);
  });

  it("ignores cookies with a different name", () => {
    const target = identity();
    const other = cookie({ name: "other", domain: ".github.com" });
    expect(collateralFor(target, [cookie(), other])).toEqual([]);
  });

  it("returns nothing when only the target exists", () => {
    expect(collateralFor(identity(), [cookie()])).toEqual([]);
  });
});

describe("lostCollateral", () => {
  const domainWide = cookie({ domain: ".github.com", value: "v2" });
  const scoped = cookie({ path: "/app", value: "v3" });

  it("reports collateral whose identity vanished after removal", () => {
    expect(lostCollateral([domainWide, scoped], [scoped])).toEqual([domainWide]);
    expect(lostCollateral([domainWide, scoped], [])).toEqual([domainWide, scoped]);
  });

  it("keeps nothing when every collateral identity survived", () => {
    expect(lostCollateral([domainWide, scoped], [scoped, domainWide])).toEqual([]);
  });

  it("matches survivors by identity, not value", () => {
    const mutated = { ...domainWide, value: "different" };
    expect(lostCollateral([domainWide], [mutated])).toEqual([]);
  });
});

describe("restoreDetailsFor", () => {
  it("reconstructs a domain cookie with the exact set mapping", () => {
    const details = restoreDetailsFor(SPACE, cookie({ domain: ".github.com", httpOnly: true }));
    expect(details).toEqual({
      url: "https://github.com/",
      name: "sid",
      value: "v1",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1_900_000_000,
    });
  });

  it("omits domain for host-only cookies so scope is not widened", () => {
    const details = restoreDetailsFor(SPACE, cookie({ domain: "github.com" }));
    expect(details.domain).toBeUndefined();
    expect(details.url).toBe("https://github.com/");
  });

  it("keeps session cookies sessioned and nonsecure cookies on http", () => {
    const c = cookie({ domain: "internal.example", path: "/x", secure: false });
    delete c.expirationDate;
    const details = restoreDetailsFor(SPACE, c);
    expect(details.expirationDate).toBeUndefined();
    expect(details.url).toBe("http://internal.example/x");
    expect(details.secure).toBe(false);
  });
});
