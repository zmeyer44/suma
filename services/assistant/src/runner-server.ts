import { serve } from "@hono/node-server";
import { join } from "node:path";
import { gateway } from "ai";
import { readAssistantRunnerConfig } from "./config";
import { ControlAssistantLinkClient } from "./control-client";
import {
  AiSdkAssistantHarness,
  EncryptedFileAssistantConversationStore,
  ProductionAssistantResources,
  RemoteAssistantToolProvider,
  createAssistantRunnerApp,
} from "./harness";

const config = readAssistantRunnerConfig();
const control = new ControlAssistantLinkClient({
  controlUrl: config.controlUrl,
  serviceToken: config.assistantServiceToken,
});
const resources = new ProductionAssistantResources({
  control,
  dataDirectory: config.dataDirectory,
  masterKey: config.masterKey,
  executablePath: config.chromiumExecutablePath,
});
const tools = new RemoteAssistantToolProvider(resources);
const conversations = new EncryptedFileAssistantConversationStore(
  join(config.dataDirectory, "conversations"),
  config.masterKey,
);
const harness = new AiSdkAssistantHarness({
  model: gateway("anthropic/claude-sonnet-4.5"),
  modelForTask: (modelId) => gateway(modelId),
  conversations,
  toolsForTask: (task) => tools.toolsForTask(task),
});
const app = createAssistantRunnerApp({ token: config.runnerToken, harness });
const server = serve({ fetch: app.fetch, port: config.port });

function stop(): void {
  server.close(() => {
    void resources.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
