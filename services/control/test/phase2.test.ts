import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_TOKEN_TTL_SECONDS,
  DEFAULT_IDLE_SUSPEND_MS,
  TERMINAL_CAPABILITIES,
  accruedCostUsd,
  generateTokenKeypair,
  hourlyRateUsd,
  signDeviceToken,
  type Capability,
  type CapabilityClaims,
  type ProcessTreeInfo,
} from "@suma/protocol";
import { ACTIVITY_SNAPSHOT_STALE_AFTER_MS, createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { createSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";
import {
  agentReportRefusal,
  signCapabilityToken,
  verifyCapabilityToken,
  refusedCaps,
} from "../src/capabilities.js";
import { GATEWAY_TOKEN_ENV } from "../src/gateway.js";
import {
  BYTES_PER_GB,
  PRO_ALLOWANCE_USD,
  R2_USD_PER_MONTH,
  VOLUME_USD_PER_MONTH,
  estimateMonthlyCost,
} from "../src/billing.js";
import {
  ABUSE_LIMITS,
  checkBoost,
  checkConcurrentMachines,
  egressThrottled,
  port25Blocked,
} from "../src/abuse.js";
import { KNOWN_AUDIT_TYPES, summarize } from "../src/audit-format.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let signing: SigningKeys;
let sandbox: StubSandboxProvider;

/** The operator-supplied egress-gateway credential (gateway.ts). */
const GATEWAY_SECRET = "test-egress-gateway-secret";

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const pair = await generateTokenKeypair();
  signing = await createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
  sandbox = new StubSandboxProvider();
  process.env[GATEWAY_TOKEN_ENV] = GATEWAY_SECRET;
  app = createApp(db, sandbox, signing);
});

function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function authedInit(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

let emailCounter = 0;

async function signup(): Promise<{
  userId: string;
  spaceId: string;
  machineId: string;
  token: string;
}> {
  const email = `phase2-${emailCounter++}@example.com`;
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const body = await res.json();
  return {
    userId: body.user.id,
    spaceId: body.space.id,
    machineId: body.machine.id,
    token: `hbr_dev_${body.user.id}`,
  };
}

async function mintCap(token: string, caps: ReadonlyArray<Capability>): Promise<string> {
  const res = await app.request("/v1/machine/capability-token", jsonInit("POST", { caps }, token));
  expect(res.status).toBe(201);
  return (await res.json()).token;
}

function pty(overrides: Partial<ProcessTreeInfo> = {}): ProcessTreeInfo {
  return {
    ptyId: "pty-1",
    command: "-zsh",
    shellOnly: true,
    suspendOptIn: false,
    jobMode: false,
    ...overrides,
  };
}

interface ActivityBody {
  clientsAttached?: number;
  processes?: ProcessTreeInfo[];
  activeTransfers?: number;
  lastInteractionAt?: number;
  awakeMsAccrued?: number;
}

async function reportActivity(capToken: string, body: ActivityBody = {}): Promise<Response> {
  return app.request(
    "/v1/machine/activity",
    jsonInit(
      "POST",
      {
        clientsAttached: 0,
        processes: [pty()],
        activeTransfers: 0,
        lastInteractionAt: Date.now(),
        awakeMsAccrued: 60_000,
        ...body,
      },
      capToken,
    ),
  );
}

async function transition(token: string, to: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return app.request("/v1/machine/transition", jsonInit("POST", { to, ...extra }, token));
}

/** A compute/storage sample, as the in-VM agent reports it. */
async function postAgentSample(cap: string, body: Record<string, unknown> = {}): Promise<Response> {
  return app.request(
    "/v1/usage/sample",
    jsonInit(
      "POST",
      { periodStart: Date.now() - 3_600_000, awakeMs: 60_000, storageGb: 1, ...body },
      cap,
    ),
  );
}

/** An egress sample, as the identity gateway reports it (separate plane, I-3). */
async function postEgressSample(
  body: Record<string, unknown>,
  secret: string = GATEWAY_SECRET,
): Promise<Response> {
  return app.request(
    "/v1/usage/egress",
    jsonInit("POST", { periodStart: Date.now() - 3_600_000, ...body }, secret),
  );
}

async function auditEvents(token: string, query = ""): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const res = await app.request(`/v1/audit${query}`, authedInit(token));
  expect(res.status).toBe(200);
  return (await res.json()).events;
}

const STALE_INTERACTION = (): number => Date.now() - DEFAULT_IDLE_SUSPEND_MS - 60_000;

