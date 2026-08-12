/**
 * Nostr signer contract (NIP-07) — shared by main (which holds the key and
 * signs) and the renderers (settings page, approval cards, request detail).
 *
 * WHERE THE PIECES LIVE, and why:
 *
 *  - THE KEY lives in MAIN, encrypted at rest with Electron's safeStorage
 *    (nostr.json beside workspace.json holds only the ciphertext). Web pages
 *    talk to `window.nostr` in their own isolated world; the guest preload
 *    relays each call to main, which resolves the site's permission policy
 *    and either answers, refuses, or parks the call as a pending request for
 *    the user to approve. The nsec itself NEVER crosses IPC after being set —
 *    settings report only the derived npub.
 *
 *  - PERMISSIONS are per-site (host), per-method, and — for `signEvent` —
 *    per event kind: "allow kind 3 on primal.net, ask for kind 1" is exactly
 *    a `kinds: {3: "allow"}` entry with `signDefault: "ask"`. Unknown sites
 *    fall back to ask-for-everything.
 *
 *  - PENDING REQUESTS are a queue in main. The overlay window (the same one
 *    that shows save cards and the floating audio player) renders the top of
 *    the stack as a card; the chrome renders the full detail side panel.
 *    Either surface answers with `nostr:respond`.
 *
 * Pure and dependency-free on purpose: both processes import it, so a method
 * cannot appear on `window.nostr` without main knowing how to authorize it.
 */

/* ------------------------------------------------------------------ *
 * Events (the NIP-01 shapes pages hand us / get back)
 * ------------------------------------------------------------------ */

/** What a page passes to `window.nostr.signEvent` (NIP-07 / NIP-01). */
export interface NostrUnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** What `signEvent` resolves with: the event, id'd and schnorr-signed. */
export interface NostrSignedEvent extends NostrUnsignedEvent {
  id: string;
  pubkey: string;
  sig: string;
}

/** NIP-07 `getRelays` shape: url → read/write intent. */
export type NostrRelayPolicy = Record<
  string,
  { read: boolean; write: boolean }
>;

/* ------------------------------------------------------------------ *
 * Methods and per-site permissions
 * ------------------------------------------------------------------ */

/** Every capability the injected `window.nostr` exposes. */
export type NostrMethod =
  | "getPublicKey"
  | "signEvent"
  | "getRelays"
  | "nip04.encrypt"
  | "nip04.decrypt"
  | "nip44.encrypt"
  | "nip44.decrypt";

export const NOSTR_METHODS: readonly NostrMethod[] = [
  "getPublicKey",
  "signEvent",
  "getRelays",
  "nip04.encrypt",
  "nip04.decrypt",
  "nip44.encrypt",
  "nip44.decrypt",
];

export function isNostrMethod(value: unknown): value is NostrMethod {
  return (
    typeof value === "string" &&
    (NOSTR_METHODS as readonly string[]).includes(value)
  );
}

/**
 * What a site may do without asking. "ask" is the universal default: nothing
 * is signed or decrypted silently until the user says so, per site.
 */
export type NostrPermissionChoice = "allow" | "ask" | "deny";

