import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDeviceKeypair,
  generateSpaceRootSecret,
  toBase64,
} from "@suma/protocol";
import type { TabInfo } from "../apps/desktop/src/shared/ipc";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "rotating-auth-space";
const HUB_PORT = 18_791;
const HUB_HTTP_URL = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS_URL = `ws://127.0.0.1:${HUB_PORT}/v1/hub/ws`;
const SCREENSHOTS = path.join(
  REPO,
  "artifacts",
  "e2e",
  "2026-08-09-manual-sync",
  "auth-session",
);

function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "Shared",
        color: "#ff5f57",
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

function html(authenticated: boolean, generation: number): string {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${authenticated ? "YouTube · Signed in" : "YouTube · Sign in"}</title>
        <style>
          :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f8f8f8;
            background: radial-gradient(circle at 18% 18%, #5e1717 0, transparent 36%),
                        radial-gradient(circle at 82% 82%, #312350 0, transparent 42%), #0f0f0f; }
          main { width: min(720px, calc(100vw - 48px)); padding: 48px; border-radius: 28px;
            border: 1px solid #ffffff20; background: #191919e8; box-shadow: 0 30px 100px #000a; }
          .eyebrow { color: #ff7474; font-size: 12px; font-weight: 800; letter-spacing: .16em;
            text-transform: uppercase; }
          h1 { margin: 16px 0 12px; font-size: clamp(40px, 7vw, 70px); line-height: 1;
            letter-spacing: -.055em; }
          p { margin: 0; color: #c9c9c9; font-size: 18px; line-height: 1.55; }
          a { display: inline-flex; margin-top: 26px; padding: 13px 22px; border-radius: 999px;
            color: #fff; background: #ff3939; text-decoration: none; font-weight: 800; }
          code { color: #fff; }
        </style>
      </head>
      <body data-auth-state="${authenticated ? "authenticated" : "signed-out"}"
        data-generation="${generation}">
        <main>
          <div class="eyebrow">Modeled YouTube rotating session</div>
          <h1>${authenticated ? "Still signed in." : "Sign in once."}</h1>
          <p>${
            authenticated
              ? `This request rotated the session to generation <code>${generation}</code>. The other connected Mac can now pull it explicitly.`
              : "Mac A will create the session. Mac B must inherit it through the manual sync control while both remain online."
          }</p>
          ${authenticated ? "" : '<a id="sign-in" href="/login">Continue with Google</a>'}
        </main>
      </body>
    </html>`;
}

async function startRotatingOrigin(): Promise<{
  server: Server;
  origin: string;
  spkiHash: string;
}> {
  const certificateDir = await mkdtemp(
    path.join(tmpdir(), "suma-rotating-cert-"),
  );
  const keyPath = path.join(certificateDir, "key.pem");
  const certificatePath = path.join(certificateDir, "certificate.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=youtube.com",
    "-addext",
    "subjectAltName=DNS:youtube.com",
  ]);
  const [key, certificate] = await Promise.all([
    readFile(keyPath),
    readFile(certificatePath),
  ]);
  const x509 = new X509Certificate(certificate);
  const spki = x509.publicKey.export({ type: "spki", format: "der" });
  const spkiHash = createHash("sha256").update(spki).digest("base64");
  let generation = 0;
  let currentToken: string | null = null;
  const rotate = (): string => {
    generation += 1;
    currentToken = `session-generation-${generation}`;
    return currentToken;
  };
  const server = createServer(
    { key, cert: certificate },
    (request, response) => {
      const url = new URL(request.url ?? "/", "https://youtube.com");
      const supplied = (request.headers.cookie ?? "")
        .split(/;\s*/)
        .find((value) => value.startsWith("SID="))
        ?.slice("SID=".length);
      if (url.pathname === "/login") {
        const token = rotate();
        response.writeHead(302, {
          location: "/account",
          "set-cookie": `SID=${token}; Domain=youtube.com; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      const authenticated =
        url.pathname === "/account" &&
        currentToken !== null &&
        supplied === currentToken;
      const body = html(authenticated, generation + (authenticated ? 1 : 0));
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
      };
      if (authenticated) {
        headers["set-cookie"] =
          `SID=${rotate()}; Domain=youtube.com; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
      }
      response.writeHead(authenticated ? 200 : 401, headers);
      response.end(body);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("rotating auth origin did not bind");
  return {
    server,
    origin: `https://youtube.com:${address.port}`,
    spkiHash,
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

async function prepareProfile(
  name: string,
  workspaceSecret: Uint8Array,
  spaceSecret: Uint8Array,
): Promise<string> {
  const userData = await mkdtemp(
    path.join(tmpdir(), `suma-rotating-auth-${name}-`),
  );
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
        email: "rotating@example.com",
        userId: "rotating",
        deviceName: name === "mac-a" ? "Mac A" : "Mac B",
        credentialKind: "device-key",
        controlDeviceId: `control-${name}`,
        authToken: `hbr_dev_rotating.${name}`,
      },
    }),
  );
  return userData;
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

async function launchMac(
  name: string,
  userData: string,
  spkiHash: string,
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
      "--host-resolver-rules=MAP youtube.com 127.0.0.1",
      `--ignore-certificate-errors-spki-list=${spkiHash}`,
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

async function createTab(
  app: ElectronApplication,
  url: string,
): Promise<TabInfo> {
  const tab = await invoke<TabInfo>(app, "tabs:create", {
    spaceId: SPACE_ID,
    url,
  });
  if (tab === null) throw new Error("tab creation failed");
  return tab;
}

async function pageState(
  app: ElectronApplication,
  origin: string,
): Promise<{ auth: string | null; generation: string | null } | null> {
  return app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(target));
    if (contents === undefined) return null;
    return contents.executeJavaScript(`({
        auth: document.body?.dataset.authState ?? null,
        generation: document.body?.dataset.generation ?? null
      })`);
  }, origin);
}

async function cookieValue(
  app: ElectronApplication,
  origin: string,
): Promise<string | null> {
  return app.evaluate(
    async ({ session }, args) => {
      const cookies = await session
        .fromPartition(`persist:space-${args.spaceId}`)
        .cookies.get({ url: args.origin });
      return cookies.find((cookie) => cookie.name === "SID")?.value ?? null;
    },
    { spaceId: SPACE_ID, origin },
  );
}

async function clickSignIn(
  app: ElectronApplication,
  origin: string,
): Promise<void> {
  const clicked = await app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(target));
    if (contents === undefined) return false;
    return contents.executeJavaScript(`(() => {
        const link = document.querySelector('#sign-in');
        if (!(link instanceof HTMLAnchorElement)) return false;
        link.click();
        return true;
      })()`);
  }, origin);
  expect(clicked).toBe(true);
}

