/**
 * Regression tests for the adversarial-review findings against PRD §8.3/§9.
 * Each describe block cites the confirmed finding it pins down.
 */

import { describe, expect, it } from "vitest";
import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  encodeCookiePlain,
  generateDeviceKeypair,
  makeVersionToken,
  seal,
  signRecord,
  toBase64,
  type CookiePlain,
  type SignableRecordFields,
} from "@suma/protocol";
import { DeviceRegistryVerifier, recordSealAad } from "../src/index.js";
import {
  attrsFor,
  createEngine,
  makeIdentity,
  ManualClock,
  must,
  testKeypair,
  testSpaceKeys,
} from "./helpers.js";

describe("finding: late explicit delete vs a chain that descends from it", () => {
  it("an older delete loses to a live write whose ancestry passes through it", async () => {
    const spaceId = "space-late-delete";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const c = await createEngine(spaceId, "dev-c", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    for (const replica of [b, c]) expect(await replica.engine.applyRemote([w0])).toEqual(["applied"]);

    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));
    expect(await c.engine.applyRemote([d1])).toEqual(["applied"]);

    // C re-logs-in (chain descends from the delete), then the session rotates.
    clock.tick(1);
    const w1 = must(await c.engine.localChange(identity, attrsFor("relogin"), false, "explicit"));
    expect(w1.causalParent).toBe(makeVersionToken(d1.recordId, d1.hlc));
    clock.tick(1);
    const w2 = must(await c.engine.localChange(identity, attrsFor("rotated"), false, "explicit"));

    // B sees the live chain FIRST, the delete LAST (reordered delivery).
    expect(await b.engine.applyRemote([w1])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([w2])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([d1])).toEqual(["stale"]);
    expect(b.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);

    // A receives the chain in order and converges to the same state.
    expect(await a.engine.applyRemote([w1, w2])).toEqual(["applied", "applied"]);
    expect(a.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);
  });

  it("a blocked write is parked and applied once its ancestry becomes provable", async () => {
    const spaceId = "space-parked";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const d = await createEngine(spaceId, "dev-d", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));
    clock.tick(1);
    const w1 = must(await a.engine.localChange(identity, attrsFor("relogin"), false, "explicit"));
    clock.tick(1);
    const w2 = must(await a.engine.localChange(identity, attrsFor("rotated"), false, "explicit"));

    // Fresh device hydrates the tombstone, then receives ONLY the newest
    // write (a hub that keeps just the latest version per record).
    expect(await d.engine.applyRemote([w0, d1])).toEqual(["applied", "applied"]);
    expect(await d.engine.applyRemote([w2])).toEqual(["resurrection-blocked"]);
    expect(d.engine.getRecord(w2.recordId)?.cause).toBe("EXPLICIT_DELETE");

    // The intermediate link arrives later; the parked write applies with it.
    expect(await d.engine.applyRemote([w1])).toEqual(["applied"]);
    expect(d.engine.getRecord(w2.recordId)?.hlc).toEqual(w2.hlc);
    expect(d.engine.listLiveCookies().map((p) => p.attributes?.value)).toEqual(["rotated"]);
  });

  it("still blocks a write whose history genuinely predates the delete", async () => {
    const spaceId = "space-still-blocked";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);
    clock.tick(1);
    const d1 = must(await a.engine.localChange(identity, null, true, "explicit"));

    // B offline since before the delete; its write descends only from w0.
    clock.tick(1);
    const stale = must(await b.engine.localChange(identity, attrsFor("zombie"), false, "explicit"));
    expect(compareHlc(stale.hlc, d1.hlc)).toBeGreaterThan(0);

    expect(await a.engine.applyRemote([stale])).toEqual(["resurrection-blocked"]);
    expect(a.engine.listLiveCookies()).toEqual([]);
  });
});

describe("finding: steady-state echo republish loop", () => {
  it("the cookie-store echo of a remote apply is suppressed, not republished", async () => {
    const spaceId = "space-echo-loop";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    // Electron fires cookies-'changed' for the applied cookie; capture relays
    // it to localChange. It must be swallowed, not signed and republished.
    const echo = await b.engine.localChange(identity, attrsFor("v0"), false, "explicit");
    expect(echo).toBeNull();
    expect(b.transport.published).toHaveLength(0);
  });

  it("a genuine user mutation right after an apply still publishes", async () => {
    const spaceId = "space-echo-genuine";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    clock.tick(1);
    const genuine = await b.engine.localChange(identity, attrsFor("different"), false, "explicit");
    expect(genuine).not.toBeNull();
    expect(b.transport.published).toHaveLength(1);
  });
});

