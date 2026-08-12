import { describe, expect, it } from "vitest";
import { matchOriginPolicy } from "@suma/protocol";
import { SEED_CORPUS, TOMBSTONE_RETENTION_MS } from "../src/index.js";

describe("seed corpus invariants (PRD §4)", () => {
  it("covers the 30–50 origin target", () => {
    expect(SEED_CORPUS.length).toBeGreaterThanOrEqual(30);
    expect(SEED_CORPUS.length).toBeLessThanOrEqual(50);
  });

  it("has unique domains", () => {
    const domains = SEED_CORPUS.map((p) => p.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("sensitive origins are never Portable and never tier-synced by default", () => {
    for (const p of SEED_CORPUS.filter((p) => p.sensitive)) {
      expect(p.mode).not.toBe("portable");
      expect(p.syncTier).toBe(0);
    }
  });

  it("device-bound origins are never tier-synced", () => {
    for (const p of SEED_CORPUS.filter((p) => p.mode === "device_bound")) {
      expect(p.syncTier).toBe(0);
    }
  });

  it("resolves representative hosts", () => {
    expect(matchOriginPolicy(SEED_CORPUS, "github.com").mode).toBe("portable");
    expect(matchOriginPolicy(SEED_CORPUS, "api.github.com").mode).toBe("portable");
    expect(matchOriginPolicy(SEED_CORPUS, "chase.com").sensitive).toBe(true);
    expect(matchOriginPolicy(SEED_CORPUS, "totally-unknown.example").syncTier).toBe(0);
  });

  it("tombstone retention meets the ≥30-day PRD floor", () => {
    expect(TOMBSTONE_RETENTION_MS).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});
