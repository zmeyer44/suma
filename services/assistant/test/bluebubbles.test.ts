import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantHarness,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssistantGatewayApp } from "../src/app";
import { BlueBubblesAdapter } from "../src/channels/bluebubbles";
import {
  AssistantTaskProcessor,
  EncryptedFileAssistantTaskStore,
} from "../src/tasks";

describe("BlueBubbles channel", () => {
  let server: Server;
  let serverUrl: string;
  const sent: Array<{ password: string | null; body: unknown }> = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      sent.push({
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

  it("authenticates, normalizes, deduplicates, runs, and replies", async () => {
    const adapter = new BlueBubblesAdapter({
      accountId: "personal",
      serverUrl,
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
  });
});
