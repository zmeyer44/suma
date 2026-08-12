import { describe, expect, it } from "vitest";
import { type CookieRecordWire } from "@suma/protocol";
import {
  buildCookieRecordWire,
  InMemoryQueueStorage,
  OfflineQueue,
  SpaceSyncEngine,
  type CookieApplier,
} from "../src/index.js";
import {
  attrsFor,
  CollectingTransport,
  createEngine,
  livePrint,
  makeIdentity,
  ManualClock,
  must,
  settle,
  testKeypair,
  testSpaceKeys,
} from "./helpers.js";

describe("conflict resolution", () => {
  it("retries a hydration record when the cookie store initially rejects it", async () => {
    const spaceId = "space-cookie-apply-retry";
    const clock = new ManualClock();
    const source = await createEngine(spaceId, "dev-source", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");
    const wire = must(
      await source.engine.localChange(
        identity,
        attrsFor("retry-me"),
        false,
        "explicit",
      ),
    );
    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();
    let shouldFail = true;
    let applied = 0;
    const applier: CookieApplier = {
      async apply() {
        if (shouldFail) throw new Error("cookie store unavailable");
        applied += 1;
      },
    };
    const target = new SpaceSyncEngine(
      spaceId,
      keys,
      { deviceId: "dev-target", privateKey: keypair.privateKey },
      new CollectingTransport(),
      applier,
      { deviceId: "dev-target", now: clock.now },
    );

    await expect(target.applyRemote([wire])).rejects.toThrow(
      "cookie store unavailable",
    );
    expect(target.getRecord(wire.recordId)).toBeUndefined();
    shouldFail = false;
    expect(await target.applyRemote([wire])).toEqual(["applied"]);
    expect(applied).toBe(1);
    expect(await target.inspectRemoteIdentity(wire)).toEqual(identity);
  });

  it("re-applies a stored winner when an origin becomes locally eligible", async () => {
    const spaceId = "space-route-promotion";
    const clock = new ManualClock();
    const source = await createEngine(spaceId, "dev-source", clock);
    const target = await createEngine(spaceId, "dev-target", clock);
    const identity = makeIdentity(spaceId, "challenged.example", "sid");
    source.engine.setOriginOverride("challenged.example", "sync");
    target.engine.setOriginOverride("challenged.example", "sync");

    const wire = must(
      await source.engine.localChange(
        identity,
        attrsFor("portable-session"),
        false,
        "explicit",
      ),
    );
    target.applier.enabled = false;
    expect(await target.engine.applyRemote([wire])).toEqual(["applied"]);
    expect(target.applier.applied).toHaveLength(0);

    target.applier.enabled = true;
    expect(await target.engine.reapplyOrigin("challenged.example")).toBe(1);
    expect(target.applier.applied.at(-1)?.plain.attributes?.value).toBe(
      "portable-session",
    );
  });

  it("applies newer records, rejects stale ones, dedupes redelivery", async () => {
    const spaceId = "space-cr-1";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w1 = must(
      await a.engine.localChange(identity, attrsFor("v1"), false, "explicit"),
    );
    clock.tick(1);
    const w2 = must(
      await a.engine.localChange(identity, attrsFor("v2"), false, "overwrite"),
    );
    expect(w2.cause).toBe("OVERWRITE");

    expect(await b.engine.applyRemote([w2])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([w1])).toEqual(["stale"]);
    expect(await b.engine.applyRemote([w2])).toEqual(["duplicate"]);
    expect(must(b.engine.getRecord(w2.recordId)).plain.attributes?.value).toBe(
      "v2",
    );

    const c = await createEngine(spaceId, "dev-c", clock);
    expect(await c.engine.applyRemote([w1, w2])).toEqual([
      "applied",
      "applied",
    ]);
    expect(must(c.engine.getRecord(w2.recordId)).plain.attributes?.value).toBe(
      "v2",
    );
  });

  it("drops HYDRATION_ECHO records arriving over the wire", async () => {
    const spaceId = "space-cr-2";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const keys = await testSpaceKeys(spaceId);
    const keypair = await testKeypair();
    const identity = makeIdentity(spaceId, "github.com", "sid");
    const echo = await buildCookieRecordWire(
      keys,
      { deviceId: "dev-x", privateKey: keypair.privateKey },
      { identity, attributes: attrsFor("echo"), deleted: false },
      { physicalMs: clock.now(), logical: 0, deviceId: "dev-x" },
      null,
      "HYDRATION_ECHO",
    );
    expect(await a.engine.applyRemote([echo])).toEqual(["duplicate"]);
    expect(a.engine.getRecord(echo.recordId)).toBeUndefined();
    expect(a.engine.listLiveCookies()).toEqual([]);
  });

  it("an explicit delete of the version we currently have always lands", async () => {
    const spaceId = "space-cr-3";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);
    clock.tick(1);
    const del = must(
      await b.engine.localChange(identity, null, true, "explicit"),
    );
    expect(await a.engine.applyRemote([del])).toEqual(["applied"]);
    expect(a.engine.listLiveCookies()).toEqual([]);
    expect(
      must(a.engine.getRecord(del.recordId)).tombstonedAtMs,
    ).not.toBeNull();
  });

  it("expired deletes follow plain LWW over an explicit tombstone, but the explicit fence persists", async () => {
    const spaceId = "space-cr-4";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const target = await createEngine(spaceId, "dev-t", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");

    clock.tick(1);
    const w0 = must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    expect(await target.engine.applyRemote([w0])).toEqual(["applied"]);
    expect(await b.engine.applyRemote([w0])).toEqual(["applied"]);

    clock.tick(1);
    const explicitDelete = must(
      await a.engine.localChange(identity, null, true, "explicit"),
    );
    expect(await target.engine.applyRemote([explicitDelete])).toEqual([
      "applied",
    ]);

    // B never saw the logout; its cookie expires with a later HLC — plain LWW.
    clock.tick(1);
    const expired = must(
      await b.engine.localChange(identity, null, true, "expired"),
    );
    expect(await target.engine.applyRemote([expired])).toEqual(["applied"]);
    expect(must(target.engine.getRecord(expired.recordId)).cause).toBe(
      "EXPIRED",
    );

    // A write whose ancestry predates the explicit logout stays blocked even
    // though the stored tombstone is now the EXPIRED one (guard is keyed off
    // the newest explicit deletion seen, stronger than a current-cause check).
    clock.tick(1);
    const stale = must(
      await b.engine.localChange(identity, attrsFor("late"), false, "explicit"),
    );
    expect(await target.engine.applyRemote([stale])).toEqual([
      "resurrection-blocked",
    ]);
    expect(target.engine.listLiveCookies()).toEqual([]);
  });

  it("ignores the removal half of an overwrite pair", async () => {
    const spaceId = "space-cr-5";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const identity = makeIdentity(spaceId, "github.com", "sid");
    clock.tick(1);
    must(
      await a.engine.localChange(identity, attrsFor("v0"), false, "explicit"),
    );
    clock.tick(1);
    expect(
      await a.engine.localChange(identity, null, true, "overwrite"),
    ).toBeNull();
    expect(a.engine.listLiveCookies()).toHaveLength(1);
    expect(a.transport.published).toHaveLength(1);
  });
});

describe("rotating-auth lease gating", () => {
  const identityFor = (spaceId: string): ReturnType<typeof makeIdentity> =>
    makeIdentity(spaceId, "cloudflare.com", "session");

  it("publishes optimistically, then force-retries only after hub rejection", async () => {
    const spaceId = "space-lease-1";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.transport.leaseGranted = false;

    clock.tick(1);
    const wire = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v0"),
        false,
        "explicit",
      ),
    );
    expect(a.transport.published).toHaveLength(1);
    expect(a.engine.queueDepth).toBe(0);

    a.transport.leaseResults.push(true);
    await a.engine.publishRejected(wire.recordId, "lease_required");
    expect(a.transport.leaseCalls.at(-1)).toMatchObject({ force: true });
    expect(a.transport.published).toHaveLength(2);
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.published.at(-1)?.recordId).toBe(wire.recordId);
  });

  it("publishes immediately when the lease is granted, acquiring it once", async () => {
    const spaceId = "space-lease-2";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);

    clock.tick(1);
    const first = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v0"),
        false,
        "explicit",
      ),
    );
    clock.tick(1);
    must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v1"),
        false,
        "overwrite",
      ),
    );

    expect(a.transport.published).toHaveLength(2);
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.leaseCalls).toHaveLength(1);
    expect(a.transport.leaseCalls[0]?.originId).toBe(first.originId);
    expect(a.transport.leaseCalls[0]?.spaceId).toBe(spaceId);
  });

  it("explicit deletes on rotating-auth origins publish without a lease", async () => {
    const spaceId = "space-lease-3";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.transport.leaseGranted = false;

    clock.tick(1);
    must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v0"),
        false,
        "explicit",
      ),
    );
    expect(a.engine.queueDepth).toBe(0);
    clock.tick(1);
    const del = must(
      await a.engine.localChange(identityFor(spaceId), null, true, "explicit"),
    );
    expect(a.transport.published.map((r) => r.recordId)).toContain(
      del.recordId,
    );
    expect(a.engine.queueDepth).toBe(0);
  });

  it("going offline releases held leases", async () => {
    const spaceId = "space-lease-4";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    clock.tick(1);
    const wire = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v0"),
        false,
        "explicit",
      ),
    );
    a.engine.setOnline(false);
    expect(a.transport.released).toContain(wire.originId);
  });

  it("force-takes a foreign lease only after the hub rejects the current rotation", async () => {
    const spaceId = "space-lease-auto-handoff";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.transport.leaseResults.push(false);

    clock.tick(1);
    const rotated = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("rotated-on-this-mac"),
        false,
        "explicit",
      ),
    );

    expect(a.transport.leaseCalls).toEqual([
      { spaceId, originId: rotated.originId, force: undefined },
    ]);
    expect(a.transport.published[0]?.recordId).toBe(rotated.recordId);

    a.transport.leaseResults.push(true);
    await a.engine.publishRejected(rotated.recordId, "lease_required");
    expect(a.transport.leaseCalls.at(-1)).toEqual({
      spaceId,
      originId: rotated.originId,
      force: true,
    });
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.published.at(-1)?.recordId).toBe(rotated.recordId);
  });

  it("offline recovery sends only the newest queued rotation", async () => {
    const spaceId = "space-lease-drain-on-handoff";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.engine.setOnline(false);

    clock.tick(1);
    const older = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("older"),
        false,
        "explicit",
      ),
    );
    expect(a.engine.queueDepth).toBe(1);

    clock.tick(1);
    const newer = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("newer"),
        false,
        "overwrite",
      ),
    );
    expect(a.engine.queueDepth).toBe(1);
    a.engine.setOnline(true);
    await settle(() => a.transport.published.length === 1);
    expect(a.engine.queueDepth).toBe(0);
    expect(a.transport.published.map((wire) => wire.hlc)).toEqual([newer.hlc]);
    expect(a.transport.published[0]?.hlc).not.toEqual(older.hlc);
  });

  it("drops a cached grant when the hub transfers the lease", async () => {
    const spaceId = "space-lease-revoked";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);

    clock.tick(1);
    const first = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v1"),
        false,
        "explicit",
      ),
    );
    expect(a.transport.leaseCalls).toHaveLength(1);

    a.engine.leaseRevoked(first.originId);
    clock.tick(1);
    must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v2"),
        false,
        "overwrite",
      ),
    );
    expect(a.transport.leaseCalls).toHaveLength(2);
  });

  it("republishes the newest local generation after an in-flight lease rejection", async () => {
    const spaceId = "space-lease-rejected-publish";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);

    clock.tick(1);
    const first = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v1"),
        false,
        "explicit",
      ),
    );
    clock.tick(1);
    const newest = must(
      await a.engine.localChange(
        identityFor(spaceId),
        attrsFor("v2"),
        false,
        "overwrite",
      ),
    );
    expect(a.transport.leaseCalls).toHaveLength(1);

    // Another Mac took the server lease before v1/v2 reached the hub. The
    // delayed ack names only the cookie, so recovery must send v2, not v1.
    a.transport.leaseResults.push(true);
    await a.engine.publishRejected(first.recordId, "lease_required");

    expect(a.transport.leaseCalls.slice(-2)).toEqual([
      { spaceId, originId: newest.originId, force: undefined },
      { spaceId, originId: newest.originId, force: true },
    ]);
    expect(a.transport.published.at(-1)?.hlc).toEqual(newest.hlc);
    expect(a.engine.queueDepth).toBe(0);
  });
});

