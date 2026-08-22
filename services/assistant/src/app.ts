import { Hono } from "hono";
import type { BlueBubblesAdapter } from "./channels/bluebubbles";
import { verifyBlueBubblesWebhookSecret } from "./channels/bluebubbles";
import type { AssistantTaskProcessor } from "./tasks/task-processor";

export interface AssistantGatewayAppOptions {
  blueBubbles: BlueBubblesAdapter;
  blueBubblesAccountId: string;
  blueBubblesWebhookSecret: string;
  processor: AssistantTaskProcessor;
}

export function createAssistantGatewayApp(options: AssistantGatewayAppOptions) {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ ok: true }));

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
      const tasks = await Promise.all(
        messages.map((message) => options.processor.enqueue(message)),
      );
      if (tasks.length > 0) void options.processor.drain();
      return context.json({ accepted: tasks.length }, 202);
    },
  );

  return app;
}
