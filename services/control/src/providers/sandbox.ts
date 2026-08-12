/**
 * The V2 exit hatch (PRD §7): every compute-plane call goes through this
 * interface so Fly Machines can be swapped for self-hosted Firecracker
 * without touching route logic. The initial phase ships only the stub.
 */

import type { MachineSpec } from "@suma/protocol";

export interface ProvisionInput {
  userId: string;
  machineId: string;
  region: string;
  spec: MachineSpec;
}

export interface ProvisionResult {
  /**
   * `host:port` the desktop's agent client can dial, when the provider knows
   * it (the stub never does). Persisted on the machine row and surfaced via
   * `/v1/me` — a provisioned VM nobody can address does not exist.
   */
  agentAddress: string | null;
}

export interface SandboxProvider {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  suspend(machineId: string): Promise<void>;
  resume(machineId: string): Promise<void>;
  coldBoot(machineId: string): Promise<void>;
  updateSpec(machineId: string, spec: MachineSpec): Promise<void>;
  destroy(machineId: string): Promise<void>;
}

export interface SandboxCall {
  method: keyof SandboxProvider;
  args: ReadonlyArray<unknown>;
}

export class StubSandboxProvider implements SandboxProvider {
  readonly calls: SandboxCall[] = [];

  private record(method: keyof SandboxProvider, args: ReadonlyArray<unknown>): Promise<void> {
    this.calls.push({ method, args });
    return Promise.resolve();
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    await this.record("provision", [input]);
    return { agentAddress: null };
  }

  suspend(machineId: string): Promise<void> {
    return this.record("suspend", [machineId]);
  }

  resume(machineId: string): Promise<void> {
    return this.record("resume", [machineId]);
  }

  coldBoot(machineId: string): Promise<void> {
    return this.record("coldBoot", [machineId]);
  }

  updateSpec(machineId: string, spec: MachineSpec): Promise<void> {
    return this.record("updateSpec", [machineId, spec]);
  }

  destroy(machineId: string): Promise<void> {
    return this.record("destroy", [machineId]);
  }
}
