/**
 * Compute mode (the "one virtual computer" choice): local-mode signups get
 * no VM, their first enrolled Mac becomes the home machine, and /v1/machine
 * answers with the mode instead of a misleading 404.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { toBase64 } from "@suma/protocol";
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

function randomPublicKeyB64(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return toBase64(raw);
}

let emailCounter = 0;

async function signup(computeMode?: "cloud" | "local") {
  const email = `mode-${emailCounter++}@example.com`;
  const res = await app.request(
    "/v1/accounts",
    jsonInit("POST", computeMode === undefined ? { email } : { email, computeMode }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  return { ...body, token: `hbr_dev_${body.user.id}` };
}

async function enroll(token: string, name: string) {
  const res = await app.request(
    "/v1/devices/enroll",
    jsonInit(
      "POST",
      { name, platform: "darwin", devicePublicKey: randomPublicKeyB64() },
      token,
    ),
  );
  expect(res.status).toBe(201);
  return res.json();
}

describe("local-mode signup", () => {
  it("creates no machine and never calls the sandbox provider", async () => {
    const before = sandbox.calls.filter((c) => c.method === "provision").length;
    const { user, space, machine } = await signup("local");
    expect(user.computeMode).toBe("local");
    expect(machine).toBeNull();
    expect(space.name).toBeTruthy();
    const after = sandbox.calls.filter((c) => c.method === "provision").length;
    expect(after).toBe(before);
  });

  it("defaults to cloud when the field is omitted, provisioning as before", async () => {
    const { user, machine } = await signup();
    expect(user.computeMode).toBe("cloud");
    expect(machine.state).toBe("provisioning");
  });
});

describe("home-machine recording at enroll", () => {
  it("first enrolled device wins the seat; the second cannot steal it", async () => {
    const { user, token } = await signup("local");
    const first = await enroll(token, "Home Mac");
    expect(first.isHomeMachine).toBe(true);
    const second = await enroll(token, "Laptop");
    expect(second.isHomeMachine).toBe(false);

    const machineRes = await app.request("/v1/machine", authedInit(token));
    expect(machineRes.status).toBe(200);
    const body = await machineRes.json();
    expect(body).toEqual({
      mode: "local",
      machine: null,
      events: [],
      homeDeviceId: first.device.id,
      homeOnline: false,
    });
    expect(body.homeDeviceId).not.toBe(second.device.id);
    void user;
  });

  it("cloud-mode enrolls never claim a home seat", async () => {
    const { token } = await signup("cloud");
    const enrolled = await enroll(token, "A Mac");
    expect(enrolled.isHomeMachine).toBe(false);
  });
});

describe("GET /v1/machine by mode", () => {
  it("answers 200 {mode:local, machine:null} before any device enrolls", async () => {
    const { token } = await signup("local");
    const res = await app.request("/v1/machine", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("local");
    expect(body.machine).toBeNull();
    expect(body.homeDeviceId).toBeNull();
  });

  it("cloud mode keeps the machine payload, now labeled", async () => {
    const { token } = await signup("cloud");
    const res = await app.request("/v1/machine", authedInit(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("cloud");
    expect(body.machine.state).toBe("provisioning");
  });
});
