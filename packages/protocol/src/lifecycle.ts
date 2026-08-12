/**
 * Process-aware compute lifecycle (PRD §8.5).
 *
 * This replaces v1.0's output-silence rule, which failed twice: a quiet
 * long-running job produces no output (silence ≠ idleness), and suspend
 * FREEZES WALL-CLOCK PROGRESS — a suspended build makes no progress until
 * something wakes it, so "your training job keeps running" was false under
 * v1.0's own policy.
 *
 * The rules implemented here:
 *   - Never auto-suspend while a non-shell user process tree is alive, unless
 *     the user opted that workload into suspend.
 *   - Job Mode ("keep running") pins the machine awake with a visible cost
 *     meter; it is the only supported story for long unattended jobs.
 *   - An idle shell may be suspended freely.
 */

/** A process tree the agent reports as alive on the machine. */
export interface ProcessTreeInfo {
  ptyId: string;
  /** The foreground process: a plain login shell vs. real user work. */
  command: string;
  /** True when the process tree is nothing but the shell itself. */
  shellOnly: boolean;
  /** User explicitly opted THIS workload into being suspendable (§8.5). */
  suspendOptIn: boolean;
  /** Job Mode: "keep running" — pins the machine awake. */
  jobMode: boolean;
}

export interface LifecycleInputs {
  /** Any client (desktop app) currently attached to the machine. */
  clientsAttached: number;
  processes: ProcessTreeInfo[];
  /** Milliseconds since the last client interaction. */
  idleMs: number;
  /** An in-flight cloud fetch or port-forward keeps the machine up. */
  activeTransfers: number;
  /** Grace period before an idle shell-only machine suspends. */
  idleSuspendAfterMs: number;
}

export type SuspendVerdict =
  | { suspend: true; reason: "idle_shell" }
  | {
      suspend: false;
      reason:
        | "client_attached"
        | "job_mode"
        | "user_process_alive"
        | "active_transfer"
        | "within_idle_grace";
      /** PTY that pinned the machine awake, for the UI's "why is this awake?" */
      ptyId?: string;
    };

/** Default grace period before suspending an idle shell-only machine. */
export const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 1000;

/**
 * Decide whether the machine may auto-suspend right now. Fails safe: any
 * doubt keeps the machine awake, because wrongly suspending a running job
 * silently stops the user's work, while wrongly staying awake only costs
 * money — which the cost meter makes visible.
 */
export function decideSuspend(inputs: LifecycleInputs): SuspendVerdict {
  if (inputs.clientsAttached > 0) return { suspend: false, reason: "client_attached" };
  if (inputs.activeTransfers > 0) return { suspend: false, reason: "active_transfer" };

  const job = inputs.processes.find((p) => p.jobMode);
  if (job !== undefined) return { suspend: false, reason: "job_mode", ptyId: job.ptyId };

  // A non-shell process tree is real user work. Only an explicit per-workload
  // opt-in makes it suspendable.
  const working = inputs.processes.find((p) => !p.shellOnly && !p.suspendOptIn);
  if (working !== undefined) {
    return { suspend: false, reason: "user_process_alive", ptyId: working.ptyId };
  }

  if (inputs.idleMs < inputs.idleSuspendAfterMs) {
    return { suspend: false, reason: "within_idle_grace" };
  }
  return { suspend: true, reason: "idle_shell" };
}

/** Human-readable explanation for the VM status pill (§10 client-visible state). */
export function explainVerdict(verdict: SuspendVerdict): string {
  if (verdict.suspend) return "Idle — suspending to stop billing.";
  switch (verdict.reason) {
    case "client_attached":
      return "Awake because this Mac is connected.";
    case "job_mode":
      return "Awake because a job is set to keep running.";
    case "user_process_alive":
      return "Awake because a process is still running in your terminal.";
    case "active_transfer":
      return "Awake because a transfer is in progress.";
    case "within_idle_grace":
      return "Idle — will suspend shortly.";
  }
}

/* ------------------------------------------------------------------ *
 * Cost meter (§8.5 Job Mode "~$0.0X/hr while awake", §11)
 * ------------------------------------------------------------------ */

/** Hourly USD rate for a machine spec, from the §11 unit-economics model. */
export function hourlyRateUsd(memoryMb: number, cpus: number): number {
  // Fly shared-cpu pricing shape: a small base per vCPU plus memory.
  const cpuCost = 0.0000008 * cpus * 3600;
  const memCost = 0.0000000055 * memoryMb * 3600;
  return Number((cpuCost + memCost).toFixed(4));
}

/** Awake-time cost so far, for the visible meter. */
export function accruedCostUsd(memoryMb: number, cpus: number, awakeMs: number): number {
  return Number(((hourlyRateUsd(memoryMb, cpus) * awakeMs) / 3_600_000).toFixed(4));
}

export function formatHourlyRate(memoryMb: number, cpus: number): string {
  return `~$${hourlyRateUsd(memoryMb, cpus).toFixed(2)}/hr while awake`;
}
