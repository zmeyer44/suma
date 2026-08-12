/**
 * NostrService — the NIP-07 signer behind every tab's `window.nostr`.
 *
 * Main signs, not the page and not the chrome, because the key must live in
 * exactly one process: it is stored in nostr.json (safeStorage-encrypted
 * when the OS keychain is available, chmod-600 either way, erased on
 * sign-out with the other local state), decrypted once at load, and after
 * `setKey` the secret never crosses IPC again — surfaces see the derived
 * npub and nothing else.
 *
 * A guest call lands here (via the guest preload's one channel) already
 * attributed: ipc.ts resolves the sender's host/origin from the FRAME, so a
 * page cannot claim to be primal.net. The site's standing policy answers
 * first — allow performs immediately, deny refuses immediately — and only
 * "ask" parks the call as a pending request for the overlay cards / detail
 * panel. Answering with "remember" writes the site rule and immediately
 * re-evaluates the rest of the queue for that host, so one "always allow
 * reactions" drains a burst of reaction requests in one tap.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  emptySitePolicy,
  MAX_PENDING_NOSTR_REQUESTS,
  resolvePermission,
  type NostrApprovalResponse,
  type NostrDenyReason,
  type NostrGuestResponse,
  type NostrPendingRequest,
  type NostrRequestPayload,
  type NostrSettingsInfo,
  type NostrSitePolicyPatch,
} from "../../shared/nostr";
import {
  applySitePolicyPatch,
  bytesToHex,
  defaultStoredState,
  deriveIdentity,
  encodeNsec,
  hexToBytes,
  newSecretKey,
  NOSTR_SETTINGS_FILENAME,
  parseGuestPayload,
  parseSecretKeyInput,
  parseStoredState,
  performNostrRequest,
  rememberPatchFor,
  sanitizeRelays,
  signBlossomGetAuth,
  signRelayAuthEvent,
  type NostrStoredState,
} from "./nostr-core";

/** The slice of WebContents a pending request watches — structural, so tests
 *  can hand in a plain object. A request dies with its document: tab closed
 *  OR navigated away, because the page-side promise is gone either way. */
export interface GuestSender {
  id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
  removeListener(event: "destroyed" | "did-navigate", listener: () => void): unknown;
}

export interface GuestCaller {
  host: string;
  origin: string;
  sender: GuestSender;
}

export interface NostrServiceDeps {
  userDataDir: string;
  /** The queue changed — index.ts fans this out to chrome AND overlay. */
  emitPending: (pending: NostrPendingRequest[]) => void;
  /** Key/relays/policies changed (settings edit or a remembered answer). */
  emitSettings: (info: NostrSettingsInfo) => void;
  /** An overlay card was expanded — the chrome opens the detail panel. */
  emitOpenDetail: (requestId: string) => void;
  /** A site called window.nostr with no key configured — surface a nudge
   *  card so "the sign-in button does nothing" is never silent. Throttled
   *  per host here, because clients poll getPublicKey on a timer. */
  emitKeyMissing?: (host: string) => void;
  /**
   * safeStorage, injected so this service stays vitest-runnable. `encrypt`
   * null ⇒ encryption unavailable (key stored plain, device.json posture);
   * `decrypt` null ⇒ ciphertext unreadable (fresh keychain, migrated disk).
   */
  encryptString?: (plain: string) => string | null;
  decryptString?: (cipher: string) => string | null;
  now?: () => number;
}

interface PendingEntry {
  request: NostrPendingRequest;
  sender: GuestSender;
  resolve: (response: NostrGuestResponse) => void;
  /** Detaches the destroyed/did-navigate watchers. */
  release: () => void;
}

function refusal(reason: NostrDenyReason, error: string): NostrGuestResponse {
  return { ok: false, reason, error };
}

const NO_KEY_MESSAGE =
  "No Nostr key is configured in this browser — add one under Settings → Nostr.";

/** How long one host's key-missing nudge suppresses the next. */
export const KEY_MISSING_NUDGE_WINDOW_MS = 60_000;