export function isNostrPermissionChoice(
  value: unknown,
): value is NostrPermissionChoice {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * One site's standing rules. `methods` covers everything except signing;
 * signing gets per-kind granularity because that is where the stakes differ:
 * a kind 3 follow-list update and a kind 1 public note are different asks.
 */
export interface NostrSitePolicy {
  /** The site host as the user saw it ("primal.net"). Policies are keyed by
   *  host, not full origin — the scheme/port of a nostr client is noise. */
  host: string;
  /** Per-method rule for the non-signing methods. Missing method ⇒ ask. */
  methods: Partial<Record<Exclude<NostrMethod, "signEvent">, NostrPermissionChoice>>;
  /** Per-kind signing rules, keyed by the kind number as a string (JSON has
   *  no integer keys). Missing kind ⇒ `signDefault`. */
  kinds: Record<string, NostrPermissionChoice>;
  /** The signing rule for kinds not listed above. */
  signDefault: NostrPermissionChoice;
  /** Last time this site asked for anything — orders the settings list. */
  lastUsedMs: number;
}

export function emptySitePolicy(host: string, nowMs: number): NostrSitePolicy {
  return {
    host,
    methods: {},
    kinds: {},
    signDefault: "ask",
    lastUsedMs: nowMs,
  };
}

/**
 * The one place a "may this site do this?" question is answered, used by main
 * before signing and by the settings page to preview what a rule means.
 * No policy for the site ⇒ ask.
 */
export function resolvePermission(
  policy: NostrSitePolicy | null | undefined,
  method: NostrMethod,
  kind?: number,
): NostrPermissionChoice {
  if (!policy) return "ask";
  if (method === "signEvent") {
    if (kind !== undefined) {
      const rule = policy.kinds[String(kind)];
      if (rule !== undefined) return rule;
    }
    return policy.signDefault;
  }
  return policy.methods[method] ?? "ask";
}

/* ------------------------------------------------------------------ *
 * Requests (guest page → main → approval surfaces)
 * ------------------------------------------------------------------ */

/** The arguments of one `window.nostr` call, method-tagged. */
export type NostrRequestPayload =
  | { method: "getPublicKey" }
  | { method: "getRelays" }
  | { method: "signEvent"; event: NostrUnsignedEvent }
  | {
      method: "nip04.encrypt" | "nip44.encrypt";
      /** The counterparty's hex pubkey. */
      peer: string;
      plaintext: string;
    }
  | {
      method: "nip04.decrypt" | "nip44.decrypt";
      peer: string;
      ciphertext: string;
    };

/**
 * A call waiting for the user. `host` is resolved by MAIN from the sender's
 * WebContents URL — never trusted from the page — and is the key the
 * "remember" checkbox writes a policy under.
 */
export interface NostrPendingRequest {
  id: string;
  host: string;
  /** Full origin, shown in the detail panel ("https://primal.net"). */
  origin: string;
  payload: NostrRequestPayload;
  createdAtMs: number;
}

/**
 * One tap on a card (or the detail panel). `remember` turns the answer into
 * a standing rule for the request's host: for `signEvent` it writes the
 * event's kind rule, for other methods the method rule. Every OTHER pending
 * request from the same host is then re-evaluated against the new policy, so
 * approving "always allow kind 7" drains a burst of reaction sign requests
 * in one tap.
 */
export interface NostrApprovalResponse {
  requestId: string;
  approved: boolean;
  /** Persist this answer as the site's rule for this method/kind. */
  remember: boolean;
}

/** Why a call failed, in the NIP-07-visible error message. */
export type NostrDenyReason =
  | "no-key" /* no nsec configured */
  | "denied" /* user said no, or a standing deny rule matched */
  | "invalid" /* the page's arguments failed validation */
  | "internal";

/* ------------------------------------------------------------------ *
 * Settings (chrome ⇄ main)
 * ------------------------------------------------------------------ */

/** What the renderer may know about the identity — no key material. */
export interface NostrSettingsInfo {
  /** A key is configured; without one, `window.nostr` reports "no key". */
  keyConfigured: boolean;
  /** The public identity derived from the stored key. */
  npub: string | null;
  pubkey: string | null;
  /** What `getRelays` answers with; edited on the settings page. */
  relays: NostrRelayPolicy;
  /** The user's Buzz workspace relay (github.com/block/buzz), or null. */
  buzzRelayUrl: string | null;
  /** Every site with standing rules, most recently used first. */
  policies: NostrSitePolicy[];
  /**
   * Present ONLY in the response to `nostr:generateKey` — shown once so the
   * user can back the new key up, then never sent again (§8.2 precedent:
   * EnrollmentStatus.recoveryCode).
   */
  generatedNsec?: string;
}

/** A settings-page edit to one site's rules. */
export interface NostrSitePolicyPatch {
  methods?: Partial<
    Record<Exclude<NostrMethod, "signEvent">, NostrPermissionChoice | null>
  >;
  /** kind → rule; null clears the kind back to `signDefault`. */
  kinds?: Record<string, NostrPermissionChoice | null>;
  signDefault?: NostrPermissionChoice;
}

/* ------------------------------------------------------------------ *
 * Presentation helpers (cards, detail panel, settings)
 * ------------------------------------------------------------------ */

/**
 * Human names for the kinds users actually meet, so the approval card can say
 * "wants to sign a reaction" instead of "kind 7". Unknown kinds fall back to
 * "kind N" — honest, and a nudge to look at the detail panel.
 */
export const NOSTR_KIND_LABELS: Record<number, string> = {
  0: "profile update",
  1: "short note",
  3: "follow list",
  4: "encrypted DM",
  5: "deletion request",
  6: "repost",
  7: "reaction",
  1059: "gift-wrapped message",
  1984: "report",
  9734: "zap request",
  9735: "zap receipt",
  10002: "relay list",
  22242: "client authentication",
  24133: "connect message",
  30023: "long-form article",
  30078: "app data",
};

export function nostrKindLabel(kind: number): string {
  return NOSTR_KIND_LABELS[kind] ?? `kind ${kind} event`;
}

/** "Sign a short note", "Read your public key" — the card's one-liner. */
export function nostrRequestSummary(payload: NostrRequestPayload): string {
  switch (payload.method) {
    case "getPublicKey":
      return "Read your public key";
    case "getRelays":
      return "Read your relay list";
    case "signEvent":
      return `Sign a ${nostrKindLabel(payload.event.kind)}`;
    case "nip04.encrypt":
    case "nip44.encrypt":
      return "Encrypt a message";
    case "nip04.decrypt":
    case "nip44.decrypt":
      return "Decrypt a message";
  }
}

/** What the "remember" checkbox will write, spelled out on the card. */
export function nostrRememberLabel(
  payload: NostrRequestPayload,
  host: string,
  approved: boolean,
): string {
  const verb = approved ? "Always allow" : "Always deny";
  if (payload.method === "signEvent") {
    return `${verb} signing ${nostrKindLabel(payload.event.kind)}s on ${host}`;
  }
  return `${verb} “${nostrRequestSummary(payload).toLowerCase()}” on ${host}`;
}

/* ---------------------------------- limits --------------------------------- */

/** Clamp what a page can park in the approval queue. */
export const MAX_PENDING_NOSTR_REQUESTS = 24;
/** Refuse absurd payloads before they reach the queue or the signer. */
export const MAX_NOSTR_CONTENT_CHARS = 100_000;
export const MAX_NOSTR_TAGS = 2_000;
export const MAX_NOSTR_TAG_ITEM_CHARS = 2_000;

/** 64 lowercase-or-uppercase hex chars — a schnorr x-only pubkey. */
export function isHexPubkey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Validate + normalize what a page handed to `signEvent`. Returns null when
 * the shape is wrong rather than throwing: the caller turns null into the
 * NIP-07 error without a pending request ever existing.
 */
export function sanitizeUnsignedEvent(
  value: unknown,
): NostrUnsignedEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  const { kind, content, created_at: createdAt, tags } = event;
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0) {
    return null;
  }
  if (typeof content !== "string" || content.length > MAX_NOSTR_CONTENT_CHARS) {
    return null;
  }
  if (
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    createdAt < 0
  ) {
    return null;
  }
  if (!Array.isArray(tags) || tags.length > MAX_NOSTR_TAGS) return null;
  const cleanTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag)) return null;
    const cleanTag: string[] = [];
    for (const item of tag) {
      if (typeof item !== "string" || item.length > MAX_NOSTR_TAG_ITEM_CHARS) {
        return null;
      }
      cleanTag.push(item);
    }
    cleanTags.push(cleanTag);
  }
  return {
    kind,
    content,
    created_at: Math.floor(createdAt),
    tags: cleanTags,
  };
}

