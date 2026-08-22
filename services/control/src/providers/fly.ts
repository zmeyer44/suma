/**
 * The real side of the V2 exit hatch (PRD §7, infra/README.md): Fly Machines
 * as the compute plane. One Fly *app per Suma machine* — Fly routes public
 * traffic per app, not per machine, so per-user apps are what make "one VM
 * and one $HOME per account" (§8.8) addressable and destroyable as a unit.
 * Everything is derived deterministically from the Suma machine id, so the
 * provider keeps no state of its own and the control-plane DB stays the only
 * source of truth.
 *
 * Every provisioned agent receives the control plane's Ed25519 public key and
 * requires a signed capability-token mux handshake. Private 6PN addressing
 * remains defense in depth; `FLY_AGENT_PUBLIC=1` is still an explicit opt-in
 * to a larger network attack surface.
 */

import { SUSPEND_MEMORY_CEILING_MB, type MachineSpec } from "@suma/protocol";
import type { ProvisionInput, ProvisionResult, SandboxProvider } from "./sandbox.js";

export interface FlyProviderConfig {
  apiToken: string;
  /** Org that owns the per-user compute apps. */
  orgSlug: string;
  /** Image ref the machine boots, e.g. `registry.fly.io/suma-compute-image:abc123`. */
  image: string;
  /** Prefix for per-user app names: `<prefix>-<sumaMachineId>`. */
  appPrefix: string;
  /** Port the in-VM suma-agent listens on (SUMA_AGENT_LISTEN). */
  agentPort: number;
  /** Size of the $HOME volume in GB. */
  volumeSizeGb: number;
  /** Allocate dedicated IPs and expose the agent port publicly. */
  exposeAgentPublicly: boolean;
  machinesApiBase: string;
  graphqlUrl: string;
  fetchImpl: typeof fetch;
}

export const FLY_DEFAULTS = {
  appPrefix: "sm-c",
  agentPort: 2222,
  volumeSizeGb: 10,
  machinesApiBase: "https://api.machines.dev/v1",
  graphqlUrl: "https://api.fly.io/graphql",
} as const;

/** Name of the $HOME volume inside each per-user app. */
const HOME_VOLUME_NAME = "home";

/** Mount point for $HOME. The agent runs as root in the user's own microVM
 * (PRD §8.5 is explicit that root-in-your-own-VM is the honest model). */
const HOME_MOUNT_PATH = "/root";

/** Seconds to wait for a created/started machine to reach `started`. */
const WAIT_TIMEOUT_SECONDS = 60;

