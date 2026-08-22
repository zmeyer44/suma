import { Hono } from "hono";
import type {
  AssistantDestination,
  InboundAssistantMessage,
} from "@suma/assistant-core/channel";
import type { BlueBubblesAdapter } from "./channels/bluebubbles";
import { verifyBlueBubblesWebhookSecret } from "./channels/bluebubbles";
import type { AssistantLinkService, LinkCommandResult } from "./control-client";
import type { AssistantTaskProcessor } from "./tasks/task-processor";
import { parseBrowserStorageState } from "./browser/session-transfer";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "./request-body";

const MAX_BROWSER_SESSION_REQUEST_BYTES = 9 * 1024 * 1024;

export interface AssistantBrowserSessionGateway {
  redeemTicket(ticket: string): Promise<{ userId: string } | null>;
  importSession(userId: string, state: unknown): Promise<void>;
}

export interface AssistantGatewayAppOptions {
  blueBubbles: BlueBubblesAdapter;
  blueBubblesAccountId: string;
  blueBubblesWebhookSecret: string;
  links: AssistantLinkService;
  processor: AssistantTaskProcessor;
  browserSessions?: AssistantBrowserSessionGateway;
  onBackgroundError?: (error: unknown) => void;
  now?: () => number;
}

export function createAssistantGatewayApp(options: AssistantGatewayAppOptions) {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const commandDeliveries = new Set<string>();
  const unlinkedNoticeAt = new Map<string, number>();

  app.get("/healthz", (context) => context.json({ ok: true }));

  app.post("/v1/browser-sessions/import", async (context) => {
    if (options.browserSessions === undefined) {
      return context.json({ error: "unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await readJsonBody(
        context.req.raw,
        MAX_BROWSER_SESSION_REQUEST_BYTES,
      );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return context.json({ error: "payload_too_large" }, 413);
      }
      return context.json({ error: "invalid JSON" }, 400);
    }
    if (
      !isRecord(body) ||
      typeof body["ticket"] !== "string" ||
      body["ticket"].length < 32 ||
      body["ticket"].length > 256
    ) {
      return context.json({ error: "invalid browser session handoff" }, 400);
    }
    let state: ReturnType<typeof parseBrowserStorageState>;
    try {
      state = parseBrowserStorageState(body["state"]);
    } catch (error) {
      return context.json(
        {
          error: "invalid browser session handoff",
          reason: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
    const authorization = await options.browserSessions.redeemTicket(
      body["ticket"],
    );
    if (authorization === null) {
      return context.json({ error: "invalid_or_expired_ticket" }, 401);
    }
    await options.browserSessions.importSession(
      authorization.userId,
      state,
    );
    return context.json({ imported: true }, 201);
  });

  app.post(
    "/v1/channels/bluebubbles/:accountId/webhook",
    async (context) => {
      if (context.req.param("accountId") !== options.blueBubblesAccountId) {
        return context.json({ error: "unknown channel account" }, 404);
      }
      const suppliedSecret =
        context.req.header("x-suma-webhook-secret") ??
        context.req.query("secret");
      if (
        !verifyBlueBubblesWebhookSecret(
          suppliedSecret,
          options.blueBubblesWebhookSecret,
        )
      ) {
        return context.json({ error: "unauthorized" }, 401);
      }

      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "invalid JSON" }, 400);
      }
      const messages = options.blueBubbles.parseWebhook(body);
      let accepted = 0;
      for (const message of messages) {
        const command = parseCommand(message.text);
        if (command !== null) {
          const deliveryKey = `${message.accountId}\u0000${message.deliveryId}`;
          if (commandDeliveries.has(deliveryKey)) continue;
          rememberBounded(commandDeliveries, deliveryKey);
          await handleCommand(options, message, command);
          continue;
        }

        const authorization = await options.links.resolve(message);
        if (authorization === null) {
          const senderKey = `${message.channel}\u0000${message.accountId}\u0000${message.externalUserId}`;
          const lastNotice = unlinkedNoticeAt.get(senderKey);
          const currentTime = now();
          if (lastNotice === undefined || currentTime - lastNotice >= 60_000) {
            unlinkedNoticeAt.set(senderKey, currentTime);
            await options.blueBubbles.send(destinationFor(message), {
              kind: "text",
              text: "This chat is not connected to Suma. In Suma, open Settings → Assistant, create a link code, then send /link CODE here.",
            });
          }
          continue;
        }
        await options.processor.enqueue(message, authorization);
        accepted += 1;
      }
      if (accepted > 0) {
        void options.processor.drain().catch(
          options.onBackgroundError ?? ((error) => console.error("assistant task drain failed", error)),
        );
      }
      return context.json({ accepted }, 202);
    },
  );

  return app;
}

type AssistantCommand =
  | { kind: "link"; code: string }
  | { kind: "unlink" };

function parseCommand(text: string): AssistantCommand | null {
  const trimmed = text.trim();
  const link = /^\/link\s+([^\s]+)$/i.exec(trimmed);
  if (link?.[1] !== undefined) return { kind: "link", code: link[1] };
  if (/^\/unlink$/i.test(trimmed)) return { kind: "unlink" };
  return null;
}

async function handleCommand(
  options: AssistantGatewayAppOptions,
  message: InboundAssistantMessage,
  command: AssistantCommand,
): Promise<void> {
  if (command.kind === "unlink") {
    const revoked = await options.links.revoke(message);
    await options.blueBubbles.send(destinationFor(message), {
      kind: "text",
      text: revoked
        ? "Disconnected. This chat can no longer use your Suma assistant."
        : "This chat was not connected to Suma.",
    });
    return;
  }

  const result = await options.links.redeem(message, command.code);
  await options.blueBubbles.send(destinationFor(message), {
    kind: "text",
    text: linkResultMessage(result),
  });
}

function linkResultMessage(result: LinkCommandResult): string {
  switch (result.kind) {
    case "linked":
      return "Connected to Suma. You can ask me to browse, work with files, or run commands on your computer.";
    case "invalid":
      return "That link code is invalid, expired, or already used. Create a new one in Suma Settings → Assistant.";
    case "conflict":
      return "This chat is already connected to another Suma account. Disconnect it there before linking again.";
    case "disabled":
      return "External assistant access is not enabled for that Suma account.";
  }
}

function destinationFor(message: InboundAssistantMessage): AssistantDestination {
  return {
    channel: message.channel,
    accountId: message.accountId,
    externalThreadId: message.externalThreadId,
  };
}

function rememberBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= 10_000) return;
  const oldest = set.values().next().value as string | undefined;
  if (oldest !== undefined) set.delete(oldest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
