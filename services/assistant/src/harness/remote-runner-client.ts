import type {
  AssistantHarness,
  AssistantTaskRecord,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";
import { appendServicePath } from "../url";

export interface RemoteRunnerClientOptions {
  runnerUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** Public gateway client for the private browser/VM runner plane. */
export class RemoteRunnerClient implements AssistantHarness {
  readonly #runnerUrl: URL;
  readonly #browserSessionUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteRunnerClientOptions) {
    this.#runnerUrl = appendServicePath(options.runnerUrl, "v1/tasks/run");
    this.#browserSessionUrl = appendServicePath(
      options.runnerUrl,
      "v1/browser-sessions/import",
    );
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
    if (response.body === null) {
      throw new Error("assistant runner returned an empty stream");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const chunk = await reader.read();
      buffered += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line !== "") await emit(parseOutboundLine(line));
        newline = buffered.indexOf("\n");
      }
      if (chunk.done) break;
    }
    if (buffered.trim() !== "") {
      await emit(parseOutboundLine(buffered.trim()));
    }
  }

  async importBrowserSession(userId: string, state: unknown): Promise<void> {
    const response = await this.#fetch(this.#browserSessionUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId, state }),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `assistant runner browser import failed with HTTP ${String(response.status)}`,
      );
    }
  }
}

function parseOutboundLine(line: string): OutboundAssistantMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("assistant runner returned malformed NDJSON");
  }
  const message = parseOutboundMessage(parsed);
  if (message === null) {
    throw new Error("assistant runner returned a malformed message");
  }
  return message;
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
