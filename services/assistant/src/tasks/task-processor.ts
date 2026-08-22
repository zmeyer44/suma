import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantChannelAdapter,
  AssistantDestination,
  AssistantHarness,
  AssistantTaskRecord,
  AssistantTaskStore,
  InboundAssistantMessage,
} from "@suma/assistant-core/channel";

export interface AssistantTaskProcessorOptions {
  store: AssistantTaskStore;
  harness: AssistantHarness;
  adapters: readonly AssistantChannelAdapter[];
}

export class AssistantTaskProcessor {
  readonly #store: AssistantTaskStore;
  readonly #harness: AssistantHarness;
  readonly #adapters: Map<string, AssistantChannelAdapter>;
  #drainPromise: Promise<void> | null = null;

  constructor(options: AssistantTaskProcessorOptions) {
    this.#store = options.store;
    this.#harness = options.harness;
    this.#adapters = new Map(
      options.adapters.map((adapter) => [adapter.channel, adapter]),
    );
  }

  async enqueue(message: InboundAssistantMessage): Promise<AssistantTaskRecord> {
    const now = new Date().toISOString();
    const dedupeKey = `${message.channel}\u0000${message.accountId}\u0000${message.deliveryId}`;
    return this.#store.enqueue({
      id: randomUUID(),
      dedupeKey,
      conversationId: conversationIdFor(message),
      message,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
  }

  async recoverAndDrain(): Promise<void> {
    await this.#store.recoverInterrupted();
    await this.drain();
  }

  drain(): Promise<void> {
    this.#drainPromise ??= this.#runDrain().finally(() => {
      this.#drainPromise = null;
    });
    return this.#drainPromise;
  }

  async #runDrain(): Promise<void> {
    while (true) {
      const task = await this.#store.claimNext();
      if (task === null) return;
      const adapter = this.#adapters.get(task.message.channel);
      if (adapter === undefined) {
        await this.#fail(task, `no adapter for channel ${task.message.channel}`);
        continue;
      }
      const destination: AssistantDestination = {
        channel: task.message.channel,
        accountId: task.message.accountId,
        externalThreadId: task.message.externalThreadId,
      };
      try {
        await this.#harness.run(task, async (message) => {
          await adapter.send(destination, message);
        });
        await this.#store.update(task.id, {
          status: "succeeded",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.#fail(task, safeError(error));
      }
    }
  }

  async #fail(task: AssistantTaskRecord, error: string): Promise<void> {
    await this.#store.update(task.id, {
      status: "failed",
      updatedAt: new Date().toISOString(),
      error,
    });
  }
}

function conversationIdFor(message: InboundAssistantMessage): string {
  return createHash("sha256")
    .update(message.channel)
    .update("\u0000")
    .update(message.accountId)
    .update("\u0000")
    .update(message.externalThreadId)
    .digest("hex");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "unknown error";
}
