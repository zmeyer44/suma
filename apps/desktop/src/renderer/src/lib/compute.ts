/**
 * Pure display helpers for the compute surfaces (PRD §8.5): machine pill
 * labels, the Job Mode cost-meter line, and the reconstructed-shell notice.
 * No DOM access — unit-tested in vitest's node environment.
 */

import type { MachineState } from "@suma/protocol";
import type { MachineStatus } from "../../../shared/ipc";

/** §8.5/§10 wording, shown when a PTY attach reports "reconstructed". */
export const RECONSTRUCTED_BANNER =
  "This shell was restored from a cold start — your scrollback and working directory are back, but the process that was running is gone.";

const STATE_LABEL: Record<MachineState, string> = {
  provisioning: "provisioning",
  running: "running",
  suspending: "suspending",
  suspended: "suspended",
  resuming: "waking",
  cold_booting: "cold boot",
  boosting: "boosting",
  boosted: "boosted",
  shrinking: "shrinking",
  error: "error",
};

export function machinePillText(status: MachineStatus | null): string {
  if (status === null) return "VM · …";
  if (status.machineId === null) return "VM · not provisioned";
  return `VM · ${STATE_LABEL[status.state]}`;
}

/** Job Mode toggle label with the visible cost meter (§8.5). */
export function jobModeLabel(status: MachineStatus | null): string {
  if (status === null || status.hourlyRate.length === 0) return "Keep running";
  return `Keep running — ${status.hourlyRate}`;
}

/** Accrued-cost line for the current awake stretch; empty when nothing accrued. */
export function accruedCostLabel(status: MachineStatus | null): string {
  if (status === null || status.machineId === null || status.accruedUsd <= 0) return "";
  return `$${status.accruedUsd.toFixed(4)} this awake stretch`;
}

export type MachineTone = "ok" | "warn" | "danger" | "faint";

export function machineTone(status: MachineStatus | null): MachineTone {
  if (status === null || status.machineId === null) return "faint";
  switch (status.state) {
    case "running":
    case "boosted":
      return "ok";
    case "error":
      return "danger";
    case "suspended":
      return "faint";
    default:
      return "warn";
  }
}
