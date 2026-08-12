/**
 * Nostr signer core — the pure half of the NIP-07 service: key parsing, the
 * nostr.json settings file, policy edits, and the crypto dispatch itself.
 * Everything here is deliberately free of Electron imports so the whole
 * signing/permission surface is exercisable from vitest; the service wraps
 * this with the queue, the IPC emitters, and safeStorage.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import {
  DEFAULT_NOSTR_RELAYS,
  emptySitePolicy,
  isHexPubkey,
  isNostrPermissionChoice,
  MAX_NOSTR_CONTENT_CHARS,
  sanitizeUnsignedEvent,
  type NostrPermissionChoice,
  type NostrRelayPolicy,
  type NostrRequestPayload,
  type NostrSignedEvent,
  type NostrSitePolicy,
  type NostrSitePolicyPatch,
} from "../../shared/nostr";

export const NOSTR_SETTINGS_FILENAME = "nostr.json";

/* ------------------------------- keys ---------------------------------- */

const HEX64_RE = /^[0-9a-f]{64}$/;

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * What the settings page accepts as "your key": an nsec1… bech32 string or
 * 64 hex chars, surrounding whitespace forgiven. Null for everything else —
 * including npubs, a paste mistake worth a specific message in the UI.
 */
export function parseSecretKeyInput(input: string): Uint8Array | null {
  const trimmed = input.trim();
  if (HEX64_RE.test(trimmed.toLowerCase())) {
    return hexToBytes(trimmed.toLowerCase());
  }
  if (trimmed.toLowerCase().startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(trimmed.toLowerCase());
      if (decoded.type === "nsec") return decoded.data;
    } catch {
      return null;
    }
  }
  return null;
}

