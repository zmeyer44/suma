import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { toBase64 } from "@suma/protocol";
import { SEED_CORPUS } from "@suma/config";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let sandbox: StubSandboxProvider;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  sandbox = new StubSandboxProvider();
  app = createApp(db, sandbox);
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

function randomPublicKeyB64(bytes = 32): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

/** Guarantees distinct created_at microseconds where tests assert ordering. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

let emailCounter = 0;

async function signup(): Promise<{
  user: { id: string; email: string; homeRegion: string };
  space: { id: string; name: string; egressPolicy: string };
  machine: { id: string; state: string; region: string };
  token: string;
}> {
  const email = `user-${emailCounter++}@example.com`;
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const body = await res.json();
  return { ...body, token: `hbr_dev_${body.user.id}` };
}

async function auditTypes(token: string, limit = 50): Promise<string[]> {
  const res = await app.request(`/v1/audit?limit=${limit}`, authedInit(token));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.events.map((e: { type: string }) => e.type);
}

describe("healthz", () => {
  it("responds without auth at / and /v1", async () => {
    for (const path of ["/healthz", "/v1/healthz"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });
});

describe("auth", () => {
  it("401s without an Authorization header", async () => {
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("401s on malformed tokens", async () => {
    for (const header of [
      "Bearer nope",
      "Bearer hbr_dev_not-a-uuid",
      "Basic hbr_dev_00000000-0000-4000-8000-000000000000",
      "hbr_dev_00000000-0000-4000-8000-000000000000",
      "Bearer hbr_dev_00000000-0000-4000-8000-000000000000.not-a-uuid",
      "Bearer hbr_dev_00000000-0000-4000-8000-000000000000.00000000-0000-4000-8000-000000000000.00000000-0000-4000-8000-000000000000",
    ]) {
      const res = await app.request("/v1/me", {
        headers: { authorization: header },
      });
      expect(res.status).toBe(401);
    }
  });

  it("401s for a well-formed token naming no user", async () => {
    const res = await app.request(
      "/v1/me",
      authedInit(`hbr_dev_${crypto.randomUUID()}`),
    );
    expect(res.status).toBe(401);
  });

  it("401s on mutating routes too", async () => {
    const res = await app.request(
      "/v1/spaces",
      jsonInit("POST", { name: "X", color: "#fff" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/accounts", () => {
  it("creates user, default space, provisioning machine, and audit event", async () => {
    const { user, space, machine, token } = await signup();
    expect(user.email).toMatch(/@example\.com$/);
    expect(user.homeRegion).toBe("iad");
    expect(space.name).toBe("Personal");
    expect(space.egressPolicy).toBe("direct");
    expect(machine.state).toBe("provisioning");
    expect(machine.region).toBe("iad");

    const provisioned = sandbox.calls.filter(
      (call) => call.method === "provision",
    );
    expect(provisioned.length).toBeGreaterThan(0);

    expect(await auditTypes(token)).toContain("account.created");
  });

  it("409s on duplicate email, case-insensitively", async () => {
    const { user } = await signup();
    for (const email of [user.email, user.email.toUpperCase()]) {
      const res = await app.request(
        "/v1/accounts",
        jsonInit("POST", { email }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "email_taken" });
    }
  });

  it("400s on an invalid email", async () => {
    const res = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email: "not-an-email" }),
    );
    expect(res.status).toBe(400);
  });

  it("honors homeRegion", async () => {
    const email = `user-${emailCounter++}@example.com`;
    const res = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email, homeRegion: "fra", displayName: "Traveler" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.homeRegion).toBe("fra");
    expect(body.machine.region).toBe("fra");
  });
});

describe("GET /v1/me", () => {
  it("returns user, spaces, machine, and device count", async () => {
    const { user, token } = await signup();
    const res = await app.request("/v1/me", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(body.spaces).toHaveLength(1);
    expect(body.machine.state).toBe("provisioning");
    expect(body.deviceCount).toBe(0);

    await app.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        {
          name: "MBP",
          platform: "darwin",
          devicePublicKey: randomPublicKeyB64(),
        },
        token,
      ),
    );
    const after = await (await app.request("/v1/me", authedInit(token))).json();
    expect(after.deviceCount).toBe(1);
  });
});

describe("devices", () => {
  it("enrolls a device and returns a device-bound hub token", async () => {
    const { user, token } = await signup();
    const devicePublicKey = randomPublicKeyB64();
    const res = await app.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        { name: "MBP", platform: "darwin", devicePublicKey },
        token,
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.device.name).toBe("MBP");
    expect(body.device.devicePublicKey).toBe(devicePublicKey);
    expect(body.hubToken).toBe(`hbr_dev_${user.id}.${body.device.id}`);
    expect(await auditTypes(token)).toContain("device.enrolled");
  });

  it("400s on a public key that is not 32 bytes of base64", async () => {
    const { token } = await signup();
    for (const devicePublicKey of ["not base64!!!", randomPublicKeyB64(16)]) {
      const res = await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          { name: "MBP", platform: "darwin", devicePublicKey },
          token,
        ),
      );
      expect(res.status).toBe(400);
    }
  });

  it("409s when enrolling an already-enrolled public key", async () => {
    const { token } = await signup();
    const devicePublicKey = randomPublicKeyB64();
    const enroll = () =>
      app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          { name: "MBP", platform: "darwin", devicePublicKey },
          token,
        ),
      );
    expect((await enroll()).status).toBe(201);
    const res = await enroll();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "device_already_enrolled" });
  });

  it("lists devices with revoked status", async () => {
    const { token } = await signup();
    await app.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        {
          name: "MBP",
          platform: "darwin",
          devicePublicKey: randomPublicKeyB64(),
        },
        token,
      ),
    );
    const res = await app.request("/v1/devices", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].revoked).toBe(false);
  });

  it("renames an enrolled device and records the audit event", async () => {
    const { token } = await signup();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "MBP",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          token,
        ),
      )
    ).json();

    const renamed = await app.request(
      `/v1/devices/${enrolled.device.id}`,
      jsonInit("PATCH", { name: "Office MacBook Pro" }, token),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).device.name).toBe("Office MacBook Pro");
    expect(await auditTypes(token)).toContain("device.renamed");

    const listed = await (
      await app.request("/v1/devices", authedInit(token))
    ).json();
    expect(listed.devices[0].name).toBe("Office MacBook Pro");

    const other = await signup();
    expect(
      (
        await app.request(
          `/v1/devices/${enrolled.device.id}`,
          jsonInit("PATCH", { name: "Not yours" }, other.token),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/v1/devices/${enrolled.device.id}`,
          jsonInit("PATCH", { name: "  " }, token),
        )
      ).status,
    ).toBe(400);
  });

  it("revokes with the honest §8.2 contract", async () => {
    const { token } = await signup();
    const devicePublicKey = randomPublicKeyB64();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          { name: "Stolen", platform: "darwin", devicePublicKey },
          token,
        ),
      )
    ).json();

    const res = await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", { reason: "stolen" }, token),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device.revokedAt).toBeTruthy();
    expect(body.device.revocationReason).toBe("stolen");
    expect(body.controlPlaneAccessRevoked).toBe(true);
    expect(body.stoppedFutureAccess).toBe(true);
    expect(body.purgeOnReconnect).toBe(true);
    expect(body.cannotInvalidateThirdPartySessions).toBe(true);

    const tier1 = SEED_CORPUS.filter((o) => o.syncTier === 1);
    expect(body.affectedOrigins).toHaveLength(tier1.length);
    const byDomain = new Map(
      body.affectedOrigins.map(
        (o: { domain: string }) => [o.domain, o] as const,
      ),
    );
    expect(byDomain.get("github.com")).toEqual({
      domain: "github.com",
      label: "GitHub",
      remoteLogoutUrl: "https://github.com/settings/sessions",
    });
    expect(byDomain.get("google.com")).toMatchObject({
      remoteLogoutUrl: "https://myaccount.google.com/device-activity",
    });
    expect(byDomain.get("slack.com")).toMatchObject({
      remoteLogoutUrl: "https://my.slack.com/account/settings#sessions",
    });
    // Tier-0 (unsynced) origins carry no third-party session exposure.
    expect(byDomain.has("netflix.com")).toBe(false);
    expect(byDomain.has("chase.com")).toBe(false);

    expect(await auditTypes(token)).toContain("device.revoked");

    const listed = await (
      await app.request("/v1/devices", authedInit(token))
    ).json();
    expect(listed.devices[0].revoked).toBe(true);
    const me = await (await app.request("/v1/me", authedInit(token))).json();
    expect(me.deviceCount).toBe(0);
  });

  it("409s when enrolling a revoked device's public key", async () => {
    const { token } = await signup();
    const devicePublicKey = randomPublicKeyB64();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          { name: "Old", platform: "darwin", devicePublicKey },
          token,
        ),
      )
    ).json();
    await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", {}, token),
    );

    const res = await app.request(
      "/v1/devices/enroll",
      jsonInit(
        "POST",
        { name: "Old again", platform: "darwin", devicePublicKey },
        token,
      ),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "device_revoked" });
  });

  it("device-bound token authenticates until revocation, then 401s everywhere", async () => {
    const { user, token } = await signup();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "MBP",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          token,
        ),
      )
    ).json();
    const deviceToken = enrolled.hubToken as string;
    expect(deviceToken).toBe(`hbr_dev_${user.id}.${enrolled.device.id}`);

    // Pre-revocation the device-bound token works on reads and mutations.
    expect((await app.request("/v1/me", authedInit(deviceToken))).status).toBe(
      200,
    );
    const created = await app.request(
      "/v1/spaces",
      jsonInit("POST", { name: "From device", color: "#111111" }, deviceToken),
    );
    expect(created.status).toBe(201);

    const revoke = await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", { reason: "stolen" }, token),
    );
    expect(revoke.status).toBe(200);

    // Post-revocation the device-bound token 401s on every route class.
    expect((await app.request("/v1/me", authedInit(deviceToken))).status).toBe(
      401,
    );
    expect(
      (await app.request("/v1/devices", authedInit(deviceToken))).status,
    ).toBe(401);
    expect(
      (await app.request("/v1/machine", authedInit(deviceToken))).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "/v1/spaces",
          jsonInit("POST", { name: "Sneaky", color: "#000000" }, deviceToken),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "/v1/machine/transition",
          jsonInit("POST", { to: "running" }, deviceToken),
        )
      ).status,
    ).toBe(401);

    // The user-scoped bootstrap token remains valid (signup → re-enroll path).
    expect((await app.request("/v1/me", authedInit(token))).status).toBe(200);
  });

  it("401s a device-bound token naming an unknown or foreign device", async () => {
    const a = await signup();
    const b = await signup();
    const enrolledB = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "Theirs",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          b.token,
        ),
      )
    ).json();

    const unknown = await app.request(
      "/v1/me",
      authedInit(`hbr_dev_${a.user.id}.${crypto.randomUUID()}`),
    );
    expect(unknown.status).toBe(401);

    const foreign = await app.request(
      "/v1/me",
      authedInit(`hbr_dev_${a.user.id}.${enrolledB.device.id}`),
    );
    expect(foreign.status).toBe(401);
  });

  it("404s revoking an unknown or foreign device", async () => {
    const { token } = await signup();
    const other = await signup();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "Theirs",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          other.token,
        ),
      )
    ).json();

    const unknown = await app.request(
      `/v1/devices/${crypto.randomUUID()}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect(unknown.status).toBe(404);

    const foreign = await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", {}, token),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("spaces", () => {
  it("lists, creates with increasing position, and patches", async () => {
    const { token } = await signup();
    const initial = await (
      await app.request("/v1/spaces", authedInit(token))
    ).json();
    expect(initial.spaces.map((s: { name: string }) => s.name)).toEqual([
      "Personal",
    ]);

    const created = await app.request(
      "/v1/spaces",
      jsonInit(
        "POST",
        { name: "Work", color: "#EF4444", egressPolicy: "suma-ip" },
        token,
      ),
    );
    expect(created.status).toBe(201);
    const work = (await created.json()).space;
    expect(work.position).toBe(1);
    expect(work.egressPolicy).toBe("suma-ip");

    const patched = await app.request(
      `/v1/spaces/${work.id}`,
      jsonInit("PATCH", { name: "Client work", color: "#10B981" }, token),
    );
    expect(patched.status).toBe(200);
    const updated = (await patched.json()).space;
    expect(updated.name).toBe("Client work");
    expect(updated.color).toBe("#10B981");
  });

  it("audits space.updated on egressPolicy change", async () => {
    const { space, token } = await signup();
    expect(await auditTypes(token)).not.toContain("space.updated");

    const res = await app.request(
      `/v1/spaces/${space.id}`,
      jsonInit("PATCH", { egressPolicy: "suma-ip" }, token),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).space.egressPolicy).toBe("suma-ip");

    const events = await (
      await app.request("/v1/audit", authedInit(token))
    ).json();
    const updatedEvent = events.events.find(
      (e: { type: string }) => e.type === "space.updated",
    );
    expect(updatedEvent.payload).toEqual({
      spaceId: space.id,
      egressPolicy: { from: "direct", to: "suma-ip" },
    });
  });

  it("rejects bad egress policies and foreign or unknown spaces", async () => {
    const { space, token } = await signup();
    const other = await signup();

    const badPolicy = await app.request(
      "/v1/spaces",
      jsonInit(
        "POST",
        { name: "X", color: "#fff", egressPolicy: "vpn" },
        token,
      ),
    );
    expect(badPolicy.status).toBe(400);

    const unknown = await app.request(
      `/v1/spaces/${crypto.randomUUID()}`,
      jsonInit("PATCH", { name: "Y" }, token),
    );
    expect(unknown.status).toBe(404);

    const foreign = await app.request(
      `/v1/spaces/${space.id}`,
      jsonInit("PATCH", { name: "Mine now" }, other.token),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("key wrappers", () => {
  it("upserts, lists, and deletes wrappers with audit", async () => {
    const { space, token } = await signup();
    const base = `/v1/spaces/${space.id}/wrappers`;

    const first = await app.request(
      base,
      jsonInit(
        "POST",
        {
          kind: "passkey-prf",
          credentialId: "cred-1",
          wrapped: toBase64(new Uint8Array([1, 2, 3])),
        },
        token,
      ),
    );
    expect(first.status).toBe(200);
    const firstWrapper = (await first.json()).wrapper;
    expect(firstWrapper.salt).toBe("");

    const afterAdd = await (
      await app.request("/v1/audit", authedInit(token))
    ).json();
    const addedEvent = afterAdd.events.find(
      (e: { type: string }) => e.type === "keys.wrapper_added",
    );
    expect(addedEvent.payload).toEqual({
      spaceId: space.id,
      kind: "passkey-prf",
      credentialId: "cred-1",
    });
    expect(await auditTypes(token)).not.toContain("keys.wrapper_rotated");

    // Same (space, kind, credential) tuple → update in place, not a new row.
    const rewrapped = toBase64(new Uint8Array([9, 9, 9]));
    const second = await app.request(
      base,
      jsonInit(
        "POST",
        { kind: "passkey-prf", credentialId: "cred-1", wrapped: rewrapped },
        token,
      ),
    );
    expect(second.status).toBe(200);
    const secondWrapper = (await second.json()).wrapper;
    expect(secondWrapper.id).toBe(firstWrapper.id);
    expect(secondWrapper.wrapped).toBe(rewrapped);

    const afterRotate = await (
      await app.request("/v1/audit", authedInit(token))
    ).json();
    const rotatedEvent = afterRotate.events.find(
      (e: { type: string }) => e.type === "keys.wrapper_rotated",
    );
    expect(rotatedEvent.payload).toEqual({
      spaceId: space.id,
      kind: "passkey-prf",
      credentialId: "cred-1",
    });

    const recovery = await app.request(
      base,
      jsonInit(
        "POST",
        {
          kind: "recovery-code",
          credentialId: "recovery",
          salt: toBase64(new Uint8Array(16)),
          wrapped: toBase64(new Uint8Array([4, 5, 6])),
        },
        token,
      ),
    );
    expect(recovery.status).toBe(200);

    const listed = await (await app.request(base, authedInit(token))).json();
    expect(listed.wrappers).toHaveLength(2);

    const del = await app.request(`${base}/${firstWrapper.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(await auditTypes(token)).toContain("keys.wrapper_removed");

    const afterDelete = await (
      await app.request(base, authedInit(token))
    ).json();
    expect(afterDelete.wrappers).toHaveLength(1);

    const again = await app.request(`${base}/${firstWrapper.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(404);
  });

  it("rejects invalid payloads and foreign spaces", async () => {
    const { space, token } = await signup();
    const other = await signup();

    const badKind = await app.request(
      `/v1/spaces/${space.id}/wrappers`,
      jsonInit(
        "POST",
        { kind: "post-it-note", credentialId: "c", wrapped: "AAAA" },
        token,
      ),
    );
    expect(badKind.status).toBe(400);

    const badB64 = await app.request(
      `/v1/spaces/${space.id}/wrappers`,
      jsonInit(
        "POST",
        { kind: "kms", credentialId: "c", wrapped: "not base64!!!" },
        token,
      ),
    );
    expect(badB64.status).toBe(400);

    const foreign = await app.request(
      `/v1/spaces/${space.id}/wrappers`,
      jsonInit(
        "POST",
        { kind: "kms", credentialId: "c", wrapped: "AAAA" },
        other.token,
      ),
    );
    expect(foreign.status).toBe(404);

    const foreignList = await app.request(
      `/v1/spaces/${space.id}/wrappers`,
      authedInit(other.token),
    );
    expect(foreignList.status).toBe(404);
  });
});

describe("machine lifecycle", () => {
  async function transition(
    token: string,
    to: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    return app.request(
      "/v1/machine/transition",
      jsonInit("POST", { to, ...extra }, token),
    );
  }

  it("walks every legal transition and surfaces cold-boot reconstruction", async () => {
    const { machine, token } = await signup();

    const chain = [
      "running",
      "suspending",
      "suspended",
      "resuming",
      "running",
      "boosting",
      "boosted",
      "shrinking",
      "running",
      "suspending",
      "suspended",
    ];
    for (const to of chain) {
      // This machine never reports activity, so the §8.5 guard refuses an
      // AUTO-suspend; driving the state machine here is the explicit
      // user-initiated kind, which is exactly what `force` means.
      const res = await transition(
        token,
        to,
        to === "suspending" ? { force: true } : {},
      );
      expect(res.status).toBe(200);
      expect((await res.json()).machine.state).toBe(to);
    }

    const coldBoot = await transition(token, "cold_booting", {
      reconstructed: true,
      detail: "snapshot failed to restore",
    });
    expect(coldBoot.status).toBe(200);
    const coldBootBody = await coldBoot.json();
    expect(coldBootBody.event.reconstructed).toBe(true);
    expect(coldBootBody.event.fromState).toBe("suspended");
    expect((await transition(token, "running")).status).toBe(200);

    const suspendCalls = sandbox.calls.filter(
      (call) => call.method === "suspend" && call.args[0] === machine.id,
    );
    expect(suspendCalls).toHaveLength(2);
    expect(
      sandbox.calls.some(
        (call) => call.method === "coldBoot" && call.args[0] === machine.id,
      ),
    ).toBe(true);

    const status = await (
      await app.request("/v1/machine", authedInit(token))
    ).json();
    expect(status.machine.state).toBe("running");
    expect(status.events.length).toBeLessThanOrEqual(20);
    expect(status.events[0].toState).toBe("running");
    expect(await auditTypes(token, 200)).toContain("machine.transition");
  });

  it("422s an illegal transition without recording it", async () => {
    const { token } = await signup();
    await transition(token, "running");

    const res = await transition(token, "suspended");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "illegal_transition",
      from: "running",
      to: "suspended",
    });

    const status = await (
      await app.request("/v1/machine", authedInit(token))
    ).json();
    expect(status.machine.state).toBe("running");
    expect(status.events).toHaveLength(1);
  });

  it("rejects the loser of concurrent transitions instead of double-applying", async () => {
    const { token } = await signup();
    await transition(token, "running");

    // Both requests imply from=running; only one conditional UPDATE can match.
    // Forced (user-initiated) so the §8.5 guard is not what refuses either.
    const [r1, r2] = await Promise.all([
      transition(token, "suspending", { force: true }),
      transition(token, "suspending", { force: true }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    // The loser either lost the conditional-UPDATE race after validating
    // against the stale from-state (409) or read the already-moved state and
    // failed validation (422). Never a second 200.
    expect([409, 422]).toContain(statuses[1]);
    const loser = r1.status === 200 ? r2 : r1;
    expect(["conflict", "illegal_transition"]).toContain(
      (await loser.json()).error,
    );

    const status = await (
      await app.request("/v1/machine", authedInit(token))
    ).json();
    expect(status.machine.state).toBe("suspending");
    // Only the winner recorded an event: →running, then one →suspending.
    expect(status.events).toHaveLength(2);
  });

  it("400s an unknown state and starts machines in provisioning", async () => {
    const { token } = await signup();
    const bad = await transition(token, "warp_speed");
    expect(bad.status).toBe(400);

    const status = await (
      await app.request("/v1/machine", authedInit(token))
    ).json();
    expect(status.machine.state).toBe("provisioning");
    expect(status.events).toEqual([]);
  });
});

describe("input bounds", () => {
  it("400s oversized signup fields", async () => {
    for (const body of [
      { email: `${"a".repeat(321)}@example.com` },
      {
        email: `bounds-${emailCounter++}@example.com`,
        displayName: "d".repeat(201),
      },
      {
        email: `bounds-${emailCounter++}@example.com`,
        homeRegion: "r".repeat(17),
      },
    ]) {
      const res = await app.request("/v1/accounts", jsonInit("POST", body));
      expect(res.status).toBe(400);
    }
  });

  it("400s oversized device enrollment fields", async () => {
    const { token } = await signup();
    const devicePublicKey = randomPublicKeyB64();
    for (const body of [
      { name: "n".repeat(201), platform: "darwin", devicePublicKey },
      { name: "MBP", platform: "p".repeat(65), devicePublicKey },
      { name: "MBP", platform: "darwin", devicePublicKey: "A".repeat(600) },
    ]) {
      const res = await app.request(
        "/v1/devices/enroll",
        jsonInit("POST", body, token),
      );
      expect(res.status).toBe(400);
    }
  });

  it("400s an oversized revocation reason", async () => {
    const { token } = await signup();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "MBP",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          token,
        ),
      )
    ).json();
    const res = await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", { reason: "r".repeat(201) }, token),
    );
    expect(res.status).toBe(400);
  });

  it("400s oversized space fields and out-of-range position", async () => {
    const { space, token } = await signup();
    for (const body of [
      { name: "n".repeat(201), color: "#fff" },
      { name: "X", color: "c".repeat(33) },
    ]) {
      expect(
        (await app.request("/v1/spaces", jsonInit("POST", body, token))).status,
      ).toBe(400);
    }
    for (const body of [
      { position: 100001 },
      { name: "n".repeat(201) },
      { color: "c".repeat(33) },
    ]) {
      const res = await app.request(
        `/v1/spaces/${space.id}`,
        jsonInit("PATCH", body, token),
      );
      expect(res.status).toBe(400);
    }
    // Boundary: position 100000 is still legal.
    const ok = await app.request(
      `/v1/spaces/${space.id}`,
      jsonInit("PATCH", { position: 100000 }, token),
    );
    expect(ok.status).toBe(200);
  });

  it("400s oversized wrapper fields", async () => {
    const { space, token } = await signup();
    const base = `/v1/spaces/${space.id}/wrappers`;
    for (const body of [
      { kind: "kms", credentialId: "c".repeat(513), wrapped: "AAAA" },
      { kind: "kms", credentialId: "c", wrapped: "A".repeat(16388) },
      {
        kind: "kms",
        credentialId: "c",
        salt: "A".repeat(1028),
        wrapped: "AAAA",
      },
    ]) {
      expect(
        (await app.request(base, jsonInit("POST", body, token))).status,
      ).toBe(400);
    }
  });

  it("400s an oversized transition detail without moving state", async () => {
    const { token } = await signup();
    const res = await app.request(
      "/v1/machine/transition",
      jsonInit("POST", { to: "running", detail: "d".repeat(201) }, token),
    );
    expect(res.status).toBe(400);
    const status = await (
      await app.request("/v1/machine", authedInit(token))
    ).json();
    expect(status.machine.state).toBe("provisioning");
  });
});

describe("audit trail", () => {
  it("returns events newest first and honors limit", async () => {
    const { token } = await signup();
    await tick();
    const enrolled = await (
      await app.request(
        "/v1/devices/enroll",
        jsonInit(
          "POST",
          {
            name: "MBP",
            platform: "darwin",
            devicePublicKey: randomPublicKeyB64(),
          },
          token,
        ),
      )
    ).json();
    await tick();
    await app.request(
      `/v1/devices/${enrolled.device.id}/revoke`,
      jsonInit("POST", {}, token),
    );

    expect(await auditTypes(token)).toEqual([
      "device.revoked",
      "device.enrolled",
      "account.created",
    ]);
    expect(await auditTypes(token, 2)).toEqual([
      "device.revoked",
      "device.enrolled",
    ]);

    const badLimit = await app.request("/v1/audit?limit=0", authedInit(token));
    expect(badLimit.status).toBe(400);
  });

  it("scopes the trail to the caller", async () => {
    const a = await signup();
    const b = await signup();
    await app.request(
      `/v1/spaces/${a.space.id}`,
      jsonInit("PATCH", { egressPolicy: "suma-ip" }, a.token),
    );
    expect(await auditTypes(a.token)).toContain("space.updated");
    expect(await auditTypes(b.token)).toEqual(["account.created"]);
  });
});
