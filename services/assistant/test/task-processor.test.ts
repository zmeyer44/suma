import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantChannelAdapter,
  AssistantHarness,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { describe, expect, it } from "vitest";
import {
  AssistantTaskProcessor,
  EncryptedFileAssistantTaskStore,
} from "../src/tasks";

describe("assistant task failures", () => {
  it("records the failure and tells the user without retrying side effects", async () => {
    const store = new EncryptedFileAssistantTaskStore(
      join(await mkdtemp(join(tmpdir(), "suma-task-failure-")), "tasks.enc"),
      randomBytes(32),
    );
    const sent: OutboundAssistantMessage[] = [];
    const adapter: AssistantChannelAdapter = {
      channel: "test",
      send(_destination, message) {
        sent.push(message);
        return Promise.resolve();
      },
    };
    let runs = 0;
    const harness: AssistantHarness = {
      run() {
        runs += 1;
        return Promise.reject(new Error("runner unavailable"));
      },
    };
    const processor = new AssistantTaskProcessor({
      store,
      harness,
      adapters: [adapter],
    });
    const task = await processor.enqueue({
      deliveryId: "delivery-1",
      channel: "test",
      accountId: "account",
      externalThreadId: "thread",
      externalUserId: "user",
      text: "do the thing",
      attachments: [],
      receivedAt: new Date(0).toISOString(),
    }, {
      userId: "user-1",
      linkId: "link-1",
      policy: {
        model: "test/model",
        enabledToolGroups: ["terminal"],
        maxSteps: 12,
        dailyWakeMinutes: 30,
        autoSuspendMinutes: 10,
      },
    });

    await processor.drain();

    expect(runs).toBe(1);
    await expect(store.findByDedupeKey(task.dedupeKey)).resolves.toMatchObject({
      status: "failed",
      error: "runner unavailable",
    });
    expect(sent).toEqual([
      {
        kind: "text",
        text: "I couldn't complete that request. Please try again.",
      },
    ]);
  });
});
