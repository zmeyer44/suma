import { describe, expect, it } from "vitest";
import { DEFAULT_MACHINE_SPEC } from "@suma/protocol";
import {
  FLY_DEFAULTS,
  FlyApiError,
  FlySandboxProvider,
  flySandboxFromEnv,
  type FlyProviderConfig,
} from "../src/providers/fly.js";

const MACHINE_ID = "0b7a3c1e-1111-2222-3333-444455556666";
const APP = `sm-c-${MACHINE_ID}`;

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Route-matching fake fetch: handlers keyed by `METHOD path` (query string
 * stripped; GraphQL calls keyed by "GRAPHQL"). Unmatched requests 404 so a
 * test that forgets a route fails loudly instead of hanging on undefined.
 */
function fakeFly(handlers: Record<string, (body: unknown) => { status?: number; json?: unknown }>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const key = url.endsWith("/graphql")
      ? "GRAPHQL"
      : `${method} ${new URL(url).pathname.replace("/v1", "")}`;
    const handler = handlers[key];
    const result = handler ? handler(body) : { status: 404, json: { error: "no handler" } };
    const status = result.status ?? 200;
    return new Response(JSON.stringify(result.json ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  fetchImpl: typeof fetch,
  overrides?: Partial<FlyProviderConfig>,
): FlySandboxProvider {
  return new FlySandboxProvider({
    apiToken: "test-token",
    orgSlug: "suma-test",
    image: "registry.fly.io/suma-compute-image:test",
    appPrefix: FLY_DEFAULTS.appPrefix,
    agentPort: FLY_DEFAULTS.agentPort,
    volumeSizeGb: FLY_DEFAULTS.volumeSizeGb,
    exposeAgentPublicly: false,
    machinesApiBase: "https://fly.test/v1",
    graphqlUrl: "https://fly.test/graphql",
    fetchImpl,
    ...overrides,
  });
}

const PROVISION_INPUT = {
  userId: "user-1",
  machineId: MACHINE_ID,
  region: "iad",
  spec: DEFAULT_MACHINE_SPEC,
  agentVerifyKey: "dGVzdC1jb250cm9sLXB1YmxpYy1rZXk=",
};

describe("FlySandboxProvider.provision", () => {
  it("creates app, volume, and machine, waits for start, and returns the private address", async () => {
    let machineConfig: Record<string, unknown> | undefined;
    const { calls, fetchImpl } = fakeFly({
      [`GET /apps/${APP}`]: () => ({ status: 404 }),
      "POST /apps": () => ({ json: {} }),
      [`GET /apps/${APP}/volumes`]: () => ({ json: [] }),
      [`POST /apps/${APP}/volumes`]: () => ({ json: { id: "vol_1", name: "home" } }),
      [`GET /apps/${APP}/machines`]: () => ({ json: [] }),
      [`POST /apps/${APP}/machines`]: (body) => {
        machineConfig = (body as { config: Record<string, unknown> }).config;
        return { json: { id: "m_1", state: "created", config: {} } };
      },
      [`GET /apps/${APP}/machines/m_1/wait`]: () => ({ json: { ok: true } }),
    });

    const result = await provider(fetchImpl).provision(PROVISION_INPUT);
    expect(result.agentAddress).toBe(`${APP}.internal:2222`);

    const appCreate = calls.find((c) => c.method === "POST" && c.url.endsWith("/apps"));
    expect(appCreate?.body).toEqual({ app_name: APP, org_slug: "suma-test" });

    const volumeCreate = calls.find((c) => c.url.endsWith("/volumes") && c.method === "POST");
    expect(volumeCreate?.body).toMatchObject({ name: "home", region: "iad", size_gb: 10 });

    // Guest maps the Suma spec; env wires the agent; the volume is $HOME.
    expect(machineConfig).toMatchObject({
      image: "registry.fly.io/suma-compute-image:test",
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
      mounts: [{ volume: "vol_1", path: "/root" }],
    });
    const env = (machineConfig as { env: Record<string, string> }).env;
    expect(env["SUMA_MACHINE_ID"]).toBe(MACHINE_ID);
    expect(env["SUMA_AGENT_LISTEN"]).toBe("[::]:2222");
    expect(env["SUMA_AGENT_VERIFY_KEY"]).toBe(PROVISION_INPUT.agentVerifyKey);
    expect(env["SUMA_AGENT_CLAIMS"]).toBeUndefined();

    // No public exposure by default: nothing touched GraphQL.
    expect(calls.some((c) => c.url.endsWith("/graphql"))).toBe(false);

    // Waited for the machine to actually start.
    const wait = calls.find((c) => c.url.includes("/machines/m_1/wait"));
    expect(wait?.url).toContain("state=started");
  });

  it("is idempotent: existing app, volume, and machine are reused, nothing re-created", async () => {
    const { calls, fetchImpl } = fakeFly({
      [`GET /apps/${APP}`]: () => ({ json: { name: APP } }),
      [`GET /apps/${APP}/volumes`]: () => ({ json: [{ id: "vol_1", name: "home" }] }),
      [`GET /apps/${APP}/machines`]: () => ({
        json: [{
          id: "m_1",
          state: "started",
          config: {
            env: {
              SUMA_MACHINE_ID: MACHINE_ID,
              SUMA_AGENT_VERIFY_KEY: PROVISION_INPUT.agentVerifyKey,
            },
          },
        }],
      }),
      [`GET /apps/${APP}/machines/m_1/wait`]: () => ({ json: { ok: true } }),
    });

    const result = await provider(fetchImpl).provision(PROVISION_INPUT);
    expect(result.agentAddress).toBe(`${APP}.internal:2222`);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("allocates missing dedicated IPs and returns the public address when exposed", async () => {
    const graphqlCalls: unknown[] = [];
    const { fetchImpl } = fakeFly({
      [`GET /apps/${APP}`]: () => ({ json: { name: APP } }),
      [`GET /apps/${APP}/volumes`]: () => ({ json: [{ id: "vol_1", name: "home" }] }),
      [`GET /apps/${APP}/machines`]: () => ({
        json: [{
          id: "m_1",
          state: "started",
          config: {
            env: {
              SUMA_MACHINE_ID: MACHINE_ID,
              SUMA_AGENT_VERIFY_KEY: PROVISION_INPUT.agentVerifyKey,
            },
          },
        }],
      }),
      [`GET /apps/${APP}/machines/m_1/wait`]: () => ({ json: { ok: true } }),
      GRAPHQL: (body) => {
        graphqlCalls.push(body);
        const query = (body as { query: string }).query;
        if (query.startsWith("query")) {
          // v6 already allocated; v4 missing.
          return {
            json: { data: { app: { ipAddresses: { nodes: [{ type: "v6" }] } } } },
          };
        }
        return { json: { data: { allocateIpAddress: { ipAddress: { address: "1.2.3.4" } } } } };
      },
    });

    const result = await provider(fetchImpl, { exposeAgentPublicly: true }).provision(
      PROVISION_INPUT,
    );
    expect(result.agentAddress).toBe(`${APP}.fly.dev:2222`);
    // One lookup + one allocation (v4 only — v6 existed).
    expect(graphqlCalls).toHaveLength(2);
    expect(graphqlCalls[1]).toMatchObject({
      variables: { input: { appId: APP, type: "v4" } },
    });
  });

  it("refuses a spec above the suspend ceiling instead of silently provisioning it", async () => {
    const { fetchImpl } = fakeFly({
      [`GET /apps/${APP}`]: () => ({ json: { name: APP } }),
      [`GET /apps/${APP}/volumes`]: () => ({ json: [{ id: "vol_1", name: "home" }] }),
      [`GET /apps/${APP}/machines`]: () => ({ json: [] }),
    });
    await expect(
      provider(fetchImpl).provision({
        ...PROVISION_INPUT,
        spec: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
      }),
    ).rejects.toThrow(/suspend ceiling/);
  });

  it("surfaces Fly API failures with status and path", async () => {
    const { fetchImpl } = fakeFly({
      [`GET /apps/${APP}`]: () => ({ status: 404 }),
      "POST /apps": () => ({ status: 500, json: { error: "boom" } }),
    });
    await expect(provider(fetchImpl).provision(PROVISION_INPUT)).rejects.toMatchObject({
      name: "FlyApiError",
      status: 500,
    });
  });
});

describe("FlySandboxProvider lifecycle", () => {
  function lifecycleFake() {
    return fakeFly({
      [`GET /apps/${APP}/machines`]: () => ({
        json: [
          {
            id: "m_1",
            state: "started",
            config: { image: "old-image", env: { KEEP: "me" }, guest: { cpus: 1 } },
          },
        ],
      }),
      [`POST /apps/${APP}/machines/m_1/suspend`]: () => ({ json: {} }),
      [`POST /apps/${APP}/machines/m_1/start`]: () => ({ json: {} }),
      [`POST /apps/${APP}/machines/m_1/stop`]: () => ({ json: {} }),
      [`POST /apps/${APP}/machines/m_1/wait`]: () => ({ json: {} }),
      [`GET /apps/${APP}/machines/m_1/wait`]: () => ({ json: {} }),
      [`POST /apps/${APP}/machines/m_1`]: () => ({ json: {} }),
      [`DELETE /apps/${APP}`]: () => ({ json: {} }),
    });
  }

  it("maps suspend and resume onto the machine's suspend/start endpoints", async () => {
    const { calls, fetchImpl } = lifecycleFake();
    const fly = provider(fetchImpl);
    await fly.suspend(MACHINE_ID);
    expect(calls.at(-1)?.url).toContain("/machines/m_1/suspend");
    await fly.resume(MACHINE_ID);
    expect(calls.at(-1)?.url).toContain("/machines/m_1/start");
  });

  it("cold boot stops then starts", async () => {
    const { calls, fetchImpl } = lifecycleFake();
    await provider(fetchImpl).coldBoot(MACHINE_ID);
    const ops = calls
      .filter((c) => c.method === "POST")
      .map((c) => new URL(c.url).pathname.split("/").at(-1));
    expect(ops).toEqual(["stop", "start"]);
    const wait = calls.find((c) => c.url.includes("/machines/m_1/wait"));
    expect(wait?.url).toContain("state=stopped");
  });

  it("updateSpec sends the existing config back with only guest swapped", async () => {
    const { calls, fetchImpl } = lifecycleFake();
    await provider(fetchImpl).updateSpec(MACHINE_ID, {
      cpuKind: "performance",
      cpus: 4,
      memoryMb: 8192,
    });
    const update = calls.find((c) => c.method === "POST" && c.url.endsWith("/machines/m_1"));
    expect(update?.body).toEqual({
      config: {
        image: "old-image",
        env: { KEEP: "me" },
        guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
      },
    });
  });

  it("destroy deletes the whole per-user app, tolerating an already-gone app", async () => {
    const { calls, fetchImpl } = lifecycleFake();
    await provider(fetchImpl).destroy(MACHINE_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url).toContain(`/apps/${APP}`);

    const gone = fakeFly({ [`DELETE /apps/${APP}`]: () => ({ status: 404 }) });
    await expect(provider(gone.fetchImpl).destroy(MACHINE_ID)).resolves.toBeUndefined();
  });

  it("throws a useful error when the app has no machine", async () => {
    const { fetchImpl } = fakeFly({
      [`GET /apps/${APP}/machines`]: () => ({ json: [] }),
    });
    await expect(provider(fetchImpl).suspend(MACHINE_ID)).rejects.toThrow(/no machine/);
  });
});

describe("flySandboxFromEnv", () => {
  it("returns null without FLY_API_TOKEN", () => {
    expect(flySandboxFromEnv({})).toBeNull();
  });

  it("treats a token without an image as a misconfiguration", () => {
    expect(() => flySandboxFromEnv({ FLY_API_TOKEN: "t" })).toThrow(/FLY_COMPUTE_IMAGE/);
  });

  it("builds a provider with defaults applied", () => {
    const fly = flySandboxFromEnv({
      FLY_API_TOKEN: "t",
      FLY_COMPUTE_IMAGE: "registry.fly.io/img:1",
    });
    expect(fly).toBeInstanceOf(FlySandboxProvider);
    expect(fly?.appName(MACHINE_ID)).toBe(APP);
    expect(fly?.agentAddress(MACHINE_ID)).toBe(`${APP}.internal:2222`);
  });

  it("honors overrides, including public exposure", () => {
    const fly = flySandboxFromEnv({
      FLY_API_TOKEN: "t",
      FLY_COMPUTE_IMAGE: "registry.fly.io/img:1",
      FLY_COMPUTE_APP_PREFIX: "custom",
      FLY_AGENT_PORT: "4000",
      FLY_AGENT_PUBLIC: "1",
    });
    expect(fly?.agentAddress(MACHINE_ID)).toBe(`custom-${MACHINE_ID}.fly.dev:4000`);
  });
});

// The error class is part of the provider's contract with callers that want
// to distinguish "Fly said no" from local bugs.
describe("FlyApiError", () => {
  it("carries status and truncates bodies", () => {
    const err = new FlyApiError(422, "POST", "/apps", "x".repeat(1000));
    expect(err.status).toBe(422);
    expect(err.message.length).toBeLessThan(400);
  });
});
