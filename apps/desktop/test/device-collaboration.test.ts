import { describe, expect, it } from "vitest";
import type { SyncedDeviceActivity } from "@suma/protocol";
import { mergeConnectedDevices } from "../src/main/device-collaboration";

const activity = (deviceId: string, name: string): SyncedDeviceActivity => ({
  deviceId,
  identityDeviceId: deviceId,
  controlDeviceId: null,
  name,
  platform: "darwin",
  updatedAtMs: 200,
});

describe("mergeConnectedDevices", () => {
  it("joins friendly control names to realtime presence", () => {
    const devices = mergeConnectedDevices({
      registry: [
        {
          id: "control-a",
          name: "Office MacBook Pro",
          platform: "darwin",
          revokedAt: null,
          enrolledAt: "2026-08-08T12:00:00Z",
          lastSeenAt: null,
        },
      ],
      presence: [{ deviceId: "control-a", online: true, lastSeenMs: 300 }],
      activities: [activity("control-a", "Old activity name")],
      localDeviceId: "local-a",
      localControlDeviceId: "control-a",
      localName: "Local fallback",
      localPlatform: "darwin",
      controlAvailable: true,
    });
    expect(devices).toMatchObject([
      {
        deviceId: "control-a",
        name: "Office MacBook Pro",
        platform: "macOS",
        online: true,
        isThisDevice: true,
      },
    ]);
  });

  it("uses encrypted activity names when the control plane is unavailable", () => {
    const devices = mergeConnectedDevices({
      registry: [],
      presence: [{ deviceId: "peer", online: true, lastSeenMs: 300 }],
      activities: [activity("peer", "Studio Mac mini")],
      localDeviceId: "self",
      localControlDeviceId: null,
      localName: "This Mac",
      localPlatform: "darwin",
      controlAvailable: false,
    });
    expect(devices.find((device) => device.deviceId === "peer")).toMatchObject({
      name: "Studio Mac mini",
      online: true,
      canRename: false,
    });
  });

  it("moves revoked devices to the end and never shows them online", () => {
    const devices = mergeConnectedDevices({
      registry: [
        {
          id: "revoked",
          name: "Old Mac",
          platform: "darwin",
          revokedAt: "2026-08-08",
        },
      ],
      presence: [{ deviceId: "revoked", online: true, lastSeenMs: 300 }],
      activities: [],
      localDeviceId: "self",
      localControlDeviceId: null,
      localName: "Current Mac",
      localPlatform: "darwin",
      controlAvailable: false,
    });
    expect(devices.at(-1)).toMatchObject({
      name: "Old Mac",
      revoked: true,
      online: false,
    });
  });
});