/** The public half, everywhere it is shown: hex for protocol, npub for eyes. */
export function deriveIdentity(secretKey: Uint8Array): {
  pubkey: string;
  npub: string;
} {
  const pubkey = getPublicKey(secretKey);
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

export function encodeNsec(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

/** A fresh valid secret key (nostr-tools draws until the scalar is valid). */
export function newSecretKey(): Uint8Array {
  return generateSecretKey();
}

/* --------------------------- the settings file -------------------------- */

/**
 * How the secret is at rest in nostr.json. "safeStorage" is the normal case
 * (OS-keychain-derived encryption); "plain" is the fallback when Electron
 * reports encryption unavailable — still chmod-600, same posture as the
 * Ed25519 device key in device.json.
 */
export type StoredNostrKey =
  | { kind: "safeStorage"; cipher: string }
  | { kind: "plain"; hex: string };

export interface NostrStoredState {
  key: StoredNostrKey | null;
  relays: NostrRelayPolicy;
  policies: NostrSitePolicy[];
  /** The user's Buzz workspace relay (github.com/block/buzz), or null. */
  buzzRelayUrl: string | null;
}

export function defaultStoredState(): NostrStoredState {
  return {
    key: null,
    relays: { ...DEFAULT_NOSTR_RELAYS },
    policies: [],
    buzzRelayUrl: null,
  };
}

const MAX_RELAYS = 50;
const MAX_POLICIES = 500;
const MAX_KIND_RULES = 200;

/** A relay is a ws(s) URL; anything else a page or a bad merge slipped in. */
export function sanitizeRelays(value: unknown): NostrRelayPolicy {
  if (typeof value !== "object" || value === null) return {};
  const relays: NostrRelayPolicy = {};
  let count = 0;
  for (const [url, entry] of Object.entries(value)) {
    if (count >= MAX_RELAYS) break;
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") continue;
    const record =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    relays[parsed.href] = {
      read: record["read"] !== false,
      write: record["write"] !== false,
    };
    count += 1;
  }
  return relays;
}

function sanitizePolicy(value: unknown): NostrSitePolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const host = record["host"];
  if (typeof host !== "string" || host === "") return null;
  const policy = emptySitePolicy(host, 0);
  const lastUsed = record["lastUsedMs"];
  if (typeof lastUsed === "number" && Number.isFinite(lastUsed)) {
    policy.lastUsedMs = lastUsed;
  }
  if (isNostrPermissionChoice(record["signDefault"])) {
    policy.signDefault = record["signDefault"];
  }
  const methods = record["methods"];
  if (typeof methods === "object" && methods !== null) {
    for (const [method, choice] of Object.entries(methods)) {
      if (!isNostrPermissionChoice(choice)) continue;
      if (
        method === "getPublicKey" ||
        method === "getRelays" ||
        method === "nip04.encrypt" ||
        method === "nip04.decrypt" ||
        method === "nip44.encrypt" ||
        method === "nip44.decrypt"
      ) {
        policy.methods[method] = choice;
      }
    }
  }
  const kinds = record["kinds"];
  if (typeof kinds === "object" && kinds !== null) {
    let count = 0;
    for (const [kind, choice] of Object.entries(kinds)) {
      if (count >= MAX_KIND_RULES) break;
      if (!/^\d+$/.test(kind) || !isNostrPermissionChoice(choice)) continue;
      policy.kinds[kind] = choice;
      count += 1;
    }
  }
  return policy;
}

/** Parse nostr.json; anything malformed degrades to defaults, never throws. */
export function parseStoredState(raw: string): NostrStoredState {
  const state = defaultStoredState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof value !== "object" || value === null) return state;
  const record = value as Record<string, unknown>;

  const key = record["key"];
  if (typeof key === "object" && key !== null) {
    const keyRecord = key as Record<string, unknown>;
    if (
      keyRecord["kind"] === "safeStorage" &&
      typeof keyRecord["cipher"] === "string"
    ) {
      state.key = { kind: "safeStorage", cipher: keyRecord["cipher"] };
    } else if (
      keyRecord["kind"] === "plain" &&
      typeof keyRecord["hex"] === "string" &&
      HEX64_RE.test(keyRecord["hex"])
    ) {
      state.key = { kind: "plain", hex: keyRecord["hex"] };
    }
  }

  const relays = sanitizeRelays(record["relays"]);
  if (Object.keys(relays).length > 0) state.relays = relays;

  const buzzRelayUrl = record["buzzRelayUrl"];
  if (typeof buzzRelayUrl === "string" && buzzRelayUrl !== "") {
    state.buzzRelayUrl = buzzRelayUrl;
  }

  if (Array.isArray(record["policies"])) {
    for (const entry of record["policies"]) {
      if (state.policies.length >= MAX_POLICIES) break;
      const policy = sanitizePolicy(entry);
      if (policy !== null && !state.policies.some((p) => p.host === policy.host)) {
        state.policies.push(policy);
      }
    }
  }
  return state;
}

/* ------------------------------ policy edits ---------------------------- */

/**
 * Apply a settings-page edit (or an approval's "remember") to one site's
 * rules. Null entries clear a rule back to the default; the patch never
 * removes the policy itself — that is `removeSitePolicy`'s job.
 */
export function applySitePolicyPatch(
  policy: NostrSitePolicy,
  patch: NostrSitePolicyPatch,
): NostrSitePolicy {
  const next: NostrSitePolicy = {
    ...policy,
    methods: { ...policy.methods },
    kinds: { ...policy.kinds },
  };
  if (patch.signDefault !== undefined && isNostrPermissionChoice(patch.signDefault)) {
    next.signDefault = patch.signDefault;
  }
  if (patch.methods !== undefined) {
    for (const [method, choice] of Object.entries(patch.methods)) {
      const key = method as keyof NostrSitePolicy["methods"];
      if (choice === null) delete next.methods[key];
      else if (isNostrPermissionChoice(choice)) next.methods[key] = choice;
    }
  }
  if (patch.kinds !== undefined) {
    for (const [kind, choice] of Object.entries(patch.kinds)) {
      if (!/^\d+$/.test(kind)) continue;
      if (choice === null) delete next.kinds[kind];
      else if (isNostrPermissionChoice(choice)) next.kinds[kind] = choice;
    }
  }
  return next;
}

/** What an approval's "remember" checkbox writes for this request. */
export function rememberPatchFor(
  payload: NostrRequestPayload,
  choice: NostrPermissionChoice,
): NostrSitePolicyPatch {
  if (payload.method === "signEvent") {
    return { kinds: { [String(payload.event.kind)]: choice } };
  }
  return { methods: { [payload.method]: choice } };
}

