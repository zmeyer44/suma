/**
 * Buzz roster protocol core — the pure half of the Buzz integration
 * (github.com/block/buzz): building the relay queries, parsing what comes
 * back, and folding three event kinds into one agent list. No sockets and
 * no Electron here, so every branch is exercisable from vitest; the
 * service (buzz-service.ts) owns the WebSocket and the NIP-42 handshake.
 *
 * The protocol, from buzz's docs/nips/NIP-AP.md and buzz-core/src/kind.rs:
 *
 *  - kind:30177 "managed agent" — ONE PER AGENT the owner set up.
 *    Owner-authored, parameterized-replaceable, `d` tag = the AGENT's
 *    pubkey, `content.name` (+ optional `persona_id` linking a definition).
 *    World-readable on the relay: this is the roster query.
 *  - kind:30175 "agent persona" — the definition an instance was spawned
 *    from; carries `avatar_url`. Author-only unless shared, which is why
 *    the fetch authenticates as the user (their key is the buzz owner).
 *  - kind:0 — the agent's own profile, fallback for name/avatar.
 *
 * Buzz relays mandate NIP-42 AUTH on the connection; the service answers
 * the challenge with a kind:22242 event signed by the stored nostr key.
 */

import * as nip19 from "nostr-tools/nip19";
import { isHexPubkey, type BuzzAgent } from "../../shared/nostr";

/* ------------------------------- filters -------------------------------- */

export const BUZZ_KIND_MANAGED_AGENT = 30177;
export const BUZZ_KIND_PERSONA = 30175;

export const ROSTER_SUB_ID = "suma-buzz-roster";
export const DETAIL_SUB_ID = "suma-buzz-detail";

/** Phase 1: every managed-agent instance on the relay. */
export function rosterRequest(): unknown[] {
  return ["REQ", ROSTER_SUB_ID, { kinds: [BUZZ_KIND_MANAGED_AGENT] }];
}

/**
 * Phase 2, from the roster: the personas that can carry avatars (ours —
 * they are author-gated anyway) and the agents' own kind:0 profiles.
 */
export function detailRequest(agentPubkeys: string[]): unknown[] {
  const filters: unknown[] = [{ kinds: [BUZZ_KIND_PERSONA] }];
  if (agentPubkeys.length > 0) {
    filters.push({ kinds: [0], authors: agentPubkeys });
  }
  return ["REQ", DETAIL_SUB_ID, ...filters];
}

export function closeRequest(subId: string): unknown[] {
  return ["CLOSE", subId];
}

/** The NIP-42 answer envelope for a signed kind:22242 event. */
export function authReply(signedEvent: unknown): unknown[] {
  return ["AUTH", signedEvent];
}

/* --------------------------- message parsing ----------------------------- */

/** The slice of a NIP-01 event this integration reads. Untrusted input. */
export interface RelayEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export type RelayMessage =
  | { type: "auth"; challenge: string }
  | { type: "event"; subId: string; event: RelayEvent }
  | { type: "eose"; subId: string }
  | { type: "closed"; subId: string; reason: string }
  | { type: "ok"; eventId: string; accepted: boolean; reason: string }
  | { type: "notice"; message: string }
  | { type: "other" };

/** Parse one relay frame; anything malformed degrades to "other". */
export function parseRelayMessage(raw: unknown): RelayMessage {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { type: "other" };
    }
  }
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return { type: "other" };
  }
  const [verb, a, b, c] = value as [string, unknown, unknown, unknown];
  if (verb === "AUTH" && typeof a === "string") {
    return { type: "auth", challenge: a };
  }
  if (verb === "EVENT" && typeof a === "string") {
    const event = sanitizeRelayEvent(b);
    if (event !== null) return { type: "event", subId: a, event };
    return { type: "other" };
  }
  if (verb === "EOSE" && typeof a === "string") return { type: "eose", subId: a };
  if (verb === "CLOSED" && typeof a === "string") {
    return { type: "closed", subId: a, reason: typeof b === "string" ? b : "" };
  }
  if (verb === "OK" && typeof a === "string") {
    return {
      type: "ok",
      eventId: a,
      accepted: b === true,
      reason: typeof c === "string" ? c : "",
    };
  }
  if (verb === "NOTICE" && typeof a === "string") {
    return { type: "notice", message: a };
  }
  return { type: "other" };
}

