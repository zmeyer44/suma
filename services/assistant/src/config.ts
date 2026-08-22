export interface AssistantGatewayConfig {
  port: number;
  dataDirectory: string;
  masterKey: Buffer;
  runnerUrl: string;
  runnerToken: string;
  blueBubblesServerUrl: string;
  blueBubblesAccountId: string;
  blueBubblesPassword: string;
  blueBubblesWebhookSecret: string;
}

export function readAssistantGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssistantGatewayConfig {
  const required = [
    "SUMA_ASSISTANT_DATA_DIR",
    "SUMA_ASSISTANT_MASTER_KEY",
    "SUMA_ASSISTANT_RUNNER_URL",
    "SUMA_ASSISTANT_RUNNER_TOKEN",
    "BLUEBUBBLES_SERVER_URL",
    "BLUEBUBBLES_ACCOUNT_ID",
    "BLUEBUBBLES_PASSWORD",
    "BLUEBUBBLES_WEBHOOK_SECRET",
  ] as const;
  const missing = required.filter((name) => !nonempty(env[name]));
  if (missing.length > 0) {
    throw new Error(
      `assistant gateway is not configured; missing ${missing.join(", ")}`,
    );
  }
  const masterKey = Buffer.from(env["SUMA_ASSISTANT_MASTER_KEY"] ?? "", "base64");
  if (masterKey.byteLength !== 32) {
    throw new Error("SUMA_ASSISTANT_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  const rawPort = env["SUMA_ASSISTANT_PORT"] ?? "8790";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SUMA_ASSISTANT_PORT must be an integer from 1 to 65535");
  }
  return {
    port,
    dataDirectory: env["SUMA_ASSISTANT_DATA_DIR"] as string,
    masterKey,
    runnerUrl: validHttpUrl(env["SUMA_ASSISTANT_RUNNER_URL"] as string),
    runnerToken: env["SUMA_ASSISTANT_RUNNER_TOKEN"] as string,
    blueBubblesServerUrl: validHttpUrl(
      env["BLUEBUBBLES_SERVER_URL"] as string,
    ),
    blueBubblesAccountId: env["BLUEBUBBLES_ACCOUNT_ID"] as string,
    blueBubblesPassword: env["BLUEBUBBLES_PASSWORD"] as string,
    blueBubblesWebhookSecret: env["BLUEBUBBLES_WEBHOOK_SECRET"] as string,
  };
}

function nonempty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function validHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`expected an HTTP(S) URL, got ${url.protocol}`);
  }
  return url.href;
}
