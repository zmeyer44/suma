import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "gateway-e2e-space";
const GATEWAY_PORT = 18_788;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots");

interface TestOrigin {
  server: Server;
  url: string;
  label: string;
}

function page(label: string, authenticated: boolean): string {
  const state = authenticated ? "authenticated" : "signed-out";
  const title = authenticated ? `${label} — Account` : `${label} — Sign in`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f7f8f5;
      background: radial-gradient(circle at 20% 10%, #244b4a 0, transparent 38%),
                  radial-gradient(circle at 90% 80%, #49306b 0, transparent 42%), #111817; }
    main { width: min(720px, calc(100vw - 48px)); padding: 46px; border: 1px solid #ffffff1f;
      border-radius: 28px; background: #15211fdd; box-shadow: 0 28px 90px #0008; }
    .eyebrow { color: #8de0d2; font-size: 12px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
    h1 { margin: 14px 0 10px; font-size: clamp(34px, 6vw, 64px); letter-spacing: -.055em; line-height: .98; }
    p { color: #b8c5c1; font-size: 18px; line-height: 1.55; }
    button { margin-top: 20px; border: 0; border-radius: 999px; padding: 14px 22px; color: #10201d;
      background: #8de0d2; font: inherit; font-weight: 800; cursor: pointer; }
    .proof { display: flex; gap: 16px; align-items: center; margin-top: 30px; padding-top: 24px; border-top: 1px solid #ffffff18; }
    .pulse { width: 12px; height: 12px; border-radius: 50%; background: #8de0d2; box-shadow: 0 0 24px #8de0d2;
      animation: pulse .8s ease-in-out infinite alternate; }
    code { color: #fff; font-size: 16px; }
    @keyframes pulse { to { transform: scale(.58); opacity: .48; } }
  </style>
</head>
<body data-auth-state="${state}">
  <main>
    <div class="eyebrow">${label} · origin-owned UI</div>
    <h1>${authenticated ? "You’re already signed in." : "One sign-in. Every Mac."}</h1>
    <p>${
      authenticated
        ? "This document, CSS, animation, and JavaScript are executing in the local Electron tab. The remote gateway supplied only the authenticated HTTP response."
        : "This test creates an HttpOnly origin session on Mac A. Mac B will then open the account page directly—without displaying or submitting this form."
    }</p>
    ${
      authenticated
        ? `<div class="proof"><span class="pulse"></span><span>Local JavaScript heartbeat: <code id="counter">0</code></span></div>`
        : `<form action="/session" method="post"><button id="sign-in" type="submit">Sign in once on Mac A</button></form>`
    }
  </main>
  <script>
    const counter = document.querySelector('#counter');
    if (counter) setInterval(() => { counter.textContent = String(Number(counter.textContent) + 1); }, 100);
  </script>
</body>
</html>`;
}

function sendHtml(
  request: Parameters<Parameters<typeof createServer>[0]>[0],
  response: Parameters<Parameters<typeof createServer>[0]>[1],
  status: number,
  html: string,
): void {
  const gzip = (request.headers["accept-encoding"] ?? "").includes("gzip");
  const body = gzip ? gzipSync(html) : Buffer.from(html);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    ...(gzip ? { "content-encoding": "gzip" } : {}),
  });
  response.end(body);
}

async function startOrigin(
  label: string,
  hostForUrl: "127.0.0.1" | "localhost",
): Promise<TestOrigin> {
  const cookieValue = encodeURIComponent(
    label.toLowerCase().replace(/\s+/g, "-"),
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin.invalid");
    const authenticated = (request.headers.cookie ?? "")
      .split(/;\s*/)
      .includes(`sid=${cookieValue}`);
    if (request.method === "POST" && url.pathname === "/session") {
      response.writeHead(303, {
        location: "/account",
        "set-cookie": `sid=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname === "/account") {
      sendHtml(
        request,
        response,
        authenticated ? 200 : 401,
        page(label, authenticated),
      );
      return;
    }
    sendHtml(request, response, 200, page(label, false));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostForUrl, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("origin did not bind");
  return { server, url: `http://${hostForUrl}:${address.port}`, label };
}

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

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
    },
    originOverrides: {},
    signInQueue: [],
    permissionGrants: [],
    deviceLocal: {
      activeSpaceId: SPACE_ID,
      activeTabBySpace: {},
      todayTabsBySpace: {},
      splitTabBySpace: {},
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function launchMac(name: string): Promise<ElectronApplication> {
  const userData = await mkdtemp(path.join(tmpdir(), `suma-${name}-`));
  await writeFile(
    path.join(userData, "workspace.json"),
    JSON.stringify(workspaceFile()),
  );
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
      SUMA_SESSION_GATEWAY_URL: GATEWAY_URL,
      SUMA_SESSION_GATEWAY_DEV_TOKEN: `hbr_dev_e2e.${name}`,
    },
  });
  app.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      process.stderr.write(`[${name}] ${message.type()}: ${message.text()}\n`);
    }
  });
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          if (
            !contents.getURL().startsWith("file:") ||
            contents.getURL().includes("#")
          )
            continue;
          const ready = await contents
            .executeJavaScript("typeof window.suma === 'object'")
            .catch(() => false);
          if (ready === true) return true;
        }
        return false;
      }),
    )
    .toBe(true);
  return app;
}

