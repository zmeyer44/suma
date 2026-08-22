import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSISTANT_FEATURE,
  type AssistantControlOptions,
} from "../src/assistant.js";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

const SERVICE_TOKEN = "assistant-service-test-token";
const OPTIONS: AssistantControlOptions = {
  serviceToken: SERVICE_TOKEN,
  defaultModel: "test/remote-model",
};

let db: Db;
let app: ReturnType<typeof createApp>;
let emailCounter = 0;

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  app = createApp(
    db,
    new StubSandboxProvider(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    OPTIONS,
  );
});

function requestInit(
  method: string,
  token: string,
  body?: unknown,
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function signupAndEnable(): Promise<{ userId: string; token: string }> {
  const response = await app.request(
    "/v1/accounts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `assistant-${emailCounter++}@example.com` }),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { user: { id: string } };
  const [user] = await db
    .select({ features: schema.users.features })
    .from(schema.users)
    .where(eq(schema.users.id, body.user.id));
  await db
    .update(schema.users)
    .set({ features: [...(user?.features ?? []), ASSISTANT_FEATURE] })
    .where(eq(schema.users.id, body.user.id));
  return { userId: body.user.id, token: `hbr_dev_${body.user.id}` };
}

async function mintCode(token: string): Promise<string> {
  const response = await app.request(
    "/v1/channels/link-code",
    requestInit("POST", token),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { code: string; expiresAt: string };
  expect(body.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  return body.code;
}

const identity = {
  channel: "bluebubbles",
  accountId: "family-mac",
  externalUserId: "+15555550123",
};

describe("assistant channel linking", () => {
  it("links, resolves on every message, and revokes immediately", async () => {
    const { userId, token } = await signupAndEnable();
    const code = await mintCode(token);

    const storedCodes = await db.select().from(schema.assistantLinkCodes);
    expect(storedCodes).toHaveLength(1);
    expect(storedCodes[0]?.codeHash).toBe(
      createHash("sha256").update(code.replace("-", "")).digest("hex"),
    );
    expect(JSON.stringify(storedCodes)).not.toContain(code);

    const redeem = await app.request(
      "/v1/assistant/link-redeem",
      requestInit("POST", SERVICE_TOKEN, {
        code,
        ...identity,
        displayName: "Claudius",
      }),
    );
    expect(redeem.status).toBe(201);
    const redeemed = (await redeem.json()) as {
      link: { id: string; userId: string };
      policy: { model: string; enabledToolGroups: string[] };
    };
    expect(redeemed.link.userId).toBe(userId);
    expect(redeemed.policy.model).toBe("test/remote-model");
    expect(redeemed.policy.enabledToolGroups).toContain("interact");
    expect(redeemed.policy.enabledToolGroups).not.toContain("history");

    const replay = await app.request(
      "/v1/assistant/link-redeem",
      requestInit("POST", SERVICE_TOKEN, { code, ...identity }),
    );
    expect(replay.status).toBe(401);

    const resolved = await app.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", SERVICE_TOKEN, identity),
    );
    expect(resolved.status).toBe(200);
    expect(
      ((await resolved.json()) as { link: { userId: string } }).link.userId,
    ).toBe(userId);

    const listed = await app.request(
      "/v1/channels/links",
      requestInit("GET", token),
    );
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { links: Array<{ id: string }> }).links.map(
        (link) => link.id,
      ),
    ).toEqual([redeemed.link.id]);

    const revoked = await app.request(
      `/v1/channels/links/${redeemed.link.id}`,
      requestInit("DELETE", token),
    );
    expect(revoked.status).toBe(200);

    const afterRevoke = await app.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", SERVICE_TOKEN, identity),
    );
    expect(afterRevoke.status).toBe(404);
  });

  it("enforces remote policy independently and uses feature removal as a kill switch", async () => {
    const { userId, token } = await signupAndEnable();
    const code = await mintCode(token);
    await app.request(
      "/v1/assistant/link-redeem",
      requestInit("POST", SERVICE_TOKEN, { code, ...identity }),
    );

    const patched = await app.request(
      "/v1/assistant/policy",
      requestInit("PATCH", token, {
        model: "openai/test-model",
        enabledToolGroups: ["tabs", "navigate", "history", "read"],
        maxSteps: 12,
        dailyWakeMinutes: 30,
        autoSuspendMinutes: 5,
      }),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()) as unknown).toMatchObject({
      policy: {
        model: "openai/test-model",
        enabledToolGroups: ["tabs", "navigate", "history", "read"],
        maxSteps: 12,
        dailyWakeMinutes: 30,
        autoSuspendMinutes: 5,
      },
    });

    const invalid = await app.request(
      "/v1/assistant/policy",
      requestInit("PATCH", token, { enabledToolGroups: ["root-shell"] }),
    );
    expect(invalid.status).toBe(400);

    await db
      .update(schema.users)
      .set({ features: ["inference"] })
      .where(eq(schema.users.id, userId));
    const resolved = await app.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", SERVICE_TOKEN, identity),
    );
    expect(resolved.status).toBe(404);
    const mint = await app.request(
      "/v1/channels/link-code",
      requestInit("POST", token),
    );
    expect(mint.status).toBe(403);
  });

  it("does not allow one external identity to link to two users", async () => {
    const first = await signupAndEnable();
    const second = await signupAndEnable();
    const firstCode = await mintCode(first.token);
    const secondCode = await mintCode(second.token);

    expect(
      (
        await app.request(
          "/v1/assistant/link-redeem",
          requestInit("POST", SERVICE_TOKEN, { code: firstCode, ...identity }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          "/v1/assistant/link-redeem",
          requestInit("POST", SERVICE_TOKEN, { code: secondCode, ...identity }),
        )
      ).status,
    ).toBe(409);
  });

  it("mints a machine-bound capability session only for a live link", async () => {
    const { userId, token } = await signupAndEnable();
    const code = await mintCode(token);
    const redeem = await app.request(
      "/v1/assistant/link-redeem",
      requestInit("POST", SERVICE_TOKEN, { code, ...identity }),
    );
    const linked = (await redeem.json()) as { link: { id: string } };
    const [machine] = await db
      .update(schema.machines)
      .set({ state: "running", agentAddress: "vm.internal:2222" })
      .where(eq(schema.machines.userId, userId))
      .returning();
    expect(machine).toBeDefined();

    const session = await app.request(
      "/v1/assistant/machine-session",
      requestInit("POST", SERVICE_TOKEN, {
        userId,
        linkId: linked.link.id,
      }),
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      agentAddress: string;
      capabilityToken: string;
      caps: string[];
      state: string;
    };
    expect(body.agentAddress).toBe("vm.internal:2222");
    expect(body.state).toBe("running");
    expect(body.caps).toEqual(
      expect.arrayContaining(["pty.spawn", "pty.io", "fs.read", "fs.write"]),
    );
    expect(body.capabilityToken.split(".")[0]).toBe(
      "eyJhbGciOiJFZERTQSIsInR5cCI6InN1bWEtY2FwK2p3cyJ9",
    );

    const forgedLink = await app.request(
      "/v1/assistant/machine-session",
      requestInit("POST", SERVICE_TOKEN, {
        userId,
        linkId: crypto.randomUUID(),
      }),
    );
    expect(forgedLink.status).toBe(404);
  });

  it("keeps assistant, device, and capability credential families disjoint", async () => {
    const { token } = await signupAndEnable();
    const deviceOnServiceRoute = await app.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", token, identity),
    );
    expect(deviceOnServiceRoute.status).toBe(401);
    expect(
      (
        await app.request(
          "/v1/assistant/machine-session",
          requestInit("POST", token, {
            userId: crypto.randomUUID(),
            linkId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(401);

    const serviceOnDeviceRoute = await app.request(
      "/v1/me",
      requestInit("GET", SERVICE_TOKEN),
    );
    expect(serviceOnDeviceRoute.status).toBe(401);

    const capabilityShapedToken = "header.payload.signature";
    const capabilityOnServiceRoute = await app.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", capabilityShapedToken, identity),
    );
    expect(capabilityOnServiceRoute.status).toBe(401);

    const closed = createApp(db, new StubSandboxProvider());
    const unconfigured = await closed.request(
      "/v1/assistant/links/resolve",
      requestInit("POST", SERVICE_TOKEN, identity),
    );
    expect(unconfigured.status).toBe(503);
  });
});