export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`fly api ${method} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "FlyApiError";
  }
}

interface FlyMachine {
  id: string;
  state: string;
  config: Record<string, unknown>;
}

interface FlyVolume {
  id: string;
  name: string;
}

export class FlySandboxProvider implements SandboxProvider {
  constructor(private readonly config: FlyProviderConfig) {}

  appName(machineId: string): string {
    return `${this.config.appPrefix}-${machineId.toLowerCase()}`;
  }

  agentAddress(machineId: string): string {
    const host = this.config.exposeAgentPublicly
      ? `${this.appName(machineId)}.fly.dev`
      : `${this.appName(machineId)}.internal`;
    return `${host}:${this.config.agentPort}`;
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const app = this.appName(input.machineId);
    await this.ensureApp(app);
    const volume = await this.ensureVolume(app, input.region);
    const machine = await this.ensureMachine(app, volume, input);
    await this.api("GET", `/apps/${app}/machines/${machine.id}/wait`, undefined, {
      query: { state: "started", timeout: String(WAIT_TIMEOUT_SECONDS) },
    });
    if (this.config.exposeAgentPublicly) {
      await this.ensurePublicIps(app);
    }
    return { agentAddress: this.agentAddress(input.machineId) };
  }

  async suspend(machineId: string): Promise<void> {
    const { app, machine } = await this.resolveMachine(machineId);
    await this.api("POST", `/apps/${app}/machines/${machine.id}/suspend`);
  }

  async resume(machineId: string): Promise<void> {
    // Fly resumes a suspended machine (and starts a stopped one) via `start`;
    // the API decides snapshot-restore vs. boot. Whether that landed as a
    // resume or a cold boot is the control plane's state machine to surface.
    const { app, machine } = await this.resolveMachine(machineId);
    await this.api("POST", `/apps/${app}/machines/${machine.id}/start`);
  }

  async coldBoot(machineId: string): Promise<void> {
    const { app, machine } = await this.resolveMachine(machineId);
    // Stop-then-start: the explicit "snapshot could not restore" recovery
    // path (§8.5). Stopping an already-stopped machine is not an error.
    await this.api("POST", `/apps/${app}/machines/${machine.id}/stop`, undefined, {
      allowStatuses: [412, 422],
    });
    await this.api("GET", `/apps/${app}/machines/${machine.id}/wait`, undefined, {
      query: { state: "stopped", timeout: String(WAIT_TIMEOUT_SECONDS) },
      allowStatuses: [400, 404, 408],
    });
    await this.api("POST", `/apps/${app}/machines/${machine.id}/start`);
  }

  async updateSpec(machineId: string, spec: MachineSpec): Promise<void> {
    const { app, machine } = await this.resolveMachine(machineId);
    // Machine update wants the full config back, not a patch: send the
    // existing config with only `guest` swapped.
    const config = { ...machine.config, guest: guestFor(spec) };
    await this.api("POST", `/apps/${app}/machines/${machine.id}`, { config });
  }

  async destroy(machineId: string): Promise<void> {
    // Deleting the app tears down its machines, volumes, and IPs in one
    // call — exactly the per-user blast radius the app-per-user layout buys.
    await this.api("DELETE", `/apps/${this.appName(machineId)}`, undefined, {
      allowStatuses: [404],
    });
  }

  /* ------------------------------------------------------------------ */

  private async ensureApp(app: string): Promise<void> {
    const existing = await this.api("GET", `/apps/${app}`, undefined, {
      allowStatuses: [404],
    });
    if (existing !== null) return;
    await this.api("POST", "/apps", { app_name: app, org_slug: this.config.orgSlug });
  }

  private async ensureVolume(app: string, region: string): Promise<FlyVolume> {
    const volumes = (await this.api("GET", `/apps/${app}/volumes`)) as FlyVolume[];
    const existing = volumes.find((v) => v.name === HOME_VOLUME_NAME);
    if (existing) return existing;
    return (await this.api("POST", `/apps/${app}/volumes`, {
      name: HOME_VOLUME_NAME,
      region,
      size_gb: this.config.volumeSizeGb,
    })) as FlyVolume;
  }

  private async ensureMachine(
    app: string,
    volume: FlyVolume,
    input: ProvisionInput,
  ): Promise<FlyMachine> {
    const machines = (await this.api("GET", `/apps/${app}/machines`)) as FlyMachine[];
    const existing = machines[0];
    if (existing) {
      const previousEnv = isRecord(existing.config["env"])
        ? existing.config["env"]
        : {};
      if (
        previousEnv["SUMA_AGENT_VERIFY_KEY"] === input.agentVerifyKey &&
        previousEnv["SUMA_MACHINE_ID"] === input.machineId
      ) {
        return existing;
      }
      const { SUMA_AGENT_CLAIMS: _legacyClaims, ...retainedEnv } = previousEnv;
      return (await this.api(
        "POST",
        `/apps/${app}/machines/${existing.id}`,
        {
          config: {
            ...existing.config,
            env: {
              ...retainedEnv,
              SUMA_MACHINE_ID: input.machineId,
              SUMA_AGENT_LISTEN: `[::]:${this.config.agentPort}`,
              SUMA_AGENT_VERIFY_KEY: input.agentVerifyKey,
            },
          },
        },
      )) as FlyMachine;
    }

    if (input.spec.memoryMb > SUSPEND_MEMORY_CEILING_MB) {
      // Not a hard Fly limit — a Suma one: above 2 GB the suspend path
      // (the product promise) silently stops existing. Refuse loudly.
      throw new Error(
        `provision spec ${input.spec.memoryMb} MB exceeds the ${SUSPEND_MEMORY_CEILING_MB} MB suspend ceiling`,
      );
    }

    return (await this.createMachine(app, {
      name: "compute",
      region: input.region,
      config: {
        image: this.config.image,
        guest: guestFor(input.spec),
        env: {
          SUMA_MACHINE_ID: input.machineId,
          // Fly private `.internal` addresses use 6PN IPv6. Ubuntu's IPv6
          // wildcard is dual-stack, so this also preserves the agent's
          // 127.0.0.1 path used by in-VM port-forward and dev probes.
          SUMA_AGENT_LISTEN: `[::]:${this.config.agentPort}`,
          SUMA_AGENT_VERIFY_KEY: input.agentVerifyKey,
        },
        mounts: [{ volume: volume.id, path: HOME_MOUNT_PATH }],
        services: [
          {
            protocol: "tcp",
            internal_port: this.config.agentPort,
            // No autostop/autostart: lifecycle is the control plane's job
            // (§8.5 process-aware verdicts), not the Fly proxy's.
            autostop: false,
            autostart: false,
            ports: [{ port: this.config.agentPort }],
          },
        ],
        restart: { policy: "always" },
      },
    })) as FlyMachine;
  }

  /** A freshly created app 404s machine creation for a moment while the
   * registration propagates to the machines platform (observed live) —
   * retry briefly rather than failing the signup that triggered it. */
  private async createMachine(app: string, body: unknown): Promise<FlyMachine> {
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.api("POST", `/apps/${app}/machines`, body)) as FlyMachine;
      } catch (err) {
        if (!(err instanceof FlyApiError) || err.status !== 404 || attempt >= maxAttempts) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async resolveMachine(
    machineId: string,
  ): Promise<{ app: string; machine: FlyMachine }> {
    const app = this.appName(machineId);
    const machines = (await this.api("GET", `/apps/${app}/machines`)) as FlyMachine[];
    const machine = machines[0];
    if (!machine) {
      throw new Error(`fly app ${app} has no machine — was ${machineId} ever provisioned?`);
    }
    return { app, machine };
  }

  /** Allocate any missing dedicated IPs (v4 billed ~$2/mo, v6 free). IP
   * allocation never made it into the Machines REST API; it lives in GraphQL. */
  private async ensurePublicIps(app: string): Promise<void> {
    const existing = await this.graphql<{
      app: { ipAddresses: { nodes: Array<{ type: string }> } } | null;
    }>(
      `query($name: String!) { app(name: $name) { ipAddresses { nodes { type } } } }`,
      { name: app },
    );
    const have = new Set(
      (existing.app?.ipAddresses.nodes ?? []).map((n) => n.type.toLowerCase()),
    );
    for (const type of ["v4", "v6"]) {
      if (have.has(type)) continue;
      await this.graphql(
        `mutation($input: AllocateIPAddressInput!) {
          allocateIpAddress(input: $input) { ipAddress { address } }
        }`,
        { input: { appId: app, type } },
      );
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.config.fetchImpl(this.config.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (!res.ok || body.errors?.length) {
      const detail = body.errors?.map((e) => e.message).join("; ") ?? `status ${res.status}`;
      throw new FlyApiError(res.status, "POST", "/graphql", detail);
    }
    if (body.data === undefined) {
      throw new FlyApiError(res.status, "POST", "/graphql", "no data in response");
    }
    return body.data;
  }

  private async api(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    opts?: { query?: Record<string, string>; allowStatuses?: number[] },
  ): Promise<unknown> {
    const url = new URL(this.config.machinesApiBase + path);
    for (const [k, v] of Object.entries(opts?.query ?? {})) url.searchParams.set(k, v);
    const res = await this.config.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      if (opts?.allowStatuses?.includes(res.status)) return null;
      throw new FlyApiError(res.status, method, path, await res.text());
    }
    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function guestFor(spec: MachineSpec): Record<string, unknown> {
  return { cpu_kind: spec.cpuKind, cpus: spec.cpus, memory_mb: spec.memoryMb };
}

/**
 * Build the Fly provider from the environment, or return null when compute
 * is not configured (the caller falls back to the recording stub). Gated on
 * FLY_API_TOKEN; a token with no image is a misconfiguration, not a mode.
 */
export function flySandboxFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): FlySandboxProvider | null {
  const apiToken = env["FLY_API_TOKEN"];
  if (!apiToken) return null;
  const image = env["FLY_COMPUTE_IMAGE"];
  if (!image) {
    throw new Error(
      "FLY_API_TOKEN is set but FLY_COMPUTE_IMAGE is not — build one with " +
        "infra/compute-image/build.sh and set the printed image ref.",
    );
  }
  return new FlySandboxProvider({
    apiToken,
    image,
    orgSlug: env["FLY_ORG_SLUG"] ?? "personal",
    appPrefix: env["FLY_COMPUTE_APP_PREFIX"] ?? FLY_DEFAULTS.appPrefix,
    agentPort: parsePort(env["FLY_AGENT_PORT"]) ?? FLY_DEFAULTS.agentPort,
    volumeSizeGb: parsePositiveInt(env["FLY_VOLUME_SIZE_GB"]) ?? FLY_DEFAULTS.volumeSizeGb,
    exposeAgentPublicly: env["FLY_AGENT_PUBLIC"] === "1",
    machinesApiBase: env["FLY_MACHINES_API_BASE"] ?? FLY_DEFAULTS.machinesApiBase,
    graphqlUrl: env["FLY_GRAPHQL_URL"] ?? FLY_DEFAULTS.graphqlUrl,
    fetchImpl,
  });
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePort(raw: string | undefined): number | null {
  const n = parsePositiveInt(raw);
  return n !== null && n <= 65535 ? n : null;
}