describe("finding: phantom echo expectations swallow the next real login", () => {
  it("a hydrated tombstone with no echo event cannot eat a later genuine write", async () => {
    const spaceId = "space-phantom";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const fresh = await createEngine(spaceId, "dev-fresh", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("old"), false, "explicit"));
    clock.tick(1);
    const tombstone = must(await a.engine.localChange(identity, null, true, "explicit"));

    // Fresh jar: removing an absent cookie emits no 'changed' event, so the
    // registered echo expectation is never consumed.
    await fresh.engine.beginHydration();
    expect(await fresh.engine.applyRemote([tombstone])).toEqual(["applied"]);
    await fresh.engine.endHydration();

    // Days later the user logs in again: different state, must publish.
    clock.tick(1);
    const login = await fresh.engine.localChange(identity, attrsFor("new-session"), false, "explicit");
    expect(login).not.toBeNull();
    expect(fresh.transport.published).toHaveLength(1);
  });

  it("a same-state expectation lapses after the echo TTL", async () => {
    const spaceId = "space-echo-ttl";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock, { echoTtlMs: 1_000 });
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"));
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    // The echo never arrives (e.g. the applier's set was a no-op). After the
    // TTL, an identical genuine write is a real mutation again.
    clock.tick(1_001);
    const genuine = await b.engine.localChange(identity, attrsFor("v0"), false, "explicit");
    expect(genuine).not.toBeNull();
  });
});

describe("finding: lease grants cached beyond the server TTL", () => {
  const rotatingIdentity = (spaceId: string): ReturnType<typeof makeIdentity> =>
    makeIdentity(spaceId, "dash.cloudflare.com", "cf_session");

  it("re-acquires the origin lease after the conservative client expiry", async () => {
    const spaceId = "space-lease-ttl";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock, { leaseTtlMs: 10_000 });
    const identity = rotatingIdentity(spaceId);

    clock.tick(1);
    must(await a.engine.localChange(identity, attrsFor("s1"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(1);

    // Within half the TTL the cached grant is trusted.
    clock.tick(2_000);
    must(await a.engine.localChange(identity, attrsFor("s2"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(1);

    // Past half the TTL the grant may have lapsed server-side — re-acquire.
    clock.tick(4_000);
    must(await a.engine.localChange(identity, attrsFor("s3"), false, "explicit"));
    expect(a.transport.leaseCalls).toHaveLength(2);
    expect(a.transport.published).toHaveLength(3);
  });
});

describe("finding: sealed identity never re-bound to wire ids", () => {
  it("rejects a record whose sealed identity does not hash to its record id", async () => {
    const spaceId = "space-binding";
    const clock = new ManualClock();
    const receiver = await createEngine(spaceId, "dev-r", clock);
    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();

    const realIdentity = makeIdentity(spaceId, "github.com", "sid");
    const claimedIdentity = makeIdentity(spaceId, "gitlab.com", "token");
    const claimedRecordId = await computeRecordIdHex(keys.idKey, claimedIdentity);
    const claimedOriginId = await computeOriginIdHex(keys.idKey, spaceId, claimedIdentity.hostKey);

    // Seal a github cookie but claim gitlab's record/origin ids — the AAD is
    // consistent with the claim, so only the re-binding check can catch it.
    const plain: CookiePlain = {
      identity: realIdentity,
      attributes: attrsFor("smuggled"),
      deleted: false,
    };
    const sealed = await seal(
      keys.sealKey,
      encodeCookiePlain(plain),
      recordSealAad(spaceId, claimedRecordId),
    );
    const fields: SignableRecordFields = {
      spaceId,
      recordId: claimedRecordId,
      originId: claimedOriginId,
      sealedRecord: toBase64(sealed),
      hlc: { physicalMs: clock.now() + 5, logical: 0, deviceId: "dev-m" },
      causalParent: null,
      cause: "WRITE",
    };
    const deviceSig = toBase64(await signRecord(keypair.privateKey, fields));

    expect(await receiver.engine.applyRemote([{ ...fields, deviceSig }])).toEqual(["rejected"]);
    expect(receiver.engine.getRecord(claimedRecordId)).toBeUndefined();
  });
});

describe("finding: device signatures never verified on receipt", () => {
  it("rejects unknown-device records under the reject policy and bad signatures always", async () => {
    const spaceId = "space-verify";
    const clock = new ManualClock();
    const sender = await createEngine(spaceId, "dev-s", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const wire = must(await sender.engine.localChange(identity, attrsFor("v0"), false, "explicit"));

    const strangerKeys = await generateDeviceKeypair();
    const strict = new DeviceRegistryVerifier("reject");
    strict.addDevice("someone-else", strangerKeys.publicKey);
    const receiverStrict = await createEngine(spaceId, "dev-r1", clock, { verifier: strict });
    expect(await receiverStrict.engine.applyRemote([wire])).toEqual(["rejected"]);

    const trusting = new DeviceRegistryVerifier("reject");
    trusting.addDevice("dev-s", (await testKeypair()).publicKey);
    const receiverTrusting = await createEngine(spaceId, "dev-r2", clock, { verifier: trusting });
    expect(await receiverTrusting.engine.applyRemote([wire])).toEqual(["applied"]);

    // Any mutated field breaks the signature.
    const tampered = { ...wire, cause: "EXPLICIT_DELETE" as const };
    const receiverTampered = await createEngine(spaceId, "dev-r3", clock, { verifier: trusting });
    expect(await receiverTampered.engine.applyRemote([tampered])).toEqual(["rejected"]);
  });
});
