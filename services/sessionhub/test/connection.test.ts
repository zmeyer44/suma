import { describe, expect, it } from "vitest";
import { connectionStorageKey, MAX_DECLARED_SPACES } from "../src/hub-core.js";
import {
  FakeConnection,
  frame,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("declared space persistence", () => {
  it("rejects hello with more than 64 spaces but keeps the socket usable", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const tooMany = Array.from(
      { length: MAX_DECLARED_SPACES + 1 },
      (_, i) => `space-${i}`,
    );
    await sendHello(core, a, "dev-a", tooMany);
    expect(a.ofType("error")[0]?.code).toBe("too_many_spaces");
    expect(a.ofType("hello.ack")).toHaveLength(0);
    expect(a.deviceId).toBeNull();
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toBeUndefined();

    // Socket stays open: a corrected hello binds the device and persists the
    // full set in DO storage (not the size-capped socket attachment).
    const atCap = tooMany.slice(0, MAX_DECLARED_SPACES);
    await sendHello(core, a, "dev-a", atCap);
    expect(a.ofType("hello.ack")).toHaveLength(1);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toEqual(atCap);
  });

  it("space bindings survive a simulated hibernation round-trip via storage", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const manySpaces = Array.from(
      { length: MAX_DECLARED_SPACES },
      (_, i) => `space-${i}`,
    );
    await sendHello(core, a, "dev-a", manySpaces);
    await sendHello(core, b, "dev-b", ["space-63"], [a]);

    // Hibernation wake: fresh connection objects carry only the deviceId
    // restored from the attachment; the space set must come from storage.
    const a2 = new FakeConnection();
    a2.deviceId = "dev-a";
    a2.connectionId = a.connectionId;
    const b2 = new FakeConnection();
    b2.deviceId = "dev-b";
    b2.connectionId = b.connectionId;

    const record = makeRecord({
      spaceId: "space-63",
      hlc: makeHlc(10, "dev-a"),
    });
    await core.handleMessage(a2, frame({ t: "publish", records: [record] }), [
      b2,
    ]);
    expect(a2.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
    expect(b2.ofType("records")[0]?.records).toEqual([record]);
  });

  it("close deletes the stored space set", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toEqual(["s1"]);
    await core.handleClose(a, []);
    expect(
      await storage.get(connectionStorageKey("dev-a", a.connectionId)),
    ).toBeUndefined();
  });
});
