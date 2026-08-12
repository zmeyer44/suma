/**
 * The Buzz roster integration. The load-bearing claims: a pasted relay URL
 * normalizes (or refuses) predictably; relay frames are untrusted input and
 * parse defensively; the fold applies replaceable-event semantics and the
 * documented avatar precedence (persona avatar_url, then the agent's kind:0
 * profile, then nothing); and the service completes the NIP-42 handshake —
 * including the auth-required-before-AUTH race — or fails with a message a
 * settings page can show.
 */

import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import {
  normalizeBuzzRelayUrl,
  truncateNpub,
  type NostrSignedEvent,
} from "../src/shared/nostr";
import {
  buildAgentList,
  parseRelayMessage,
  relayMediaSha256,
  BUZZ_KIND_MANAGED_AGENT,
  BUZZ_KIND_PERSONA,
  DETAIL_SUB_ID,
  ROSTER_SUB_ID,
  type RelayEvent,
} from "../src/main/nostr/buzz-core";
import { BuzzService, type BuzzSocket } from "../src/main/nostr/buzz-service";
import { signBlossomGetAuth, signRelayAuthEvent } from "../src/main/nostr/nostr-core";

/* ------------------------------ url + parse ------------------------------ */

describe("normalizeBuzzRelayUrl", () => {
  it("accepts ws/wss, maps http(s), defaults bare hosts to wss", () => {
    expect(normalizeBuzzRelayUrl("wss://buzz.example.com")).toBe("wss://buzz.example.com/");
    expect(normalizeBuzzRelayUrl("ws://localhost:3000")).toBe("ws://localhost:3000/");
    expect(normalizeBuzzRelayUrl("https://buzz.example.com")).toBe("wss://buzz.example.com/");
    expect(normalizeBuzzRelayUrl("http://localhost:3000")).toBe("ws://localhost:3000/");
    expect(normalizeBuzzRelayUrl("  buzz.example.com  ")).toBe("wss://buzz.example.com/");
  });

  it("refuses non-websocket schemes and junk; empty clears", () => {
    expect(normalizeBuzzRelayUrl("ftp://buzz.example.com")).toBeNull();
    expect(normalizeBuzzRelayUrl("not a url")).toBeNull();
    expect(normalizeBuzzRelayUrl("")).toBeNull();
  });
});

describe("parseRelayMessage", () => {
  it("parses the frames the fetch conversation uses", () => {
    expect(parseRelayMessage('["AUTH","challenge-abc"]')).toEqual({
      type: "auth",
      challenge: "challenge-abc",
    });
    expect(parseRelayMessage('["EOSE","sub"]')).toEqual({ type: "eose", subId: "sub" });
    expect(parseRelayMessage('["CLOSED","sub","auth-required: do auth"]')).toEqual({
      type: "closed",
      subId: "sub",
      reason: "auth-required: do auth",
    });
    expect(parseRelayMessage('["OK","id",true,""]')).toMatchObject({
      type: "ok",
      accepted: true,
    });
  });

  it("degrades malformed frames and events to 'other' instead of throwing", () => {
    expect(parseRelayMessage("not json").type).toBe("other");
    expect(parseRelayMessage('{"kind":1}').type).toBe("other");
    // EVENT with a corrupt payload (bad pubkey) is dropped whole.
    expect(
      parseRelayMessage(
        JSON.stringify(["EVENT", "sub", { id: "x", kind: 1, pubkey: "nope", created_at: 1, tags: [], content: "" }]),
      ).type,
    ).toBe("other");
  });
});

/* -------------------------------- the fold ------------------------------- */

const OWNER = "a".repeat(64);
const AGENT_A = "b".repeat(64);
const AGENT_B = "c".repeat(64);

function managedAgent(
  agentPubkey: string,
  name: string,
  personaId: string | null,
  createdAt = 100,
): RelayEvent {
  return {
    id: `ma-${agentPubkey}-${String(createdAt)}`,
    kind: BUZZ_KIND_MANAGED_AGENT,
    pubkey: OWNER,
    created_at: createdAt,
    tags: [["d", agentPubkey]],
    content: JSON.stringify(
      personaId === null ? { name } : { name, persona_id: personaId },
    ),
  };
}

