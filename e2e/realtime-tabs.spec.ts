import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDeviceKeypair,
  generateSpaceRootSecret,
  toBase64,
} from "@suma/protocol";
import type { TabInfo } from "../apps/desktop/src/shared/ipc";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "realtime-tabs-space";
const HUB_PORT = 18_790;
const HUB_HTTP_URL = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS_URL = `ws://127.0.0.1:${HUB_PORT}/v1/hub/ws`;
const ARTIFACT_ROOT = path.join(
  REPO,
  "artifacts",
  "e2e",
  "2026-08-09-device-snapshots",
);
const SCREENSHOTS = path.join(ARTIFACT_ROOT, "workspace");
function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "Shared",
        color: "#6bd6c8",
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

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function startOrigin(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin.invalid");
    const label = url.pathname.slice(1) || "landing";
    const body = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Realtime · ${label}</title>
          <style>
            :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
            * { box-sizing: border-box; }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f7fbfa;
              background: radial-gradient(circle at 15% 12%, #286b67 0, transparent 42%),
                          radial-gradient(circle at 90% 88%, #483076 0, transparent 44%), #0f1518; }
            main { width: min(720px, calc(100vw - 48px)); padding: 48px; border-radius: 28px;
              border: 1px solid #ffffff22; background: #151d22e8; box-shadow: 0 30px 100px #0009; }
            .eyebrow { color: #7ce5d7; font-size: 12px; font-weight: 800; letter-spacing: .16em;
              text-transform: uppercase; }
            h1 { margin: 16px 0 12px; font-size: clamp(42px, 7vw, 72px); letter-spacing: -.055em; }
            p { margin: 0; color: #b9c9c8; font-size: 18px; line-height: 1.55; }
            code { color: #fff; }
          </style>
        </head>
        <body data-page=${JSON.stringify(label)}>
          <main>
            <div class="eyebrow">Live workspace · locally rendered</div>
            <h1>${label.replaceAll("-", " ")}</h1>
            <p>This page is running in this Mac&rsquo;s WebContents. Its shared tab identity is <code>${label}</code>.</p>
          </main>
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
    throw new Error("origin did not bind");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function prepareProfile(
  name: string,
  workspaceSecret: Uint8Array,
  spaceSecret: Uint8Array,
): Promise<string> {
  const userData = await mkdtemp(path.join(tmpdir(), `suma-realtime-${name}-`));
  const keys = await generateDeviceKeypair();
  await writeFile(
    path.join(userData, "workspace.json"),
    JSON.stringify(workspaceFile()),
  );
  await writeFile(
    path.join(userData, "device.json"),
    JSON.stringify({
      deviceId: name,
      privateKeyJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
      publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
      spaceSecrets: { [SPACE_ID]: toBase64(spaceSecret) },
      workspaceSecret: toBase64(workspaceSecret),
      enrollment: {
        state: "enrolled",
        controlUrl: "http://127.0.0.1:9",
        email: "realtime@example.com",
        userId: "realtime",
        deviceName:
          name === "mac-a" ? "Claudius’s MacBook Pro" : "Studio Mac mini",
        credentialKind: "device-key",
        controlDeviceId: `control-${name}`,
        authToken: `hbr_dev_realtime.${name}`,
      },
    }),
  );
  return userData;
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
    env: { ...process.env, SUMA_HUB_URL: HUB_WS_URL },
  });
  app.on("console", (message) => {
    if (message.type() === "error")
      process.stderr.write(`[${name}] ${message.text()}\n`);
  });
  await expect
    .poll(() => invoke(app, "sync:status", undefined))
    .toMatchObject({ state: "connected" });
  return app;
}

async function invoke<T>(
  app: ElectronApplication,
  channel: string,
  args: unknown,
): Promise<T | null> {
  return app.evaluate(
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
      return null;
    },
    { channel, args },
  ) as Promise<T | null>;
}

async function tabs(app: ElectronApplication): Promise<TabInfo[]> {
  return (
    (await invoke<TabInfo[]>(app, "tabs:list", { spaceId: SPACE_ID })) ?? []
  );
}

async function createTab(
  app: ElectronApplication,
  url: string,
): Promise<TabInfo> {
  const created = await invoke<TabInfo>(app, "tabs:create", {
    spaceId: SPACE_ID,
    url,
  });
  if (created === null) throw new Error("tab creation failed");
  return created;
}

async function screenshotWindow(
  app: ElectronApplication,
  name: string,
  directory = SCREENSHOTS,
): Promise<void> {
  const chrome = await app.firstWindow();
  await chrome.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await mkdir(directory, { recursive: true });
  await chrome.screenshot({ path: path.join(directory, name) });
}

async function renderedTabIds(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(async ({ webContents }) => {
    const chrome = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getURL().startsWith("file:") &&
          !contents.getURL().includes("#"),
      );
    if (chrome === undefined) return [];
    return chrome.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-flip-id]'))
        .map((element) => element.getAttribute('data-flip-id'))
        .filter((id) => id !== null && !id.startsWith('__'))`,
    );
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("a linked Mac inherits canonical state and can sync distinct device snapshots", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  const stateDir = await mkdtemp(path.join(tmpdir(), "suma-realtime-hub-"));
  const hub: ChildProcess = spawn(
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
      stateDir,
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let hubLog = "";
  hub.stdout?.on("data", (chunk: Buffer) => (hubLog += chunk.toString()));
  hub.stderr?.on("data", (chunk: Buffer) => (hubLog += chunk.toString()));

  const origin = await startOrigin();
  const workspaceSecret = generateSpaceRootSecret();
  const spaceSecret = generateSpaceRootSecret();
  const profileA = await prepareProfile("mac-a", workspaceSecret, spaceSecret);
  const profileB = await prepareProfile("mac-b", workspaceSecret, spaceSecret);
  let macA: ElectronApplication | null = null;
  let macB: ElectronApplication | null = null;
  try {
    await waitForUrl(`${HUB_HTTP_URL}/healthz`);
    macA = await launchMac("mac-a", profileA);
    const chromeA = await macA.firstWindow();
    const syncA = chromeA.getByTestId("workspace-sync-button");
    await expect(syncA).toBeDisabled();

    // The first Mac explicitly establishes the canonical restore point.
    const one = await createTab(macA, `${origin.origin}/one`);
    const two = await createTab(macA, `${origin.origin}/two`);
    const three = await createTab(macA, `${origin.origin}/three`);
    await expect.poll(() => renderedTabIds(macA!)).toHaveLength(3);
    await expect(syncA).toBeEnabled();
    await syncA.click();
    await expect(chromeA.getByTestId("workspace-sync-options")).toBeVisible();
    await chromeA.getByTestId("workspace-sync-push").click();
    await expect(syncA).toBeDisabled();
    // Let the baseline success notification complete before testing a later,
    // unrelated device-change state on this same window.
    await expect(chromeA.getByTestId("toast")).toHaveCount(0, {
      timeout: 10_000,
    });
    await screenshotWindow(macA, "01-mac-a-canonical-baseline.png");

    // A newly linked Mac inherits canonical tabs without opening Sync.
    macB = await launchMac("mac-b", profileB);
    const chromeB = await macB.firstWindow();
    const syncB = chromeB.getByTestId("workspace-sync-button");
    await expect
      .poll(async () => (await tabs(macB!)).map((tab) => tab.id))
      .toEqual([one.id, two.id, three.id]);
    await expect(syncB).toBeDisabled();
    await screenshotWindow(macB, "02-mac-b-first-link-inherited.png");

    // Mac B auto-saves a navigation to its own lane; canonical and Mac A stay put.
    await invoke(macB, "tabs:navigate", {
      tabId: two.id,
      url: `${origin.origin}/two-from-mac-b`,
    });
    await expect
      .poll(
        async () => (await tabs(macB!)).find((tab) => tab.id === two.id)?.url,
      )
      .toBe(`${origin.origin}/two-from-mac-b`);
    await expect(syncA).toBeEnabled();
    expect((await tabs(macA)).find((tab) => tab.id === two.id)?.url).toBe(
      `${origin.origin}/two`,
    );
    await screenshotWindow(macA, "03-mac-b-device-copy-ready.png");

    // Mac A can target Mac B directly; Push is intentionally unavailable for peers.
    await syncA.click();
    await expect(chromeA.getByTestId("workspace-sync-sources")).toBeVisible();
    const macBSource = chromeA.getByTestId("workspace-sync-source-mac-b");
    await expect(macBSource).toContainText("Studio Mac mini");
    await macBSource.click();
    await expect(chromeA.getByTestId("workspace-sync-push")).toHaveCount(0);
    await screenshotWindow(macA, "04-mac-b-selected-as-source.png");
    await chromeA.getByTestId("workspace-sync-pull").click();
    await expect
      .poll(
        async () => (await tabs(macA!)).find((tab) => tab.id === two.id)?.url,
      )
      .toBe(`${origin.origin}/two-from-mac-b`);
    await screenshotWindow(macA, "05-pulled-mac-b-device-copy.png");

    // Matching Mac B locally removes the redundant device choice; canonical remains available.
    await expect(chromeA.getByTestId("toast")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(syncA).toBeEnabled();
    await syncA.click();
    await expect(
      chromeA.getByTestId("workspace-sync-source-mac-b"),
    ).toHaveCount(0);
    await expect(
      chromeA.getByTestId("workspace-sync-source-canonical"),
    ).toContainText("Different");
    await screenshotWindow(macA, "06-redundant-device-source-hidden.png");
    await chromeA.getByTestId("workspace-sync-push").click();
    await expect(syncA).toBeDisabled();
    await expect(syncB).toBeDisabled();

    // Device-specific Merge preserves unique work from both Macs before a canonical Push.
    const localA = await createTab(macA, `${origin.origin}/local-a`);
    const localB = await createTab(macB, `${origin.origin}/local-b`);
    await expect(syncA).toBeEnabled();
    await syncA.click();
    const changedMacBSource = chromeA.getByTestId(
      "workspace-sync-source-mac-b",
    );
    await expect(changedMacBSource).toBeVisible();
    await changedMacBSource.click();
    await chromeA.getByTestId("workspace-sync-merge").click();
    await expect
      .poll(async () => (await tabs(macA!)).map((tab) => tab.id))
      .toEqual([one.id, two.id, three.id, localB.id, localA.id]);
    await screenshotWindow(macA, "07-device-merge-kept-both-macs.png");

    await syncA.click();
    await chromeA.getByTestId("workspace-sync-source-canonical").click();
    await chromeA.getByTestId("workspace-sync-push").click();
    await expect(syncB).toBeEnabled();
    await syncB.click();
    await chromeB.getByTestId("workspace-sync-source-canonical").click();
    await chromeB.getByTestId("workspace-sync-pull").click();
    await expect
      .poll(async () => (await tabs(macB!)).map((tab) => tab.id))
      .toEqual([one.id, two.id, three.id, localB.id, localA.id]);
    await expect(syncA).toBeDisabled();
    await expect(syncB).toBeDisabled();
    await screenshotWindow(macB, "08-canonical-converged.png");
  } catch (error) {
    throw new Error(`${String(error)}\n\nSessionHub output:\n${hubLog}`);
  } finally {
    await macB?.close().catch(() => undefined);
    await macA?.close().catch(() => undefined);
    await closeServer(origin.server);
    hub.kill("SIGTERM");
  }
});