/** The relays a fresh identity starts with — broadly-used public relays. */
export const DEFAULT_NOSTR_RELAYS: NostrRelayPolicy = {
  "wss://relay.damus.io": { read: true, write: true },
  "wss://relay.primal.net": { read: true, write: true },
  "wss://nos.lol": { read: true, write: true },
};

/* ------------------------------------------------------------------ *
 * Buzz workspace (github.com/block/buzz) — agent roster
 * ------------------------------------------------------------------ */

/**
 * One agent set up on the user's Buzz relay. Buzz publishes a kind:30177
 * "managed agent" event per instance (owner-authored, d tag = the AGENT's
 * pubkey, content.name); avatars resolve through the linked kind:30175
 * persona (`avatar_url`) or the agent's own kind:0 profile. See
 * docs/nips/NIP-AP.md in the buzz repo.
 */
export interface BuzzAgent {
  /** The agent's own identity — the 30177 event's d tag. */
  pubkey: string;
  npub: string;
  name: string;
  avatarUrl: string | null;
  /** The kind:30175 definition slug this instance was spawned from. */
  personaId: string | null;
}

export type BuzzFetchStatus = "idle" | "loading" | "ready" | "error";

/** The renderer-facing snapshot of the Buzz roster fetch. */
export interface BuzzAgentsState {
  status: BuzzFetchStatus;
  relayUrl: string | null;
  agents: BuzzAgent[];
  /** Human-readable failure ("relay refused: auth-required …"), ready state ⇒ null. */
  error: string | null;
  fetchedAtMs: number | null;
}

export const IDLE_BUZZ_STATE: BuzzAgentsState = {
  status: "idle",
  relayUrl: null,
  agents: [],
  error: null,
  fetchedAtMs: null,
};

/**
 * Normalize what the user pastes into a relay websocket URL: bare hosts get
 * wss://, http(s) is mapped to ws(s) (buzz serves both on one origin), and
 * anything unparseable is null. "" clears the configured relay.
 */
export function normalizeBuzzRelayUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  return parsed.href;
}

/** "npub1abcde…wxyz" — the under-avatar identity chip. */
export function truncateNpub(npub: string): string {
  if (npub.length <= 16) return npub;
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * Guest bridge (page → preload → main)
 * ------------------------------------------------------------------ */

/**
 * The ONE channel guest pages reach main on, via the nostr guest preload
 * (preload/nostr-guest.cjs). Deliberately outside `window.suma`'s contract:
 * the chrome preload's allowlist never carries it, and main guards it with
 * its own sender check (the sender's session must belong to a space).
 */
export const NOSTR_GUEST_CHANNEL = "nostr:guest-call";

/**
 * Errors travel as values, not thrown: a rejected `ipcMain.handle` promise
 * reaches the page wrapped in Electron's "Error invoking remote method"
 * noise, and the message is the ONLY part of this contract a site sees.
 */
export type NostrGuestResponse =
  | { ok: true; result: unknown }
  | { ok: false; reason: NostrDenyReason; error: string };
