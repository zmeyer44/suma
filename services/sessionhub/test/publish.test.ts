import { describe, expect, it } from "vitest";
import { MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE } from "@suma/config";
import {
  FakeConnection,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("publish", () => {
  it("accepts a fresh record, acks it, and broadcasts to peers in the same space", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await sendHello(core, c, "dev-c", ["s2"], [a, b]);

    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), [b, c]);

    const acks = a.ofType("publish.ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.accepted).toEqual([record.recordId]);
    expect(acks[0]?.rejected).toEqual([]);

    const fanout = b.ofType("records");
    expect(fanout).toHaveLength(1);
    expect(fanout[0]?.spaceId).toBe("s1");
    expect(fanout[0]?.records).toEqual([record]);
    // deviceSig echoed through untouched
    expect(fanout[0]?.records[0]?.deviceSig).toBe(record.deviceSig);
    expect(c.ofType("records")).toHaveLength(0);
  });

  it("rejects stale writes (stored HLC >= incoming) without broadcasting", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    const newer = makeRecord({ spaceId: "s1", hlc: makeHlc(20, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [newer] }), [b]);
    b.clear();

    const stale = { ...newer, hlc: makeHlc(15, "dev-a") };
    await core.handleMessage(a, frame({ t: "publish", records: [stale] }), [b]);
    const ack = a.ofType("publish.ack")[1];
    expect(ack?.accepted).toEqual([]);
    expect(ack?.rejected).toEqual([{ recordId: newer.recordId, reason: "stale" }]);
    expect(b.ofType("records")).toHaveLength(0);

    const equal = { ...newer };
    await core.handleMessage(a, frame({ t: "publish", records: [equal] }), [b]);
    expect(a.ofType("publish.ack")[2]?.rejected[0]?.reason).toBe("stale");
  });

  it("rejects records for spaces not declared in hello", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const record = makeRecord({ spaceId: "s2", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);
    const ack = a.ofType("publish.ack")[0];
    expect(ack?.accepted).toEqual([]);
    expect(ack?.rejected).toEqual([{ recordId: record.recordId, reason: "malformed" }]);
  });

  it("requires hello before publish", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);
    expect(a.ofType("error")[0]?.code).toBe("hello_required");
    expect(a.ofType("publish.ack")).toHaveLength(0);
  });

  it("keeps the socket open on malformed frames and answers with an error frame", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await core.handleMessage(a, "not json", []);
    await core.handleMessage(a, JSON.stringify({ t: "publish", records: [] }), []);
    const errors = a.ofType("error");
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "malformed")).toBe(true);
  });

  it("rate limits per (device, origin) past the per-minute cap, then recovers", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const originId = hex64(0xbeef);
    const cap = MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE;
    const batch = Array.from({ length: cap }, (_, i) =>
      makeRecord({ spaceId: "s1", originId, hlc: makeHlc(100 + i, "dev-a") }),
    );
    await core.handleMessage(a, frame({ t: "publish", records: batch }), []);
    expect(a.ofType("publish.ack")[0]?.accepted).toHaveLength(cap);
    expect(a.ofType("error")).toHaveLength(0);

    const over = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(1000, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [over] }), []);
    expect(a.ofType("publish.ack")[1]?.rejected).toEqual([
      { recordId: over.recordId, reason: "stale" },
    ]);
    expect(a.ofType("error")[0]?.code).toBe("rate_limited");

    // A different origin from the same device is unaffected.
    const otherOrigin = makeRecord({
      spaceId: "s1",
      originId: hex64(0xf00d),
      hlc: makeHlc(1001, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "publish", records: [otherOrigin] }), []);
    expect(a.ofType("publish.ack")[2]?.accepted).toEqual([otherOrigin.recordId]);

    // Window slides: a minute later the origin accepts again.
    clock.nowMs += 61_000;
    const later = makeRecord({ spaceId: "s1", originId, hlc: makeHlc(2000, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [later] }), []);
    expect(a.ofType("publish.ack")[3]?.accepted).toEqual([later.recordId]);
  });

  it("answers ping with pong", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await core.handleMessage(a, frame({ t: "ping" }), []);
    expect(a.last()).toEqual({ t: "pong" });
  });
});