async function screenshotTab(
  app: ElectronApplication,
  origin: string,
  filename: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(target));
    if (contents === undefined) throw new Error("auth tab missing");
    await contents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const image = await contents.capturePage();
    return image.toPNG().toString("base64");
  }, origin);
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(
    path.join(SCREENSHOTS, filename),
    Buffer.from(encoded, "base64"),
  );
}

async function screenshotChrome(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }) => {
    const chrome = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getURL().startsWith("file:") &&
          !contents.getURL().includes("#"),
      );
    if (chrome === undefined) throw new Error("Suma chrome missing");
    await chrome.executeJavaScript(
      `Promise.all(document.getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)))
        .then(() => new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
    );
    const image = await chrome.capturePage();
    return image.toPNG().toString("base64");
  });
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(
    path.join(SCREENSHOTS, filename),
    Buffer.from(encoded, "base64"),
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("rotating Google-style auth is staged and pulled while both Macs stay online", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  const stateDir = await mkdtemp(path.join(tmpdir(), "suma-rotating-hub-"));
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

  const auth = await startRotatingOrigin();
  const workspaceSecret = generateSpaceRootSecret();
  const spaceSecret = generateSpaceRootSecret();
  const profileA = await prepareProfile("mac-a", workspaceSecret, spaceSecret);
  const profileB = await prepareProfile("mac-b", workspaceSecret, spaceSecret);
  let macA: ElectronApplication | null = null;
  let macB: ElectronApplication | null = null;
  try {
    await waitForUrl(`${HUB_HTTP_URL}/healthz`);
    macA = await launchMac("mac-a", profileA, auth.spkiHash);
    macB = await launchMac("mac-b", profileB, auth.spkiHash);

    const chromeA = await macA.firstWindow();
    const chromeB = await macB.firstWindow();
    const syncA = chromeA.getByTestId("workspace-sync-button");
    const syncB = chromeB.getByTestId("workspace-sync-button");

    // Mac A creates the only login. Mac B receives the encrypted update but
    // its cookie store remains untouched until the user explicitly Pulls.
    const tabA = await createTab(macA, `${auth.origin}/`);
    await expect
      .poll(() => pageState(macA!, auth.origin))
      .toMatchObject({
        auth: "signed-out",
      });
    await clickSignIn(macA, auth.origin);
    await expect
      .poll(() => pageState(macA!, auth.origin))
      .toMatchObject({
        auth: "authenticated",
      });
    await screenshotTab(macA, auth.origin, "01-mac-a-signed-in.png");
    await expect(syncB).toBeEnabled();
    expect(await cookieValue(macB, auth.origin)).toBeNull();
    await screenshotChrome(macB, "02-mac-b-session-change-pending.png");

    await syncB.click();
    await expect(chromeB.getByTestId("workspace-sync-options")).toBeVisible();
    await screenshotChrome(macB, "03-mac-b-pull-choice.png");
    await chromeB.getByTestId("workspace-sync-pull").click();
    await expect.poll(() => cookieValue(macB!, auth.origin)).not.toBeNull();
    await expect(syncB).toBeDisabled();

    // Mac B can use and rotate the inherited session without disconnecting A.
    const tabB = await createTab(macB, `${auth.origin}/account`);
    await expect
      .poll(() => pageState(macB!, auth.origin))
      .toMatchObject({
        auth: "authenticated",
      });
    await screenshotTab(
      macB,
      auth.origin,
      "04-mac-b-authenticated-after-pull.png",
    );

    // B's rotation is staged on A. Merge applies cookies before it applies or
    // follows workspace URLs, then reloads A against the new cookie lineage.
    await expect(syncA).toBeEnabled();
    await syncA.click();
    await expect(chromeA.getByText("Remote changes")).toBeVisible();
    await expect(chromeA.getByText("Changes on this Mac")).toBeVisible();
    await chromeA.getByTestId("workspace-sync-merge").click();
    await expect
      .poll(() => pageState(macA!, auth.origin))
      .toMatchObject({
        auth: "authenticated",
      });
    await screenshotTab(macA, auth.origin, "05-mac-a-merged-session.png");
    expect(tabA.id).not.toBe(tabB.id);
  } catch (error) {
    throw new Error(`${String(error)}\n\nSessionHub output:\n${hubLog}`);
  } finally {
    await macB?.close().catch(() => undefined);
    await macA?.close().catch(() => undefined);
    await closeServer(auth.server);
    hub.kill("SIGTERM");
  }
});
