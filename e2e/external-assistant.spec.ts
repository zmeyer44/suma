import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/pglite";
import type { AssistantHarness } from "@suma/assistant-core/channel";
import {
  generateDeviceKeypair,
  generateSpaceRootSecret,
  toBase64,
} from "@suma/protocol";
import { createApp as createControlApp } from "../services/control/src/app";
import { ensureSchema } from "../services/control/src/db/migrate";
import * as controlSchema from "../services/control/src/db/schema";
import { StubSandboxProvider } from "../services/control/src/providers/sandbox";
import { createAssistantGatewayApp } from "../services/assistant/src/app";
import {
  BrowserSessionTransferService,
  EncryptedFileBrowserSessionStore,
  PlaywrightBrowserBackend,
  PlaywrightBrowserRuntime,
  SafeBrowserNetworkPolicy,
} from "../services/assistant/src/browser";
import { BlueBubblesAdapter } from "../services/assistant/src/channels/bluebubbles";
import { ControlAssistantLinkClient } from "../services/assistant/src/control-client";
import {
  RemoteRunnerClient,
  createAssistantRunnerApp,
} from "../services/assistant/src/harness";
import {
  AssistantTaskProcessor,
  EncryptedFileAssistantTaskStore,
} from "../services/assistant/src/tasks";

const REPO = path.resolve(process.cwd());
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "external-assistant",
);
const SERVICE_TOKEN = "e2e-assistant-service-token";
const RUNNER_TOKEN = "e2e-runner-token";
const WEBHOOK_SECRET = "e2e-webhook-secret";
const BLUEBUBBLES_PASSWORD = "e2e-bluebubbles-password";
const ACCOUNT_ID = "e2e-family-mac";
const EXTERNAL_USER = "+15555550123";
const EXTERNAL_THREAD = `iMessage;-;${EXTERNAL_USER}`;
const SPACE_ID = "remote-browser";

const chromePath = [
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => candidate !== undefined && existsSync(candidate));

interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

interface BridgeMessage {
  role: "user" | "assistant";
  text: string;
}

interface BridgeServer extends RunningServer {
  messages: BridgeMessage[];
  setGatewayUrl(url: string): void;
}

test.skip(chromePath === undefined, "Chrome is required for remote browser E2E");

