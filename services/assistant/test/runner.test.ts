import type { AssistantHarness, AssistantTaskRecord } from "@suma/assistant-core/channel";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { RemoteRunnerClient, createAssistantRunnerApp } from "../src/harness";

describe("private assistant runner boundary", () => {
  it("requires service authentication and transports assistant output", async () => {
    let releaseRunner: (() => void) | undefined;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const harness: AssistantHarness = {
      async run(task, emit) {
        await emit({ kind: "status", text: "working" });
        await runnerGate;
        await emit({ kind: "text", text: `ran ${task.message.text}` });
      },
    };
    const app = createAssistantRunnerApp({ token: "runner-token", harness });
    const unauthorized = await app.request("/v1/tasks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: makeTask() }),
    });
    expect(unauthorized.status).toBe(401);

    const emitted: unknown[] = [];
    let requestedPath = "";
    const client = new RemoteRunnerClient({
      runnerUrl: "https://runner.internal/mounted/",
      token: "runner-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedPath = new URL(request.url).pathname;
        return app.request(
          new Request("https://runner.internal/v1/tasks/run", {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
        );
      },
    });
    let sawStatus: (() => void) | undefined;
    const statusSeen = new Promise<void>((resolve) => {
      sawStatus = resolve;
    });
    const running = client.run(makeTask(), (message) => {
      emitted.push(message);
      if (message.kind === "status") sawStatus?.();
      return Promise.resolve();
    });
    await statusSeen;
    expect(emitted).toEqual([{ kind: "status", text: "working" }]);
    releaseRunner?.();
    await running;
    expect(emitted).toEqual([
      { kind: "status", text: "working" },
      { kind: "text", text: "ran inspect the build" },
    ]);
    expect(requestedPath).toBe("/mounted/v1/tasks/run");
  });

  it("streams status before completion over a real HTTP socket", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness: AssistantHarness = {
      async run(_task, emit) {
        await emit({ kind: "status", text: "socket working" });
        await gate;
        await emit({ kind: "text", text: "socket done" });
      },
    };
    const app = createAssistantRunnerApp({ token: "runner-token", harness });
    const server = serve({ fetch: app.fetch, port: 0 }) as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("runner socket did not bind");
    }
    try {
      const client = new RemoteRunnerClient({
        runnerUrl: `http://127.0.0.1:${String(address.port)}`,
        token: "runner-token",
      });
      const emitted: string[] = [];
      let sawStatus: (() => void) | undefined;
      const statusSeen = new Promise<void>((resolve) => {
        sawStatus = resolve;
      });
      const running = client.run(makeTask(), (message) => {
        emitted.push(message.text ?? "");
        if (message.kind === "status") sawStatus?.();
        return Promise.resolve();
      });

      await statusSeen;
      expect(emitted).toEqual(["socket working"]);
      release?.();
      await running;
      expect(emitted).toEqual(["socket working", "socket done"]);
    } finally {
      release?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it("authenticates and validates browser session imports", async () => {
    const imported: Array<{ userId: string; state: unknown }> = [];
    const harness: AssistantHarness = { run: () => Promise.resolve() };
    const app = createAssistantRunnerApp({
      token: "runner-token",
      harness,
      browserSessions: {
        importBrowserSession(userId, state) {
          imported.push({ userId, state });
          return Promise.resolve();
        },
      },
    });
    const unauthorized = await app.request("/v1/browser-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-1", state: storageState() }),
    });
    expect(unauthorized.status).toBe(401);

    let requestedPath = "";
    const client = new RemoteRunnerClient({
      runnerUrl: "https://runner.internal/mounted/",
      token: "runner-token",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedPath = new URL(request.url).pathname;
        return app.request(
          new Request("https://runner.internal/v1/browser-sessions/import", {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
        );
      },
    });
    await client.importBrowserSession("user-1", storageState());
    expect(requestedPath).toBe("/mounted/v1/browser-sessions/import");
    expect(imported).toEqual([{ userId: "user-1", state: storageState() }]);

    const invalid = await app.request("/v1/browser-sessions/import", {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        state: { cookies: [], origins: [{ origin: "file:///tmp", localStorage: [] }] },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(imported).toHaveLength(1);
  });
});

function storageState() {
  return {
    cookies: [
      {
        name: "session",
        value: "signed-in",
        domain: "accounts.example",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [
      {
        origin: "https://accounts.example",
        localStorage: [{ name: "workspace", value: "primary" }],
      },
    ],
  };
}

function makeTask(): AssistantTaskRecord {
  return {
    id: "task-1",
    dedupeKey: "delivery-1",
    conversationId: "conversation-1",
    authorization: {
      userId: "user-1",
      linkId: "link-1",
      policy: {
        model: "test/model",
        enabledToolGroups: ["tabs", "navigate", "read"],
        maxSteps: 12,
        dailyWakeMinutes: 30,
        autoSuspendMinutes: 10,
      },
    },
    status: "running",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    message: {
      deliveryId: "delivery-1",
      channel: "test",
      accountId: "test",
      externalThreadId: "thread",
      externalUserId: "user",
      text: "inspect the build",
      attachments: [],
      receivedAt: new Date(0).toISOString(),
    },
  };
}
