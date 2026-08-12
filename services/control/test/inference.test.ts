import { createServer, type IncomingMessage, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { INFERENCE_DISABLED, INFERENCE_FEATURE } from "../src/inference.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

/**
 * Vended inference (src/inference.ts): the metered /v1/ai/gateway/* proxy
 * that swaps a device token for the operator's upstream gateway key. The
 * upstream here is a local recorder so every assertion about what crosses
 * the wire — headers, body, path — is against what actually arrived.
 */

const UPSTREAM_KEY = "upstream-secret-key";
const DAILY_CAP = 3;

interface SeenRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  cookie: string | undefined;
  contentType: string | undefined;
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: SeenRequest[] = [];

let db: Db;
let app: ReturnType<typeof createApp>;
let closedApp: ReturnType<typeof createApp>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        path: req.url ?? "",
        method: req.method ?? "",
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        contentType: req.headers["content-type"],
        body,
      });
      if (req.url === "/v1/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"delta":"hel"}\n\n');
        res.write('data: {"delta":"lo"}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/boom")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad model" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          model: "anthropic/claude-opus-5",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  upstreamUrl = `http://127.0.0.1:${address.port}`;

  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const options = {
    upstreamUrl,
    apiKey: UPSTREAM_KEY,
    dailyRequestCap: DAILY_CAP,
  };
  app = createApp(
    db,
    new StubSandboxProvider(),
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  closedApp = createApp(
    db,
    new StubSandboxProvider(),
    undefined,
    undefined,
    undefined,
    undefined,
    INFERENCE_DISABLED,
  );
});

afterAll(() => {
  upstream.close();
});

let emailCounter = 0;
async function makeUser(features: string[]): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `inference-${emailCounter++}@example.com`, features })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("insert failed");
  return user.id;
}

function chatRequest(token: string, body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      cookie: "secret-session=1",
    },
    body: JSON.stringify(
      body ?? { model: "anthropic/claude-opus-5", messages: [] },
    ),
  };
}

describe("vended inference proxy (/v1/ai/gateway)", () => {
  it("requires device auth like every /v1 route", async () => {
    const res = await app.request(
      "/v1/ai/gateway/v1/chat/completions",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });

  it("is closed (404) when no upstream key is configured", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const res = await closedApp.request(
      "/v1/ai/gateway/v1/chat/completions",
      chatRequest(`hbr_dev_${userId}`),
    );
    expect(res.status).toBe(404);
  });

  it("refuses accounts without the inference feature", async () => {
    const userId = await makeUser(["files"]);
    const res = await app.request(
      "/v1/ai/gateway/v1/chat/completions",
      chatRequest(`hbr_dev_${userId}`),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "feature_required",
      feature: INFERENCE_FEATURE,
    });
  });

  it("proxies with the operator key, never the caller's credentials", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const res = await app.request(
      "/v1/ai/gateway/v1/chat/completions",
      chatRequest(`hbr_dev_${userId}`),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { usage: Record<string, number> };
    expect(payload.usage.completion_tokens).toBe(34);

    const last = seen.at(-1);
    expect(last?.path).toBe("/v1/chat/completions");
    expect(last?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    // The device token and browser-ish headers must not cross the boundary.
    expect(last?.cookie).toBeUndefined();
    expect(last?.body).toContain("anthropic/claude-opus-5");
    expect(last?.contentType).toBe("application/json");
  });

  it("records a usage row with model and token counts", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    await app.request(
      "/v1/ai/gateway/v1/chat/completions",
      chatRequest(`hbr_dev_${userId}`),
    );
    const rows = await db
      .select()
      .from(schema.inferenceUsage)
      .where(eq(schema.inferenceUsage.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: "/v1/chat/completions",
      model: "anthropic/claude-opus-5",
      status: 200,
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it("streams SSE bodies through untouched, metering the request", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const res = await app.request(
      "/v1/ai/gateway/v1/stream",
      chatRequest(`hbr_dev_${userId}`, { model: "anthropic/claude-sonnet-5", stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"delta":"hel"}');
    expect(text).toContain("data: [DONE]");

    const rows = await db
      .select()
      .from(schema.inferenceUsage)
      .where(eq(schema.inferenceUsage.userId, userId));
    expect(rows[0]).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("passes upstream errors through, and meters them", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const res = await app.request(
      "/v1/ai/gateway/v1/boom",
      chatRequest(`hbr_dev_${userId}`),
    );
    expect(res.status).toBe(400);
    const rows = await db
      .select()
      .from(schema.inferenceUsage)
      .where(
        and(
          eq(schema.inferenceUsage.userId, userId),
          eq(schema.inferenceUsage.status, 400),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("enforces the per-user daily request cap", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const token = `hbr_dev_${userId}`;
    for (let i = 0; i < DAILY_CAP; i += 1) {
      const res = await app.request(
        "/v1/ai/gateway/v1/chat/completions",
        chatRequest(token),
      );
      expect(res.status).toBe(200);
    }
    const refused = await app.request(
      "/v1/ai/gateway/v1/chat/completions",
      chatRequest(token),
    );
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("reports availability and the meter on /v1/ai/status", async () => {
    const userId = await makeUser([INFERENCE_FEATURE]);
    const token = `hbr_dev_${userId}`;
    await app.request("/v1/ai/gateway/v1/chat/completions", chatRequest(token));

    const res = await app.request("/v1/ai/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      vending: true,
      enabled: true,
      available: true,
      dailyRequestCap: DAILY_CAP,
      requestsToday: 1,
    });

    const closed = await closedApp.request("/v1/ai/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await closed.json()) as { available: boolean }).available).toBe(
      false,
    );
  });

  it("grants the inference feature to fresh signups", async () => {
    const res = await app.request("/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fresh-signup@example.com" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { features: string[] } };
    expect(body.user.features).toContain(INFERENCE_FEATURE);
  });
});
