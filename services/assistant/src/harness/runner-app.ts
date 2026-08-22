import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AssistantHarness,
  AssistantTaskRecord,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { isAssistantToolGroupId } from "@suma/assistant-core/tool-groups";
import { Hono } from "hono";
import {
  parseBrowserStorageState,
  type BrowserStorageState,
} from "../browser";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../request-body";

const MAX_BROWSER_SESSION_REQUEST_BYTES = 9 * 1024 * 1024;

export interface RunnerBrowserSessionImporter {
  importBrowserSession(
    userId: string,
    state: BrowserStorageState,
  ): Promise<void>;
}

export function createAssistantRunnerApp(options: {
  token: string;
  harness: AssistantHarness;
  browserSessions?: RunnerBrowserSessionImporter;
}) {
  const app = new Hono();
  app.get("/healthz", (context) => context.json({ ok: true }));
  app.post("/v1/browser-sessions/import", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.token)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    if (options.browserSessions === undefined) {
      return context.json({ error: "unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await readJsonBody(
        context.req.raw,
        MAX_BROWSER_SESSION_REQUEST_BYTES,
      );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return context.json({ error: "payload_too_large" }, 413);
      }
      return context.json({ error: "invalid JSON" }, 400);
    }
    if (!isRecord(body) || typeof body["userId"] !== "string") {
      return context.json({ error: "invalid browser session handoff" }, 400);
    }
    let state: BrowserStorageState;
    try {
      state = parseBrowserStorageState(body["state"]);
    } catch (error) {
      return context.json(
        {
          error: "invalid browser session handoff",
          reason: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    await options.browserSessions.importBrowserSession(body["userId"], state);
    return context.json({ imported: true }, 201);
  });
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
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void options.harness
          .run(task, (message: OutboundAssistantMessage) => {
            controller.enqueue(
              encoder.encode(`${JSON.stringify(message)}\n`),
            );
            return Promise.resolve();
          })
          .then(() => controller.close())
          .catch((error: unknown) => controller.error(error));
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });
  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const authorization = record["authorization"];
  if (
    typeof record["id"] !== "string" ||
    typeof record["conversationId"] !== "string" ||
    typeof message !== "object" ||
    message === null ||
    !validAuthorization(authorization)
  ) {
    return null;
  }
  return task as AssistantTaskRecord;
}

function validAuthorization(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const policy = record["policy"];
  if (typeof policy !== "object" || policy === null) return false;
  const p = policy as Record<string, unknown>;
  return (
    typeof record["userId"] === "string" &&
    typeof record["linkId"] === "string" &&
    typeof p["model"] === "string" &&
    Array.isArray(p["enabledToolGroups"]) &&
    p["enabledToolGroups"].every(
      (group) => typeof group === "string" && isAssistantToolGroupId(group),
    ) &&
    boundedInteger(p["maxSteps"], 1, 80) &&
    boundedInteger(p["dailyWakeMinutes"], 0, 1_440) &&
    boundedInteger(p["autoSuspendMinutes"], 1, 120)
  );
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