export class NostrService {
  private readonly filePath: string;
  private readonly deps: NostrServiceDeps;
  private readonly now: () => number;
  private state: NostrStoredState;
  /** The decrypted secret, resident only here. Null ⇒ no usable key. */
  private secretKey: Uint8Array | null = null;
  private identity: { pubkey: string; npub: string } | null = null;
  private readonly queue: PendingEntry[] = [];
  /** host → last key-missing nudge, so a polling client nudges once. */
  private readonly keyMissingNudgedAtMs = new Map<string, number>();
  private stopped = false;

  constructor(deps: NostrServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.filePath = path.join(deps.userDataDir, NOSTR_SETTINGS_FILENAME);
    mkdirSync(deps.userDataDir, { recursive: true });
    this.state = this.read();
    this.loadSecret();
  }

  /* ------------------------------ persistence ---------------------------- */

  private read(): NostrStoredState {
    if (!existsSync(this.filePath)) return defaultStoredState();
    try {
      return parseStoredState(readFileSync(this.filePath, "utf8"));
    } catch {
      return defaultStoredState();
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    chmodSync(this.filePath, 0o600);
  }

  private loadSecret(): void {
    const stored = this.state.key;
    this.secretKey = null;
    this.identity = null;
    if (stored === null) return;
    let hex: string | null = null;
    if (stored.kind === "plain") hex = stored.hex;
    else hex = this.deps.decryptString?.(stored.cipher) ?? null;
    if (hex === null || !/^[0-9a-f]{64}$/.test(hex)) return;
    this.secretKey = hexToBytes(hex);
    this.identity = deriveIdentity(this.secretKey);
  }

  /* ------------------------------- settings ------------------------------ */

  settings(): NostrSettingsInfo {
    return {
      keyConfigured: this.secretKey !== null,
      npub: this.identity?.npub ?? null,
      pubkey: this.identity?.pubkey ?? null,
      relays: { ...this.state.relays },
      buzzRelayUrl: this.state.buzzRelayUrl,
      policies: [...this.state.policies].sort(
        (a, b) => b.lastUsedMs - a.lastUsedMs,
      ),
    };
  }

  /** The configured Buzz workspace relay — read by BuzzService per fetch. */
  buzzRelayUrl(): string | null {
    return this.state.buzzRelayUrl;
  }

  /** Already-normalized URL, or null to clear (ipc.ts validates input). */
  setBuzzRelay(url: string | null): NostrSettingsInfo {
    this.state.buzzRelayUrl = url;
    this.persist();
    this.deps.emitSettings(this.settings());
    return this.settings();
  }

  /**
   * Answer a relay's NIP-42 challenge as the user. Null without a key —
   * the caller (BuzzService) turns that into "set up your key first".
   */
  signRelayAuth(relayUrl: string, challenge: string) {
    if (this.secretKey === null) return null;
    return signRelayAuthEvent(this.secretKey, relayUrl, challenge);
  }

  /** Blossom GET authorization for a buzz relay's media blob (avatars). */
  signMediaAuth(sha256: string, serverHost: string) {
    if (this.secretKey === null) return null;
    return signBlossomGetAuth(this.secretKey, sha256, serverHost);
  }

  private storeSecret(secretKey: Uint8Array): void {
    const hex = bytesToHex(secretKey);
    const cipher = this.deps.encryptString?.(hex) ?? null;
    this.state.key =
      cipher !== null
        ? { kind: "safeStorage", cipher }
        : { kind: "plain", hex };
    this.secretKey = secretKey;
    this.identity = deriveIdentity(secretKey);
    this.persist();
    this.deps.emitSettings(this.settings());
  }

  /** Accepts nsec1… or 64-char hex. Throws a user-facing message otherwise. */
  setKey(input: string): NostrSettingsInfo {
    const secretKey = parseSecretKeyInput(input);
    if (secretKey === null) {
      throw new Error(
        "That doesn't look like a Nostr secret key — paste an nsec1… string or 64 hex characters.",
      );
    }
    this.storeSecret(secretKey);
    return this.settings();
  }

  /**
   * Mint a fresh identity. The reply — and ONLY this reply — carries the
   * nsec, so the user can back it up; it is never derivable again from any
   * IPC surface (recoveryCode pattern, §8.2).
   */
  generateKey(): NostrSettingsInfo {
    const secretKey = newSecretKey();
    this.storeSecret(secretKey);
    return { ...this.settings(), generatedNsec: encodeNsec(secretKey) };
  }

  removeKey(): NostrSettingsInfo {
    this.state.key = null;
    this.secretKey = null;
    this.identity = null;
    this.persist();
    // Whatever was waiting can never be signed now — answer, don't hang.
    this.drainQueue(() => refusal("no-key", NO_KEY_MESSAGE));
    this.deps.emitSettings(this.settings());
    return this.settings();
  }

  setRelays(relays: unknown): NostrSettingsInfo {
    this.state.relays = sanitizeRelays(relays);
    this.persist();
    this.deps.emitSettings(this.settings());
    return this.settings();
  }

  setSitePolicy(host: string, patch: NostrSitePolicyPatch): NostrSettingsInfo {
    const existing =
      this.state.policies.find((p) => p.host === host) ??
      emptySitePolicy(host, this.now());
    const next = applySitePolicyPatch(existing, patch);
    this.state.policies = [
      ...this.state.policies.filter((p) => p.host !== host),
      next,
    ];
    this.persist();
    this.reevaluate(host);
    this.deps.emitSettings(this.settings());
    return this.settings();
  }

  removeSitePolicy(host: string): NostrSettingsInfo {
    this.state.policies = this.state.policies.filter((p) => p.host !== host);
    this.persist();
    this.deps.emitSettings(this.settings());
    return this.settings();
  }

  /* ------------------------------ the queue ------------------------------ */

  pending(): NostrPendingRequest[] {
    return this.queue.map((entry) => entry.request);
  }

  /** An overlay card's expand tap — relay to the chrome's detail panel. */
  expand(requestId: string): void {
    if (this.queue.some((entry) => entry.request.id === requestId)) {
      this.deps.emitOpenDetail(requestId);
    }
  }

  respond(response: NostrApprovalResponse): void {
    const entry = this.queue.find(
      (candidate) => candidate.request.id === response.requestId,
    );
    if (entry === undefined) return;
    if (response.remember) {
      // Write the standing rule first: settleEntry only answers THIS call;
      // reevaluate() then applies the new rule to the rest of the queue.
      const patch = rememberPatchFor(
        entry.request.payload,
        response.approved ? "allow" : "deny",
      );
      this.setSitePolicy(entry.request.host, patch);
    }
    this.settleEntry(entry, response.approved);
  }

  /** Answer one entry and take it off the queue. */
  private settleEntry(entry: PendingEntry, approved: boolean): void {
    const index = this.queue.indexOf(entry);
    if (index === -1) return;
    this.queue.splice(index, 1);
    entry.release();
    if (!approved) {
      entry.resolve(refusal("denied", "The user denied this request."));
    } else {
      void this.perform(entry.request.payload).then(entry.resolve);
    }
    this.deps.emitPending(this.pending());
  }

  /** A standing rule changed — drain every queued call it now decides. */
  private reevaluate(host: string): void {
    const policy = this.state.policies.find((p) => p.host === host) ?? null;
    for (const entry of [...this.queue]) {
      if (entry.request.host !== host) continue;
      const payload = entry.request.payload;
      const choice = resolvePermission(
        policy,
        payload.method,
        payload.method === "signEvent" ? payload.event.kind : undefined,
      );
      if (choice === "ask") continue;
      this.settleEntry(entry, choice === "allow");
    }
  }

  private drainQueue(answer: () => NostrGuestResponse): void {
    const entries = this.queue.splice(0, this.queue.length);
    for (const entry of entries) {
      entry.release();
      entry.resolve(answer());
    }
    if (entries.length > 0) this.deps.emitPending(this.pending());
  }

  /** Sign-out / quit: nothing may hang on a queue that no longer exists. */
  stop(): void {
    this.stopped = true;
    this.drainQueue(() => refusal("internal", "The signer is shutting down."));
    this.secretKey = null;
    this.identity = null;
  }

  /* ---------------------------- guest requests --------------------------- */

  /**
   * One `window.nostr` call. `caller` was attributed by ipc.ts from the
   * sender frame — nothing in `raw` is trusted before parseGuestPayload.
   */
  async handleGuest(
    caller: GuestCaller,
    raw: unknown,
  ): Promise<NostrGuestResponse> {
    if (this.stopped) {
      return refusal("internal", "The signer is shutting down.");
    }
    const payload = parseGuestPayload(raw);
    if (payload === null) {
      return refusal("invalid", "Malformed window.nostr request.");
    }
    if (this.secretKey === null) {
      this.nudgeKeyMissing(caller.host);
      return refusal("no-key", NO_KEY_MESSAGE);
    }

    const policy =
      this.state.policies.find((p) => p.host === caller.host) ?? null;
    if (policy !== null) {
      policy.lastUsedMs = this.now();
      this.persist();
    }
    const choice = resolvePermission(
      policy,
      payload.method,
      payload.method === "signEvent" ? payload.event.kind : undefined,
    );
    if (choice === "deny") {
      return refusal(
        "denied",
        `${caller.host} is not allowed to do this — see Settings → Nostr.`,
      );
    }
    if (choice === "allow") return this.perform(payload);
    return this.enqueue(caller, payload);
  }

  private enqueue(
    caller: GuestCaller,
    payload: NostrRequestPayload,
  ): Promise<NostrGuestResponse> {
    if (this.queue.length >= MAX_PENDING_NOSTR_REQUESTS) {
      return Promise.resolve(
        refusal("denied", "Too many pending Nostr requests — answer the open ones first."),
      );
    }
    const request: NostrPendingRequest = {
      id: randomUUID(),
      host: caller.host,
      origin: caller.origin,
      payload,
      createdAtMs: this.now(),
    };
    return new Promise<NostrGuestResponse>((resolve) => {
      // The document this promise belongs to can vanish two ways; either
      // one orphans the page-side promise, so the entry dies with it.
      const onGone = (): void => {
        const entry = this.queue.find((e) => e.request.id === request.id);
        if (entry === undefined) return;
        this.queue.splice(this.queue.indexOf(entry), 1);
        entry.release();
        entry.resolve(refusal("denied", "The requesting page went away."));
        this.deps.emitPending(this.pending());
      };
      caller.sender.once("destroyed", onGone);
      caller.sender.on("did-navigate", onGone);
      const release = (): void => {
        if (!caller.sender.isDestroyed()) {
          caller.sender.removeListener("destroyed", onGone);
          caller.sender.removeListener("did-navigate", onGone);
        }
      };
      this.queue.push({ request, sender: caller.sender, resolve, release });
      this.deps.emitPending(this.pending());
    });
  }

  /** One nudge per host per window — a login page retrying getPublicKey on
   *  a timer must not pile up cards. */
  private nudgeKeyMissing(host: string): void {
    const last = this.keyMissingNudgedAtMs.get(host);
    const now = this.now();
    if (last !== undefined && now - last < KEY_MISSING_NUDGE_WINDOW_MS) return;
    this.keyMissingNudgedAtMs.set(host, now);
    this.deps.emitKeyMissing?.(host);
  }

  private async perform(
    payload: NostrRequestPayload,
  ): Promise<NostrGuestResponse> {
    const secretKey = this.secretKey;
    if (secretKey === null) return refusal("no-key", NO_KEY_MESSAGE);
    try {
      const result = await performNostrRequest(
        secretKey,
        this.state.relays,
        payload,
      );
      return { ok: true, result };
    } catch (err) {
      const message =
        err instanceof Error && err.message !== ""
          ? err.message
          : "The request could not be completed.";
      return refusal("internal", message);
    }
  }
}
