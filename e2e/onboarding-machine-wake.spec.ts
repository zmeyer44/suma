import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateDeviceKeypair } from "@suma/protocol";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "onboarding-machine-wake-space";
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "onboarding-machine-wake",
);

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
      newTabUrl: "https://www.google.com",
    },
    originOverrides: {},
    signInQueue: [],
    permissionGrants: [],
    deviceLocal: {
      activeSpaceId: SPACE_ID,
      activeTabBySpace: {},
      todayTabsBySpace: {},
      realtimeTabsMigratedBySpace: {},
      splitTabBySpace: {},
      nativeTransportDomains: [],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function prepareProfile(): Promise<string> {
  const userData = await mkdtemp(
    path.join(tmpdir(), "suma-onboarding-machine-wake-"),
  );
  const keys = await generateDeviceKeypair();
  await Promise.all([
    writeFile(
      path.join(userData, "workspace.json"),
      JSON.stringify(workspaceFile()),
    ),
    writeFile(
      path.join(userData, "device.json"),
      JSON.stringify({
        deviceId: "onboarding-machine-wake-device",
        privateKeyJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
        publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
        spaceSecrets: {},
        enrollment: {
          state: "signed-up",
          controlUrl: "http://127.0.0.1:9",
          email: "machine-wake@example.com",
          displayName: "Machine Wake Test",
          userId: "machine-wake-user",
          deviceName: null,
          credentialKind: null,
          controlDeviceId: null,
          authToken: "hbr_dev_machine_wake",
          computeMode: "cloud",
          isHomeMachine: null,
        },
      }),
    ),
  ]);
  return userData;
}

function safeLaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "SUMA_CONTROL_URL",
    "SUMA_HUB_URL",
    "SUMA_SESSION_GATEWAY_URL",
    "SUMA_SESSION_GATEWAY_DEV_TOKEN",
    "R2_ACCOUNT_ID",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "FLY_API_TOKEN",
    "FLY_COMPUTE_IMAGE",
    "FLY_COMPUTE_APP_PREFIX",
  ]) {
    delete env[key];
  }
  env.SUMA_NO_DOTENV = "1";
  env.SUMA_AGENT_URL = "tcp://127.0.0.1:9";
  return env;
}

async function launchApp(userData: string): Promise<ElectronApplication> {
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
    env: safeLaunchEnv(),
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

async function sendWorkspaceState(
  app: ElectronApplication,
  connected: boolean,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, payload) => {
      const chrome = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getURL().startsWith("file:") &&
            !contents.getURL().includes("#"),
        );
      if (chrome === undefined)
        throw new Error("Suma chrome WebContents missing");
      chrome.send("workspace:changed", payload);
    },
    {
      source: "remote",
      connected,
      activeSpaceId: SPACE_ID,
    },
  );
}

async function settleRenderer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.suma.invoke("auth:status", undefined);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

test("a transient machine connection does not leak a workspace error into onboarding", async () => {
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });
  const userData = await prepareProfile();
  const app = await launchApp(userData);
  try {
    const page = await chromePage(app);

    // Signup now secures the Mac before waiting on the machine, so transient
    // workspace state cannot move or interrupt the credential step.
    await expect(
      page.getByRole("heading", { name: "What should unlock this Mac?" }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS, "01-credential.png"),
      fullPage: true,
    });

    // A stale up/down pulse used to start an unused file-tree request behind onboarding.
    await sendWorkspaceState(app, true);
    await expect(
      page.getByRole("heading", { name: "What should unlock this Mac?" }),
    ).toBeVisible();
    await sendWorkspaceState(app, false);
    await expect(
      page.getByRole("heading", { name: "What should unlock this Mac?" }),
    ).toBeVisible();
    await settleRenderer(page);

    // The provisioning UI owns this state; a raw workspace RPC toast is never useful here.
    await expect(page.getByText(/workspace:tree failed/)).toHaveCount(0);
    await expect(page.getByText(/suma-agent unreachable/)).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS, "02-after-transient-link.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