describe("policy gating", () => {
  it("does not capture tier-0 or sensitive origins without opt-in", async () => {
    const spaceId = "space-pol-1";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    clock.tick(1);
    expect(
      await a.engine.localChange(
        makeIdentity(spaceId, "chase.com", "auth"),
        attrsFor("x"),
        false,
        "explicit",
      ),
    ).toBeNull();
    expect(
      await a.engine.localChange(
        makeIdentity(spaceId, "zoom.us", "zm"),
        attrsFor("x"),
        false,
        "explicit",
      ),
    ).toBeNull();
    expect(
      await a.engine.localChange(
        makeIdentity(spaceId, "www.chase.com", "auth"),
        null,
        true,
        "explicit",
      ),
    ).toBeNull();
    expect(a.engine.listLiveCookies()).toEqual([]);
    expect(a.transport.published).toHaveLength(0);
    expect(a.engine.queueDepth).toBe(0);
  });

  it("captures a sensitive origin only after explicit opt-in, and 'never' wins over policy", async () => {
    const spaceId = "space-pol-2";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);

    expect(a.engine.getOriginPolicyFor("chase.com").synced).toBe(false);
    a.engine.setOriginOverride("chase.com", "sync");
    expect(a.engine.getOriginPolicyFor("chase.com").synced).toBe(true);

    clock.tick(1);
    const wire = await a.engine.localChange(
      makeIdentity(spaceId, "www.chase.com", "auth"),
      attrsFor("x"),
      false,
      "explicit",
    );
    expect(wire).not.toBeNull();
    expect(a.transport.published).toHaveLength(1);

    a.engine.setOriginOverride("github.com", "never");
    clock.tick(1);
    expect(
      await a.engine.localChange(
        makeIdentity(spaceId, "github.com", "sid"),
        attrsFor("x"),
        false,
        "explicit",
      ),
    ).toBeNull();
    expect(a.transport.published).toHaveLength(1);

    a.engine.setOriginOverride("github.com", null);
    clock.tick(1);
    expect(
      await a.engine.localChange(
        makeIdentity(spaceId, "github.com", "sid"),
        attrsFor("x"),
        false,
        "explicit",
      ),
    ).not.toBeNull();
  });

  it("getOriginPolicyFor reports policy, override, and sync decision for subdomains", async () => {
    const spaceId = "space-pol-3";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    a.engine.setOriginOverride("chase.com", "sync");
    const view = a.engine.getOriginPolicyFor("app.chase.com");
    expect(view.policy.label).toBe("Chase");
    expect(view.override).toBe("sync");
    expect(view.synced).toBe(true);
    const untested = a.engine.getOriginPolicyFor("example.com");
    expect(untested.policy.syncTier).toBe(0);
    expect(untested.override).toBeNull();
    expect(untested.synced).toBe(false);
  });
});