test("desktop session handoff lets BlueBubbles drive an authenticated remote browser", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });
  const closers: Array<() => Promise<void>> = [];
  let releaseWork: () => void = () => undefined;
  let processor: AssistantTaskProcessor | undefined;
  let harnessStarted = false;
  const streamedMessages: string[] = [];
  const adapterRequests: string[] = [];
  let desktop: ElectronApplication | undefined;

  try {
    const pglite = new PGlite();
    closers.push(() => pglite.close());
    const db = drizzle(pglite, { schema: controlSchema });
    await ensureSchema(db);
    const [user] = await db
      .insert(controlSchema.users)
      .values({
        email: `external-assistant-${Date.now()}@example.com`,
        features: ["assistant", "inference"],
      })
      .returning({ id: controlSchema.users.id });
    if (user === undefined) throw new Error("failed to create E2E user");
    const deviceToken = `hbr_dev_${user.id}`;

    const assistantOptions = {
      serviceToken: SERVICE_TOKEN,
      defaultModel: "e2e/model",
      publicUrl: null as string | null,
    };
    const control = await startFetchServer(
      createControlApp(
        db,
        new StubSandboxProvider(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        assistantOptions,
      ).fetch,
    );
    closers.push(control.close);

    const account = await startAccountServer();
    closers.push(account.close);

    const bridge = await startBridgeServer();
    closers.push(bridge.close);

    const browserDirectory = await mkdtemp(
      path.join(tmpdir(), "suma-external-browser-e2e-"),
    );
    const browserStore = new EncryptedFileBrowserSessionStore(
      browserDirectory,
      randomBytes(32),
    );
    const browserRuntime = new PlaywrightBrowserRuntime({
      executablePath: chromePath,
      headless: true,
    });
    closers.push(() => browserRuntime.close());
    const browser = new PlaywrightBrowserBackend({
      runtime: browserRuntime,
      sessionKey: { userId: user.id, spaceId: SPACE_ID },
      store: browserStore,
      networkPolicy: new SafeBrowserNetworkPolicy({
        allowedOrigins: [account.url],
      }),
    });
    closers.push(() => browser.close());

    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const harness: AssistantHarness = {
      async run(task, emit) {
        harnessStarted = true;
        expect(task.authorization.userId).toBe(user.id);
        expect(task.authorization.policy.enabledToolGroups).toContain(
          "interact",
        );
        await emit({ kind: "status", text: "Working…" });
        await workGate;

        const tab = await browser.openTab(`${account.url}/account`);
        expect((await browser.readPage(tab.tabId)).text).toContain(
          "Signed in as Claudius",
        );
        await browser.typeText({
          tabId: tab.tabId,
          selector: "#display-name",
          text: "Remote Suma",
        });
        await browser.click({ tabId: tab.tabId, selector: "#save-profile" });
        const result = await browser.readPage(tab.tabId);
        expect(result.text).toContain("Signed in as Remote Suma");
        const screenshot = await browser.screenshot(tab.tabId);
        await writeFile(
          path.join(SCREENSHOTS, "06-remote-account-updated.jpg"),
          Buffer.from(screenshot.data, "base64"),
        );
        await emit({
          kind: "text",
          text: "Updated the signed-in account display name to Remote Suma.",
        });
      },
    };

    const runner = await startFetchServer(
      createAssistantRunnerApp({
        token: RUNNER_TOKEN,
        harness,
        browserSessions: {
          importBrowserSession: (userId, state) =>
            new BrowserSessionTransferService(browserStore).import(
              { userId, spaceId: SPACE_ID },
              state,
            ),
        },
      }).fetch,
    );
    closers.push(runner.close);

    const blueBubbles = new BlueBubblesAdapter({
      accountId: ACCOUNT_ID,
      serverUrl: bridge.url,
      password: BLUEBUBBLES_PASSWORD,
      fetch: (input, init) => {
        adapterRequests.push(String(input));
        return fetch(input, init);
      },
    });
    const taskDirectory = await mkdtemp(
      path.join(tmpdir(), "suma-external-tasks-e2e-"),
    );
    const remoteRunner = new RemoteRunnerClient({
      runnerUrl: runner.url,
      token: RUNNER_TOKEN,
    });
    processor = new AssistantTaskProcessor({
      store: new EncryptedFileAssistantTaskStore(
        path.join(taskDirectory, "tasks.enc"),
        randomBytes(32),
      ),
      harness: {
        run: (task, emit) =>
          remoteRunner.run(task, (message) => {
            if ("text" in message && message.text !== undefined) {
              streamedMessages.push(message.text);
            }
            return emit(message);
          }),
      },
      adapters: [blueBubbles],
    });
    const links = new ControlAssistantLinkClient({
      controlUrl: control.url,
      serviceToken: SERVICE_TOKEN,
    });
    const gateway = await startFetchServer(
      createAssistantGatewayApp({
        blueBubbles,
        blueBubblesAccountId: ACCOUNT_ID,
        blueBubblesWebhookSecret: WEBHOOK_SECRET,
        links,
        processor,
        browserSessions: {
          redeemTicket: (ticket) => links.redeemBrowserSessionTicket(ticket),
          importSession: (userId, state) =>
            remoteRunner.importBrowserSession(userId, state),
        },
      }).fetch,
    );
    closers.push(gateway.close);
    assistantOptions.publicUrl = gateway.url;
    bridge.setGatewayUrl(gateway.url);

    const codeResponse = await fetch(`${control.url}/v1/channels/link-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(codeResponse.status).toBe(201);
    const { code } = (await codeResponse.json()) as { code: string };

    await page.setViewportSize({ width: 1100, height: 820 });
    await page.goto(bridge.url);
    await expect(page.getByTestId("connection-state")).toHaveText("Not linked");

    // The initial screenshot proves this is an external chat surface, not Suma desktop.
    await page.screenshot({
      path: path.join(SCREENSHOTS, "01-unlinked-bridge.png"),
      fullPage: true,
    });

    // Linking must be explicit and confirmed in-channel before any model/tool work.
    await page.getByLabel("Message").fill(`/link ${code}`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Connected to Suma", { exact: false })).toBeVisible();
    await expect(page.getByTestId("connection-state")).toHaveText("Linked");
    await page.screenshot({
      path: path.join(SCREENSHOTS, "02-linked-bridge.png"),
      fullPage: true,
    });

    // A real desktop space holds the account cookie and live local storage;
    // Settings makes the sensitive transfer explicit before the app closes.
    const profile = await prepareDesktopProfile({
      controlUrl: control.url,
      deviceToken,
      userId: user.id,
    });
    desktop = await electron.launch({
      executablePath: path.join(
        REPO,
        "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [
        path.join(REPO, "apps/desktop/out/main/index.js"),
        `--user-data-dir=${profile}`,
      ],
      env: safeDesktopEnv(profile),
    });
    const desktopPage = await chromePage(desktop);
    await desktop.evaluate(
      async ({ session }, value) => {
        await session
          .fromPartition(`persist:space-${value.spaceId}`)
          .cookies.set({
            url: value.accountUrl,
            name: "suma_e2e_session",
            value: "authenticated",
            path: "/",
            httpOnly: true,
            sameSite: "lax",
          });
      },
      { accountUrl: account.url, spaceId: SPACE_ID },
    );
    await desktopPage.evaluate(
      (value) =>
        window.suma.invoke("tabs:create", {
          spaceId: value.spaceId,
          url: `${value.accountUrl}/account`,
        }),
      { accountUrl: account.url, spaceId: SPACE_ID },
    );
    await expect
      .poll(() => hasLiveTabUrl(desktop!, `${account.url}/account`))
      .toBe(true);
    await desktop.evaluate(
      async ({ webContents }, value) => {
        const tab = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === `${value.accountUrl}/account`);
        if (tab === undefined) throw new Error("authenticated desktop tab missing");
        await tab.executeJavaScript(
          `localStorage.setItem("workspace", "primary")`,
        );
      },
      { accountUrl: account.url },
    );
    await desktopPage.evaluate(
      (spaceId) =>
        window.suma.invoke("tabs:create", {
          spaceId,
          url: "suma://settings/assistant",
        }),
      SPACE_ID,
    );
    await expect(
      desktopPage.getByRole("heading", { name: "Assistant", exact: true }),
    ).toBeVisible();
    await expect(
      desktopPage.getByRole("button", { name: "Share active space sessions" }),
    ).toBeVisible();
    await desktopPage.screenshot({
      path: path.join(SCREENSHOTS, "03-desktop-share-ready.png"),
      fullPage: true,
    });

    // The button performs the complete ticket → gateway → private-runner
    // handoff; its receipt and the encrypted runner state are both observed.
    await desktopPage
      .getByRole("button", { name: "Share active space sessions" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect
      .poll(() => browserStore.load({ userId: user.id, spaceId: SPACE_ID }))
      .toMatchObject({
        cookies: [expect.objectContaining({ name: "suma_e2e_session" })],
        origins: [
          {
            origin: account.url,
            localStorage: [{ name: "workspace", value: "primary" }],
          },
        ],
      });
    await expect(
      desktopPage.getByTestId("remote-browser-share-receipt"),
    ).toContainText("Personal · 1 cookie · 1 site");
    await desktopPage.screenshot({
      path: path.join(SCREENSHOTS, "04-desktop-share-complete.png"),
      fullPage: true,
    });
    await desktop.close();
    desktop = undefined;

    // A streamed status proves the public gateway does not wait for the browser turn to finish.
    await page
      .getByLabel("Message")
      .fill("Open my account and change the display name to Remote Suma");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => harnessStarted).toBe(true);
    await expect.poll(() => streamedMessages).toContain("Working…");
    await expect.poll(() => adapterRequests.length).toBeGreaterThan(1);
    await expect
      .poll(() => bridge.messages.map((message) => message.text), {
        timeout: 5_000,
      })
      .toContain("Working…");
    await expect(page.getByText("Working…", { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS, "05-working-bridge.png"),
      fullPage: true,
    });

    // Releasing the deterministic turn lets the real remote browser use its shared login.
    releaseWork();
    await expect(
      page.getByText(
        "Updated the signed-in account display name to Remote Suma.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => account.profileName())
      .toBe("Remote Suma");
    await page.screenshot({
      path: path.join(SCREENSHOTS, "07-final-bridge.png"),
      fullPage: true,
    });
  } finally {
    releaseWork();
    await desktop?.close().catch(() => undefined);
    await processor?.drain().catch(() => undefined);
    for (const close of closers.reverse()) await close().catch(() => undefined);
  }
});

function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "Personal",
        color: "#5b8cff",
        position: 0,
        egressPolicy: "direct",
        createdAtMs: 1,
      },
    ],
    pins: [],
    archives: [],
    settings: {
      historySyncEnabled: false,
      autoArchiveAfterHours: 12,
      keyMode: "e2ee",
      newTabUrl: "about:blank",
    },
    originOverrides: {},
    signInQueue: [],
    permissionGrants: [],
    deviceLocal: {
      activeSpaceId: SPACE_ID,
      activeTabBySpace: {},
      todayTabsBySpace: {},
      realtimeTabsMigratedBySpace: { [SPACE_ID]: true },
      splitTabBySpace: {},
      nativeTransportDomains: [],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function prepareDesktopProfile(options: {
  controlUrl: string;
  deviceToken: string;
  userId: string;
}): Promise<string> {
  const userData = await mkdtemp(
    path.join(tmpdir(), "suma-external-desktop-e2e-"),
  );
  const keys = await generateDeviceKeypair();
  const spaceSecret = generateSpaceRootSecret();
  const workspaceSecret = generateSpaceRootSecret();
  await Promise.all([
    writeFile(
      path.join(userData, "workspace.json"),
      JSON.stringify(workspaceFile()),
    ),
    writeFile(
      path.join(userData, "device.json"),
      JSON.stringify({
        deviceId: "external-assistant-device",
        privateKeyJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
        publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
        spaceSecrets: { [SPACE_ID]: toBase64(spaceSecret) },
        workspaceSecret: toBase64(workspaceSecret),
        enrollment: {
          state: "enrolled",
          controlUrl: options.controlUrl,
          email: "external-assistant@example.com",
          displayName: "External Assistant E2E",
          userId: options.userId,
          deviceName: "External Assistant Mac",
          credentialKind: "device-key",
          controlDeviceId: null,
          authToken: options.deviceToken,
          computeMode: "local",
          isHomeMachine: true,
        },
      }),
    ),
  ]);
  return userData;
}

function safeDesktopEnv(userData: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    SUMA_USER_DATA: userData,
    SUMA_NO_DOTENV: "1",
  };
  for (const key of [
    "SUMA_CONTROL_URL",
    "SUMA_HUB_URL",
    "SUMA_SESSION_GATEWAY_URL",
    "SUMA_SESSION_GATEWAY_DEV_TOKEN",
    "SUMA_AGENT_URL",
    "SUMA_EGRESS_URL",
  ]) {
    delete env[key];
  }
  return env;
}

async function chromePage(app: ElectronApplication) {
  await expect
    .poll(() =>
      app
        .windows()
        .find(
          (candidate) =>
            candidate.url().startsWith("file:") &&
            !candidate.url().includes("#"),
        ),
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

function hasLiveTabUrl(app: ElectronApplication, url: string): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, expected) =>
      webContents
        .getAllWebContents()
        .some((contents) => contents.getURL() === expected),
    url,
  );
}

async function startAccountServer(): Promise<
  RunningServer & { profileName(): string }
> {
  let profileName = "Claudius";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://account.invalid");
    const authenticated = (request.headers.cookie ?? "")
      .split(/;\s*/)
      .includes("suma_e2e_session=authenticated");
    if (!authenticated) {
      sendHtml(response, 401, signedOutAccountPage());
      return;
    }
    if (request.method === "POST" && url.pathname === "/profile") {
      const body = new URLSearchParams((await readBody(request)).toString("utf8"));
      profileName = body.get("displayName")?.trim() || profileName;
      response.writeHead(303, { location: "/account" });
      response.end();
      return;
    }
    sendHtml(response, 200, accountPage(profileName));
  });
  const running = await listen(server);
  return { ...running, profileName: () => profileName };
}

async function startBridgeServer(): Promise<BridgeServer> {
  const messages: BridgeMessage[] = [];
  let gatewayUrl: string | null = null;
  let delivery = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://bridge.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, 200, bridgePage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/messages") {
      sendJson(response, 200, { messages });
      return;
    }
    if (request.method === "POST" && url.pathname === "/send") {
      if (gatewayUrl === null) {
        sendJson(response, 503, { error: "gateway_not_ready" });
        return;
      }
      const body = JSON.parse((await readBody(request)).toString("utf8")) as {
        text?: unknown;
      };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text === "") {
        sendJson(response, 400, { error: "empty_message" });
        return;
      }
      messages.push({ role: "user", text });
      delivery += 1;
      const webhook = await fetch(
        `${gatewayUrl}/v1/channels/bluebubbles/${ACCOUNT_ID}/webhook?secret=${WEBHOOK_SECRET}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "new-message",
            data: {
              guid: `bridge-delivery-${String(delivery)}`,
              text,
              isFromMe: false,
              chats: [{ guid: EXTERNAL_THREAD }],
              handle: { address: EXTERNAL_USER },
            },
          }),
        },
      );
      sendJson(response, webhook.status, await webhook.json());
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/message/text"
    ) {
      if (url.searchParams.get("password") !== BLUEBUBBLES_PASSWORD) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = JSON.parse((await readBody(request)).toString("utf8")) as {
        text?: unknown;
      };
      if (typeof body.text === "string") {
        messages.push({ role: "assistant", text: body.text });
      }
      sendJson(response, 200, { status: 200 });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  const running = await listen(server);
  return {
    ...running,
    messages,
    setGatewayUrl(url) {
      gatewayUrl = url;
    },
  };
}