/* --------------------------- request validation ------------------------- */

/**
 * Turn whatever the page invoked into a typed payload, or null. This is the
 * trust boundary: nothing beyond this function ever sees a page-shaped
 * object, and null means the NIP-07 call fails without a request existing.
 */
export function parseGuestPayload(value: unknown): NostrRequestPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const method = record["method"];
  if (method === "getPublicKey" || method === "getRelays") return { method };
  if (method === "signEvent") {
    const event = sanitizeUnsignedEvent(record["event"]);
    if (event === null) return null;
    return { method, event };
  }
  if (method === "nip04.encrypt" || method === "nip44.encrypt") {
    const peer = record["peer"];
    const plaintext = record["plaintext"];
    if (!isHexPubkey(peer)) return null;
    if (typeof plaintext !== "string" || plaintext.length > MAX_NOSTR_CONTENT_CHARS) {
      return null;
    }
    return { method, peer: peer.toLowerCase(), plaintext };
  }
  if (method === "nip04.decrypt" || method === "nip44.decrypt") {
    const peer = record["peer"];
    const ciphertext = record["ciphertext"];
    if (!isHexPubkey(peer)) return null;
    if (typeof ciphertext !== "string" || ciphertext.length > MAX_NOSTR_CONTENT_CHARS) {
      return null;
    }
    return { method, peer: peer.toLowerCase(), ciphertext };
  }
  return null;
}

/**
 * The NIP-42 client-authentication event (kind:22242) a relay's AUTH
 * challenge is answered with. Ephemeral by kind — relays verify and drop it.
 */
export function signRelayAuthEvent(
  secretKey: Uint8Array,
  relayUrl: string,
  challenge: string,
): NostrSignedEvent {
  const signed = finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    },
    secretKey,
  );
  return {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
}

/**
 * The Blossom (BUD-01) GET authorization a buzz relay's `/media/<sha256>`
 * endpoint demands: kind 24242, `t=get`, the blob's `x` hash, a bounded
 * `expiration`, and non-empty human-readable content. Sent base64-encoded
 * in an `Authorization: Nostr …` header.
 */
export function signBlossomGetAuth(
  secretKey: Uint8Array,
  sha256: string,
  serverHost: string,
): NostrSignedEvent {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = finalizeEvent(
    {
      kind: 24242,
      created_at: nowSeconds,
      tags: [
        ["t", "get"],
        ["x", sha256],
        ["server", serverHost],
        ["expiration", String(nowSeconds + 300)],
      ],
      content: "Suma: fetch Buzz agent avatar",
    },
    secretKey,
  );
  return {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
}

/* ------------------------------ the crypto ------------------------------ */

/**
 * Perform an APPROVED request. Only ever called with a validated payload and
 * a live secret key; errors here are crypto-level (bad ciphertext, mostly)
 * and surface to the page as the NIP-07 error message.
 */
export async function performNostrRequest(
  secretKey: Uint8Array,
  relays: NostrRelayPolicy,
  payload: NostrRequestPayload,
): Promise<unknown> {
  switch (payload.method) {
    case "getPublicKey":
      return getPublicKey(secretKey);
    case "getRelays":
      return { ...relays };
    case "signEvent": {
      const signed = finalizeEvent({ ...payload.event }, secretKey);
      const result: NostrSignedEvent = {
        id: signed.id,
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
        sig: signed.sig,
      };
      return result;
    }
    case "nip04.encrypt":
      return nip04.encrypt(secretKey, payload.peer, payload.plaintext);
    case "nip04.decrypt":
      return nip04.decrypt(secretKey, payload.peer, payload.ciphertext);
    case "nip44.encrypt":
      return nip44.encrypt(
        payload.plaintext,
        nip44.getConversationKey(secretKey, payload.peer),
      );
    case "nip44.decrypt":
      return nip44.decrypt(
        payload.ciphertext,
        nip44.getConversationKey(secretKey, payload.peer),
      );
  }
}
