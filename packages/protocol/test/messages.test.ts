import { describe, expect, it } from "vitest";
import {
  makeVersionToken,
  matchOriginPolicy,
  mergeLww,
  parseClientMessage,
  parseServerMessage,
  parseVersionToken,
  sortByHlc,
  workspaceKeyFor,
  type ClientMessage,
  type OriginPolicy,
} from "../src/index.js";

describe("wire messages", () => {
  it("round-trips a publish message", () => {
    const msg: ClientMessage = {
      t: "publish",
      records: [
        {
          spaceId: "space-1",
          recordId: "ab".repeat(32),
          originId: "cd".repeat(32),
          sealedRecord: "c2VhbGVk",
          hlc: { physicalMs: 1000, logical: 0, deviceId: "dev-a" },
          causalParent: null,
          deviceSig: "c2ln",
          cause: "WRITE",
        },
      ],
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("rejects malformed frames", () => {
    expect(() => parseClientMessage(JSON.stringify({ t: "publish", records: [] }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ t: "nope" }))).toThrow();
    expect(() =>
      parseServerMessage(JSON.stringify({ t: "records", spaceId: "", records: [] })),
    ).toThrow();
  });

  it("version tokens round-trip", () => {
    const hlc = { physicalMs: 123456, logical: 42, deviceId: "dev-b" };
    const token = makeVersionToken("ab".repeat(32), hlc);
    expect(parseVersionToken(token)).toEqual({ recordId: "ab".repeat(32), hlc });
  });

  it("sortByHlc orders oldest first", () => {
    const rs = [
      { hlc: { physicalMs: 2, logical: 0, deviceId: "a" } },
      { hlc: { physicalMs: 1, logical: 5, deviceId: "b" } },
      { hlc: { physicalMs: 1, logical: 2, deviceId: "c" } },
    ];
    expect(sortByHlc(rs).map((r) => r.hlc.physicalMs)).toEqual([1, 1, 2]);
    expect(sortByHlc(rs)[0]?.hlc.logical).toBe(2);
  });
});

describe("continuity policy matching", () => {
  const policies: OriginPolicy[] = [
    {
      domain: "github.com",
      label: "GitHub",
      mode: "portable",
      syncTier: 1,
      rotatingAuth: false,
      sensitive: false,
    },
    {
      domain: "gist.github.com",
      label: "GitHub Gist",
      mode: "assisted",
      syncTier: 0,
      rotatingAuth: false,
      sensitive: false,
    },
  ];

  it("matches subdomains and prefers the longest suffix", () => {
    expect(matchOriginPolicy(policies, "github.com").label).toBe("GitHub");
    expect(matchOriginPolicy(policies, "api.github.com").label).toBe("GitHub");
    expect(matchOriginPolicy(policies, "gist.github.com").label).toBe("GitHub Gist");
  });

  it("falls back to the untested-origin default (assisted, no sync)", () => {
    const p = matchOriginPolicy(policies, "example.com");
    expect(p.mode).toBe("assisted");
    expect(p.syncTier).toBe(0);
  });

  it("never matches a partial label ('evilgithub.com')", () => {
    expect(matchOriginPolicy(policies, "evilgithub.com").label).toBe("Untested origin");
  });
});

describe("workspace LWW", () => {
  it("keeps the newer value and keys docs stably", () => {
    const older = { value: "a", hlc: { physicalMs: 1, logical: 0, deviceId: "x" } };
    const newer = { value: "b", hlc: { physicalMs: 2, logical: 0, deviceId: "y" } };
    expect(mergeLww(older, newer).value).toBe("b");
    expect(mergeLww(newer, older).value).toBe("b");
    expect(
      workspaceKeyFor({
        kind: "pin",
        pin: { id: "p1", spaceId: "s", url: "https://x", title: "t", position: 0 },
      }),
    ).toBe("pin:p1");
  });
});
