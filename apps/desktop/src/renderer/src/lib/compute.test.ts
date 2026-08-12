import { describe, expect, it } from "vitest";
import { formatHourlyRate } from "@suma/protocol";
import type { MachineStatus } from "../../../shared/ipc";
import {
  accruedCostLabel,
  jobModeLabel,
  machinePillText,
  machineTone,
  RECONSTRUCTED_BANNER,
} from "./compute";

function status(overrides: Partial<MachineStatus> = {}): MachineStatus {
  return {
    machineId: "m1",
    state: "running",
    spec: { cpus: 2, memoryMb: 2048 },
    reason: "Awake because this Mac is connected.",
    hourlyRate: formatHourlyRate(2048, 2),
    accruedUsd: 0.0123,
    reconstructed: false,
    ...overrides,
  };
}

describe("RECONSTRUCTED_BANNER", () => {
  it("uses the exact §8.5/§10 wording", () => {
    expect(RECONSTRUCTED_BANNER).toBe(
      "This shell was restored from a cold start — your scrollback and working directory are back, but the process that was running is gone.",
    );
  });
});

describe("jobModeLabel (§8.5 cost meter)", () => {
  it("shows the shared hourly-rate string", () => {
    expect(jobModeLabel(status())).toBe(`Keep running — ${formatHourlyRate(2048, 2)}`);
    expect(jobModeLabel(status())).toMatch(/^Keep running — ~\$\d+\.\d{2}\/hr while awake$/);
  });

  it("never shows a rate for a machine that does not exist", () => {
    expect(jobModeLabel(null)).toBe("Keep running");
    expect(jobModeLabel(status({ machineId: null, hourlyRate: "" }))).toBe("Keep running");
  });
});

describe("machinePillText", () => {
  it("labels the states the pill shows", () => {
    expect(machinePillText(status())).toBe("VM · running");
    expect(machinePillText(status({ state: "resuming" }))).toBe("VM · waking");
    expect(machinePillText(status({ machineId: null }))).toBe("VM · not provisioned");
    expect(machinePillText(null)).toBe("VM · …");
  });
});

describe("accruedCostLabel", () => {
  it("formats accrued cost and hides it when there is nothing to show", () => {
    expect(accruedCostLabel(status())).toBe("$0.0123 this awake stretch");
    expect(accruedCostLabel(status({ accruedUsd: 0 }))).toBe("");
    expect(accruedCostLabel(status({ machineId: null }))).toBe("");
    expect(accruedCostLabel(null)).toBe("");
  });
});

describe("machineTone", () => {
  it("maps states to pill tones", () => {
    expect(machineTone(status())).toBe("ok");
    expect(machineTone(status({ state: "error" }))).toBe("danger");
    expect(machineTone(status({ state: "suspended" }))).toBe("faint");
    expect(machineTone(status({ state: "resuming" }))).toBe("warn");
    expect(machineTone(null)).toBe("faint");
  });
});