function sanitizeRelayEvent(value: unknown): RelayEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, kind, pubkey, created_at: createdAt, tags, content } = record;
  if (typeof id !== "string" || typeof content !== "string") return null;
  if (typeof kind !== "number" || !Number.isInteger(kind)) return null;
  if (!isHexPubkey(pubkey)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(tags)) return null;
  const cleanTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || !tag.every((item) => typeof item === "string")) {
      return null;
    }
    cleanTags.push(tag);
  }
  return {
    id,
    kind,
    pubkey: pubkey.toLowerCase(),
    created_at: createdAt,
    tags: cleanTags,
    content,
  };
}

export function firstTagValue(event: RelayEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

/* ------------------------------ the roster ------------------------------- */

interface ManagedAgentRow {
  pubkey: string;
  name: string;
  personaId: string | null;
  createdAt: number;
}

/**
 * Fold the collected events into the agent list. Replaceable-event
 * semantics are applied per coordinate (latest created_at wins), avatars
 * resolve persona-first (the definition the owner configured), then the
 * agent's own kind:0 profile, and the list comes back name-sorted.
 */
export function buildAgentList(events: RelayEvent[]): BuzzAgent[] {
  const instances = new Map<string, ManagedAgentRow>();
  const personaAvatars = new Map<string, { url: string | null; createdAt: number }>();
  const profileAvatars = new Map<string, { url: string | null; createdAt: number }>();

  for (const event of events) {
    if (event.kind === BUZZ_KIND_MANAGED_AGENT) {
      const agentPubkey = firstTagValue(event, "d")?.toLowerCase() ?? null;
      if (agentPubkey === null || !isHexPubkey(agentPubkey)) continue;
      const existing = instances.get(agentPubkey);
      if (existing !== undefined && existing.createdAt >= event.created_at) continue;
      const content = parseJson(event.content);
      const name = typeof content?.["name"] === "string" ? content["name"] : "";
      const personaId =
        typeof content?.["persona_id"] === "string" ? content["persona_id"] : null;
      instances.set(agentPubkey, {
        pubkey: agentPubkey,
        name,
        personaId,
        createdAt: event.created_at,
      });
    } else if (event.kind === BUZZ_KIND_PERSONA) {
      const slug = firstTagValue(event, "d");
      if (slug === null) continue;
      const existing = personaAvatars.get(slug);
      if (existing !== undefined && existing.createdAt >= event.created_at) continue;
      const content = parseJson(event.content);
      personaAvatars.set(slug, {
        url: httpUrlOrNull(content?.["avatar_url"]),
        createdAt: event.created_at,
      });
    } else if (event.kind === 0) {
      const existing = profileAvatars.get(event.pubkey);
      if (existing !== undefined && existing.createdAt >= event.created_at) continue;
      const content = parseJson(event.content);
      // Standard kind:0 calls it "picture"; buzz's users table calls it
      // "avatar" — accept either.
      profileAvatars.set(event.pubkey, {
        url:
          httpUrlOrNull(content?.["picture"]) ?? httpUrlOrNull(content?.["avatar"]),
        createdAt: event.created_at,
      });
    }
  }

  const agents: BuzzAgent[] = [];
  for (const row of instances.values()) {
    const personaAvatar =
      row.personaId !== null ? (personaAvatars.get(row.personaId)?.url ?? null) : null;
    const profileAvatar = profileAvatars.get(row.pubkey)?.url ?? null;
    agents.push({
      pubkey: row.pubkey,
      npub: nip19.npubEncode(row.pubkey),
      name: row.name !== "" ? row.name : "Unnamed agent",
      avatarUrl: personaAvatar ?? profileAvatar,
      personaId: row.personaId,
    });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name) || a.pubkey.localeCompare(b.pubkey));
  return agents;
}

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * When an avatar lives on the RELAY's own media store, return the blob's
 * sha256 — those reads demand Blossom auth (media.rs: authenticated GET +
 * relay membership), so a bare <img> gets a 401 and the service must fetch
 * the bytes itself. Foreign-host avatars return null and load directly.
 */
export function relayMediaSha256(
  avatarUrl: string,
  relayUrl: string,
): string | null {
  let avatar: URL;
  let relay: URL;
  try {
    avatar = new URL(avatarUrl);
    relay = new URL(relayUrl);
  } catch {
    return null;
  }
  if (avatar.host !== relay.host) return null;
  const match = /^\/media\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/.exec(
    avatar.pathname,
  );
  return match?.[1] ?? null;
}

/** Only fetchable images — a javascript: URL is not an avatar. */
function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