async function openTab(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
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
        await contents.executeJavaScript(
          `window.suma.invoke("tabs:create", ${JSON.stringify({ spaceId: args.spaceId, url: args.url })})`,
        );
        return;
      }
      throw new Error("Suma chrome WebContents not found");
    },
    { url, spaceId: SPACE_ID },
  );
  await expect.poll(() => pageState(app, url)).not.toBeNull();
}

async function pageState(
  app: ElectronApplication,
  origin: string,
): Promise<{
  url: string;
  auth: string | null;
  counter: number | null;
  title: string;
} | null> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) return null;
      return contents.executeJavaScript(`({
        url: location.href,
        auth: document.body?.dataset.authState ?? null,
        counter: document.querySelector('#counter') ? Number(document.querySelector('#counter').textContent) : null,
        title: document.title
      })`);
    },
    { origin },
  );
}

async function mirroredCookieNames(
  app: ElectronApplication,
  url: string,
): Promise<string[]> {
  return app.evaluate(
    async ({ session }, args) => {
      const cookies = await session
        .fromPartition(`persist:space-${args.spaceId}`)
        .cookies.get({ url: args.url });
      return cookies.map((cookie) => cookie.name).sort();
    },
    { spaceId: SPACE_ID, url },
  );
}

async function clickSignIn(
  app: ElectronApplication,
  origin: string,
): Promise<void> {
  const clicked = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) return false;
      return contents.executeJavaScript(`(() => {
        const button = document.querySelector('#sign-in');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
    },
    { origin },
  );
  expect(clicked).toBe(true);
  await expect
    .poll(() => pageState(app, origin))
    .toMatchObject({ auth: "authenticated" });
}

async function screenshotTab(
  app: ElectronApplication,
  origin: string,
  filename: string,
): Promise<string> {
  const encoded = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined)
        throw new Error(`tab not found for ${args.origin}`);
      await contents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      // A newly attached WebContentsView can expose a partially populated
      // compositor surface on its first snapshot. Prime the capturer, request
      // a full repaint, and then take the artifact used for visual review.
      await contents.capturePage();
      contents.invalidate();
      await contents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const image = await contents.capturePage();
      return image.toPNG().toString("base64");
    },
    { origin },
  );
  const target = path.join(SCREENSHOTS, filename);
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(target, Buffer.from(encoded, "base64"));
  return target;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("Mac B inherits Mac A's canonical sessions while both sites render locally", async () => {
  test.setTimeout(120_000);
  const stateDir = await mkdtemp(path.join(tmpdir(), "suma-gateway-state-"));
  const gateway: ChildProcess = spawn(
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
      String(GATEWAY_PORT),
      "--persist-to",
      stateDir,
      "--var",
      "GATEWAY_DEV_ALLOW_PRIVATE:1",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let gatewayLog = "";
  gateway.stdout?.on(
    "data",
    (chunk: Buffer) => (gatewayLog += chunk.toString()),
  );
  gateway.stderr?.on(
    "data",
    (chunk: Buffer) => (gatewayLog += chunk.toString()),
  );

  const originA = await startOrigin("Origin Alpha", "127.0.0.1");
  const originB = await startOrigin("Origin Beta", "localhost");
  let macA: ElectronApplication | null = null;
  let macB: ElectronApplication | null = null;
  try {
    await waitForUrl(`${GATEWAY_URL}/healthz`);
    macA = await launchMac("mac-a");
    macB = await launchMac("mac-b");

    await openTab(macA, `${originA.url}/`);
    await expect
      .poll(() => pageState(macA!, originA.url))
      .toMatchObject({ auth: "signed-out" });
    await screenshotTab(macA, originA.url, "01-mac-a-before-login.png");
    await clickSignIn(macA, originA.url);
    const alphaA = await pageState(macA, originA.url);
    expect(alphaA?.url).toBe(`${originA.url}/account`);
    await expect
      .poll(() => pageState(macA!, originA.url))
      .toMatchObject({ auth: "authenticated" });
    await screenshotTab(macA, originA.url, "02-mac-a-after-login.png");

    // A second, unrelated hostname proves the path is not driven by an origin
    // corpus or per-site adapter.
    await openTab(macA, `${originB.url}/`);
    await clickSignIn(macA, originB.url);
    await expect
      .poll(() => pageState(macA!, originB.url))
      .toMatchObject({ auth: "authenticated" });

    // Mac B never opens either sign-in page and never submits either form.
    await openTab(macB, `${originA.url}/account`);
    await expect
      .poll(() => pageState(macB!, originA.url))
      .toMatchObject({ auth: "authenticated" });
    await expect
      .poll(() => mirroredCookieNames(macB!, originA.url))
      .toContain("sid");
    await expect
      .poll(async () => (await pageState(macB!, originA.url))?.counter ?? 0)
      .toBeGreaterThan(8);
    await screenshotTab(macB, originA.url, "03-mac-b-alpha-without-login.png");

    await openTab(macB, `${originB.url}/account`);
    await expect
      .poll(() => pageState(macB!, originB.url))
      .toMatchObject({ auth: "authenticated" });
    await expect
      .poll(async () => (await pageState(macB!, originB.url))?.counter ?? 0)
      .toBeGreaterThan(8);
    await screenshotTab(macB, originB.url, "04-mac-b-beta-without-login.png");
  } catch (error) {
    throw new Error(
      `${String(error)}\n\nSession gateway output:\n${gatewayLog}`,
    );
  } finally {
    await macB?.close().catch(() => undefined);
    await macA?.close().catch(() => undefined);
    await closeServer(originB.server);
    await closeServer(originA.server);
    gateway.kill("SIGTERM");
  }
});
