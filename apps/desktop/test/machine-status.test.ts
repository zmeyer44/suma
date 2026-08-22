import { describe, expect, it } from "vitest";
import { formatHourlyRate, hourlyRateUsd } from "@suma/protocol";
import { MachineService } from "../src/main/compute/machine-service";
import {
  defaultReasonFor,
  isAwakeState,
  localAwayMachineStatus,
  localHomeMachineStatus,
  localOnlyMachineStatus,
  presentMachineStatus,
  type ControlMachineEventRow,
  type ControlMachineRow,
} from "../src/main/compute/machine-status";
import type { ControlClient } from "../src/main/control-client";

const NOW = Date.parse("2026-08-05T12:00:00Z");

function machine(
  overrides: Partial<ControlMachineRow> = {},
): ControlMachineRow {
  return {
    id: "m1",
    state: "running",
    cpuKind: "shared",
    cpus: 2,
    memoryMb: 2048,
    region: "iad",
    lastTransitionAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...overrides,
  };
}

function event(
  overrides: Partial<ControlMachineEventRow> = {},
): ControlMachineEventRow {
  return {
    id: "e1",
    machineId: "m1",
    fromState: "suspended",
    toState: "running",
    reconstructed: false,
    detail: null,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("presentMachineStatus", () => {
  it("formats the §8.5 cost meter via the shared lifecycle module", () => {
    const status = presentMachineStatus({
      machine: machine(),
      latestEvent: event(),
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(status.hourlyRate).toBe(formatHourlyRate(2048, 2));
    expect(status.hourlyRate).toMatch(/^~\$\d+\.\d{2}\/hr while awake$/);
  });

  it("accrues cost only for the current awake stretch", () => {
    const halfHour = presentMachineStatus({
      machine: machine(),
      latestEvent: null,
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(halfHour.accruedUsd).toBeCloseTo(hourlyRateUsd(2048, 2) / 2, 3);

    const suspended = presentMachineStatus({
      machine: machine({ state: "suspended" }),
      latestEvent: null,
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(suspended.accruedUsd).toBe(0);
  });

  it("prefers the lifecycle explanation, falling back per state", () => {
    const explained = presentMachineStatus({
      machine: machine(),
      latestEvent: null,
      lifecycleExplanation: "Awake because a job is set to keep running.",
      nowMs: NOW,
    });
    expect(explained.reason).toBe(
      "Awake because a job is set to keep running.",
    );

    const fallback = presentMachineStatus({
      machine: machine({ state: "suspended" }),
      latestEvent: null,
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(fallback.reason).toBe(defaultReasonFor("suspended"));
  });

  it("surfaces reconstructed from the latest machine event (§8.5)", () => {
    const cold = presentMachineStatus({
      machine: machine(),
      latestEvent: event({ fromState: "cold_booting", reconstructed: true }),
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(cold.reconstructed).toBe(true);

    const warm = presentMachineStatus({
      machine: machine(),
      latestEvent: event(),
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(warm.reconstructed).toBe(false);
  });

  it("maps an unknown state to error rather than lying", () => {
    const status = presentMachineStatus({
      machine: machine({ state: "warp-drive" }),
      latestEvent: null,
      lifecycleExplanation: null,
      nowMs: NOW,
    });
    expect(status.state).toBe("error");
  });
});

describe("localOnlyMachineStatus", () => {
  it("reports not-provisioned honestly: null id, no rate, no accrual", () => {
    const status = localOnlyMachineStatus();
    expect(status.machineId).toBeNull();
    expect(status.hourlyRate).toBe("");
    expect(status.accruedUsd).toBe(0);
    expect(status.reason).toContain("local-only");
  });
});

describe("isAwakeState", () => {
  it("bills only in awake states", () => {
    expect(isAwakeState("running")).toBe(true);
    expect(isAwakeState("boosted")).toBe(true);
    expect(isAwakeState("suspended")).toBe(false);
    expect(isAwakeState("resuming")).toBe(false);
  });
});

describe("MachineService in local compute mode", () => {
  function localModeClient(homeDeviceId: string | null = null): {
    client: ControlClient;
    calls: string[];
  } {
    const calls: string[] = [];
    const client = {
      getMachine: async () => {
        calls.push("getMachine");
        return {
          mode: "local" as const,
          machine: null,
          events: [],
          homeDeviceId,
        };
      },
      getMachineLifecycle: async () => {
        calls.push("getMachineLifecycle");
        return null;
      },
      transitionMachine: async () => {
        calls.push("transitionMachine");
        throw new Error("must never be called in local mode");
      },
    } as unknown as ControlClient;
    return { client, calls };
  }

  it("reports this-Mac status, never retargets the link, plane ok", async () => {
    const { client } = localModeClient();
    const addresses: string[] = [];
    const service = new MachineService({
      control: () => client,
      emit: () => undefined,
      onAgentAddress: (address) => addresses.push(address),
    });
    const status = await service.refresh();
    expect(status).toEqual(localHomeMachineStatus());
    expect(status.machineId).toBeNull();
    expect(status.state).toBe("running");
    expect(status.reason).toContain("This Mac is your computer");
    expect(addresses).toEqual([]);
    expect(service.planeState()).toBe("ok");
  });

  it("gates local compute when another enrolled Mac owns the seat", async () => {
    const { client } = localModeClient("home-device");
    const roles: string[] = [];
    const service = new MachineService({
      control: () => client,
      emit: () => undefined,
      controlDeviceId: () => "linked-device",
      onLocalComputerRole: (role) => roles.push(role),
    });

    // No homeOnline in the stub's answer ⇒ offline copy.
    expect(await service.refresh()).toEqual(localAwayMachineStatus(false));
    expect(service.status().reason).toContain("offline");
    expect(roles).toEqual(["away"]);
  });

  it("shows the connected-away status when the relay reports home online", async () => {
    const calls: string[] = [];
    const client = {
      getMachine: async () => ({
        mode: "local" as const,
        machine: null,
        events: [],
        homeDeviceId: "home-device",
        homeOnline: true,
      }),
      getMachineLifecycle: async () => null,
      transitionMachine: async () => {
        calls.push("transitionMachine");
        throw new Error("never");
      },
    } as unknown as ControlClient;
    const online: boolean[] = [];
    const service = new MachineService({
      control: () => client,
      emit: () => undefined,
      controlDeviceId: () => "linked-device",
      onHomeOnline: (up) => online.push(up),
    });
    const status = await service.refresh();
    expect(status).toEqual(localAwayMachineStatus(true));
    expect(status.state).toBe("running");
    expect(status.reason).toContain("Connected to your computer");
    expect(online).toEqual([true]);
    expect(calls).toEqual([]);
  });

  it("uses confirmed local ownership while the control plane is offline", async () => {
    const roles: string[] = [];
    const service = new MachineService({
      control: () => null,
      emit: () => undefined,
      knownLocalComputerRole: () => "home",
      onLocalComputerRole: (role) => roles.push(role),
    });

    expect(await service.refresh()).toEqual(localHomeMachineStatus());
    expect(roles).toEqual(["home"]);
  });

  it("refuses wake/suspend with a friendly error instead of a control call", async () => {
    const { client, calls } = localModeClient();
    const service = new MachineService({
      control: () => client,
      emit: () => undefined,
    });
    await service.refresh();
    await expect(service.suspend()).rejects.toThrow(
      /this Mac is your computer/,
    );
    expect(calls.filter((c) => c === "transitionMachine")).toEqual([]);
  });
});

describe("MachineService cloud agent authentication", () => {
  it("mints and reuses a signed capability token before retargeting the mux", async () => {
    let mints = 0;
    const client = {
      getMachine: async () => ({
        mode: "cloud" as const,
        machine: { ...machine(), agentAddress: "vm.internal:2222" },
        events: [],
      }),
      getMachineLifecycle: async () => null,
      mintMachineCapabilityToken: async () => {
        mints += 1;
        return {
          token: "signed-capability-token",
          exp: Math.floor(Date.now() / 1_000) + 300,
          caps: [],
        };
      },
    } as unknown as ControlClient;
    const targets: Array<{ address: string; token: string }> = [];
    const service = new MachineService({
      control: () => client,
      emit: () => undefined,
      onAgentAddress: (address, token) => targets.push({ address, token }),
    });

    await service.refresh();
    await service.refresh();

    expect(mints).toBe(1);
    expect(targets).toEqual([
      { address: "vm.internal:2222", token: "signed-capability-token" },
      { address: "vm.internal:2222", token: "signed-capability-token" },
    ]);
  });
});
