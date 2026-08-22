import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantTaskRecord } from "@suma/assistant-core/channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "@suma/agent-client";
import {
  ProductionAssistantResources,
  type MachineSessionIssuer,
} from "../src/harness";

describe("production runner resources", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("mints, presents, and pools a signed per-user VM connection", async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          seen.push(`${frame.channel}:${frame.payload.toString("utf8")}`);
          if (frame.channel === "auth") socket.write(encodeFrame("auth", "ok"));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const issuer = {
      machineSession: vi.fn().mockResolvedValue({
        agentAddress: `127.0.0.1:${String(port)}`,
        capabilityToken: "signed-runner-capability",
        exp: Math.floor(Date.now() / 1_000) + 300,
        state: "running",
      }),
    } as MachineSessionIssuer;
    const resources = new ProductionAssistantResources({
      control: issuer,
      dataDirectory: await mkdtemp(join(tmpdir(), "suma-runner-resources-")),
      masterKey: Buffer.alloc(32, 7),
    });
    cleanups.push(() => resources.close());

    const first = await resources.agentForTask(task());
    const second = await resources.agentForTask(task());

    expect(first).toBe(second);
    expect(issuer.machineSession).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe("auth:signed-runner-capability");
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
        enabledToolGroups: ["terminal"],
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
