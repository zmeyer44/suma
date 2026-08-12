import { describe, expect, it } from "vitest";
import { ORIGIN_LEASE_TTL_MS } from "@suma/config";
import { MAX_LEASE_TTL_MS } from "../src/hub-core.js";
import {
  FakeConnection,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

const originId = hex64(0xcafe);

describe("origin leases", () => {
  it("grants a free lease, denies another device, grants again after expiry", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    const granted = a.ofType("lease.granted")[0];
    expect(granted?.holderDeviceId).toBe("dev-a");
    expect(granted?.expiresAtMs).toBe(clock.nowMs + ORIGIN_LEASE_TTL_MS);

    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    const denied = b.ofType("lease.denied")[0];
    expect(denied?.holderDeviceId).toBe("dev-a");
    expect(b.ofType("lease.granted")).toHaveLength(0);

    clock.nowMs += ORIGIN_LEASE_TTL_MS + 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
  });

  it("renews for the current holder and caps requested ttl at 5x default", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    await core.handleMessage(
      a,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        ttlMs: ORIGIN_LEASE_TTL_MS * 100,
      }),
      [],
    );
    expect(a.ofType("lease.granted")[0]?.expiresAtMs).toBe(
      clock.nowMs + MAX_LEASE_TTL_MS,
    );

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [],
    );
    expect(a.ofType("lease.granted")[1]?.holderDeviceId).toBe("dev-a");
  });

  it("force takeover transfers the lease and notifies the previous holder", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    await core.handleMessage(
      b,
      frame({
        t: "lease.acquire",
        spaceId: "s1",
        originId,
        force: true,
        recordId: "candidate-record",
        candidateHlc: { physicalMs: 2, logical: 0, deviceId: "dev-b" },
      }),
      [a],
    );
    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    const revoked = a.ofType("lease.revoked")[0];
    expect(revoked?.newHolderDeviceId).toBe("dev-b");
    expect(revoked?.originId).toBe(originId);
  });

  it("blocks publishes from non-holders while the lease is live, unblocks after release", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );

    const foreign = makeRecord({
      spaceId: "s1",
      originId,
      hlc: makeHlc(10, "dev-b"),
    });
    await core.handleMessage(b, frame({ t: "publish", records: [foreign] }), [
      a,
    ]);
    expect(b.ofType("publish.ack")[0]?.rejected).toEqual([
      { recordId: foreign.recordId, reason: "lease_required" },
    ]);

    // The holder itself can still publish.
    const own = makeRecord({
      spaceId: "s1",
      originId,
      hlc: makeHlc(11, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "publish", records: [own] }), [b]);
    expect(a.ofType("publish.ack")[0]?.accepted).toEqual([own.recordId]);

    await core.handleMessage(
      a,
      frame({ t: "lease.release", spaceId: "s1", originId }),
      [b],
    );
    const retry = { ...foreign, hlc: makeHlc(12, "dev-b") };
    await core.handleMessage(b, frame({ t: "publish", records: [retry] }), [a]);
    expect(b.ofType("publish.ack")[1]?.accepted).toEqual([retry.recordId]);
  });

  it("ignores release from a device that does not hold the lease", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );
    await core.handleMessage(
      b,
      frame({ t: "lease.release", spaceId: "s1", originId }),
      [a],
    );

    clock.nowMs += 1;
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [a],
    );
    expect(b.ofType("lease.denied")[0]?.holderDeviceId).toBe("dev-a");
  });

  it("releases a device's leases when its last socket closes", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(
      a,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [b],
    );

    await core.handleClose(a, [b]);
    await core.handleMessage(
      b,
      frame({ t: "lease.acquire", spaceId: "s1", originId }),
      [],
    );

    expect(b.ofType("lease.granted")[0]?.holderDeviceId).toBe("dev-b");
    expect(b.ofType("lease.denied")).toHaveLength(0);
  });
});
