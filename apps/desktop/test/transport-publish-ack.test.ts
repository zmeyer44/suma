import { describe, expect, it } from "vitest";
import type { CookieRecordWire } from "@suma/protocol";
import { WsTransport, type TransportEvents } from "../src/main/sync/transport";

function connectedTransport(
  sent: string[],
  events: TransportEvents = {},
): WsTransport {
  const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", events);
  Object.assign(transport, {
    state: "connected",
    socket: {
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => undefined,
      addEventListener: () => undefined,
    },
  });
  return transport;
}

function wire(recordId: string): CookieRecordWire {
  return {
    spaceId: "space-1",
    recordId,
    originId: "b".repeat(64),
    sealedRecord: "sealed",
    hlc: { physicalMs: 1, logical: 0, deviceId: "dev-a" },
    causalParent: null,
    deviceSig: "signature",
    cause: "WRITE",
  };
}

describe("WsTransport publish acknowledgements", () => {
  it("surfaces lease rejections before reporting convergence", () => {
    const events: string[] = [];
    const transport = new WsTransport("ws://127.0.0.1:1", "dev-a", {
      onPublishRejected: (rejections) =>
        events.push(`rejected:${rejections[0]?.reason}`),
      onConverged: () => events.push("converged"),
    });

    (
      transport as unknown as {
        handleFrame(raw: string): void;
      }
    ).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId: "record-1", reason: "lease_required" }],
      }),
    );

    expect(events).toEqual(["rejected:lease_required", "converged"]);
  });

  it("does not open the cookie fence until every publish is acknowledged", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const recordId = "a".repeat(64);
    transport.publish([wire(recordId)]);

    let settled = false;
    const flush = transport.flushCookiePublishes().then((confirmed) => {
      settled = true;
      return confirmed;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({ t: "publish.ack", accepted: [recordId], rejected: [] }),
    );
    await expect(flush).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("accepts a stale ack as proof the hub already has that cookie winner", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const recordId = "d".repeat(64);
    transport.publish([wire(recordId)]);
    const flush = transport.flushCookiePublishes();

    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "publish.ack",
        accepted: [],
        rejected: [{ recordId, reason: "stale" }],
      }),
    );

    await expect(flush).resolves.toBe(true);
  });

  it("coalesces concurrent same-origin lease requests", async () => {
    const sent: string[] = [];
    const transport = connectedTransport(sent);
    const first = transport.acquireLease("space-1", "google-origin");
    const second = transport.acquireLease("space-1", "google-origin");

    expect(sent.map((value) => JSON.parse(value))).toEqual([
      {
        t: "lease.acquire",
        spaceId: "space-1",
        originId: "google-origin",
      },
    ]);
    (transport as unknown as { handleFrame(raw: string): void }).handleFrame(
      JSON.stringify({
        t: "lease.granted",
        spaceId: "space-1",
        originId: "google-origin",
        holderDeviceId: "dev-a",
        expiresAtMs: Date.now() + 60_000,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("returns unacknowledged records to the engine when a socket is replaced", () => {
    const sent: string[] = [];
    const interrupted: string[] = [];
    const transport = connectedTransport(sent, {
      onPublishInterrupted: (recordIds) => interrupted.push(...recordIds),
    });
    const recordId = "c".repeat(64);
    transport.publish([wire(recordId)]);

    const internal = transport as unknown as {
      socket: unknown;
      scheduleReconnect(socket: unknown): void;
    };
    internal.scheduleReconnect(internal.socket);

    expect(interrupted).toEqual([recordId]);
    expect(transport.state).toBe("offline");
  });
});
