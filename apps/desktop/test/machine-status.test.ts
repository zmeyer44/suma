import { describe, expect, it } from "vitest";
import { formatHourlyRate, hourlyRateUsd } from "@suma/protocol";
import {
  defaultReasonFor,
  isAwakeState,
  localOnlyMachineStatus,
  presentMachineStatus,
  type ControlMachineEventRow,
  type ControlMachineRow,
} from "../src/main/compute/machine-status";

const NOW = Date.parse("2026-08-05T12:00:00Z");

function machine(overrides: Partial<ControlMachineRow> = {}): ControlMachineRow {
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

function event(overrides: Partial<ControlMachineEventRow> = {}): ControlMachineEventRow {
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
    expect(explained.reason).toBe("Awake because a job is set to keep running.");

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
