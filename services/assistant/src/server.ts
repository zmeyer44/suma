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
const app = createAssistantGatewayApp({
  blueBubbles,
  blueBubblesAccountId: config.blueBubblesAccountId,
  blueBubblesWebhookSecret: config.blueBubblesWebhookSecret,
  processor,
});

const server = serve({ fetch: app.fetch, port: config.port });
void processor.recoverAndDrain();

function stop(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
