/**
 * The NIP-07 signer service. The load-bearing claims: a key round-trips
 * through nostr.json (encrypted when safeStorage-style crypto is available,
 * chmod-600 plain otherwise) and the nsec is never in a `settings()` reply;
 * an unknown site's request queues rather than signing silently; standing
 * rules answer without a prompt in both directions; "remember" writes the
 * rule AND drains the rest of that host's queue; and a request dies with
 * its page instead of dangling forever.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { describe, expect, it } from "vitest";
import type {
  NostrPendingRequest,
  NostrSettingsInfo,
  NostrSignedEvent,
} from "../src/shared/nostr";
import {
  bytesToHex,
  deriveIdentity,
  newSecretKey,
  parseSecretKeyInput,
  parseStoredState,
  sanitizeRelays,
} from "../src/main/nostr/nostr-core";
import {
  NostrService,
  type GuestSender,
  type NostrServiceDeps,
} from "../src/main/nostr/nostr-service";

function tempDir(): string {
  const dir = path.join(tmpdir(), `suma-nostr-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fake tab WebContents: alive until told otherwise, listeners inspectable. */
class FakeSender implements GuestSender {
  id = 1;
  private destroyed = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }
  once(event: "destroyed", listener: () => void): void {
    this.push(event, listener);
  }
  on(event: "did-navigate", listener: () => void): void {
    this.push(event, listener);
  }
  removeListener(event: "destroyed" | "did-navigate", listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((entry) => entry !== listener),
    );
  }
  destroy(): void {
    this.destroyed = true;
    for (const listener of this.listeners.get("destroyed") ?? []) listener();
  }
  navigate(): void {
    for (const listener of this.listeners.get("did-navigate") ?? []) listener();
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
  private push(event: string, listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
}

interface Harness {
  service: NostrService;
  dir: string;
  pendingPushes: NostrPendingRequest[][];
  settingsPushes: NostrSettingsInfo[];
  openedDetails: string[];
}

function build(overrides: Partial<NostrServiceDeps> = {}): Harness {
  const dir = tempDir();
  const pendingPushes: NostrPendingRequest[][] = [];
  const settingsPushes: NostrSettingsInfo[] = [];
  const openedDetails: string[] = [];
  const service = new NostrService({
    userDataDir: dir,
    emitPending: (pending) => pendingPushes.push(pending),
    emitSettings: (info) => settingsPushes.push(info),
    emitOpenDetail: (requestId) => openedDetails.push(requestId),
    ...overrides,
  });
  return { service, dir, pendingPushes, settingsPushes, openedDetails };
}

function caller(sender: FakeSender, host = "primal.net") {
  return { host, origin: `https://${host}`, sender };
}

const NOTE = { kind: 1, content: "hello", created_at: 1_700_000_000, tags: [] };

describe("key handling", () => {
  it("parses nsec and hex, refuses npubs and junk", () => {
    const sk = newSecretKey();
    const nsec = nip19.nsecEncode(sk);
    expect(parseSecretKeyInput(nsec)).toEqual(sk);
    expect(parseSecretKeyInput(` ${bytesToHex(sk)} `)).toEqual(sk);
    expect(parseSecretKeyInput(nip19.npubEncode(deriveIdentity(sk).pubkey))).toBeNull();
    expect(parseSecretKeyInput("hunter2")).toBeNull();
  });

  it("stores the key encrypted when crypto is available, and round-trips", () => {
    // A reversible stand-in for safeStorage.
    const enc = (plain: string): string => Buffer.from(plain).toString("base64");
    const dec = (cipher: string): string => Buffer.from(cipher, "base64").toString();
    const { service, dir } = build({ encryptString: enc, decryptString: dec });
    const sk = newSecretKey();
    const info = service.setKey(nip19.nsecEncode(sk));
    expect(info.keyConfigured).toBe(true);
    expect(info.npub).toBe(deriveIdentity(sk).npub);

    const file = path.join(dir, "nostr.json");
    const onDisk = readFileSync(file, "utf8");
    // The raw hex is not in the file, and the file is private to the user.
    expect(onDisk).not.toContain(bytesToHex(sk));
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // A second service over the same dir (an app relaunch) recovers the key.
    const again = build({ encryptString: enc, decryptString: dec, userDataDir: dir });
    expect(again.service.settings().npub).toBe(deriveIdentity(sk).npub);
  });

  it("falls back to a plain (still chmod-600) key without crypto", () => {
    const { service, dir } = build();
    const sk = newSecretKey();
    service.setKey(bytesToHex(sk));
    const reloaded = parseStoredState(
      readFileSync(path.join(dir, "nostr.json"), "utf8"),
    );
    expect(reloaded.key).toEqual({ kind: "plain", hex: bytesToHex(sk) });
  });

  it("reveals a generated nsec once and never in settings()", () => {
    const { service } = build();
    const info = service.generateKey();
    expect(info.generatedNsec).toMatch(/^nsec1/);
    expect(service.settings().generatedNsec).toBeUndefined();
    expect(service.settings().keyConfigured).toBe(true);
  });

  it("rejects invalid key input with a user-facing message", () => {
    const { service } = build();
    expect(() => service.setKey("npub1notasecret")).toThrow(/secret key/);
  });
});

describe("guest requests and the queue", () => {
  it("refuses everything without a key, without queueing", async () => {
    const { service, pendingPushes } = build();
    const reply = await service.handleGuest(caller(new FakeSender()), {
      method: "getPublicKey",
    });
    expect(reply).toMatchObject({ ok: false, reason: "no-key" });
    expect(pendingPushes).toEqual([]);
  });

  it("nudges the user once per host when a site asks with no key set", async () => {
    let clock = 1_000;
    const nudges: string[] = [];
    const { service } = build({
      emitKeyMissing: (host) => nudges.push(host),
      now: () => clock,
    });
    // A login page polling getPublicKey must produce ONE card, not a pile…
    await service.handleGuest(caller(new FakeSender(), "coracle.social"), {
      method: "getPublicKey",
    });
    clock += 5_000;
    await service.handleGuest(caller(new FakeSender(), "coracle.social"), {
      method: "getPublicKey",
    });
    expect(nudges).toEqual(["coracle.social"]);
    // …a different host nudges independently…
    await service.handleGuest(caller(new FakeSender(), "primal.net"), {
      method: "getPublicKey",
    });
    expect(nudges).toEqual(["coracle.social", "primal.net"]);
    // …and the same host nudges again once the window passes.
    clock += 61_000;
    await service.handleGuest(caller(new FakeSender(), "coracle.social"), {
      method: "getPublicKey",
    });
    expect(nudges).toEqual(["coracle.social", "primal.net", "coracle.social"]);
  });

  it("refuses malformed payloads before permissions are even consulted", async () => {
    const { service } = build();
    service.generateKey();
    const reply = await service.handleGuest(caller(new FakeSender()), {
      method: "signEvent",
      event: { kind: "1", content: 2 },
    });
    expect(reply).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("queues an unknown site's request instead of answering silently", async () => {
    const { service, pendingPushes } = build();
    service.generateKey();
    const promise = service.handleGuest(caller(new FakeSender()), {
      method: "signEvent",
      event: NOTE,
    });
    expect(pendingPushes.at(-1)).toHaveLength(1);
    const request = service.pending()[0]!;
    expect(request.host).toBe("primal.net");

    service.respond({ requestId: request.id, approved: true, remember: false });
    const reply = await promise;
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const event = reply.result as NostrSignedEvent;
      expect(event.kind).toBe(1);
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(service.settings().pubkey);
    }
    // Answered ⇒ gone, on both surfaces.
    expect(service.pending()).toEqual([]);
    expect(pendingPushes.at(-1)).toEqual([]);
  });

  it("denying resolves the page's promise with an error value", async () => {
    const { service } = build();
    service.generateKey();
    const promise = service.handleGuest(caller(new FakeSender()), {
      method: "getPublicKey",
    });
    service.respond({
      requestId: service.pending()[0]!.id,
      approved: false,
      remember: false,
    });
    expect(await promise).toMatchObject({ ok: false, reason: "denied" });
  });

  it("standing allow rules answer without a prompt — the primal.net example", async () => {
    const { service, pendingPushes } = build();
    service.generateKey();
    service.setSitePolicy("primal.net", {
      kinds: { "3": "allow" },
      signDefault: "ask",
    });
    // Kind 3 (follow list): allowed silently.
    const followList = await service.handleGuest(caller(new FakeSender()), {
      method: "signEvent",
      event: { ...NOTE, kind: 3 },
    });
    expect(followList.ok).toBe(true);
    expect(pendingPushes).toEqual([]);
    // Kind 1 (note): still queues.
    void service.handleGuest(caller(new FakeSender()), {
      method: "signEvent",
      event: NOTE,
    });
    expect(service.pending()).toHaveLength(1);
  });

  it("standing deny rules refuse without a prompt", async () => {
    const { service } = build();
    service.generateKey();
    service.setSitePolicy("evil.example", { methods: { getPublicKey: "deny" } });
    const reply = await service.handleGuest(
      caller(new FakeSender(), "evil.example"),
      { method: "getPublicKey" },
    );
    expect(reply).toMatchObject({ ok: false, reason: "denied" });
  });

  it("a remembered approval writes the rule and drains that host's queue", async () => {
    const { service, settingsPushes } = build();
    service.generateKey();
    const sender = new FakeSender();
    const first = service.handleGuest(caller(sender), {
      method: "signEvent",
      event: { ...NOTE, kind: 7, content: "+" },
    });
    const second = service.handleGuest(caller(sender), {
      method: "signEvent",
      event: { ...NOTE, kind: 7, content: "🤙" },
    });
    // A different kind from the same host must NOT be drained by the rule.
    const other = service.handleGuest(caller(sender), {
      method: "signEvent",
      event: NOTE,
    });
    expect(service.pending()).toHaveLength(3);

    service.respond({
      requestId: service.pending()[0]!.id,
      approved: true,
      remember: true,
    });
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);

    const policy = service
      .settings()
      .policies.find((p) => p.host === "primal.net");
    expect(policy?.kinds["7"]).toBe("allow");
    expect(settingsPushes.length).toBeGreaterThan(0);
    // The kind-1 request is still waiting on the user.
    expect(service.pending()).toHaveLength(1);
    void other;
  });

  it("a request dies with its page — tab close and navigation both", async () => {
    const { service } = build();
    service.generateKey();
    const closing = new FakeSender();
    const navigating = new FakeSender();
    const closed = service.handleGuest(caller(closing), { method: "getPublicKey" });
    const navigated = service.handleGuest(caller(navigating), {
      method: "getPublicKey",
    });
    expect(service.pending()).toHaveLength(2);
    closing.destroy();
    navigating.navigate();
    expect(await closed).toMatchObject({ ok: false, reason: "denied" });
    expect(await navigated).toMatchObject({ ok: false, reason: "denied" });
    expect(service.pending()).toEqual([]);
  });

  it("detaches its listeners once a request is settled", async () => {
    const { service } = build();
    service.generateKey();
    const sender = new FakeSender();
    const promise = service.handleGuest(caller(sender), { method: "getPublicKey" });
    expect(sender.listenerCount("destroyed")).toBe(1);
    service.respond({
      requestId: service.pending()[0]!.id,
      approved: true,
      remember: false,
    });
    await promise;
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(sender.listenerCount("did-navigate")).toBe(0);
  });

  it("removing the key answers everything pending rather than hanging", async () => {
    const { service } = build();
    service.generateKey();
    const promise = service.handleGuest(caller(new FakeSender()), {
      method: "getPublicKey",
    });
    service.removeKey();
    expect(await promise).toMatchObject({ ok: false, reason: "no-key" });
  });

  it("nip04 and nip44 round-trip through approved requests", async () => {
    const { service } = build();
    service.generateKey();
    service.setSitePolicy("primal.net", {
      methods: {
        "nip04.encrypt": "allow",
        "nip04.decrypt": "allow",
        "nip44.encrypt": "allow",
        "nip44.decrypt": "allow",
      },
    });
    const peer = deriveIdentity(newSecretKey()).pubkey;
    for (const nip of ["nip04", "nip44"] as const) {
      const encrypted = await service.handleGuest(caller(new FakeSender()), {
        method: `${nip}.encrypt`,
        peer,
        plaintext: "sealed",
      });
      expect(encrypted.ok).toBe(true);
      if (!encrypted.ok) continue;
      // Decrypting our own ciphertext works because the conversation key is
      // symmetric between the two parties.
      const decrypted = await service.handleGuest(caller(new FakeSender()), {
        method: `${nip}.decrypt`,
        peer,
        ciphertext: encrypted.result as string,
      });
      expect(decrypted).toMatchObject({ ok: true, result: "sealed" });
    }
  });

  it("expand relays only requests that are actually pending", () => {
    const { service, openedDetails } = build();
    service.generateKey();
    void service.handleGuest(caller(new FakeSender()), { method: "getPublicKey" });
    const id = service.pending()[0]!.id;
    service.expand(id);
    service.expand("no-such-request");
    expect(openedDetails).toEqual([id]);
  });
});

describe("relay hygiene", () => {
  it("keeps only ws(s) URLs and defaults read/write to true", () => {
    const relays = sanitizeRelays({
      "wss://relay.damus.io": { read: true, write: false },
      "https://not-a-relay.example": { read: true, write: true },
      "javascript:alert(1)": {},
      "wss://nos.lol": {},
    });
    expect(Object.keys(relays)).toEqual(["wss://relay.damus.io/", "wss://nos.lol/"]);
    expect(relays["wss://relay.damus.io/"]).toEqual({ read: true, write: false });
    expect(relays["wss://nos.lol/"]).toEqual({ read: true, write: true });
  });
});
