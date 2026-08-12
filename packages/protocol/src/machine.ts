/**
 * Compute-plane machine lifecycle (PRD Appendix D, §8.5).
 *
 *   provisioning → running → suspending → suspended → resuming | cold_booting → running
 *   plus boosting → boosted (stop/start) → shrinking
 *
 * All transitions emit client-visible events; `cold_booting` surfaces the
 * "reconstructed" notice — cold boot loses the process, never the context
 * (scrollback, cwd, history persist outside the memory snapshot).
 */

export const MACHINE_STATES = [
  "provisioning",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "cold_booting",
  "boosting",
  "boosted",
  "shrinking",
  "error",
] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

export const MACHINE_TRANSITIONS: Record<MachineState, ReadonlyArray<MachineState>> = {
  provisioning: ["running", "error"],
  running: ["suspending", "boosting", "error"],
  suspending: ["suspended", "error"],
  // A suspended machine may cold-boot if its snapshot can't restore (§8.5).
  suspended: ["resuming", "cold_booting", "error"],
  resuming: ["running", "cold_booting", "error"],
  cold_booting: ["running", "error"],
  boosting: ["boosted", "error"],
  boosted: ["shrinking", "error"],
  shrinking: ["running", "error"],
  error: ["provisioning", "cold_booting"],
};

export function canTransition(from: MachineState, to: MachineState): boolean {
  return MACHINE_TRANSITIONS[from].includes(to);
}

export interface MachineLifecycleEvent {
  machineId: string;
  from: MachineState;
  to: MachineState;
  atMs: number;
  /** True when a PTY was reconstructed rather than resumed (§8.5 UI contract). */
  reconstructed?: boolean;
  detail?: string;
}

export interface MachineSpec {
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
}

/** Default: shared-cpu-2x / 2 GB — the Fly suspend ceiling (§8.5). */
export const DEFAULT_MACHINE_SPEC: MachineSpec = { cpuKind: "shared", cpus: 2, memoryMb: 2048 };

/** Suspend is only available at or below this memory size (no swap). */
export const SUSPEND_MEMORY_CEILING_MB = 2048;
