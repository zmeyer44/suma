import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTokenKeypair, toBase64 } from "@suma/protocol";
import type {
  ConnectedDeviceInfo,
  EnrollmentStatus,
  SpaceInfo,
  TabInfo,
} from "../apps/desktop/src/shared/ipc";

const REPO = path.resolve(process.cwd());
const CONTROL_PORT = 18_791;
const HUB_PORT = 18_792;
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const HUB_HTTP_URL = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS_URL = `ws://127.0.0.1:${HUB_PORT}/v1/hub/ws`;
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots", "device-linking");

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(url)).ok;
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
}

async function launchMac(
  name: string,
  userData: string,
): Promise<ElectronApplication> {
  const executablePath = path.join(
    REPO,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
  const app = await electron.launch({
    executablePath,
    args: [
      path.join(REPO, "apps/desktop/out/main/index.js"),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...process.env,
      SUMA_CONTROL_URL: CONTROL_URL,
      SUMA_HUB_URL: "",
    },
  });
  app.on("console", (message) => {
    if (message.type() === "error")
      process.stderr.write(`[${name}] ${message.text()}\n`);
  });
  return app;
}

async function invoke<T>(
  app: ElectronApplication,
  channel: string,
  args: unknown,
): Promise<T> {
  const result = await app.evaluate(
    async ({ webContents }, request) => {
      for (const contents of webContents.getAllWebContents()) {
        if (
          !contents.getURL().startsWith("file:") ||
          contents.getURL().includes("#")
        )
          continue;
        const ready = await contents
          .executeJavaScript("typeof window.suma === 'object'")
          .catch(() => false);
        if (ready !== true) continue;
        return contents.executeJavaScript(
          `window.suma.invoke(${JSON.stringify(request.channel)}, ${JSON.stringify(request.args)})`,
        );
      }
      throw new Error("Suma chrome IPC bridge missing");
    },
    { channel, args },
  );
  return result as T;
}

async function screenshotWindow(
  app: ElectronApplication,
  name: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }) => {
    const chrome = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getURL().startsWith("file:") &&
          !contents.getURL().includes("#"),
      );
    if (chrome === undefined)
      throw new Error("Suma chrome WebContents missing");
    await chrome.executeJavaScript(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    const image = await chrome.capturePage();
    return image.toPNG().toString("base64");
  });
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(path.join(SCREENSHOTS, name), Buffer.from(encoded, "base64"));
}

async function openDeviceSettings(app: ElectronApplication): Promise<void> {
  const page = await app.firstWindow();
  await page.keyboard.press("Escape");
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Account activity")).toBeVisible();
}