function persona(slug: string, avatarUrl: string | null, createdAt = 100): RelayEvent {
  return {
    id: `p-${slug}-${String(createdAt)}`,
    kind: BUZZ_KIND_PERSONA,
    pubkey: OWNER,
    created_at: createdAt,
    tags: [["d", slug]],
    content: JSON.stringify({ display_name: slug, avatar_url: avatarUrl }),
  };
}

function profile(pubkey: string, picture: string | null, createdAt = 100): RelayEvent {
  return {
    id: `k0-${pubkey}-${String(createdAt)}`,
    kind: 0,
    pubkey,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify({ name: "profile-name", picture }),
  };
}

describe("buildAgentList", () => {
  it("folds instances with persona-first avatar resolution", () => {
    const agents = buildAgentList([
      managedAgent(AGENT_A, "Reviewer", "reviewer-persona"),
      managedAgent(AGENT_B, "Helper", null),
      persona("reviewer-persona", "https://cdn.example/reviewer.png"),
      profile(AGENT_A, "https://cdn.example/ignored-kind0.png"),
      profile(AGENT_B, "https://cdn.example/helper-kind0.png"),
    ]);
    expect(agents.map((a) => a.name)).toEqual(["Helper", "Reviewer"]);
    const reviewer = agents.find((a) => a.name === "Reviewer")!;
    // The persona the owner configured beats the agent's own profile.
    expect(reviewer.avatarUrl).toBe("https://cdn.example/reviewer.png");
    expect(reviewer.pubkey).toBe(AGENT_A);
    expect(reviewer.npub).toBe(nip19.npubEncode(AGENT_A));
    // No persona ⇒ the kind:0 picture.
    expect(agents.find((a) => a.name === "Helper")!.avatarUrl).toBe(
      "https://cdn.example/helper-kind0.png",
    );
  });

  it("applies replaceable semantics — the newest event per agent wins", () => {
    const agents = buildAgentList([
      managedAgent(AGENT_A, "Old Name", null, 100),
      managedAgent(AGENT_A, "New Name", null, 200),
      managedAgent(AGENT_A, "Stale Replay", null, 150),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("New Name");
  });

  it("survives junk: bad d tags, non-JSON content, javascript: avatars", () => {
    const junk: RelayEvent = {
      id: "junk",
      kind: BUZZ_KIND_MANAGED_AGENT,
      pubkey: OWNER,
      created_at: 100,
      tags: [["d", "not-a-pubkey"]],
      content: "{",
    };
    const evil = persona("evil", null);
    evil.content = JSON.stringify({ avatar_url: "javascript:alert(1)" });
    const unnamed = managedAgent(AGENT_A, "", null);
    const agents = buildAgentList([junk, evil, unnamed]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Unnamed agent");
    expect(agents[0]!.avatarUrl).toBeNull();
  });
});

/* ------------------------------- the service ----------------------------- */

/** A scriptable relay end of the socket. */
class FakeSocket implements BuzzSocket {
  sent: unknown[][] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: "open" | "close" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
  frame(message: unknown[]): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }
  /** The last REQ's sub id for `kinds`, so the test can answer it. */
  lastReq(): unknown[] | undefined {
    return [...this.sent].reverse().find((frame) => frame[0] === "REQ");
  }
}

function buildService(
  socket: FakeSocket,
  signable = true,
  fetchImpl?: typeof fetch,
) {
  const sk = generateSecretKey();
  const states: string[] = [];
  const service = new BuzzService({
    relayUrl: () => "wss://buzz.test/",
    signAuth: (relayUrl, challenge): NostrSignedEvent | null =>
      signable ? signRelayAuthEvent(sk, relayUrl, challenge) : null,
    signMediaAuth: (sha256, host): NostrSignedEvent | null =>
      signable ? signBlossomGetAuth(sk, sha256, host) : null,
    emitChanged: (state) => states.push(state.status),
    connect: () => socket,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    timeoutMs: 2_000,
  });
  return { service, states, pubkey: getPublicKey(sk) };
}

describe("BuzzService", () => {
  it("completes the handshake: AUTH challenge, roster, detail, ready", async () => {
    const socket = new FakeSocket();
    const { service, states } = buildService(socket);
    const flight = service.refresh();

    socket.emit("open");
    // The relay challenges; the service must answer with a signed 22242
    // and re-issue the roster REQ.
    socket.frame(["AUTH", "challenge-1"]);
    const authFrame = socket.sent.find((frame) => frame[0] === "AUTH");
    expect(authFrame).toBeDefined();
    const authEvent = authFrame![1] as NostrSignedEvent;
    expect(authEvent.kind).toBe(22242);
    expect(authEvent.tags).toContainEqual(["challenge", "challenge-1"]);

    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Reviewer", "reviewer-persona")]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    // Detail phase must ask for personas AND the roster's agent profiles.
    const detail = socket.lastReq()!;
    expect(detail[1]).toBe(DETAIL_SUB_ID);
    expect(JSON.stringify(detail)).toContain(String(BUZZ_KIND_PERSONA));
    expect(JSON.stringify(detail)).toContain(AGENT_A);

    socket.frame(["EVENT", DETAIL_SUB_ID, persona("reviewer-persona", "https://cdn.example/r.png")]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);

    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]!.avatarUrl).toBe("https://cdn.example/r.png");
    expect(socket.closed).toBe(true);
    expect(states).toEqual(["loading", "ready"]);
  });

  it("tolerates auth-required arriving before the AUTH challenge", async () => {
    const socket = new FakeSocket();
    const { service } = buildService(socket);
    const flight = service.refresh();
    socket.emit("open");
    // The relay refuses the eager REQ first…
    socket.frame(["CLOSED", ROSTER_SUB_ID, "auth-required: authenticate"]);
    // …then challenges; the answer re-issues the REQ.
    socket.frame(["AUTH", "challenge-2"]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);
    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents).toEqual([]);
  });

  it("tolerates the pre-auth REQ's refusal arriving AFTER the auth reply", async () => {
    // Real-relay frame order: our eager REQ is refused in server order,
    // so its CLOSED lands after we already answered the challenge.
    const socket = new FakeSocket();
    const { service } = buildService(socket);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "challenge-race"]);
    socket.frame(["CLOSED", ROSTER_SUB_ID, "auth-required: authenticate first"]);
    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Racer", null)]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);
    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents.map((a) => a.name)).toEqual(["Racer"]);
    // …but a post-auth "restricted" refusal stays terminal (covered below),
    // and repeated auth-required refusals do not loop: only one retry.
    const reqCount = socket.sent.filter((f) => f[0] === "REQ" && f[1] === ROSTER_SUB_ID).length;
    expect(reqCount).toBeLessThanOrEqual(3); // eager + post-auth + one retry
  });

  it("ignores CLOSED acks for finished subscriptions — the real-relay trace", async () => {
    // Frame-for-frame replay of wss://suma.communities.buzz.xyz/: the
    // eager REQ's refusal triggers the one retry, the duplicate roster sub
    // replays its events after the phase moved to detail, and the relay
    // acks our CLOSE with a bare CLOSED "" — which must NOT fail a fetch
    // that already has everything it asked for.
    const socket = new FakeSocket();
    const { service } = buildService(socket);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "challenge"]);
    socket.frame(["CLOSED", ROSTER_SUB_ID, "auth-required: not authenticated"]);
    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Bumble", null)]);
    socket.frame(["EOSE", ROSTER_SUB_ID]); // → phase flips to detail, CLOSE sent
    // The retry sub replays after the phase moved on…
    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Bumble", null)]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    // …and the relay acks the CLOSE with an empty-reason CLOSED.
    socket.frame(["CLOSED", ROSTER_SUB_ID, ""]);
    socket.frame(["EVENT", DETAIL_SUB_ID, profile(AGENT_A, "https://cdn.example/b.png")]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);
    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents.map((a) => a.name)).toEqual(["Bumble"]);
    expect(state.agents[0]!.avatarUrl).toBe("https://cdn.example/b.png");
  });

  it("fails with a settings-page message when auth is needed but no key exists", async () => {
    const socket = new FakeSocket();
    const { service } = buildService(socket, false);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "challenge-3"]);
    const state = await flight;
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/Nostr key/);
  });

  it("surfaces a terminal relay refusal", async () => {
    const socket = new FakeSocket();
    const { service } = buildService(socket);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "c"]);
    socket.frame(["CLOSED", ROSTER_SUB_ID, "restricted: not a member"]);
    const state = await flight;
    expect(state.status).toBe("error");
    expect(state.error).toContain("restricted: not a member");
  });

  it("times out a relay that never answers", async () => {
    const socket = new FakeSocket();
    const sk = generateSecretKey();
    const service = new BuzzService({
      relayUrl: () => "wss://buzz.test/",
      signAuth: (relayUrl, challenge) => signRelayAuthEvent(sk, relayUrl, challenge),
      signMediaAuth: () => null,
      emitChanged: () => undefined,
      connect: () => socket,
      timeoutMs: 50,
    });
    const flight = service.refresh();
    socket.emit("open");
    const state = await flight;
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/did not answer/);
  });

  it("goes idle when no relay is configured", async () => {
    const service = new BuzzService({
      relayUrl: () => null,
      signAuth: () => null,
      signMediaAuth: () => null,
      emitChanged: () => undefined,
    });
    const state = await service.refresh();
    expect(state.status).toBe("idle");
  });
});