describe("capability tokens (I-2)", () => {
  it("mints a machine-bound, short-lived token and audits the cap list", async () => {
    const { userId, machineId, token } = await signup();
    const res = await app.request(
      "/v1/machine/capability-token",
      jsonInit("POST", { caps: [...TERMINAL_CAPABILITIES] }, token),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const verified = await verifyCapabilityToken(signing.verifyKey, body.token, nowSeconds());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.claims.mid).toBe(machineId);
    expect(verified.claims.sub).toBe(userId);
    expect(verified.claims.caps).toEqual([...TERMINAL_CAPABILITIES]);
    expect(verified.claims.exp - verified.claims.iat).toBe(CAPABILITY_TOKEN_TTL_SECONDS);
    expect(body.exp).toBe(verified.claims.exp);

    const minted = (await auditEvents(token)).find((e) => e.type === "capability.minted");
    expect(minted?.payload).toMatchObject({ machineId, caps: [...TERMINAL_CAPABILITIES] });
  });

  it("authenticates the agent activity route", async () => {
    const { token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const res = await reportActivity(cap);
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBeDefined();
  });

  it("NEVER authenticates a device/user route (I-2: the VM cannot impersonate a device)", async () => {
    const { token, spaceId } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);

    const attempts: Array<[string, RequestInit]> = [
      ["/v1/me", authedInit(cap)],
      ["/v1/devices", authedInit(cap)],
      ["/v1/machine", authedInit(cap)],
      ["/v1/machine/lifecycle", authedInit(cap)],
      ["/v1/audit", authedInit(cap)],
      ["/v1/usage/summary", authedInit(cap)],
      [`/v1/spaces/${spaceId}/wrappers`, authedInit(cap)],
      ["/v1/machine/transition", jsonInit("POST", { to: "running" }, cap)],
      ["/v1/machine/job-mode", jsonInit("POST", { ptyId: "pty-1", enabled: true }, cap)],
      ["/v1/machine/boost", jsonInit("POST", {}, cap)],
      ["/v1/spaces", jsonInit("POST", { name: "X", color: "#fff" }, cap)],
      ["/v1/devices/enroll", jsonInit("POST", { name: "VM", platform: "linux", devicePublicKey: "A".repeat(44) }, cap)],
      // Above all: a capability token must not mint more capability tokens.
      ["/v1/machine/capability-token", jsonInit("POST", { caps: ["pty.spawn"] }, cap)],
    ];
    for (const [path, init] of attempts) {
      const res = await app.request(path, init);
      expect(res.status, `capability token must not authenticate ${path}`).toBe(401);
    }
  });

  it("rejects device/user credentials on agent routes", async () => {
    const { userId, token } = await signup();
    const iat = nowSeconds();
    const bootstrapJws = await signDeviceToken(signing.signingKey, {
      sub: userId,
      did: userId,
      iat,
      exp: iat + 600,
      jti: crypto.randomUUID(),
    });
    // Sanity: this device-plane JWS authenticates a user route...
    expect((await app.request("/v1/me", authedInit(bootstrapJws))).status).toBe(200);

    // ...but neither it, the dev stub, nor nothing at all reaches the agent plane.
    const sample = { periodStart: Date.now(), awakeMs: 1000, proxiedBytes: 0, storageGb: 0 };
    for (const credential of [bootstrapJws, token]) {
      expect((await reportActivity(credential)).status).toBe(401);
      expect(
        (await app.request("/v1/usage/sample", jsonInit("POST", sample, credential))).status,
      ).toBe(401);
    }
    expect((await app.request("/v1/machine/activity", jsonInit("POST", {}))).status).toBe(401);
  });

  it("rejects an expired capability token", async () => {
    const { userId, machineId } = await signup();
    const iat = nowSeconds() - CAPABILITY_TOKEN_TTL_SECONDS - 120;
    const claims: CapabilityClaims = {
      mid: machineId,
      sub: userId,
      caps: ["pty.spawn"],
      iat,
      exp: iat + CAPABILITY_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    };
    const expired = await signCapabilityToken(signing.signingKey, claims);
    const res = await reportActivity(expired);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("expired");
  });

  it("rejects a token whose machine binding does not hold", async () => {
    const a = await signup();
    const b = await signup();
    const iat = nowSeconds();
    // Signed with the real key but naming another user's machine.
    const crossMachine = await signCapabilityToken(signing.signingKey, {
      mid: b.machineId,
      sub: a.userId,
      caps: ["pty.spawn"],
      iat,
      exp: iat + CAPABILITY_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    });
    const unknownMachine = await signCapabilityToken(signing.signingKey, {
      mid: crypto.randomUUID(),
      sub: a.userId,
      caps: ["pty.spawn"],
      iat,
      exp: iat + CAPABILITY_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    });
    for (const forged of [crossMachine, unknownMachine]) {
      const res = await reportActivity(forged);
      expect(res.status).toBe(401);
      expect((await res.json()).reason).toBe("machine_binding");
    }
  });

  it("refuses fetch/fs caps unless the account has the feature", async () => {
    const { userId, token } = await signup();
    // Signup grants the V1 default feature set, so an account WITHOUT the
    // feature has to be made deliberately — that is the case under test.
    await db.update(schema.users).set({ features: [] }).where(eq(schema.users.id, userId));
    const res = await app.request(
      "/v1/machine/capability-token",
      jsonInit("POST", { caps: ["pty.spawn", "fs.read", "fetch.public"] }, token),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("capability_refused");
    expect(body.caps.sort()).toEqual(["fetch.public", "fs.read"]);

    await db.update(schema.users).set({ features: ["files", "cloud-fetch"] }).where(eq(schema.users.id, userId));
    const granted = await app.request(
      "/v1/machine/capability-token",
      jsonInit("POST", { caps: ["pty.spawn", "fs.read", "fs.write", "fetch.public"] }, token),
    );
    expect(granted.status).toBe(201);
    expect((await granted.json()).caps).toContain("fetch.public");
  });

  it("rejects capability names outside the protocol's set", async () => {
    const { token } = await signup();
    for (const caps of [["device.enroll"], ["pty.spawn", "keys.read"], []]) {
      const res = await app.request("/v1/machine/capability-token", jsonInit("POST", { caps }, token));
      expect(res.status).toBe(400);
    }
  });

  it("verifyCapabilityToken rejects the device-token family and tampering", async () => {
    const { userId, machineId, token } = await signup();
    const iat = nowSeconds();
    const deviceJws = await signDeviceToken(signing.signingKey, {
      sub: userId,
      did: userId,
      iat,
      exp: iat + 600,
      jti: crypto.randomUUID(),
    });
    expect(await verifyCapabilityToken(signing.verifyKey, deviceJws, iat)).toEqual({
      ok: false,
      reason: "not_capability_token",
    });
    expect(await verifyCapabilityToken(signing.verifyKey, "garbage", iat)).toEqual({
      ok: false,
      reason: "malformed",
    });

    const cap = await mintCap(token, ["pty.spawn"]);
    const [header, , sig] = cap.split(".") as [string, string, string];
    const other: CapabilityClaims = {
      mid: machineId,
      sub: userId,
      caps: ["fs.write"],
      iat,
      exp: iat + CAPABILITY_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    };
    const swapped = await signCapabilityToken(signing.signingKey, other);
    const tampered = `${header}.${swapped.split(".")[1]}.${sig}`;
    expect(await verifyCapabilityToken(signing.verifyKey, tampered, iat)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refusedCaps gates exactly the non-terminal caps on features", () => {
    expect(refusedCaps([...TERMINAL_CAPABILITIES], [])).toEqual([]);
    expect(refusedCaps(["fs.read", "fs.write", "fetch.public"], [])).toEqual([
      "fs.read",
      "fs.write",
      "fetch.public",
    ]);
    expect(refusedCaps(["fs.read", "fetch.public"], ["files"])).toEqual(["fetch.public"]);
    expect(refusedCaps(["fs.read", "fetch.public"], ["files", "cloud-fetch"])).toEqual([]);
  });
});

describe("process-aware lifecycle (§8.5)", () => {
  it("persists the activity snapshot and returns the verdict", async () => {
    const { machineId, token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const res = await reportActivity(cap, {
      processes: [pty({ ptyId: "build", command: "npm run build", shellOnly: false })],
      lastInteractionAt: STALE_INTERACTION(),
      awakeMsAccrued: 120_000,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toEqual({
      suspend: false,
      reason: "user_process_alive",
      ptyId: "build",
    });

    const [row] = await db
      .select()
      .from(schema.machineActivity)
      .where(eq(schema.machineActivity.machineId, machineId));
    expect(row?.awakeMsAccrued).toBe(120_000);
    expect(row?.processes).toHaveLength(1);

    // A later report replaces the snapshot in place (one row per machine).
    const idle = await reportActivity(cap, { lastInteractionAt: STALE_INTERACTION() });
    expect((await idle.json()).verdict).toEqual({ suspend: true, reason: "idle_shell" });
  });

  it("reports the idle grace period before an idle shell may suspend", async () => {
    const { token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const res = await reportActivity(cap, { lastInteractionAt: Date.now() });
    expect((await res.json()).verdict).toEqual({ suspend: false, reason: "within_idle_grace" });
  });

  it("serves the VM pill: verdict, explanation, and wouldSuspendAt", async () => {
    const { token } = await signup();

    // Nothing reported yet: an answer (keep awake), not a 404 — the pill must
    // never go blank, and §8.5 keeps a machine we cannot see awake.
    const unreported = await app.request("/v1/machine/lifecycle", authedInit(token));
    expect(unreported.status).toBe(200);
    const unreportedBody = await unreported.json();
    expect(unreportedBody.verdict).toEqual({ suspend: false, reason: "activity_unknown" });
    expect(unreportedBody.explanation).toBe(
      "Waiting for the machine to report in — staying awake until it does.",
    );
    expect(unreportedBody.wouldSuspendAt).toBeNull();
    expect(unreportedBody.reportedAt).toBeNull();

    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const lastInteractionAt = Date.now() - 1000;
    await reportActivity(cap, { lastInteractionAt });
    const res = await app.request("/v1/machine/lifecycle", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toEqual({ suspend: false, reason: "within_idle_grace" });
    expect(body.explanation).toBe("Idle — will suspend shortly.");
    expect(body.wouldSuspendAt).toBe(lastInteractionAt + DEFAULT_IDLE_SUSPEND_MS);

    // Pinned awake by an attached client: no scheduled suspend time.
    await reportActivity(cap, { clientsAttached: 1, lastInteractionAt });
    const pinned = await (await app.request("/v1/machine/lifecycle", authedInit(token))).json();
    expect(pinned.verdict.reason).toBe("client_attached");
    expect(pinned.explanation).toBe("Awake because this Mac is connected.");
    expect(pinned.wouldSuspendAt).toBeNull();
  });

  it("refuses suspending while a user process is alive, unless forced", async () => {
    const { token } = await signup();
    await transition(token, "running");
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    await reportActivity(cap, {
      processes: [pty({ ptyId: "train", command: "python train.py", shellOnly: false })],
      lastInteractionAt: STALE_INTERACTION(),
    });

    const refused = await transition(token, "suspending");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "would_interrupt_work",
      reason: "user_process_alive",
      ptyId: "train",
    });

    // An explicit user action may still suspend — and the audit trail says so.
    const forced = await transition(token, "suspending", { force: true });
    expect(forced.status).toBe(200);
    const suspending = (await auditEvents(token)).find(
      (e) => e.type === "machine.transition" && e.payload["to"] === "suspending",
    );
    expect(suspending?.payload["force"]).toBe(true);
  });

  it("allows suspending an idle shell past the grace period without force", async () => {
    const { machineId, token } = await signup();
    await transition(token, "running");
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    await reportActivity(cap, { lastInteractionAt: STALE_INTERACTION() });
    const res = await transition(token, "suspending");
    expect(res.status).toBe(200);
    expect(
      sandbox.calls.some((call) => call.method === "suspend" && call.args[0] === machineId),
    ).toBe(true);
  });

  it("refuses an auto-suspend on a machine that has never reported in", async () => {
    const { machineId, token } = await signup();
    await transition(token, "running");

    // §8.5 fails safe: with no snapshot the control plane cannot know whether
    // work is alive, and no shipped component creates that row yet — so the
    // guard must refuse rather than wave the suspend through.
    const refused = await transition(token, "suspending");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "would_interrupt_work",
      reason: "activity_unknown",
    });
    expect(
      sandbox.calls.some((call) => call.method === "suspend" && call.args[0] === machineId),
    ).toBe(false);

    // The user may still say "suspend it anyway".
    expect((await transition(token, "suspending", { force: true })).status).toBe(200);
    expect(
      sandbox.calls.some((call) => call.method === "suspend" && call.args[0] === machineId),
    ).toBe(true);
  });

  it("treats a snapshot older than the staleness window as unknown", async () => {
    const { machineId, token } = await signup();
    await transition(token, "running");
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    // Idle shell, past the grace period: fresh, this verdict says suspend.
    const fresh = await reportActivity(cap, { lastInteractionAt: STALE_INTERACTION() });
    expect((await fresh.json()).verdict).toEqual({ suspend: true, reason: "idle_shell" });

    // Age the report itself. The machine may have got busy since; idleMs kept
    // growing regardless, so without a freshness check this snapshot would go
    // on saying "suspend" forever.
    await db
      .update(schema.machineActivity)
      .set({ lastReportAt: new Date(Date.now() - ACTIVITY_SNAPSHOT_STALE_AFTER_MS - 60_000) })
      .where(eq(schema.machineActivity.machineId, machineId));

    const lifecycle = await (await app.request("/v1/machine/lifecycle", authedInit(token))).json();
    expect(lifecycle.verdict).toEqual({ suspend: false, reason: "activity_unknown" });
    expect(lifecycle.wouldSuspendAt).toBeNull();
    expect(lifecycle.reportedAt).not.toBeNull();

    const refused = await transition(token, "suspending");
    expect(refused.status).toBe(409);
    expect((await refused.json()).reason).toBe("activity_unknown");

    // A fresh report of the same idle shell suspends again.
    await reportActivity(cap, { lastInteractionAt: STALE_INTERACTION() });
    expect((await transition(token, "suspending")).status).toBe(200);
  });

  it("Job Mode pins the machine awake and is audited", async () => {
    const { machineId, token } = await signup();
    await transition(token, "running");
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    await reportActivity(cap, {
      processes: [pty({ ptyId: "job", command: "cargo build", shellOnly: false, suspendOptIn: true })],
      lastInteractionAt: STALE_INTERACTION(),
    });
    // Opted into suspend, so without Job Mode the machine may sleep...
    expect(
      (await (await app.request("/v1/machine/lifecycle", authedInit(token))).json()).verdict.suspend,
    ).toBe(true);

    const enabled = await app.request(
      "/v1/machine/job-mode",
      jsonInit("POST", { ptyId: "job", enabled: true }, token),
    );
    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json();
    expect(enabledBody.verdict).toEqual({ suspend: false, reason: "job_mode", ptyId: "job" });
    expect(enabledBody.explanation).toBe("Awake because a job is set to keep running.");

    const changed = (await auditEvents(token)).find((e) => e.type === "job.mode_changed");
    expect(changed?.payload).toEqual({ machineId, ptyId: "job", enabled: true });

    // ...and the suspend guard now refuses.
    const refused = await transition(token, "suspending");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "would_interrupt_work",
      reason: "job_mode",
      ptyId: "job",
    });

    // Turning Job Mode off releases the pin (the opt-in still stands).
    const disabled = await app.request(
      "/v1/machine/job-mode",
      jsonInit("POST", { ptyId: "job", enabled: false }, token),
    );
    expect((await disabled.json()).verdict.suspend).toBe(true);
    expect((await transition(token, "suspending")).status).toBe(200);
  });

  it("404s Job Mode for an unknown PTY or an unreported machine", async () => {
    const { token } = await signup();
    const none = await app.request(
      "/v1/machine/job-mode",
      jsonInit("POST", { ptyId: "pty-1", enabled: true }, token),
    );
    expect(none.status).toBe(404);
    expect((await none.json()).error).toBe("no_activity_reported");

    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    await reportActivity(cap);
    const unknown = await app.request(
      "/v1/machine/job-mode",
      jsonInit("POST", { ptyId: "nope", enabled: true }, token),
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("unknown_pty");
  });

  it("records cold_booting → running as reconstructed even when the caller omits it", async () => {
    const { token } = await signup();
    for (const to of ["running", "suspending", "suspended", "cold_booting"]) {
      // No snapshot on this machine, so the suspend leg is the explicit
      // user-initiated kind (see the guard's default-refuse test below).
      const extra = to === "suspending" ? { force: true } : {};
      expect((await transition(token, to, extra)).status).toBe(200);
    }
    const res = await transition(token, "running");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event.fromState).toBe("cold_booting");
    expect(body.event.reconstructed).toBe(true);
  });
});

describe("billing (§11)", () => {
  it("estimateMonthlyCost prices a typical active user within §11's ranges", async () => {
    const spec = { memoryMb: 2048, cpus: 2 };
    const awakeMs = 75 * 3_600_000;
    const proxiedBytes = 37.5 * BYTES_PER_GB;
    const est = estimateMonthlyCost(spec, { awakeMs, proxiedBytes });

    expect(est.computeHours).toBe(75);
    expect(est.computeUsd).toBe(accruedCostUsd(spec.memoryMb, spec.cpus, awakeMs));
    // §11: Compute VM $1.50–3.50, proxied bandwidth ~$0.50–1 at $0.02/GB.
    expect(est.computeUsd).toBeGreaterThanOrEqual(1.5);
    expect(est.computeUsd).toBeLessThanOrEqual(3.5);
    expect(est.egressGb).toBe(37.5);
    expect(est.egressUsd).toBe(0.75);
    expect(est.volumeUsd).toBe(VOLUME_USD_PER_MONTH);
    expect(est.r2Usd).toBe(R2_USD_PER_MONTH);
    expect(est.totalUsd).toBe(
      Number((est.computeUsd + est.egressUsd + est.volumeUsd + est.r2Usd).toFixed(4)),
    );
    expect(est.totalUsd).toBeLessThanOrEqual(PRO_ALLOWANCE_USD);
    expect(est.withinPlan).toBe(true);
  });

  it("estimateMonthlyCost flags a margin-killing user as outside the plan", () => {
    const est = estimateMonthlyCost(
      { memoryMb: 2048, cpus: 2 },
      { awakeMs: 720 * 3_600_000, proxiedBytes: 500 * BYTES_PER_GB },
    );
    expect(est.egressUsd).toBe(10);
    expect(est.totalUsd).toBeGreaterThan(PRO_ALLOWANCE_USD);
    expect(est.withinPlan).toBe(false);
  });

  it("zero usage still carries the flat §11 volume and R2 line items", () => {
    const est = estimateMonthlyCost({ memoryMb: 2048, cpus: 2 }, { awakeMs: 0, proxiedBytes: 0 });
    expect(est.computeUsd).toBe(0);
    expect(est.egressUsd).toBe(0);
    expect(est.totalUsd).toBe(Number((VOLUME_USD_PER_MONTH + R2_USD_PER_MONTH).toFixed(4)));
    expect(est.withinPlan).toBe(true);
  });

  it("aggregates samples into the summary the cost meter renders", async () => {
    const { userId, machineId, token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const now = Date.now();

    const first = await postAgentSample(cap, {
      periodStart: now - 2 * 3_600_000,
      awakeMs: 3_600_000,
      storageGb: 20,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()).sample;
    expect(created).toMatchObject({ userId, machineId, source: "agent", proxiedBytes: 0 });
    expect(
      (await postAgentSample(cap, { periodStart: now - 3_600_000, awakeMs: 3_600_000, storageGb: 25 })).status,
    ).toBe(201);
    // Egress is metered by the gateway plane, never by the machine (I-3).
    for (const periodStart of [now - 2 * 3_600_000, now - 3_600_000]) {
      expect((await postEgressSample({ userId, periodStart, proxiedBytes: BYTES_PER_GB })).status).toBe(201);
    }
    // Outside the 30-day window: must not count.
    expect(
      (await postAgentSample(cap, { periodStart: now - 40 * 86_400_000, awakeMs: 20 * 3_600_000, storageGb: 1 })).status,
    ).toBe(201);
    expect(
      (await postEgressSample({ userId, periodStart: now - 40 * 86_400_000, proxiedBytes: 999 * BYTES_PER_GB })).status,
    ).toBe(201);

    const res = await app.request("/v1/usage/summary", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(30);
    expect(body.totals).toEqual({
      awakeMs: 7_200_000,
      proxiedBytes: 2 * BYTES_PER_GB,
      storageGb: 25,
    });
    expect(body.hourlyRateUsd).toBe(hourlyRateUsd(2048, 2));
    expect(body.estimate).toEqual(
      estimateMonthlyCost({ memoryMb: 2048, cpus: 2 }, { awakeMs: 7_200_000, proxiedBytes: 2 * BYTES_PER_GB }),
    );
    expect(body.throttled).toBe(false);
  });

  it("reports throttled when the last day's egress exceeds the §9 cap", async () => {
    const { userId, token } = await signup();
    const over = (ABUSE_LIMITS.maxProxiedGbPerDay + 1) * BYTES_PER_GB;
    expect(
      (await postEgressSample({ userId, periodStart: Date.now() - 3_600_000, proxiedBytes: over })).status,
    ).toBe(201);
    const body = await (await app.request("/v1/usage/summary", authedInit(token))).json();
    expect(body.throttled).toBe(true);
  });

  it("rejects malformed samples and summary windows", async () => {
    const { token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const bad = await postAgentSample(cap, { awakeMs: -1 });
    expect(bad.status).toBe(400);
    expect((await app.request("/v1/usage/summary?days=0", authedInit(token))).status).toBe(400);
    expect((await app.request("/v1/usage/summary?days=91", authedInit(token))).status).toBe(400);
  });
});

describe("usage metering origin split (I-3)", () => {
  it("refuses an agent-sourced sample that names egress at all", async () => {
    const { userId, token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);

    // The whole attack in one request: a token that lives inside the user's
    // VM naming the number that drives the gateway's throttle.
    const forged = await postAgentSample(cap, {
      proxiedBytes: (ABUSE_LIMITS.maxProxiedGbPerDay + 1) * BYTES_PER_GB,
    });
    expect(forged.status).toBe(403);
    expect((await forged.json()).error).toBe("egress_not_agent_reportable");

    // Not even zero, and not by claiming to be the gateway.
    expect((await postAgentSample(cap, { proxiedBytes: 0 })).status).toBe(403);
    expect((await postAgentSample(cap, { source: "gateway" })).status).toBe(403);
    expect((await postAgentSample(cap, { source: "agent" })).status).toBe(201);

    // Nothing was stored, so the browser's egress is untouched.
    const summary = await (await app.request("/v1/usage/summary", authedInit(token))).json();
    expect(summary.totals.proxiedBytes).toBe(0);
    expect(summary.throttled).toBe(false);
    const rows = await db
      .select()
      .from(schema.usageSamples)
      .where(eq(schema.usageSamples.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proxiedBytes).toBe(0);
    expect(rows[0]?.source).toBe("agent");
  });

  it("400s out-of-range figures rather than storing them", async () => {
    const { userId, token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const now = Date.now();

    // A day cannot contain more than 24 h of awake time.
    expect((await postAgentSample(cap, { awakeMs: 86_400_001 })).status).toBe(400);
    expect((await postAgentSample(cap, { storageGb: 10_001 })).status).toBe(400);
    // A future-dated period never ages out of the throttle window.
    const future = await postAgentSample(cap, { periodStart: now + 3_600_000 });
    expect(future.status).toBe(400);
    expect(await future.json()).toEqual({
      error: "out_of_range",
      field: "periodStart",
      reason: "in_future",
    });
    expect((await postAgentSample(cap, { periodStart: now - 91 * 86_400_000 })).status).toBe(400);
    // The gateway is a remote writer too, and gets the same bounds.
    expect((await postEgressSample({ userId, proxiedBytes: 12e12 })).status).toBe(400);
    expect(
      (await postEgressSample({ userId, periodStart: now + 3_600_000, proxiedBytes: 1 })).status,
    ).toBe(400);

    // An activity report cannot pin the machine awake with a future clock.
    const skewed = await reportActivity(cap, { lastInteractionAt: now + 3_600_000 });
    expect(skewed.status).toBe(400);
    expect((await reportActivity(cap, { awakeMsAccrued: 91 * 86_400_000 })).status).toBe(400);

    const rows = await db
      .select()
      .from(schema.usageSamples)
      .where(eq(schema.usageSamples.userId, userId));
    expect(rows).toEqual([]);
    const summary = await (await app.request("/v1/usage/summary", authedInit(token))).json();
    expect(summary.totals).toEqual({ awakeMs: 0, proxiedBytes: 0, storageGb: 0 });
  });

  it("accepts egress only from the gateway credential", async () => {
    const { userId, token } = await signup();
    const cap = await mintCap(token, TERMINAL_CAPABILITIES);
    const sample = { userId, periodStart: Date.now() - 3_600_000, proxiedBytes: BYTES_PER_GB };

    // Neither plane the user (or the VM) can reach may write egress.
    for (const credential of [token, cap, "hbr_dev_nope", `${GATEWAY_SECRET}x`]) {
      expect((await postEgressSample(sample, credential)).status).toBe(401);
    }
    expect((await app.request("/v1/usage/egress", jsonInit("POST", sample))).status).toBe(401);

    expect((await postEgressSample(sample)).status).toBe(201);
    expect((await postEgressSample({ ...sample, userId: crypto.randomUUID() })).status).toBe(404);

    const summary = await (await app.request("/v1/usage/summary", authedInit(token))).json();
    expect(summary.totals.proxiedBytes).toBe(BYTES_PER_GB);
  });

  it("refuses egress metering entirely when no gateway credential is configured", async () => {
    const { userId } = await signup();
    delete process.env[GATEWAY_TOKEN_ENV];
    try {
      const res = await postEgressSample({ userId, proxiedBytes: BYTES_PER_GB });
      expect(res.status).toBe(503);
      expect((await res.json()).reason).toBe("gateway_auth_unconfigured");
    } finally {
      process.env[GATEWAY_TOKEN_ENV] = GATEWAY_SECRET;
    }
  });

  it("requires a terminal-scoped capability token on the agent reporting routes", async () => {
    const { userId, token } = await signup();
    await db
      .update(schema.users)
      .set({ features: ["files", "cloud-fetch"] })
      .where(eq(schema.users.id, userId));

    // A token minted for the feature-gated file/fetch grants is a different,
    // broader grant — it must not double as the machine's metering identity.
    const wide = await mintCap(token, [...TERMINAL_CAPABILITIES, "fs.read"]);
    const activity = await reportActivity(wide);
    expect(activity.status).toBe(403);
    expect((await activity.json()).error).toBe("capability_refused");
    expect((await postAgentSample(wide)).status).toBe(403);

    // A narrower terminal-scoped token still reports.
    const narrow = await mintCap(token, ["pty.spawn"]);
    expect((await reportActivity(narrow)).status).toBe(200);
    expect((await postAgentSample(narrow)).status).toBe(201);
  });

  it("agentReportRefusal names the caps that disqualify a token", () => {
    expect(agentReportRefusal([...TERMINAL_CAPABILITIES])).toBeNull();
    expect(agentReportRefusal(["pty.io"])).toBeNull();
    expect(agentReportRefusal([])).toBe("capability token grants nothing");
    expect(agentReportRefusal(["pty.io", "fs.write"])).toBe("not a terminal-scoped token: fs.write");
  });
});

describe("abuse controls (§9)", () => {
  it("pure limit checks: boost cap, machine cap, egress throttle, port 25", () => {
    expect(checkBoost(0)).toEqual({ allowed: true });
    expect(checkBoost(ABUSE_LIMITS.maxBoostsPerDay - 1)).toEqual({ allowed: true });
    const refused = checkBoost(ABUSE_LIMITS.maxBoostsPerDay);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.limit).toBe("boosts_per_day");
    expect(refused.reason).toContain(`${ABUSE_LIMITS.maxBoostsPerDay}`);

    expect(ABUSE_LIMITS.maxConcurrentMachines).toBe(1);
    expect(checkConcurrentMachines(0)).toEqual({ allowed: true });
    expect(checkConcurrentMachines(1).allowed).toBe(false);

    const capBytes = ABUSE_LIMITS.maxProxiedGbPerDay * BYTES_PER_GB;
    expect(egressThrottled(capBytes)).toBe(false);
    expect(egressThrottled(capBytes + 1)).toBe(true);

    // §9: outbound SMTP is not a knob.
    expect(port25Blocked).toBe(true);
  });

  it("boosts a running machine through the sandbox provider", async () => {
    const { machineId, token } = await signup();
    await transition(token, "running");
    const res = await app.request("/v1/machine/boost", jsonInit("POST", { memoryMb: 8192 }, token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.machine.state).toBe("boosting");
    expect(body.machine.memoryMb).toBe(8192);
    expect(body.event).toMatchObject({ fromState: "running", toState: "boosting" });
    expect(
      sandbox.calls.some(
        (call) =>
          call.method === "updateSpec" &&
          call.args[0] === machineId &&
          (call.args[1] as { memoryMb: number }).memoryMb === 8192,
      ),
    ).toBe(true);
    const boosted = (await auditEvents(token)).find((e) => e.type === "machine.boosted");
    expect(boosted?.payload).toEqual({ machineId, memoryMb: 8192 });
  });

  it("422s boosting from a non-running state and 400s a bad size", async () => {
    const { token } = await signup();
    const res = await app.request("/v1/machine/boost", jsonInit("POST", {}, token));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "illegal_transition", from: "provisioning", to: "boosting" });

    await transition(token, "running");
    expect(
      (await app.request("/v1/machine/boost", jsonInit("POST", { memoryMb: 1024 }, token))).status,
    ).toBe(400);
  });

  it("429s past the daily boost cap and audits abuse.limit_hit", async () => {
    const { token } = await signup();
    await transition(token, "running");
    for (let i = 0; i < ABUSE_LIMITS.maxBoostsPerDay; i++) {
      expect((await app.request("/v1/machine/boost", jsonInit("POST", {}, token))).status).toBe(200);
      for (const to of ["boosted", "shrinking", "running"]) {
        expect((await transition(token, to)).status).toBe(200);
      }
    }
    const res = await app.request("/v1/machine/boost", jsonInit("POST", {}, token));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("abuse_limit");
    expect(body.limit).toBe("boosts_per_day");
    expect(body.reason).toContain("Boost limit reached");

    const hit = (await auditEvents(token, "?type=abuse.limit_hit")).find(
      (e) => e.type === "abuse.limit_hit",
    );
    expect(hit?.payload).toMatchObject({
      limit: "boosts_per_day",
      count: ABUSE_LIMITS.maxBoostsPerDay,
      max: ABUSE_LIMITS.maxBoostsPerDay,
    });
  });
});

describe("audit trail API (§8.7)", () => {
  async function seedWrapperEvents(token: string, spaceId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const res = await app.request(
        `/v1/spaces/${spaceId}/wrappers`,
        jsonInit("POST", { kind: "passkey-prf", credentialId: `cred-${i}`, wrapped: "AAAA" }, token),
      );
      expect(res.status).toBe(200);
    }
  }

  it("paginates newest-first with a stable cursor and no gaps or overlaps", async () => {
    const { token, spaceId } = await signup();
    await seedWrapperEvents(token, spaceId, 5); // + account.created = 6 events

    const full = await (await app.request("/v1/audit?limit=50", authedInit(token))).json();
    expect(full.events).toHaveLength(6);
    expect(full.nextCursor).toBeNull();

    const page1 = await (await app.request("/v1/audit?limit=4", authedInit(token))).json();
    expect(page1.entries).toHaveLength(4);
    expect(page1.nextCursor).toBe(page1.entries[3].id);

    const page2 = await (
      await app.request(`/v1/audit?limit=4&cursor=${page1.nextCursor}`, authedInit(token))
    ).json();
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const paged = [...page1.entries, ...page2.entries].map((e: { id: string }) => e.id);
    expect(paged).toEqual(full.entries.map((e: { id: string }) => e.id));
    expect(new Set(paged).size).toBe(6);
    // Oldest event overall is the signup.
    expect(page2.entries[1].type).toBe("account.created");
  });

  it("filters by type, combined with pagination", async () => {
    const { token, spaceId } = await signup();
    await seedWrapperEvents(token, spaceId, 3);

    const filtered = await (
      await app.request("/v1/audit?type=keys.wrapper_added", authedInit(token))
    ).json();
    expect(filtered.entries).toHaveLength(3);
    for (const entry of filtered.entries) expect(entry.type).toBe("keys.wrapper_added");

    const page1 = await (
      await app.request("/v1/audit?type=keys.wrapper_added&limit=2", authedInit(token))
    ).json();
    expect(page1.entries).toHaveLength(2);
    const page2 = await (
      await app.request(
        `/v1/audit?type=keys.wrapper_added&limit=2&cursor=${page1.nextCursor}`,
        authedInit(token),
      )
    ).json();
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it("renders entries with human summaries and scopes them to the caller", async () => {
    const { token } = await signup();
    const body = await (await app.request("/v1/audit", authedInit(token))).json();
    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0];
    expect(entry.type).toBe("account.created");
    expect(entry.summary).toMatch(/^Account created for phase2-\d+@example\.com\.$/);
    expect(entry).toHaveProperty("actorDeviceId");
    expect(entry).toHaveProperty("createdAt");
  });

  it("400s a malformed cursor and returns an empty page for a stale one", async () => {
    const { token } = await signup();
    expect((await app.request("/v1/audit?cursor=not-a-uuid", authedInit(token))).status).toBe(400);
    const stale = await (
      await app.request(`/v1/audit?cursor=${crypto.randomUUID()}`, authedInit(token))
    ).json();
    expect(stale.events).toEqual([]);
    expect(stale.nextCursor).toBeNull();
  });

  it("summarize covers every audit type the codebase emits, plus a default", () => {
    const samples: Record<(typeof KNOWN_AUDIT_TYPES)[number], Record<string, unknown>> = {
      "account.created": { email: "a@example.com" },
      "auth.device_credential_registered": { deviceId: "d" },
      "auth.passkey_registered": { credentialId: "c", prfCapable: true },
      "device.enrolled": { deviceId: "d", name: "MBP" },
      "device.revoked": { deviceId: "d", reason: "stolen" },
      "space.updated": { spaceId: "s", egressPolicy: { from: "direct", to: "suma-ip" } },
      "keys.wrapper_added": { spaceId: "s", kind: "passkey-prf", credentialId: "c" },
      "keys.wrapper_rotated": { spaceId: "s", kind: "passkey-prf", credentialId: "c" },
      "keys.wrapper_removed": { wrapperId: "w", spaceId: "s", kind: "kms", credentialId: "c" },
      "keys.recovery_set": { spaceId: "s" },
      "machine.transition": { machineId: "m", from: "cold_booting", to: "running", reconstructed: true },
      "machine.boosted": { machineId: "m", memoryMb: 8192 },
      "job.mode_changed": { machineId: "m", ptyId: "pty-1", enabled: true },
      "capability.minted": { machineId: "m", caps: ["pty.spawn", "pty.io"] },
      "abuse.limit_hit": { limit: "boosts_per_day", reason: "Boost limit reached: 5 boosts in the last 24 hours (max 5)." },
      "files.uploaded": { fileId: "f", path: "/datasets/imagenet.tar", sizeBytes: 5_000_000 },
      "files.deleted": { fileId: "f", path: "/datasets/imagenet.tar", sizeBytes: 5_000_000 },
      "files.quota_blocked": { path: "/big.bin", incomingBytes: 1024, usedBytes: 1024 },
      "transfer.created": { transferId: "t", host: "releases.example.com", destPath: "/big.bin", eligibility: "public" },
      "transfer.cancelled": { transferId: "t", destPath: "/big.bin", from: "fetching" },
    };
    for (const type of KNOWN_AUDIT_TYPES) {
      const summary = summarize(type, samples[type]);
      expect(summary, `summary for ${type}`).toMatch(/^[A-Z].*\.$/);
      expect(summary).not.toContain("Unrecognized");
      // Every branch must also survive a missing payload.
      expect(summarize(type, null)).toMatch(/\.$/);
    }
    expect(summarize("machine.transition", samples["machine.transition"])).toBe(
      "Your machine moved from cold_booting to running (restored from cold start).",
    );
    expect(summarize("job.mode_changed", samples["job.mode_changed"])).toBe(
      "Job Mode was turned on for terminal pty-1 — the machine will stay awake.",
    );
    expect(summarize("something.new", { any: 1 })).toBe("Unrecognized event (something.new).");
  });
});
