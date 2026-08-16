/**
 * MachineService — the machine:* IPC surface (PRD §8.5). Talks to the control
 * plane through the enrolled ControlClient; with no control plane configured
 * (local-only mode) it reports the honest "not provisioned" status instead of
 * throwing, so Phase 1's local-only mode keeps working with the simulated
 * agent.
 */

import { clearInterval, setInterval } from "node:timers";
import type { MachineStatus } from "../../shared/ipc";
import type { ControlClient } from "../control-client";
import {
  localAwayMachineStatus,
  localHomeMachineStatus,
  localOnlyMachineStatus,
  presentMachineStatus,
} from "./machine-status";

const POLL_MS = 15_000;

export interface MachineDeps {
  /** Authenticated client, or null in local-only mode — re-read every call so
   *  enrollment mid-session picks up without rewiring. */
  control: () => ControlClient | null;
  emit: (status: MachineStatus) => void;
  /** Called whenever a refresh learns the VM's agent address — the hook that
   *  retargets the agent link from the simulator to the real machine. */
  onAgentAddress?: (address: string) => void;
  /** This installation's enrolled control-plane device id. */
  controlDeviceId?: () => string | null;
  /** Persisted local ownership, so a confirmed home Mac still works offline. */
  knownLocalComputerRole?: () => "home" | "away" | null;
  /** Gates the local simulator when the computer seat belongs elsewhere. */
  onLocalComputerRole?: (role: "home" | "away" | "not-local") => void;
  now?: () => number;
}

export class MachineService {
  private current: MachineStatus = localOnlyMachineStatus();
  private reachable = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MachineDeps) {}

  status(): MachineStatus {
    return { ...this.current, spec: { ...this.current.spec } };
  }

  async refresh(): Promise<MachineStatus> {
    const client = this.deps.control();
    if (client === null) {
      const knownRole = this.deps.knownLocalComputerRole?.() ?? null;
      if (knownRole !== null) {
        this.reachable = true;
        this.deps.onLocalComputerRole?.(knownRole);
        this.setStatus(
          knownRole === "home"
            ? localHomeMachineStatus()
            : localAwayMachineStatus(),
        );
        return this.status();
      }
      this.reachable = true;
      this.setStatus(localOnlyMachineStatus());
      return this.status();
    }
    try {
      const { mode, machine, events, homeDeviceId } = await client.getMachine();
      if (mode === "local") {
        // Before the first enrollment there is no owner yet; this install is
        // the provisional home. Once claimed, only that exact control device
        // may keep using the in-process computer.
        const currentDeviceId = this.deps.controlDeviceId?.() ?? null;
        const isHome =
          homeDeviceId === undefined ||
          homeDeviceId === null ||
          (currentDeviceId !== null && homeDeviceId === currentDeviceId);
        this.reachable = true;
        this.deps.onLocalComputerRole?.(isHome ? "home" : "away");
        this.setStatus(
          isHome ? localHomeMachineStatus() : localAwayMachineStatus(),
        );
        return this.status();
      }
      if (machine === null) {
        throw new Error("control plane returned no cloud machine");
      }
      this.deps.onLocalComputerRole?.("not-local");
      if (
        typeof machine.agentAddress === "string" &&
        machine.agentAddress.length > 0
      ) {
        this.deps.onAgentAddress?.(machine.agentAddress);
      }
      let explanation: string | null = null;
      try {
        explanation = (await client.getMachineLifecycle())?.explanation ?? null;
      } catch {
        explanation = null; // lifecycle route errored — the state fallback stands
      }
      this.reachable = true;
      this.setStatus(
        presentMachineStatus({
          machine,
          latestEvent: events[0] ?? null,
          lifecycleExplanation: explanation,
          nowMs: (this.deps.now ?? Date.now)(),
        }),
      );
    } catch {
      const knownRole = this.deps.knownLocalComputerRole?.() ?? null;
      if (knownRole !== null) {
        this.reachable = true;
        this.deps.onLocalComputerRole?.(knownRole);
        this.setStatus(
          knownRole === "home"
            ? localHomeMachineStatus()
            : localAwayMachineStatus(),
        );
        return this.status();
      }
      // Control unreachable: keep the last-known status rather than invent
      // one; planeState() reports the compute plane down.
      this.reachable = false;
    }
    return this.status();
  }

  async wake(): Promise<MachineStatus> {
    return this.transitionIf("suspended", "resuming");
  }

  async suspend(): Promise<MachineStatus> {
    return this.transitionIf("running", "suspending");
  }

  async boost(memoryMb: number): Promise<MachineStatus> {
    const client = this.requireClient();
    if (!Number.isInteger(memoryMb) || memoryMb < 2048 || memoryMb > 8192) {
      throw new Error("boost size must be between 2048 and 8192 MB");
    }
    await client.boostMachine(memoryMb);
    return this.refresh();
  }

  /** §10 failure-matrix rollup for PlaneHealth.computePlane. */
  planeState(): "ok" | "down" | "cold_booted" {
    if (this.deps.control() === null) return "ok"; // local-only: the simulator is the compute plane
    if (!this.reachable) return "down";
    if (this.current.reconstructed) return "cold_booted";
    return "ok";
  }

  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private async transitionIf(
    fromState: string,
    to: string,
  ): Promise<MachineStatus> {
    const client = this.requireClient();
    await this.refresh();
    if (this.current.machineId === null) {
      throw new Error(
        "this Mac is your computer — there is no cloud machine to transition",
      );
    }
    if (this.current.state !== fromState) return this.status(); // already on its way
    await client.transitionMachine(to);
    return this.refresh();
  }

  private requireClient(): ControlClient {
    const client = this.deps.control();
    if (client === null) {
      throw new Error(
        "no cloud machine — Suma is running local-only without a control plane",
      );
    }
    return client;
  }

  private setStatus(next: MachineStatus): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (changed) this.deps.emit(this.status());
  }
}