describe("relay-hosted avatars (Blossom-authenticated media)", () => {
  const SHA = "f".repeat(64);

  it("recognizes relay media URLs and leaves foreign hosts alone", () => {
    expect(relayMediaSha256(`https://buzz.test/media/${SHA}.png`, "wss://buzz.test/")).toBe(SHA);
    expect(relayMediaSha256(`https://buzz.test/media/${SHA}`, "wss://buzz.test/")).toBe(SHA);
    expect(relayMediaSha256(`https://cdn.example/media/${SHA}.png`, "wss://buzz.test/")).toBeNull();
    expect(relayMediaSha256("https://buzz.test/media/not-a-hash.png", "wss://buzz.test/")).toBeNull();
  });

  it("fetches relay avatars with a Blossom header and inlines them as data URIs", async () => {
    const socket = new FakeSocket();
    const captured: Array<{ url: string; auth: string }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>)["authorization"]),
      });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    const { service } = buildService(socket, true, fetchImpl);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "c"]);
    const withRelayAvatar = persona("reviewer-persona", `https://buzz.test/media/${SHA}.png`);
    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Reviewer", "reviewer-persona")]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    socket.frame(["EVENT", DETAIL_SUB_ID, withRelayAvatar]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);
    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents[0]!.avatarUrl).toMatch(/^data:image\/png;base64,/);
    // The GET carried a base64 kind:24242 with t=get and the blob hash.
    expect(captured).toHaveLength(1);
    const authEvent = JSON.parse(
      Buffer.from(captured[0]!.auth.replace(/^Nostr /, ""), "base64").toString(),
    ) as NostrSignedEvent;
    expect(authEvent.kind).toBe(24242);
    expect(authEvent.tags).toContainEqual(["t", "get"]);
    expect(authEvent.tags).toContainEqual(["x", SHA]);
  });

  it("downgrades a refused avatar to the glyph instead of failing the roster", async () => {
    const socket = new FakeSocket();
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const { service } = buildService(socket, true, fetchImpl);
    const flight = service.refresh();
    socket.emit("open");
    socket.frame(["AUTH", "c"]);
    socket.frame(["EVENT", ROSTER_SUB_ID, managedAgent(AGENT_A, "Reviewer", "reviewer-persona")]);
    socket.frame(["EOSE", ROSTER_SUB_ID]);
    socket.frame(["EVENT", DETAIL_SUB_ID, persona("reviewer-persona", `https://buzz.test/media/${SHA}.png`)]);
    socket.frame(["EOSE", DETAIL_SUB_ID]);
    const state = await flight;
    expect(state.status).toBe("ready");
    expect(state.agents[0]!.avatarUrl).toBeNull();
  });
});

describe("truncateNpub", () => {
  it("keeps the prefix and tail", () => {
    const npub = nip19.npubEncode(AGENT_A);
    const truncated = truncateNpub(npub);
    expect(truncated.startsWith("npub1")).toBe(true);
    expect(truncated).toContain("…");
    expect(truncated.length).toBe(15);
    expect(npub.endsWith(truncated.slice(-4))).toBe(true);
  });
});

/* --------- the auth event is verifiable by the relay (sanity) ------------ */

describe("signRelayAuthEvent", () => {
  it("produces a valid kind:22242 with relay + challenge tags", () => {
    const sk = generateSecretKey();
    const event = signRelayAuthEvent(sk, "wss://buzz.test/", "xyz");
    expect(event.kind).toBe(22242);
    expect(event.tags).toContainEqual(["relay", "wss://buzz.test/"]);
    expect(event.tags).toContainEqual(["challenge", "xyz"]);
    expect(event.pubkey).toBe(getPublicKey(sk));
    // Round-trips through nostr-tools' own verification.
    const verified = finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content: "" },
      sk,
    );
    expect(verified.pubkey).toBe(event.pubkey);
  });
});
