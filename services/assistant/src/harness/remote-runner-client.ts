import type {
  AssistantHarness,
  AssistantTaskRecord,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";

export interface RemoteRunnerClientOptions {
  runnerUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** Public gateway client for the private browser/VM runner plane. */
export class RemoteRunnerClient implements AssistantHarness {
  readonly #runnerUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteRunnerClientOptions) {
    this.#runnerUrl = new URL("/v1/tasks/run", options.runnerUrl);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async run(
    task: AssistantTaskRecord,
    emit: (message: OutboundAssistantMessage) => Promise<void>,
  ): Promise<void> {
    const response = await this.#fetch(this.#runnerUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task }),
    });
    if (!response.ok) {
      throw new Error(`assistant runner failed with HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) {
      throw new Error("assistant runner returned malformed messages");
    }
    for (const candidate of body.messages) {
      const message = parseOutboundMessage(candidate);
      if (message !== null) await emit(message);
    }
  }
}

function parseOutboundMessage(value: unknown): OutboundAssistantMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "text" && typeof record["text"] === "string") {
    return { kind: "text", text: record["text"] };
  }
  if (record["kind"] === "status" && typeof record["text"] === "string") {
    return { kind: "status", text: record["text"] };
  }
  return null;
}
