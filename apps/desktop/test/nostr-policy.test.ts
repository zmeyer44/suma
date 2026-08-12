/**
 * Nostr signer — the permission model and payload hygiene. The load-bearing
 * claims: an unknown site can do NOTHING silently (every method resolves to
 * "ask"); per-kind signing rules beat the site's signing default ("allow kind
 * 3 on primal.net, ask for kind 1" is expressible and honored); and nothing a
 * page hands to signEvent reaches the queue or the signer without surviving
 * validation.
 */

import { describe, expect, it } from "vitest";
import {
  emptySitePolicy,
  isNostrMethod,
  nostrKindLabel,
  nostrRememberLabel,
  nostrRequestSummary,
  resolvePermission,
  sanitizeUnsignedEvent,
  MAX_NOSTR_CONTENT_CHARS,
  MAX_NOSTR_TAGS,
  type NostrSitePolicy,
} from "../src/shared/nostr";

function policy(overrides: Partial<NostrSitePolicy> = {}): NostrSitePolicy {
  return { ...emptySitePolicy("primal.net", 1000), ...overrides };
}

describe("resolvePermission", () => {
  it("defaults everything to ask when the site has no policy", () => {
    expect(resolvePermission(null, "getPublicKey")).toBe("ask");
    expect(resolvePermission(undefined, "signEvent", 1)).toBe("ask");
    expect(resolvePermission(null, "nip44.decrypt")).toBe("ask");
  });

  it("defaults unlisted methods of a known site to ask", () => {
    const p = policy({ methods: { getPublicKey: "allow" } });
    expect(resolvePermission(p, "getPublicKey")).toBe("allow");
    expect(resolvePermission(p, "nip04.encrypt")).toBe("ask");
  });

  it("per-kind signing rules beat the site's signing default", () => {
    // The PRD example: allow kind 3 (follow list) on primal.net, ask for kind 1.
    const p = policy({ kinds: { "3": "allow" }, signDefault: "ask" });
    expect(resolvePermission(p, "signEvent", 3)).toBe("allow");
    expect(resolvePermission(p, "signEvent", 1)).toBe("ask");
  });

  it("signDefault covers kinds with no rule, including deny", () => {
    const p = policy({ kinds: { "1": "allow" }, signDefault: "deny" });
    expect(resolvePermission(p, "signEvent", 1)).toBe("allow");
    expect(resolvePermission(p, "signEvent", 30023)).toBe("deny");
  });

  it("signEvent with no kind falls back to signDefault", () => {
    const p = policy({ kinds: { "1": "allow" }, signDefault: "ask" });
    expect(resolvePermission(p, "signEvent")).toBe("ask");
  });
});

describe("sanitizeUnsignedEvent", () => {
  const good = {
    kind: 1,
    content: "hello nostr",
    created_at: 1_700_000_000,
    tags: [["e", "abc"], ["p", "def"]],
  };

  it("accepts a well-formed event and floors created_at", () => {
    const event = sanitizeUnsignedEvent({ ...good, created_at: 1700000000.9 });
    expect(event).not.toBeNull();
    expect(event!.created_at).toBe(1700000000);
    expect(event!.tags).toEqual(good.tags);
  });

  it("rejects non-objects and missing fields", () => {
    expect(sanitizeUnsignedEvent(null)).toBeNull();
    expect(sanitizeUnsignedEvent("kind 1")).toBeNull();
    expect(sanitizeUnsignedEvent({})).toBeNull();
    expect(sanitizeUnsignedEvent({ ...good, kind: undefined })).toBeNull();
  });

  it("rejects fractional, negative, or non-numeric kinds", () => {
    expect(sanitizeUnsignedEvent({ ...good, kind: 1.5 })).toBeNull();
    expect(sanitizeUnsignedEvent({ ...good, kind: -1 })).toBeNull();
    expect(sanitizeUnsignedEvent({ ...good, kind: "1" })).toBeNull();
  });

  it("rejects malformed tags — anything but string[][]", () => {
    expect(sanitizeUnsignedEvent({ ...good, tags: "nope" })).toBeNull();
    expect(sanitizeUnsignedEvent({ ...good, tags: [["e", 5]] })).toBeNull();
    expect(sanitizeUnsignedEvent({ ...good, tags: ["e"] })).toBeNull();
  });

  it("clamps absurd payloads instead of queueing them", () => {
    const bigContent = "x".repeat(MAX_NOSTR_CONTENT_CHARS + 1);
    expect(sanitizeUnsignedEvent({ ...good, content: bigContent })).toBeNull();
    const manyTags = Array.from({ length: MAX_NOSTR_TAGS + 1 }, () => ["t"]);
    expect(sanitizeUnsignedEvent({ ...good, tags: manyTags })).toBeNull();
  });

  it("drops extra fields a page smuggled in (id, pubkey, sig)", () => {
    const event = sanitizeUnsignedEvent({
      ...good,
      id: "spoofed",
      pubkey: "spoofed",
      sig: "spoofed",
    });
    expect(event).toEqual({ ...good });
  });
});

describe("presentation helpers", () => {
  it("labels known kinds and stays honest about unknown ones", () => {
    expect(nostrKindLabel(1)).toBe("short note");
    expect(nostrKindLabel(3)).toBe("follow list");
    expect(nostrKindLabel(424242)).toBe("kind 424242 event");
  });

  it("summarizes each method for the card one-liner", () => {
    expect(nostrRequestSummary({ method: "getPublicKey" })).toBe(
      "Read your public key",
    );
    expect(
      nostrRequestSummary({
        method: "signEvent",
        event: { kind: 7, content: "+", created_at: 1, tags: [] },
      }),
    ).toBe("Sign a reaction");
  });

  it("spells out what remember will write, per kind and per host", () => {
    const label = nostrRememberLabel(
      {
        method: "signEvent",
        event: { kind: 3, content: "", created_at: 1, tags: [] },
      },
      "primal.net",
      true,
    );
    expect(label).toBe("Always allow signing follow lists on primal.net");
  });

  it("recognizes the method vocabulary and nothing else", () => {
    expect(isNostrMethod("signEvent")).toBe(true);
    expect(isNostrMethod("nip44.encrypt")).toBe(true);
    expect(isNostrMethod("signSchnorr")).toBe(false);
  });
});
