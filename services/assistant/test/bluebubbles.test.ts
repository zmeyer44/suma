import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantHarness,
  AssistantTaskAuthorization,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAssistantGatewayApp } from "../src/app";
import { BlueBubblesAdapter } from "../src/channels/bluebubbles";
import {
  AssistantTaskProcessor,
  EncryptedFileAssistantTaskStore,
} from "../src/tasks";

describe("BlueBubbles channel", () => {
  let server: Server;
  let serverUrl: string;
  const sent: Array<{ path: string; password: string | null; body: unknown }> = [];
  const authorization: AssistantTaskAuthorization = {
    userId: "user-1",
    linkId: "link-1",
    policy: {
      model: "test/model",
      enabledToolGroups: ["tabs", "navigate", "read", "interact"],
      maxSteps: 20,
      dailyWakeMinutes: 60,
      autoSuspendMinutes: 10,
    },
  };

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      sent.push({
        path: url.pathname,
        password: url.searchParams.get("password"),
        body: JSON.parse(body) as unknown,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":200}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("BlueBubbles test server did not bind");
    }
    serverUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it("authenticates, normalizes, deduplicates, runs, and replies", async () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl: `${serverUrl}/bluebubbles/`,
      password: "bb-password",
    });
    const store = new EncryptedFileAssistantTaskStore(
      join(await mkdtemp(join(tmpdir(), "suma-tasks-")), "tasks.enc"),
      randomBytes(32),
    );
    const emitted: OutboundAssistantMessage[] = [];
    const harness: AssistantHarness = {
      async run(task, emit) {
        const reply = { kind: "text", text: `done: ${task.message.text}` } as const;
        emitted.push(reply);
        await emit(reply);
      },
    };
    const processor = new AssistantTaskProcessor({
      store,
      harness,
      adapters: [adapter],
    });
    const app = createAssistantGatewayApp({
      blueBubbles: adapter,
      blueBubblesAccountId: "personal",
      blueBubblesWebhookSecret: "webhook-secret",
      links: {
        resolve: () => Promise.resolve(authorization),
        redeem: () => Promise.resolve({ kind: "linked", authorization }),
        revoke: () => Promise.resolve(true),
      },
      processor,
    });
    const payload = {
      type: "new-message",
      data: {
        guid: "message-guid-1",
        text: "open my dashboard",
        isFromMe: false,
        dateCreated: 1_788_000_000,
        chats: [{ guid: "iMessage;-;+15551234567" }],
        handle: { address: "+15551234567" },
      },
    };

    const unauthorized = await app.request(
      "/v1/channels/bluebubbles/personal/webhook",
      { method: "POST", body: JSON.stringify(payload) },
    );
    expect(unauthorized.status).toBe(401);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(
        "/v1/channels/bluebubbles/personal/webhook?secret=webhook-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      expect(response.status).toBe(202);
    }
    await processor.drain();

    expect(emitted).toEqual([
      { kind: "text", text: "done: open my dashboard" },
    ]);
    expect(sent).toEqual([
      {
        path: "/bluebubbles/api/v1/message/text",
        password: "bb-password",
        body: {
          chatGuid: "iMessage;-;+15551234567",
          text: "done: open my dashboard",
          method: "private-api",
        },
      },
    ]);
  });

  it("ignores outbound and malformed BlueBubbles events", () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
      password: "bb-password",
    });
    expect(
      adapter.parseWebhook({
        type: "new-message",
        data: { guid: "1", text: "echo", isFromMe: true },
      }),
    ).toEqual([]);
    expect(adapter.parseWebhook({ type: "updated-message", data: {} })).toEqual(
      [],
    );
    expect(
      adapter.parseWebhook({
        type: "new-message",
        data: {
          guid: "group-message",
          text: "hello everyone",
          isFromMe: false,
          chats: [{ guid: "iMessage;+;group-id" }],
          handle: { address: "+15551234567" },
        },
      }),
    ).toEqual([]);
  });

  it("handles link commands without invoking the model and deduplicates delivery", async () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
      password: "bb-password",
    });
    let redeems = 0;
    const processor = {
      enqueue: () => Promise.reject(new Error("command reached task queue")),
      drain: () => Promise.resolve(),
    } as unknown as AssistantTaskProcessor;
    const app = createAssistantGatewayApp({
      blueBubbles: adapter,
      blueBubblesAccountId: "personal",
      blueBubblesWebhookSecret: "webhook-secret",
      links: {
        resolve: () => Promise.resolve(null),
        redeem: () => {
          redeems += 1;
          return Promise.resolve({ kind: "linked", authorization });
        },
        revoke: () => Promise.resolve(true),
      },
      processor,
    });
    const payload = blueBubblesPayload("link-delivery", "/link ABCD-2345");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(
        "/v1/channels/bluebubbles/personal/webhook?secret=webhook-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      expect(response.status).toBe(202);
    }

    expect(redeems).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      text: expect.stringContaining("Connected to Suma"),
    });
  });

  it("keeps unlinked senders out of the queue and rate-limits the link notice", async () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
      password: "bb-password",
    });
    let enqueues = 0;
    const processor = {
      enqueue: () => {
        enqueues += 1;
        return Promise.reject(new Error("unlinked message reached task queue"));
      },
      drain: () => Promise.resolve(),
    } as unknown as AssistantTaskProcessor;
    const app = createAssistantGatewayApp({
      blueBubbles: adapter,
      blueBubblesAccountId: "personal",
      blueBubblesWebhookSecret: "webhook-secret",
      links: {
        resolve: () => Promise.resolve(null),
        redeem: () => Promise.resolve({ kind: "invalid" }),
        revoke: () => Promise.resolve(false),
      },
      processor,
      now: () => 1_000,
    });

    for (const delivery of ["unlinked-1", "unlinked-2"]) {
      const response = await app.request(
        "/v1/channels/bluebubbles/personal/webhook?secret=webhook-secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(blueBubblesPayload(delivery, "browse for me")),
        },
      );
      expect(response.status).toBe(202);
    }

    expect(enqueues).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      text: expect.stringContaining("not connected to Suma"),
    });
  });

  it("delivers one append-only progress update per ten seconds", async () => {
    let now = 1_000;
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
      password: "bb-password",
      now: () => now,
    });
    const destination = {
      channel: "bluebubbles",
      accountId: "personal",
      externalThreadId: "iMessage;-;+15551234567",
    };

    await adapter.send(destination, { kind: "status", text: "Working…" });
    await adapter.send(destination, { kind: "status", text: "Still working…" });
    now += 10_000;
    await adapter.send(destination, { kind: "status", text: "Tests running…" });

    expect(sent.map((request) => request.body)).toEqual([
      {
        chatGuid: destination.externalThreadId,
        text: "Working…",
        method: "private-api",
      },
      {
        chatGuid: destination.externalThreadId,
        text: "Tests running…",
        method: "private-api",
      },
    ]);
  });

  it("observes background drain failures instead of rejecting unhandled", async () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
      password: "bb-password",
    });
    const drainError = new Error("task store unavailable");
    let observed: unknown;
    const processor = {
      enqueue: async (message: unknown) => message,
      drain: () => Promise.reject(drainError),
    } as unknown as AssistantTaskProcessor;
    const app = createAssistantGatewayApp({
      blueBubbles: adapter,
      blueBubblesAccountId: "personal",
      blueBubblesWebhookSecret: "webhook-secret",
      links: {
        resolve: () => Promise.resolve(authorization),
        redeem: () => Promise.resolve({ kind: "linked", authorization }),
        revoke: () => Promise.resolve(true),
      },
      processor,
      onBackgroundError: (error) => {
        observed = error;
      },
    });
    const response = await app.request(
      "/v1/channels/bluebubbles/personal/webhook?secret=webhook-secret",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "new-message",
          data: {
            guid: "message-guid-background-error",
            text: "hello",
            isFromMe: false,
            chats: [{ guid: "iMessage;-;+15551234567" }],
            handle: { address: "+15551234567" },
          },
        }),
      },
    );
    await Promise.resolve();

    expect(response.status).toBe(202);
    expect(observed).toBe(drainError);
  });
});

function blueBubblesPayload(deliveryId: string, text: string) {
  return {
    type: "new-message",
    data: {
      guid: deliveryId,
      text,
      isFromMe: false,
      chats: [{ guid: "iMessage;-;+15551234567" }],
      handle: { address: "+15551234567" },
    },
  };
}
