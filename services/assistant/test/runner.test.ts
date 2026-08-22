import type { AssistantHarness, AssistantTaskRecord } from "@suma/assistant-core/channel";
import { describe, expect, it } from "vitest";
import { RemoteRunnerClient, createAssistantRunnerApp } from "../src/harness";

describe("private assistant runner boundary", () => {
  it("requires service authentication and transports assistant output", async () => {
    const harness: AssistantHarness = {
      async run(task, emit) {
        await emit({ kind: "status", text: "working" });
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
    const client = new RemoteRunnerClient({
      runnerUrl: "https://runner.internal",
      token: "runner-token",
      fetch: async (input, init) => app.request(new Request(input, init)),
    });
    await client.run(makeTask(), (message) => {
      emitted.push(message);
      return Promise.resolve();
    });
    expect(emitted).toEqual([
      { kind: "status", text: "working" },
      { kind: "text", text: "ran inspect the build" },
    ]);
  });
});

function makeTask(): AssistantTaskRecord {
  return {
    id: "task-1",
    dedupeKey: "delivery-1",
    conversationId: "conversation-1",
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