describe("OfflineQueue", () => {
  const wireAt = (physicalMs: number, suffix = "00"): CookieRecordWire => ({
    spaceId: "s",
    recordId: `${"ab".repeat(31)}${suffix}`,
    originId: "cd".repeat(32),
    sealedRecord: "c2VhbGVk",
    hlc: { physicalMs, logical: 0, deviceId: "dev" },
    causalParent: null,
    deviceSig: "c2ln",
    cause: "WRITE",
  });

  it("compacts per record and drains newest winners in HLC order exactly once", () => {
    const queue = new OfflineQueue();
    queue.enqueue(wireAt(5, "01"));
    queue.enqueue(wireAt(1, "02"));
    queue.enqueue(wireAt(3, "01"));
    expect(queue.depth).toBe(2);
    expect(queue.peek().map((r) => r.hlc.physicalMs)).toEqual([1, 5]);
    expect(queue.depth).toBe(2);
    expect(queue.drain().map((r) => r.hlc.physicalMs)).toEqual([1, 5]);
    expect(queue.depth).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("supports pluggable storage", () => {
    const storage = new InMemoryQueueStorage();
    const queue = new OfflineQueue(storage);
    queue.enqueue(wireAt(2));
    expect(storage.size()).toBe(1);
    queue.drain();
    expect(storage.size()).toBe(0);
  });
});

describe("origin snapshot and rollback", () => {
  it("restores per-origin last-known-good and republishes the restored state", async () => {
    const spaceId = "space-rb";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const sid = makeIdentity(spaceId, "github.com", "sid");
    const csrf = makeIdentity(spaceId, ".github.com", "csrf");
    const other = makeIdentity(spaceId, "gitlab.com", "sid");

    clock.tick(1);
    const w1 = must(
      await a.engine.localChange(sid, attrsFor("sid-v0"), false, "explicit"),
    );
    clock.tick(1);
    must(
      await a.engine.localChange(csrf, attrsFor("csrf-v0"), false, "explicit"),
    );
    clock.tick(1);
    must(
      await a.engine.localChange(
        other,
        attrsFor("gitlab-v0"),
        false,
        "explicit",
      ),
    );

    const snapshot = a.engine.snapshotOrigin(w1.originId);
    expect(snapshot.records).toHaveLength(2);

    clock.tick(1);
    must(
      await a.engine.localChange(sid, attrsFor("sid-v1"), false, "overwrite"),
    );
    clock.tick(1);
    must(await a.engine.localChange(csrf, null, true, "explicit"));
    clock.tick(1);
    must(
      await a.engine.localChange(
        makeIdentity(spaceId, "github.com", "extra"),
        attrsFor("extra-v0"),
        false,
        "explicit",
      ),
    );

    // The snapshot is an immutable copy of the state at capture time.
    const snapSid = snapshot.records.find((r) => r.recordId === w1.recordId);
    expect(snapSid?.plain.attributes?.value).toBe("sid-v0");

    clock.tick(1);
    const republished = await a.engine.rollbackOrigin(w1.originId, snapshot);
    expect(republished).toHaveLength(3); // delete "extra" + restore sid + restore csrf

    const values = new Set(
      a.engine
        .listLiveCookies()
        .map(
          (p) =>
            `${p.identity.hostKey}:${p.identity.name}=${p.attributes?.value}`,
        ),
    );
    expect(values).toEqual(
      new Set([
        "github.com:sid=sid-v0",
        ".github.com:csrf=csrf-v0",
        "gitlab.com:sid=gitlab-v0",
      ]),
    );

    // Replaying A's full publish stream converges another device to the same state.
    await b.engine.applyRemote(a.transport.published);
    expect(livePrint(b.engine)).toBe(livePrint(a.engine));
  });
});

describe("hasRecord (pre-existing cookie seeding)", () => {
  it("is false for unknown identities, true after a local write or a remote apply", async () => {
    const spaceId = "space-seed-1";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    const b = await createEngine(spaceId, "dev-b", clock);
    const identity = makeIdentity(spaceId, "x.com", "auth_token");

    // Nothing seen yet.
    expect(await a.engine.hasRecord(identity)).toBe(false);

    // A local write registers a record…
    clock.tick(1);
    const wire = must(
      await a.engine.localChange(identity, attrsFor("v1"), false, "explicit"),
    );
    expect(await a.engine.hasRecord(identity)).toBe(true);

    // …and so does receiving it on a peer — which is what makes seeding on the
    // linked device skip cookies it already got, never clobbering them.
    expect(await b.engine.hasRecord(identity)).toBe(false);
    expect(await b.engine.applyRemote([wire])).toEqual(["applied"]);
    expect(await b.engine.hasRecord(identity)).toBe(true);
  });

  it("gates seeding by policy: a non-synced origin never publishes", async () => {
    const spaceId = "space-seed-2";
    const clock = new ManualClock();
    const a = await createEngine(spaceId, "dev-a", clock);
    // netflix.com is device_bound / syncTier 0 in the seed corpus.
    const bound = makeIdentity(spaceId, "netflix.com", "NetflixId");
    clock.tick(1);
    expect(
      await a.engine.localChange(bound, attrsFor("v1"), false, "explicit"),
    ).toBeNull();
    expect(a.transport.published).toHaveLength(0);
  });
});
