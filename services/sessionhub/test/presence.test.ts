import { describe, expect, it } from "vitest";
import { connectionStorageKey } from "../src/hub-core.js";
import {
  FakeConnection,
  frame,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("presence", () => {
  it("hello.ack carries all known devices with online flags", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    const ackA = a.ofType("hello.ack")[0];
    expect(ackA?.serverTimeMs).toBe(clock.nowMs);
    expect(ackA?.presence).toEqual([
      { deviceId: "dev-a", online: true, lastSeenMs: clock.nowMs },
    ]);

    clock.nowMs += 500;
    const b = new FakeConnection();
    await sendHello(core, b, "dev-b", ["s1"], [a]);
    const ackB = b.ofType("hello.ack")[0];
    expect(ackB?.presence).toHaveLength(2);
    expect(ackB?.presence).toContainEqual({
      deviceId: "dev-a",
      online: true,
      lastSeenMs: clock.nowMs - 500,
    });
    expect(ackB?.presence).toContainEqual({
      deviceId: "dev-b",
      online: true,
      lastSeenMs: clock.nowMs,
    });

    // The already-connected device saw dev-b come online.
    expect(a.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-b", online: true, lastSeenMs: clock.nowMs },
    ]);
  });

  it("close updates lastSeen and broadcasts offline to remaining sockets", async () => {
    const { core, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    clock.nowMs += 1_000;
    a.clear();
    await core.handleClose(b, [a]);
    expect(a.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-b", online: false, lastSeenMs: clock.nowMs },
    ]);

    // A later hello.ack reports dev-b offline with the close-time lastSeen.
    clock.nowMs += 1_000;
    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", [], [a]);
    expect(c.ofType("hello.ack")[0]?.presence).toContainEqual({
      deviceId: "dev-b",
      online: false,
      lastSeenMs: clock.nowMs - 1_000,
    });
  });

  it("closing a stale duplicate socket keeps the device online", async () => {
    const { core, storage, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    // dev-a reconnects on a new socket before the old one closes.
    const a2 = new FakeConnection();
    await sendHello(core, a2, "dev-a", ["s1"], [a, b]);

    a2.clear();
    b.clear();
    await core.handleClose(a, [a2, b]);
    // No offline broadcast while another dev-a socket is open, and the live
    // connection's stored space set is untouched.
    expect(b.ofType("presence")).toHaveLength(0);
    expect(a2.ofType("presence")).toHaveLength(0);
    expect(
      await storage.get(connectionStorageKey("dev-a", a2.connectionId)),
    ).toEqual(["s1"]);

    // Closing the last dev-a socket broadcasts offline as usual.
    await core.handleClose(a2, [b]);
    expect(b.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-a", online: false, lastSeenMs: clock.nowMs },
    ]);
    expect(
      await storage.get(connectionStorageKey("dev-a", a2.connectionId)),
    ).toBeUndefined();
  });

  it("a stale close cannot erase a replacement that missed the close peer snapshot", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    // The replacement hello wins storage, but the old close event was queued
    // with an earlier peer snapshot that contains only dev-b. A device-wide
    // conn key lets this stale close delete the replacement's declaration.
    const replacement = new FakeConnection();
    await sendHello(core, replacement, "dev-a", ["s1"], [b]);
    b.clear();
    await core.handleClose(a, [b]);

    expect(b.ofType("presence")).toHaveLength(0);
    expect(
      await storage.get(
        connectionStorageKey("dev-a", replacement.connectionId),
      ),
    ).toEqual(["s1"]);

    const record = makeRecord({
      spaceId: "s1",
      hlc: makeHlc(10, "dev-a"),
    });
    await core.handleMessage(
      replacement,
      frame({ t: "publish", records: [record] }),
      [b],
    );
    expect(replacement.ofType("publish.ack")[0]?.accepted).toEqual([
      record.recordId,
    ]);
    expect(b.ofType("records")[0]?.records).toEqual([record]);
  });

  it("closing a socket that never sent hello is a no-op", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const anon = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await core.handleClose(anon, [a]);
    expect(a.ofType("presence")).toHaveLength(0);
  });
});
