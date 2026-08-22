import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AssistantChannelAdapter,
  AssistantDestination,
  InboundAssistantMessage,
  OutboundAssistantMessage,
} from "@suma/assistant-core/channel";

export interface BlueBubblesAdapterOptions {
  accountId: string;
  serverUrl: string;
  password: string;
  fetch?: typeof fetch;
}

interface BlueBubblesMessageData {
  guid?: unknown;
  text?: unknown;
  isFromMe?: unknown;
  dateCreated?: unknown;
  chats?: unknown;
  handle?: unknown;
  attachments?: unknown;
}

/** Initial iMessage transport through the user's BlueBubbles server. */
export class BlueBubblesAdapter implements AssistantChannelAdapter {
  readonly channel = "bluebubbles";
  readonly #accountId: string;
  readonly #serverUrl: URL;
  readonly #password: string;
  readonly #fetch: typeof fetch;

  constructor(options: BlueBubblesAdapterOptions) {
    this.#accountId = options.accountId;
    this.#serverUrl = new URL(options.serverUrl);
    this.#password = options.password;
    this.#fetch = options.fetch ?? fetch;
  }

  parseWebhook(body: unknown): InboundAssistantMessage[] {
    if (!isRecord(body) || body["type"] !== "new-message") return [];
    const data = body["data"] as BlueBubblesMessageData | undefined;
    if (!isRecord(data) || data.isFromMe === true) return [];

    const deliveryId = stringValue(data.guid);
    const text = stringValue(data.text).trim();
    const chats = Array.isArray(data.chats) ? data.chats : [];
    const firstChat = chats[0];
    const externalThreadId = isRecord(firstChat)
      ? stringValue(firstChat["guid"])
      : "";
    const externalUserId = isRecord(data.handle)
      ? stringValue(data.handle["address"])
      : "";
    if (
      deliveryId === "" ||
      externalThreadId === "" ||
      externalUserId === "" ||
      text === ""
    ) {
      return [];
    }

    return [
      {
        deliveryId,
        channel: this.channel,
        accountId: this.#accountId,
        externalThreadId,
        externalUserId,
        text,
        attachments: parseAttachments(data.attachments),
        receivedAt: parseBlueBubblesDate(data.dateCreated),
      },
    ];
  }

  async send(
    destination: AssistantDestination,
    message: OutboundAssistantMessage,
  ): Promise<void> {
    if (destination.accountId !== this.#accountId) {
      throw new Error("BlueBubbles destination account does not match adapter");
    }
    if (message.kind === "attachment") {
      throw new Error("BlueBubbles attachment delivery is not implemented yet");
    }
    if (message.kind === "status") return;

    const url = new URL("/api/v1/message/text", this.#serverUrl);
    // BlueBubbles authenticates REST requests with its password/token query.
    url.searchParams.set("password", this.#password);
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatGuid: destination.externalThreadId,
        text: message.text,
        method: "private-api",
      }),
    });
    if (!response.ok) {
      throw new Error(
        `BlueBubbles send failed with HTTP ${String(response.status)}`,
      );
    }
  }
}

export function verifyBlueBubblesWebhookSecret(
  supplied: string | undefined,
  expected: string,
): boolean {
  if (supplied === undefined || supplied === "" || expected === "") return false;
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function parseAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((attachment) => {
    if (!isRecord(attachment)) return [];
    const id = stringValue(attachment["guid"]);
    const mediaType =
      stringValue(attachment["mimeType"]) || "application/octet-stream";
    if (id === "") return [];
    const filename = stringValue(attachment["transferName"]);
    return [
      {
        id,
        mediaType,
        ...(filename === "" ? {} : { filename }),
      },
    ];
  });
}

function parseBlueBubblesDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Server payloads historically use either seconds or milliseconds.
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date().toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
