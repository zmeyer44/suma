import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTokenKeypair, toBase64 } from "@suma/protocol";
import type { EnrollmentStatus } from "../apps/desktop/src/shared/ipc";

const REPO = path.resolve(process.cwd());
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "onboarding-enrollment",
);

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const secretPrefixes = [
    "AI_GATEWAY_",
    "CONTROL_TOKEN_",
    "FLY_",
    "GEMINI_",
    "R2_",
    "SUMA_AGENT_",
    "SUMA_CONTROL_",
    "SUMA_HUB_",
    "SUMA_SESSION_GATEWAY_",
  ];
  for (const key of Object.keys(env)) {
    if (secretPrefixes.some((prefix) => key.startsWith(prefix)))
      delete env[key];
  }
  env.SUMA_NO_DOTENV = "1";
  return env;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("temporary control port did not bind");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(url)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<boolean>((resolve) => {
    child.once("exit", () => resolve(true));
  });
  const graceful = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful) child.kill("SIGKILL");
}

async function launchApp(
  userData: string,
  controlUrl: string,
): Promise<ElectronApplication> {
  const executablePath = path.join(
    REPO,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
  return electron.launch({
    executablePath,
    args: [
      path.join(REPO, "apps/desktop/out/main/index.js"),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...scrubbedEnv(),
      SUMA_CONTROL_URL: controlUrl,
      // The local control uses the sandbox stub and never exposes an agent.
      SUMA_AGENT_URL: "tcp://127.0.0.1:9",
    },
  });
}

async function chromePage(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      app
        .windows()
        .map((page) => page.url())
        .find((url) => url.startsWith("file:") && !url.includes("#")),
    )
    .not.toBeUndefined();
  const page = app
    .windows()
    .find(
      (candidate) =>
        candidate.url().startsWith("file:") && !candidate.url().includes("#"),
    );
  if (page === undefined) throw new Error("Suma chrome page missing");
  await expect
    .poll(() => page.evaluate(() => typeof window.suma === "object"))
    .toBe(true);
  return page;
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOTS, name),
    fullPage: true,
  });
}

test("signup enrolls before cloud provisioning can outlive its bootstrap token", async ({}, testInfo) => {
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });
  const stateRoot = await mkdtemp(
    path.join(tmpdir(), "suma-onboarding-enroll-"),
  );
  const controlState = path.join(stateRoot, "control");
  const profile = path.join(stateRoot, "desktop");
  await Promise.all([
    mkdir(controlState, { recursive: true }),
    mkdir(profile, { recursive: true }),
  ]);

  const port = await freePort();
  const controlUrl = `http://127.0.0.1:${port}`;
  const signing = await generateTokenKeypair();
  const control = spawn(
    "pnpm",
    ["--filter", "@suma/control", "exec", "tsx", "src/server.ts"],
    {
      cwd: REPO,
      env: {
        ...scrubbedEnv(),
        PORT: String(port),
        DATABASE_URL: `pglite:${controlState}`,
        OBJECT_STORE: "stub",
        SUMA_INVITES_REQUIRED: "0",
        CONTROL_TOKEN_SK: toBase64(signing.privateKeyPkcs8),
        CONTROL_TOKEN_PK: toBase64(signing.publicKeyRaw),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let controlLog = "";
  control.stdout?.on("data", (chunk: Buffer) => {
    controlLog += chunk.toString();
  });
  control.stderr?.on("data", (chunk: Buffer) => {
    controlLog += chunk.toString();
  });

  let app: ElectronApplication | null = null;
  try {
    await waitForUrl(`${controlUrl}/v1/healthz`);
    app = await launchApp(profile, controlUrl);
    const page = await chromePage(app);

    await expect(
      page.getByRole("heading", { name: "How do you want to start?" }),
    ).toBeVisible();
    await capture(page, "01-account.png");

    const email = `onboarding-${Date.now()}@example.com`;
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Display name").fill("Onboarding Test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Where should your computer live?" }),
    ).toBeVisible();
    await capture(page, "02-computer.png");

    await page.getByRole("button", { name: "Create my computer" }).click();
    await expect(
      page.getByRole("heading", { name: "What should unlock this Mac?" }),
    ).toBeVisible();
    await expect(page.getByText("I'll do this later")).toHaveCount(0);
    await capture(page, "03-credential-before-provisioning.png");

    await page.getByRole("button", { name: "Secure this Mac" }).click();
    await expect(
      page.getByRole("heading", { name: "Setting up your computer" }),
    ).toBeVisible({ timeout: 30_000 });
    const status = await page.evaluate(
      () =>
        window.suma.invoke(
          "auth:status",
          undefined,
        ) as Promise<EnrollmentStatus>,
    );
    expect(status.state).toBe("enrolled");
    await expect(page.getByText(/auth:enroll failed/i)).toHaveCount(0);
    await expect(page.getByText(/unauthorized/i)).toHaveCount(0);
    await capture(page, "04-enrolled-and-provisioning.png");
  } finally {
    if (app !== null) await app.close();
    await stopProcess(control);
    await testInfo.attach("isolated-control.log", {
      body: controlLog,
      contentType: "text/plain",
    });
    await rm(stateRoot, { recursive: true, force: true });
  }
});
