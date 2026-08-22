import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  AiSdkAssistantHarness,
  EncryptedFileAssistantConversationStore,
  retainCompleteConversationTurns,
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

  it("truncates only between complete user turns", () => {
    const messages = Array.from({ length: 60 }, (_, index) => [
      { role: "user", content: `user ${String(index)}` },
      { role: "assistant", content: `call ${String(index)}` },
      { role: "tool", content: [] },
    ]).flat() as ModelMessage[];

    const retained = retainCompleteConversationTurns(messages);

    expect(retained.length).toBeLessThanOrEqual(100);
    expect(retained.length % 3).toBe(0);
    for (let index = 0; index < retained.length; index += 3) {
      expect(retained[index]?.role).toBe("user");
      expect(retained[index + 1]?.role).toBe("assistant");
      expect(retained[index + 2]?.role).toBe("tool");
    }
  });

  it("enforces the control-plane model, step cap, and tool groups", async () => {
    const conversations = new EncryptedFileAssistantConversationStore(
      await mkdtemp(join(tmpdir(), "suma-policy-conversations-")),
      randomBytes(32),
    );
    const selectedModels: string[] = [];
    let generated:
      | { toolNames: string[]; maxSteps: number }
      | undefined;
    const harness = new AiSdkAssistantHarness({
      model: {} as LanguageModel,
      modelForTask: (modelId) => {
        selectedModels.push(modelId);
        return {} as LanguageModel;
      },
      conversations,
      toolsForTask: () =>
        Promise.resolve({
          navigate: {},
          reload: {},
          run_command: {},
          unknown_power_tool: {},
        } as unknown as ToolSet),
      generate: ({ tools, maxSteps }) => {
        generated = { toolNames: Object.keys(tools), maxSteps };
        return Promise.resolve({
          text: "done",
          responseMessages: [{ role: "assistant", content: "done" }],
        });
      },
    });
    const authorized = task("use the browser");
    authorized.authorization.policy.model = "provider/approved-model";
    authorized.authorization.policy.enabledToolGroups = ["navigate"];
    authorized.authorization.policy.maxSteps = 7;

    await harness.run(authorized, () => Promise.resolve());

    expect(selectedModels).toEqual(["provider/approved-model"]);
    expect(generated).toEqual({ toolNames: ["navigate"], maxSteps: 7 });
  });
});

function task(text: string): AssistantTaskRecord {
  return {
    id: text,
    dedupeKey: text,
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
