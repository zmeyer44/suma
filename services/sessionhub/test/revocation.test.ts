import { describe, expect, it } from "vitest";
import { CLOSE_REVOKED, connectionStorageKey } from "../src/hub-core.js";
import worker, { type Env } from "../src/index.js";
import {
  FakeConnection,
  frame,
  makeFixture,
  makeHlc,
  makeRecord,
  sendHello,
} from "./helpers.js";

describe("HubCore.revokeDevice", () => {
  it("persists the revocation, clears device state, and returns the device's sockets", async () => {
    const { core, storage } = makeFixture();
    const a1 = new FakeConnection();
    const a2 = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a1, "dev-a", ["s1"]);
    await sendHello(core, a2, "dev-a", ["s1"], [a1]);
    await sendHello(core, b, "dev-b", ["s1"], [a1, a2]);

    const toClose = await core.revokeDevice("dev-a", [a1, a2, b]);
    expect(toClose).toHaveLength(2);
    expect(toClose[0]).toBe(a1);
    expect(toClose[1]).toBe(a2);
    expect(await storage.get("revoked:dev-a")).toBe(true);
    expect(
      await storage.get(connectionStorageKey("dev-a", a1.connectionId)),
    ).toBeUndefined();
    expect(
      await storage.get(connectionStorageKey("dev-a", a2.connectionId)),
    ).toBeUndefined();
    expect(await storage.get("presence:dev-a")).toBeUndefined();
    expect(await core.isRevoked("dev-a")).toBe(true);
  });

  it("broadcasts offline to other devices and leaves them untouched", async () => {
    const { core, storage, clock } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    b.clear();
    const toClose = await core.revokeDevice("dev-a", [a, b]);
    expect(toClose).toEqual([a]);
    expect(b.ofType("presence")[0]?.devices).toEqual([
      { deviceId: "dev-a", online: false, lastSeenMs: clock.nowMs },
    ]);
    // The unrelated device keeps its state and can still publish.
    expect(await core.isRevoked("dev-b")).toBe(false);
    expect(
      await storage.get(connectionStorageKey("dev-b", b.connectionId)),
    ).toEqual(["s1"]);
    expect(await storage.get("presence:dev-b")).toBeDefined();
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(10, "dev-b") });
    await core.handleMessage(b, frame({ t: "publish", records: [record] }), []);
    expect(b.ofType("publish.ack")[0]?.accepted).toEqual([record.recordId]);
  });

  it("refuses a revoked device's reconnect with 4003", async () => {
    const { core } = makeFixture();
    await core.revokeDevice("dev-a", []);

    // Stub mode: hello claims the revoked deviceId.
    const fresh = new FakeConnection();
    await sendHello(core, fresh, "dev-a", ["s1"]);
    expect(fresh.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
    expect(fresh.ofType("hello.ack")).toHaveLength(0);
    expect(fresh.deviceId).toBeNull();

    // Verified mode: the edge-bound deviceId wins over the hello frame's
    // claim, so a revoked device cannot masquerade as another.
    const sneaky = new FakeConnection();
    sneaky.deviceId = "dev-a";
    await core.handleMessage(
      sneaky,
      frame({ t: "hello", deviceId: "dev-x", spaceIds: [] }),
      [],
    );
    expect(sneaky.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
  });

  it("kills an already-open socket on its next frame if the close was missed", async () => {
    // A device connected before revocation; imagine the admin socket-close
    // raced or was dropped, so this exact connection stays open. Its next
    // frame must terminate it (§8.2), bounding sync to one more message.
    const { core, storage } = makeFixture();
    const live = new FakeConnection();
    await sendHello(core, live, "dev-a", ["s1"]);
    live.clear();

    // Persist revocation WITHOUT going through revokeDevice's socket-close
    // (the missed-close scenario).
    await storage.put("revoked:dev-a", true);

    await core.handleMessage(live, frame({ t: "ping" }), []);
    expect(live.closed).toEqual([{ code: CLOSE_REVOKED, reason: "revoked" }]);
    expect(live.ofType("pong")).toHaveLength(0);

    // A publish from the same socket is likewise refused, not accepted.
    const other = new FakeConnection();
    await sendHello(core, other, "dev-b", ["s1"]);
    const record = makeRecord({ spaceId: "s1", hlc: makeHlc(5, "dev-a") });
    await core.handleMessage(live, frame({ t: "publish", records: [record] }), [
      other,
    ]);
    expect(live.ofType("publish.ack")).toHaveLength(0);
    expect(other.ofType("records")).toHaveLength(0);
  });

  it("closing the revoked socket afterwards does not resurrect presence", async () => {
    const { core, storage } = makeFixture();
    const a = new FakeConnection();
    const b = new FakeConnection();
    await sendHello(core, a, "dev-a", ["s1"]);
    await sendHello(core, b, "dev-b", ["s1"], [a]);

    await core.revokeDevice("dev-a", [a, b]);
    b.clear();
    await core.handleClose(a, [b]);
    expect(b.ofType("presence")).toHaveLength(0);
    expect(await storage.get("presence:dev-a")).toBeUndefined();
  });
});

