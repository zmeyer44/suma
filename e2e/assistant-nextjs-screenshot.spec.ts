import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDeviceKeypair,
  generateSpaceRootSecret,
  toBase64,
} from "@suma/protocol";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "assistant-nextjs-space";
const PROMPT = "Create a NextJS app and send me a screenshot";
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "assistant-nextjs-screenshot",
);

test.skip(
  process.env["SUMA_LIVE_ASSISTANT_E2E"] !== "1",
  "set SUMA_LIVE_ASSISTANT_E2E=1 to run a billed model turn and npm scaffold",
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

async function prepareProfile(userData: string): Promise<void> {
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
        deviceId: "assistant-nextjs-device",
        privateKeyJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
        publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
        spaceSecrets: { [SPACE_ID]: toBase64(spaceSecret) },
        workspaceSecret: toBase64(workspaceSecret),
        enrollment: {
          state: "enrolled",
          controlUrl: null,
          email: "assistant-e2e@example.com",
          displayName: "Assistant E2E",
          userId: "assistant-e2e-user",
          deviceName: "Assistant E2E Mac",
          credentialKind: "device-key",
          controlDeviceId: null,
          authToken: null,
          computeMode: "local",
          isHomeMachine: true,
        },
      }),
    ),
  ]);
}

function safeLaunchEnv(
  userData: string,
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    SUMA_USER_DATA: userData,
    SUMA_WORKSPACE_ROOT: workspaceRoot,
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

async function chromePage(app: ElectronApplication): Promise<Page> {
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

async function findNextPackage(root: string): Promise<string | null> {
  async function visit(
    directory: string,
    depth: number,
  ): Promise<string | null> {
    if (depth > 4) return null;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    const packageEntry = entries.find(
      (entry) => entry.isFile() && entry.name === "package.json",
    );
    if (packageEntry !== undefined) {
      try {
        const parsed = JSON.parse(
          await readFile(path.join(directory, packageEntry.name), "utf8"),
        ) as { dependencies?: Record<string, string> };
        if (parsed.dependencies?.["next"] !== undefined) return directory;
      } catch {
        // A partially written package is not a completed Next.js scaffold.
      }
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        [".git", ".next", ".suma", "node_modules"].includes(entry.name)
      ) {
        continue;
      }
      const found = await visit(path.join(directory, entry.name), depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  return visit(root, 0);
}

async function saveCompositedWindow(
  app: ElectronApplication,
  destination: string,
): Promise<void> {
  const data = await app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
    const shell = BaseWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && !(window instanceof BrowserWindow),
    );
    if (shell === undefined) return null;
    const [width, height] = shell.getContentSize();
    const pieces: Array<{
      bounds: { x: number; y: number; width: number; height: number };
      data: string;
    }> = [];
    for (const child of shell.contentView.children) {
      const contents = child.webContents;
      if (
        contents === undefined ||
        contents.isDestroyed() ||
        !child.getVisible()
      ) {
        continue;
      }
      const image = await contents.capturePage();
      if (!image.isEmpty()) {
        pieces.push({ bounds: child.getBounds(), data: image.toDataURL() });
      }
    }
    const html =
      `<body style="margin:0;position:relative;width:${width}px;height:${height}px;background:#0f1115">` +
      pieces
        .map(
          (piece) =>
            `<img src="${piece.data}" style="position:absolute;left:${piece.bounds.x}px;top:${piece.bounds.y}px;width:${piece.bounds.width}px;height:${piece.bounds.height}px">`,
        )
        .join("") +
      "</body>";
    const compositor = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: { offscreen: true },
    });
    await compositor.loadURL(
      `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screenshot = await compositor.webContents.capturePage();
    compositor.destroy();
    return screenshot.toPNG().toString("base64");
  });
  if (data === null) throw new Error("Suma window could not be composited");
  await writeFile(destination, Buffer.from(data, "base64"));
}

test("the assistant creates and screenshots a Next.js app from one prompt", async () => {
  test.setTimeout(12 * 60 * 1_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });
  const userData = await mkdtemp(
    path.join(tmpdir(), "suma-assistant-profile-"),
  );
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "suma-assistant-workspace-"),
  );
  await prepareProfile(userData);
  const executablePath = path.join(
    REPO,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
  const app = await electron.launch({
    executablePath,
    args: [path.join(REPO, "apps/desktop/out/main/index.js")],
    env: safeLaunchEnv(userData, workspaceRoot),
  });

  try {
    const page = await chromePage(app);

    // The test starts from the same empty assistant state a user sees.
    const chatToggle = page.getByRole("button", {
      name: "AI chat",
      exact: true,
    });
    await expect(chatToggle).toBeVisible();
    await chatToggle.evaluate((button: HTMLButtonElement) => button.click());
    const chat = page.getByRole("complementary", { name: "AI chat" });
    await expect(chat).toBeVisible();
    await expect(page.getByLabel("Message")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS, "01-chat-ready.png"),
      fullPage: true,
    });

    // The exact natural-language request must start a real multi-tool turn.
    await page.getByLabel("Message").fill(PROMPT);
    await page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')
        ?.click();
    });
    await expect(
      page.getByLabel("Conversation").getByText(PROMPT),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS, "02-agent-working.png"),
      fullPage: true,
    });

    // Completion is only real when the tool loop settles and exposes its screenshot.
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, {
      timeout: 10 * 60 * 1_000,
    });
    const conversation = page.getByLabel("Conversation");
    await expect(conversation.getByText("Took a screenshot")).toBeVisible();
    await expect(
      conversation.locator('img[src^="data:image/"]').last(),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS, "03-agent-complete.png"),
      fullPage: true,
    });

    // Files and a live localhost tab prove the result is more than chat prose.
    await expect.poll(() => findNextPackage(workspaceRoot)).not.toBeNull();
    await expect
      .poll(() =>
        app
          .windows()
          .find((candidate) =>
            /^http:\/\/(?:localhost|127\.0\.0\.1):\d+/u.test(candidate.url()),
          ),
      )
      .not.toBeUndefined();
    const preview = app
      .windows()
      .find((candidate) =>
        /^http:\/\/(?:localhost|127\.0\.0\.1):\d+/u.test(candidate.url()),
      );
    if (preview === undefined) throw new Error("Next.js preview tab missing");
    await preview.screenshot({
      path: path.join(SCREENSHOTS, "04-rendered-nextjs-page.png"),
      fullPage: true,
    });
    await saveCompositedWindow(
      app,
      path.join(SCREENSHOTS, "05-composited-result.png"),
    );
  } finally {
    await app.close();
    await Promise.all([
      rm(userData, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});
