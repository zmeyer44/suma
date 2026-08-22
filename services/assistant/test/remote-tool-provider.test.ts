import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserBackend } from "@suma/assistant-core/browser";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import { afterEach, describe, expect, it } from "vitest";
import { SimAgent } from "../../../apps/desktop/src/main/compute/sim-agent";
import { RemoteAssistantToolProvider } from "../src/harness";

describe("remote assistant tool provider", () => {
  const sims: SimAgent[] = [];
  afterEach(() => sims.splice(0).forEach((sim) => sim.stop()));

  it("composes full browser and VM tools for an authorized task", async () => {
    const root = await mkdtemp(join(tmpdir(), "suma-provider-"));
    const sim = new SimAgent({ root: () => root });
    sims.push(sim);
    const provider = new RemoteAssistantToolProvider({
      browserForTask: () => Promise.resolve({} as BrowserBackend),
      agentForTask: () => Promise.resolve(sim),
    });

    const tools = await provider.toolsForTask(task());

    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "list_tabs",
        "navigate",
        "click",
        "type_text",
        "run_command",
        "open_terminal_app",
        "read_file",
        "write_file",
        "add_memory",
      ]),
    );
  });
});

function task(): AssistantTaskRecord {
  const now = new Date(0).toISOString();
  return {
    id: "task-1",
    dedupeKey: "delivery-1",
    conversationId: "conversation-1",
    authorization: {
      userId: "user-1",
      linkId: "link-1",
      policy: {
        model: "test/model",
        enabledToolGroups: ["tabs", "terminal"],
        maxSteps: 10,
        dailyWakeMinutes: 30,
        autoSuspendMinutes: 10,
      },
    },
    message: {
      deliveryId: "delivery-1",
      channel: "bluebubbles",
      accountId: "bridge-1",
      externalThreadId: "thread-1",
      externalUserId: "user-1",
      text: "run a command",
      attachments: [],
      receivedAt: now,
    },
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}
