import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AssistantHarness,
  AssistantTaskRecord,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { Hono } from "hono";

export function createAssistantRunnerApp(options: {
  token: string;
  harness: AssistantHarness;
}) {
  const app = new Hono();
  app.get("/healthz", (context) => context.json({ ok: true }));
  app.post("/v1/tasks/run", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.token)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid JSON" }, 400);
    }
    const task = parseTask(body);
    if (task === null) return context.json({ error: "invalid task" }, 400);
    const messages: OutboundAssistantMessage[] = [];
    await options.harness.run(task, (message) => {
      messages.push(message);
      return Promise.resolve();
    });
    return context.json({ messages });
  });
  return app;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ") || expected === "") {
    return false;
  }
  const actualDigest = createHash("sha256").update(header.slice(7)).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function parseTask(value: unknown): AssistantTaskRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const task = (value as Record<string, unknown>)["task"];
  if (typeof task !== "object" || task === null) return null;
  const record = task as Record<string, unknown>;
  const message = record["message"];
  if (
    typeof record["id"] !== "string" ||
    typeof record["conversationId"] !== "string" ||
    typeof message !== "object" ||
    message === null
  ) {
    return null;
  }
  return task as AssistantTaskRecord;
}
