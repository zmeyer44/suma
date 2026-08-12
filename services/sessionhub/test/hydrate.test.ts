import { describe, expect, it } from "vitest";
import { HYDRATE_CHUNK_SIZE, MAX_RECORD_HISTORY } from "../src/hub-core.js";
import {
  FakeConnection,
  frame,
  hex64,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("hydrate", () => {
  it("streams only records newer than sinceHlc and reports the watermark", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    const old = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    const mid = makeRecord({ spaceId: "s1", hlc: makeHlc(20, "dev-a") });
    const newer = makeRecord({ spaceId: "s1", hlc: makeHlc(30, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [old, mid, newer] }), []);

    await core.handleMessage(
      b,
      frame({ t: "hydrate", spaceId: "s1", sinceHlc: makeHlc(10, "dev-a") }),
      [a],
    );
    const frames = b.ofType("records");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.records.map((r) => r.recordId)).toEqual([mid.recordId, newer.recordId]);
    const done = b.ofType("hydrate.done")[0];
    expect(done?.count).toBe(2);
    expect(done?.watermark).toEqual(newer.hlc);
  });

  it("chunks hydration into frames of at most 256 records, oldest first", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const total = HYDRATE_CHUNK_SIZE + 44;
    const records = Array.from({ length: total }, (_, i) =>
      makeRecord({ spaceId: "s1", originId: hex64(10_000 + i), hlc: makeHlc(1 + i, "dev-a") }),
    );
    for (let i = 0; i < records.length; i += 50) {
      await core.handleMessage(
        a,
        frame({ t: "publish", records: records.slice(i, i + 50) }),
        [],
      );
    }

    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(b, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [a]);

    const frames = b.ofType("records");
    expect(frames).toHaveLength(2);
    expect(frames[0]?.records).toHaveLength(HYDRATE_CHUNK_SIZE);
    expect(frames[1]?.records).toHaveLength(44);
    const streamed = frames.flatMap((f) => f.records.map((r) => r.recordId));
    expect(streamed).toEqual(records.map((r) => r.recordId));
    expect(b.ofType("hydrate.done")[0]?.count).toBe(total);
  });

  it("does not leak records across spaces", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1", "s2"]);
    const inS1 = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-a") });
    const inS2 = makeRecord({ spaceId: "s2", hlc: makeHlc(11, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [inS1, inS2] }), []);

    a.clear();
    await core.handleMessage(a, frame({ t: "hydrate", spaceId: "s2", sinceHlc: null }), []);
    expect(a.ofType("records")[0]?.records.map((r) => r.recordId)).toEqual([inS2.recordId]);
  });

  it("rollback deletes rolled-back records for that origin and is broadcast to everyone", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    const target = hex64(0xdead);
    const other = hex64(0xfeed);
    const keep = makeRecord({ spaceId: "s1", originId: target, hlc: makeHlc(10, "dev-a") });
    const dropped = makeRecord({ spaceId: "s1", originId: target, hlc: makeHlc(30, "dev-a") });
    const unrelated = makeRecord({ spaceId: "s1", originId: other, hlc: makeHlc(40, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [keep, dropped, unrelated] }), []);

    await core.handleMessage(
      a,
      frame({ t: "rollback", spaceId: "s1", originId: target, toHlc: makeHlc(20, "dev-a") }),
      [b],
    );
    // Broadcast to all sockets of the user, sender included.
    expect(a.ofType("rollback.applied")).toHaveLength(1);
    expect(b.ofType("rollback.applied")).toHaveLength(1);
    expect(b.ofType("rollback.applied")[0]?.toHlc).toEqual(makeHlc(20, "dev-a"));

    b.clear();
    await core.handleMessage(b, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [a]);
    const ids = b.ofType("records").flatMap((f) => f.records.map((r) => r.recordId));
    expect(ids).toEqual([keep.recordId, unrelated.recordId]);
    expect(b.ofType("hydrate.done")[0]?.count).toBe(2);
  });

  it("records published after a rollback hydrate again (no permanent black hole)", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const target = hex64(0xdead);
    const first = makeRecord({ spaceId: "s1", originId: target, hlc: makeHlc(30, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [first] }), []);
    await core.handleMessage(
      a,
      frame({ t: "rollback", spaceId: "s1", originId: target, toHlc: makeHlc(20, "dev-a") }),
      [],
    );

    // The same recordId, republished after the rollback, is accepted (the
    // rolled-back version was deleted, not marker-shadowed) …
    const again = { ...first, hlc: makeHlc(50, "dev-a") };
    await core.handleMessage(a, frame({ t: "publish", records: [again] }), []);
    expect(a.ofType("publish.ack")[1]?.accepted).toEqual([first.recordId]);

    // … and a fresh device hydrates it.
    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(b, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [a]);
    expect(b.ofType("records")[0]?.records).toEqual([again]);
    expect(b.ofType("hydrate.done")[0]?.count).toBe(1);
  });

  it("rollback keeps versions at or below toHlc and promotes the newest survivor", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const target = hex64(0xdead);
    const v1 = makeRecord({ spaceId: "s1", originId: target, hlc: makeHlc(10, "dev-a") });
    const v2 = { ...v1, hlc: makeHlc(30, "dev-a") };
    await core.handleMessage(a, frame({ t: "publish", records: [v1] }), []);
    await core.handleMessage(a, frame({ t: "publish", records: [v2] }), []);

    await core.handleMessage(
      a,
      frame({ t: "rollback", spaceId: "s1", originId: target, toHlc: makeHlc(20, "dev-a") }),
      [],
    );

    a.clear();
    await core.handleMessage(a, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), []);
    expect(a.ofType("records")[0]?.records).toEqual([v1]);
    expect(a.ofType("hydrate.done")[0]?.count).toBe(1);

    // The surviving version became latest again: a write newer than v1 but
    // older than the rolled-back v2 is no longer rejected as stale.
    const rewrite = { ...v1, hlc: makeHlc(15, "dev-a") };
    await core.handleMessage(a, frame({ t: "publish", records: [rewrite] }), []);
    expect(a.ofType("publish.ack")[0]?.accepted).toEqual([v1.recordId]);
  });

  it("rejects rollback for a space not declared in hello", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const c = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, c, "dev-c", ["s2"], [a]);

    const target = hex64(0xdead);
    const record = makeRecord({ spaceId: "s1", originId: target, hlc: makeHlc(30, "dev-a") });
    await core.handleMessage(a, frame({ t: "publish", records: [record] }), []);

    a.clear();
    await core.handleMessage(
      c,
      frame({ t: "rollback", spaceId: "s1", originId: target, toHlc: makeHlc(10, "dev-a") }),
      [a],
    );
    expect(c.ofType("error")[0]?.code).toBe("malformed");
    expect(c.ofType("rollback.applied")).toHaveLength(0);
    expect(a.ofType("rollback.applied")).toHaveLength(0);

    // The record was not deleted.
    await core.handleMessage(a, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [c]);
    expect(a.ofType("records")[0]?.records).toEqual([record]);
  });

  it("retains at most 8 versions per record and hydrates them HLC-ascending", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const total = MAX_RECORD_HISTORY + 2;
    const base = makeRecord({ spaceId: "s1", hlc: makeHlc(1, "dev-a") });
    for (let i = 1; i <= total; i += 1) {
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...base, hlc: makeHlc(i, "dev-a") }] }),
        [],
      );
    }

    // A fresh device receives the retained causal chain: the 8 newest
    // versions of the record, oldest first — enough to walk a re-login
    // ancestry (tombstone → rewrite → rewrite) instead of just the tip.
    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    await core.handleMessage(b, frame({ t: "hydrate", spaceId: "s1", sinceHlc: null }), [a]);
    const streamed = b.ofType("records").flatMap((f) => f.records);
    expect(streamed).toHaveLength(MAX_RECORD_HISTORY);
    expect(streamed.every((r) => r.recordId === base.recordId)).toBe(true);
    expect(streamed.map((r) => r.hlc.physicalMs)).toEqual(
      Array.from({ length: MAX_RECORD_HISTORY }, (_, i) => total - MAX_RECORD_HISTORY + 1 + i),
    );
    expect(b.ofType("hydrate.done")[0]?.count).toBe(MAX_RECORD_HISTORY);
  });

  it("hydrate applies sinceHlc per version, not per record", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);

    const base = makeRecord({ spaceId: "s1", hlc: makeHlc(1, "dev-a") });
    for (let i = 1; i <= 4; i += 1) {
      await core.handleMessage(
        a,
        frame({ t: "publish", records: [{ ...base, hlc: makeHlc(i, "dev-a") }] }),
        [],
      );
    }

    a.clear();
    await core.handleMessage(
      a,
      frame({ t: "hydrate", spaceId: "s1", sinceHlc: makeHlc(2, "dev-a") }),
      [],
    );
    const streamed = a.ofType("records").flatMap((f) => f.records);
    expect(streamed.map((r) => r.hlc.physicalMs)).toEqual([3, 4]);
    expect(a.ofType("hydrate.done")[0]?.count).toBe(2);
  });

  it("returns an empty hydration for an unknown space", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["nope"]);
    await core.handleMessage(a, frame({ t: "hydrate", spaceId: "nope", sinceHlc: null }), []);
    expect(a.ofType("records")).toHaveLength(0);
    const done = a.ofType("hydrate.done")[0];
    expect(done?.count).toBe(0);
    expect(done?.watermark).toBeNull();
  });
});
