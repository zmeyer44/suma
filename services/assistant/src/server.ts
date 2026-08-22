import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createAssistantGatewayApp } from "./app";
import { BlueBubblesAdapter } from "./channels/bluebubbles";
import { readAssistantGatewayConfig } from "./config";
import { RemoteRunnerClient } from "./harness/remote-runner-client";
import {
  AssistantTaskProcessor,
  EncryptedFileAssistantTaskStore,
} from "./tasks";
import { ControlAssistantLinkClient } from "./control-client";

const config = readAssistantGatewayConfig();
const blueBubbles = new BlueBubblesAdapter({
  accountId: config.blueBubblesAccountId,
  serverUrl: config.blueBubblesServerUrl,
  password: config.blueBubblesPassword,
});
const store = new EncryptedFileAssistantTaskStore(
  join(config.dataDirectory, "tasks.enc"),
  config.masterKey,
);
const processor = new AssistantTaskProcessor({
  store,
  harness: new RemoteRunnerClient({
    runnerUrl: config.runnerUrl,
    token: config.runnerToken,
  }),
  adapters: [blueBubbles],
});
const links = new ControlAssistantLinkClient({
  controlUrl: config.controlUrl,
  serviceToken: config.assistantServiceToken,
});
const app = createAssistantGatewayApp({
  blueBubbles,
  blueBubblesAccountId: config.blueBubblesAccountId,
  blueBubblesWebhookSecret: config.blueBubblesWebhookSecret,
  links,
  processor,
});

const server = serve({ fetch: app.fetch, port: config.port });
void processor.recoverAndDrain().catch((error: unknown) => {
  console.error("assistant task recovery failed", error);
  server.close(() => {
    process.exitCode = 1;
  });
});

function stop(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
