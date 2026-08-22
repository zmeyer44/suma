import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readAssistantGatewayConfig,
  readAssistantRunnerConfig,
} from "../src/config";

describe("assistant gateway config", () => {
  it("names every missing credential instead of falling back", () => {
    expect(() => readAssistantGatewayConfig({})).toThrow(
      "SUMA_ASSISTANT_MASTER_KEY",
    );
  });

  it("accepts a complete explicit configuration", () => {
    const config = readAssistantGatewayConfig({
      SUMA_ASSISTANT_DATA_DIR: "/data/assistant",
      SUMA_ASSISTANT_MASTER_KEY: randomBytes(32).toString("base64"),
      SUMA_ASSISTANT_RUNNER_URL: "https://runner.internal/",
      SUMA_ASSISTANT_RUNNER_TOKEN: "runner-token",
      SUMA_CONTROL_URL: "https://control.example/",
      ASSISTANT_SERVICE_TOKEN: "assistant-service-token",
      BLUEBUBBLES_SERVER_URL: "https://messages.example/",
      BLUEBUBBLES_ACCOUNT_ID: "personal",
      BLUEBUBBLES_PASSWORD: "password",
      BLUEBUBBLES_WEBHOOK_SECRET: "webhook-secret",
      SUMA_ASSISTANT_PORT: "9000",
    });
    expect(config.port).toBe(9000);
    expect(config.masterKey).toHaveLength(32);
  });
});

describe("assistant runner config", () => {
  it("fails closed and names the runner's missing credentials", () => {
    expect(() => readAssistantRunnerConfig({})).toThrow(
      "AI_GATEWAY_API_KEY",
    );
  });

  it("accepts a complete explicit configuration", () => {
    const config = readAssistantRunnerConfig({
      SUMA_ASSISTANT_DATA_DIR: "/data/assistant",
      SUMA_ASSISTANT_MASTER_KEY: randomBytes(32).toString("base64"),
      SUMA_ASSISTANT_RUNNER_TOKEN: "runner-token",
      SUMA_CONTROL_URL: "https://control.example/base/",
      ASSISTANT_SERVICE_TOKEN: "assistant-service-token",
      AI_GATEWAY_API_KEY: "gateway-key",
      SUMA_ASSISTANT_RUNNER_PORT: "9001",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/chromium",
    });

    expect(config).toMatchObject({
      port: 9001,
      controlUrl: "https://control.example/base/",
      chromiumExecutablePath: "/opt/chromium",
    });
    expect(config.masterKey).toHaveLength(32);
  });
});
