import { describe, expect, it } from "vitest";
import {
  FakeConnection,
  frame,
  makeFixture,
  makeHlc,
  makeWorkspaceDoc,
  sendHello,
} from "./helpers.js";

describe("workspace sync", () => {
  it("applies LWW per key: newer wins, older loses, only winners broadcast", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", []);
    await sendHello(core, b, "dev-b", [], [a]);

    const v1 = makeWorkspaceDoc({ key: "space:1", hlc: makeHlc(20, "dev-a") });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [v1] }), [b]);
    expect(b.ofType("workspace.records")[0]?.docs).toEqual([v1]);

    // Older write for the same key loses — no broadcast at all.
    b.clear();
    const stale = makeWorkspaceDoc({
      key: "space:1",
      sealedValue: "b2xk",
      hlc: makeHlc(10, "dev-b"),
    });
    await core.handleMessage(b, frame({ t: "workspace.publish", docs: [stale] }), [a]);
    expect(a.ofType("workspace.records")).toHaveLength(0);

    // Newer write wins and is broadcast; a mixed batch broadcasts winners only.
    const v2 = makeWorkspaceDoc({
      key: "space:1",
      sealedValue: "bmV3",
      hlc: makeHlc(30, "dev-b"),
    });
    const loser = makeWorkspaceDoc({
      key: "space:1",
      hlc: makeHlc(25, "dev-b"),
    });
    const fresh = makeWorkspaceDoc({ key: "pin:9", hlc: makeHlc(5, "dev-b") });
    await core.handleMessage(
      b,
      frame({ t: "workspace.publish", docs: [v2, loser, fresh] }),
      [a],
    );
    expect(a.ofType("workspace.records")[0]?.docs).toEqual([v2, fresh]);

    // Hydration returns the winning versions.
    const c = new FakeConnection();
    await sendHello(core, c, "dev-c", [], [a, b]);
    await core.handleMessage(c, frame({ t: "workspace.hydrate", sinceHlc: null }), [a, b]);
    const docs = c.ofType("workspace.records").flatMap((f) => f.docs);
    expect(docs).toEqual([makeWorkspaceDoc({ key: "pin:9", hlc: makeHlc(5, "dev-b") }), v2]);
    expect(c.ofType("workspace.hydrate.done")[0]?.count).toBe(2);
  });

  it("workspace.hydrate honors sinceHlc and tombstoned (null) values survive", async () => {
    const { core } = makeFixture();
    const a = new FakeConnection();
    await sendHello(core, a, "dev-a", []);

    const kept = makeWorkspaceDoc({ key: "archive:1", hlc: makeHlc(10, "dev-a") });
    const deleted = makeWorkspaceDoc({
      key: "space:2",
      sealedValue: null,
      hlc: makeHlc(20, "dev-a"),
    });
    await core.handleMessage(a, frame({ t: "workspace.publish", docs: [kept, deleted] }), []);

    a.clear();
    await core.handleMessage(
      a,
      frame({ t: "workspace.hydrate", sinceHlc: makeHlc(10, "dev-a") }),
      [],
    );
    const docs = a.ofType("workspace.records").flatMap((f) => f.docs);
    expect(docs).toEqual([deleted]);
    expect(docs[0]?.sealedValue).toBeNull();
    expect(a.ofType("workspace.hydrate.done")[0]?.count).toBe(1);
  });
});