async function startFetchServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
): Promise<RunningServer> {
  const server = serve({ fetch: fetchHandler, port: 0 }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return runningServer(server);
}

async function listen(server: Server): Promise<RunningServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return runningServer(server, address);
}

function runningServer(
  server: Server,
  knownAddress: ReturnType<Server["address"]> = server.address(),
): RunningServer {
  const address = knownAddress;
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to TCP");
  }
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function accountPage(profileName: string): string {
  const escaped = profileName.replace(/[&<>"']/g, (character) =>
    `&#${String(character.charCodeAt(0))};`,
  );
  return `<!doctype html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>Northstar Account</title><style>
      :root{font-family:Inter,ui-sans-serif,system-ui;color:#17211d;background:#edf4ef}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 15% 10%,#bce2d2,transparent 35%),#edf4ef}
      main{width:min(680px,calc(100vw - 48px));background:#fff;border:1px solid #dce8e1;border-radius:28px;padding:44px;box-shadow:0 24px 80px #19362b20}
      .eyebrow{color:#347c63;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:42px;letter-spacing:-.04em;margin:12px 0 8px}
      p{color:#68776f;font-size:17px}label{display:grid;gap:8px;margin-top:30px;font-weight:700}input{border:1px solid #cbd9d1;border-radius:14px;padding:14px 16px;font:inherit}
      button{margin-top:18px;border:0;border-radius:999px;padding:13px 20px;background:#173f31;color:white;font:inherit;font-weight:800}
    </style></head><body><main><div class="eyebrow">Northstar · Account</div>
    <h1>Signed in as ${escaped}</h1><p>Your authenticated account profile is available to the delegated Suma browser.</p>
    <form method="post" action="/profile"><label>Display name<input id="display-name" name="displayName" value="${escaped}"></label>
    <button id="save-profile" type="submit">Save profile</button></form></main></body></html>`;
}

function signedOutAccountPage(): string {
  return "<!doctype html><title>Sign in</title><body><h1>Sign in required</h1></body>";
}

function bridgePage(): string {
  return `<!doctype html>
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Messages · Suma</title><style>
    :root{font-family:Inter,ui-sans-serif,system-ui;color:#f5f7f6;background:#0e1412}*{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% 0,#203e34,transparent 38%),#0e1412;display:grid;place-items:center;padding:34px}
    main{width:min(820px,100%);height:740px;display:grid;grid-template-rows:auto 1fr auto;background:#151d1a;border:1px solid #ffffff19;border-radius:30px;overflow:hidden;box-shadow:0 34px 100px #0009}
    header{display:flex;align-items:center;gap:14px;padding:20px 24px;border-bottom:1px solid #ffffff12;background:#18231f}.avatar{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:#b6f0d8;color:#123126;font-weight:900}
    h1{font-size:17px;margin:0}.sub{color:#8da097;font-size:13px;margin-top:4px}.state{margin-left:auto;color:#9bb0a7;font-size:12px;border:1px solid #ffffff18;border-radius:999px;padding:7px 10px}
    #messages{padding:26px;overflow:auto;display:flex;flex-direction:column;gap:12px}.message{max-width:72%;padding:12px 15px;border-radius:18px;line-height:1.45;white-space:pre-wrap}.user{align-self:flex-end;background:#b6f0d8;color:#10271f;border-bottom-right-radius:5px}.assistant{align-self:flex-start;background:#25312d;color:#f1f5f3;border-bottom-left-radius:5px}
    form{display:flex;gap:10px;padding:18px;border-top:1px solid #ffffff12;background:#121916}input{flex:1;border:1px solid #ffffff20;background:#202a26;color:white;border-radius:999px;padding:14px 18px;font:inherit;outline:none}input:focus{border-color:#8bd5b8}
    button{border:0;border-radius:999px;padding:0 22px;background:#b6f0d8;color:#123126;font:inherit;font-weight:850;cursor:pointer}.empty{margin:auto;color:#75867e;text-align:center}.empty strong{display:block;color:#d5ded9;font-size:20px;margin-bottom:8px}
  </style></head><body><main><header><div class="avatar">S</div><div><h1>Suma assistant</h1><div class="sub">BlueBubbles bridge · desktop offline</div></div><div class="state" data-testid="connection-state">Not linked</div></header>
  <section id="messages" data-testid="conversation"><div class="empty"><strong>Your Suma, wherever you are.</strong>Link this chat to get started.</div></section>
  <form id="composer"><label for="message" hidden>Message</label><input id="message" aria-label="Message" autocomplete="off" placeholder="Message Suma"><button type="submit">Send</button></form></main>
  <script>
    const messages = document.querySelector('#messages');
    const state = document.querySelector('[data-testid="connection-state"]');
    let last = '';
    async function refresh(){
      const payload = await fetch('/messages').then(r=>r.json());
      const signature = JSON.stringify(payload.messages);
      if(signature===last)return; last=signature;
      messages.replaceChildren();
      if(payload.messages.length===0){const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<strong>Your Suma, wherever you are.</strong>Link this chat to get started.';messages.append(empty)}
      for(const item of payload.messages){const bubble=document.createElement('div');bubble.className='message '+item.role;bubble.textContent=item.text;messages.append(bubble)}
      if(payload.messages.some(item=>item.role==='assistant' && item.text.startsWith('Connected to Suma'))){state.textContent='Linked'}
      messages.scrollTop=messages.scrollHeight;
    }
    document.querySelector('#composer').addEventListener('submit',async(event)=>{event.preventDefault();const input=document.querySelector('#message');const text=input.value.trim();if(!text)return;input.value='';await fetch('/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});await refresh()});
    void refresh(); setInterval(()=>void refresh(),100);
  </script></body></html>`;
}
