import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  AiSdkAssistantHarness,
  EncryptedFileAssistantConversationStore,
} from "../src/harness";

describe("channel-neutral AI harness", () => {
  it("retains conversation context while keeping channel details outside the loop", async () => {
    const conversations = new EncryptedFileAssistantConversationStore(
      await mkdtemp(join(tmpdir(), "suma-conversations-")),
      randomBytes(32),
    );
    const seen: ModelMessage[][] = [];
    const harness = new AiSdkAssistantHarness({
      model: {} as LanguageModel,
      conversations,
      toolsForTask: () => Promise.resolve({}),
      generate: ({ messages }) => {
        seen.push(messages);
        const userText = messages.at(-1)?.content;
        return Promise.resolve({
          text: `reply ${typeof userText === "string" ? userText : ""}`,
          responseMessages: [
            { role: "assistant", content: "stored assistant reply" },
          ],
        });
      },
    });
    const outputs: string[] = [];
    await harness.run(task("first"), async (message) => {
      if (message.kind === "text") outputs.push(message.text);
    });
    await harness.run(task("second"), async (message) => {
      if (message.kind === "text") outputs.push(message.text);
    });

    expect(outputs).toEqual(["reply first", "reply second"]);
    expect(seen[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "stored assistant reply" },
      { role: "user", content: "second" },
    ]);
  });
});

function task(text: string): AssistantTaskRecord {
  return {
    id: text,
    dedupeKey: text,
    conversationId: "conversation-1",
    status: "running",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    message: {
      deliveryId: text,
      channel: "test",
      accountId: "test",
      externalThreadId: "thread",
      externalUserId: "user",
      text,
      attachments: [],
      receivedAt: new Date(0).toISOString(),
    },
  };
}