async function startOrigin(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://linked.invalid");
    const state = url.pathname.slice(1) || "linked";
    const body = `<!doctype html>
      <html>
        <head><meta charset="utf-8"><title>Linked · ${state}</title></head>
        <body data-linked-state=${JSON.stringify(state)}>
          <main><h1>${state}</h1><p>This navigation rendered locally after device linking.</p></main>
        </body>
      </html>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("linked-device origin did not bind");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("a code-linked Mac becomes a reciprocal live device", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  const stateRoot = await mkdtemp(path.join(tmpdir(), "suma-device-link-"));
  const controlState = path.join(stateRoot, "control");
  const hubState = path.join(stateRoot, "hub");
  const profileA = path.join(stateRoot, "mac-a");
  const profileB = path.join(stateRoot, "mac-b");
  await Promise.all([
    mkdir(controlState, { recursive: true }),
    mkdir(hubState, { recursive: true }),
    mkdir(profileA, { recursive: true }),
    mkdir(profileB, { recursive: true }),
  ]);

  const signing = await generateTokenKeypair();
  const publicKey = toBase64(signing.publicKeyRaw);
  const privateKey = toBase64(signing.privateKeyPkcs8);
  const origin = await startOrigin();
  const hub = spawn(
    "pnpm",
    [
      "--filter",
      "@suma/sessionhub",
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(HUB_PORT),
      "--persist-to",
      hubState,
      "--var",
      `CONTROL_PUBLIC_KEY:${publicKey}`,
      "--var",
      "GATEWAY_DEV_ALLOW_PRIVATE:1",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  const control = spawn(
    "pnpm",
    ["--filter", "@suma/control", "exec", "tsx", "src/dev-server.ts"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(CONTROL_PORT),
        DATABASE_URL: `pglite:${controlState}`,
        OBJECT_STORE: "stub",
        SUMA_INVITES_REQUIRED: "0",
        SUMA_HUB_PUBLIC_URL: HUB_WS_URL,
        CONTROL_TOKEN_SK: privateKey,
        CONTROL_TOKEN_PK: publicKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serviceLog = "";
  for (const child of [hub, control]) {
    child.stdout?.on(
      "data",
      (chunk: Buffer) => (serviceLog += chunk.toString()),
    );
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (serviceLog += chunk.toString()),
    );
  }

  let macA: ElectronApplication | null = null;
  let macB: ElectronApplication | null = null;
  try {
    await Promise.all([
      waitForUrl(`${HUB_HTTP_URL}/healthz`),
      waitForUrl(`${CONTROL_URL}/v1/healthz`),
    ]);
    macA = await launchMac("mac-a", profileA);

    // The first Mac creates the account and becomes its first device.
    const email = `device-link-${Date.now()}@example.com`;
    await invoke<EnrollmentStatus>(macA, "auth:signup", {
      email,
      displayName: "Link Test",
    });
    const enrolledA = await invoke<EnrollmentStatus>(macA, "auth:enroll", {
      name: "Sender MacBook Pro",
    });
    expect(enrolledA.state).toBe("enrolled");
    const link = await invoke<{ code: string }>(
      macA,
      "auth:mintEnrollmentCode",
      undefined,
    );

    // The second Mac redeems the one-time code and enrolls its own identity.
    macB = await launchMac("mac-b", profileB);
    const signedInB = await invoke<EnrollmentStatus>(
      macB,
      "auth:signinWithCode",
      { code: link.code },
    );
    expect(signedInB.state).toBe("signed-up");
    const enrolledB = await invoke<EnrollmentStatus>(macB, "auth:enroll", {
      name: "Linked Mac mini",
    });
    expect(enrolledB.state).toBe("enrolled");

    // Registry identity and SessionHub presence must converge reciprocally.
    await expect
      .poll(() =>
        invoke<ConnectedDeviceInfo[]>(macA!, "devices:list", undefined),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Sender MacBook Pro",
            online: true,
            isThisDevice: true,
          }),
          expect.objectContaining({
            name: "Linked Mac mini",
            online: true,
            isThisDevice: false,
          }),
        ]),
      );
    await expect
      .poll(() =>
        invoke<ConnectedDeviceInfo[]>(macB!, "devices:list", undefined),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Sender MacBook Pro",
            online: true,
            isThisDevice: false,
          }),
          expect.objectContaining({
            name: "Linked Mac mini",
            online: true,
            isThisDevice: true,
          }),
        ]),
      );

    // A code-linked device must remain attached to the live workspace after
    // session hydration, not merely appear once in the account registry.
    await expect
      .poll(async () => {
        const spaces = await invoke<SpaceInfo[]>(
          macA!,
          "spaces:list",
          undefined,
        );
        return spaces.find((space) => space.active)?.id ?? null;
      })
      .not.toBeNull();
    const spaceId = (
      await invoke<SpaceInfo[]>(macA, "spaces:list", undefined)
    ).find((space) => space.active)?.id;
    if (spaceId === undefined) throw new Error("Mac A has no active space");
    const created = await invoke<TabInfo>(macA, "tabs:create", {
      spaceId,
      url: `${origin.origin}/from-mac-a`,
    });
    await expect
      .poll(async () => {
        const tabs = await invoke<TabInfo[]>(macB!, "tabs:list", { spaceId });
        return tabs.find((tab) => tab.id === created.id)?.url ?? null;
      })
      .toBe(`${origin.origin}/from-mac-a`);
    await invoke(macB, "tabs:navigate", {
      tabId: created.id,
      url: `${origin.origin}/from-mac-b`,
    });
    await expect
      .poll(async () => {
        const tabs = await invoke<TabInfo[]>(macA!, "tabs:list", { spaceId });
        return tabs.find((tab) => tab.id === created.id)?.url ?? null;
      })
      .toBe(`${origin.origin}/from-mac-b`);
    await expect
      .poll(() =>
        invoke<ConnectedDeviceInfo[]>(macA!, "devices:list", undefined),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Linked Mac mini", online: true }),
        ]),
      );
    await screenshotWindow(macA, "01-linked-devices-still-syncing.png");

    await openDeviceSettings(macA);
    await (await macA.firstWindow())
      .getByText("Linked Mac mini")
      .scrollIntoViewIfNeeded();
    await screenshotWindow(macA, "02-sender-sees-linked-device-online.png");
    await openDeviceSettings(macB);
    await (await macB.firstWindow())
      .getByText("Sender MacBook Pro")
      .scrollIntoViewIfNeeded();
    await screenshotWindow(macB, "03-linked-device-sees-sender-online.png");
  } catch (error) {
    throw new Error(`${String(error)}\n\nService output:\n${serviceLog}`);
  } finally {
    await macB?.close().catch(() => undefined);
    await macA?.close().catch(() => undefined);
    await closeServer(origin.server);
    control.kill("SIGTERM");
    hub.kill("SIGTERM");
  }
});
