/**
 * Pure MachineStatus presentation (PRD §8.5): control-plane machine rows +
 * lifecycle explanation + latest event → the status the pill and terminal
 * panel show. Cost figures come from @suma/protocol's lifecycle module —
 * the shared source of truth — never recomputed here.
 */

import {
  accruedCostUsd,
  DEFAULT_MACHINE_SPEC,
  formatHourlyRate,
  MACHINE_STATES,
  type MachineState,
} from "@suma/protocol";
import type { MachineStatus } from "../../shared/ipc";

/** Machine row as the control plane serializes it (Dates become ISO strings). */
export interface ControlMachineRow {
  id: string;
  state: string;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
  region: string;
  lastTransitionAt: string | null;
}

export interface ControlMachineEventRow {
  id: string;
  machineId: string;
  fromState: string;
  toState: string;
  reconstructed: boolean;
  detail: string | null;
  createdAt: string;
}

/** States in which the machine is billing ("awake"). */
const AWAKE_STATES: ReadonlySet<MachineState> = new Set([
  "running",
  "boosting",
  "boosted",
  "shrinking",
]);

export function isAwakeState(state: MachineState): boolean {
  return AWAKE_STATES.has(state);
}

/** Honest per-state fallback when the Phase-2 lifecycle route is absent. */
export function defaultReasonFor(state: MachineState): string {
  switch (state) {
    case "provisioning":
      return "Setting up your machine.";
    case "running":
      return "Awake.";
    case "suspending":
      return "Suspending — stopping billing.";
    case "suspended":
      return "Suspended — not billing.";
    case "resuming":
      return "Waking…";
    case "cold_booting":
      return "Cold booting — restoring your context. Running processes were lost.";
    case "boosting":
      return "Boosting to a larger machine.";
    case "boosted":
      return "Boosted — larger machine while you need it.";
    case "shrinking":
      return "Returning to the default machine size.";
    case "error":
      return "Machine error — the control plane has details.";
  }
}

/**
 * The IPC contract has no "absent machine" state, so local-only mode reports
 * machineId: null (the signal the UI keys off) with a plainly-worded reason —
 * never a fake lifecycle. No rate is shown for a machine that does not exist.
 */
export function localOnlyMachineStatus(): MachineStatus {
  return {
    machineId: null,
    state: "suspended",
    spec: {
      cpus: DEFAULT_MACHINE_SPEC.cpus,
      memoryMb: DEFAULT_MACHINE_SPEC.memoryMb,
    },
    reason:
      "No cloud machine — Suma is running local-only without a control plane.",
    hourlyRate: "",
    accruedUsd: 0,
    reconstructed: false,
  };
}

/** Local compute mode: this Mac IS the computer — by choice, not absence. */
export function localHomeMachineStatus(): MachineStatus {
  return {
    machineId: null,
    state: "running",
    spec: { cpus: 0, memoryMb: 0 },
    reason: "This Mac is your computer — your files live in its Suma folder.",
    hourlyRate: "",
    accruedUsd: 0,
    reconstructed: false,
  };
}

/** Local compute belongs to another enrolled Mac; no relay exists yet. */
/** Local compute mode, seen from a device that is NOT the home Mac. The
 *  relay makes the home Mac reachable — `homeOnline` says whether it is. */
export function localAwayMachineStatus(homeOnline: boolean): MachineStatus {
  return {
    machineId: null,
    state: homeOnline ? "running" : "suspended",
    spec: { cpus: 0, memoryMb: 0 },
    reason: homeOnline
      ? "Connected to your computer — another Mac. Your files and shells live there."
      : "Your computer is offline. Suma will reconnect when it's back online.",
    hourlyRate: "",
    accruedUsd: 0,
    reconstructed: false,
  };
}

export interface PresentMachineArgs {
  machine: ControlMachineRow;
  /** Newest machine event, if any — carries the reconstructed flag (§8.5). */
  latestEvent: ControlMachineEventRow | null;
  /** Explanation from GET /v1/machine/lifecycle; null when the route is absent. */
  lifecycleExplanation: string | null;
  nowMs: number;
}

export function presentMachineStatus(args: PresentMachineArgs): MachineStatus {
  const { machine, latestEvent, lifecycleExplanation, nowMs } = args;
  const state: MachineState = (MACHINE_STATES as readonly string[]).includes(
    machine.state,
  )
    ? (machine.state as MachineState)
    : "error";
  // Cost of the current awake stretch (since the last transition into an
  // awake state). The billing aggregate across stretches lives on the control
  // plane (§11) — this meter is the live "why is it costing money right now".
  const transitionMs =
    machine.lastTransitionAt === null
      ? Number.NaN
      : Date.parse(machine.lastTransitionAt);
  const awakeMs =
    isAwakeState(state) && Number.isFinite(transitionMs)
      ? Math.max(0, nowMs - transitionMs)
      : 0;
  return {
    machineId: machine.id,
    state,
    spec: { cpus: machine.cpus, memoryMb: machine.memoryMb },
    reason: lifecycleExplanation ?? defaultReasonFor(state),
    hourlyRate: formatHourlyRate(machine.memoryMb, machine.cpus),
    accruedUsd: accruedCostUsd(machine.memoryMb, machine.cpus, awakeMs),
    reconstructed: latestEvent?.reconstructed === true,
  };
}