function fakeEnv(
  onFetch: (userId: string, request: Request) => Response,
  extra: Partial<Env> = {},
): Env {
  return {
    SESSION_HUB: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: (request: Request) => Promise.resolve(onFetch(id.name, request)),
      }),
    },
    ...extra,
  } as unknown as Env;
}

describe("worker /v1/admin/revoke", () => {
  const body = JSON.stringify({ userId: "alice", deviceId: "device-1" });

  it("rejects a missing or bad admin token with 401", async () => {
    const env = fakeEnv(() => new Response("should not be reached"), {
      ADMIN_TOKEN: "s3cret",
    });
    const bare = await worker.fetch(
      new Request("https://hub.test/v1/admin/revoke", { method: "POST", body }),
      env,
    );
    expect(bare.status).toBe(401);
    const wrong = await worker.fetch(
      new Request("https://hub.test/v1/admin/revoke", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body,
      }),
      env,
    );
    expect(wrong.status).toBe(401);
  });

  it("stays disabled while ADMIN_TOKEN is unset", async () => {
    const env = fakeEnv(() => new Response("should not be reached"));
    const res = await worker.fetch(
      new Request("https://hub.test/v1/admin/revoke", {
        method: "POST",
        headers: { authorization: "Bearer anything" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("routes an authorized revoke to the user's DO with the validated body", async () => {
    let seenUser: string | null = null;
    let seenRequest: Request | null = null;
    const env = fakeEnv(
      (userId, request) => {
        seenUser = userId;
        seenRequest = request;
        return new Response(JSON.stringify({ ok: true, closed: 1 }));
      },
      { ADMIN_TOKEN: "s3cret" },
    );
    const res = await worker.fetch(
      new Request("https://hub.test/v1/admin/revoke", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, closed: 1 });
    expect(seenUser).toBe("alice");
    const forwarded = seenRequest as Request | null;
    expect(forwarded).not.toBeNull();
    expect(forwarded?.method).toBe("POST");
    expect(new URL(forwarded?.url ?? "").pathname).toBe("/v1/admin/revoke");
    expect(await forwarded?.json()).toEqual({
      userId: "alice",
      deviceId: "device-1",
    });
  });

  it("rejects malformed bodies before touching the DO", async () => {
    const env = fakeEnv(() => new Response("should not be reached"), {
      ADMIN_TOKEN: "s3cret",
    });
    for (const bad of ["not json", JSON.stringify({ userId: "alice" })]) {
      const res = await worker.fetch(
        new Request("https://hub.test/v1/admin/revoke", {
          method: "POST",
          headers: { authorization: "Bearer s3cret" },
          body: bad,
        }),
        env,
      );
      expect(res.status).toBe(400);
    }
  });

  it("rejects non-POST methods", async () => {
    const env = fakeEnv(() => new Response("should not be reached"), {
      ADMIN_TOKEN: "s3cret",
    });
    const res = await worker.fetch(
      new Request("https://hub.test/v1/admin/revoke", {
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(res.status).toBe(405);
  });
});
