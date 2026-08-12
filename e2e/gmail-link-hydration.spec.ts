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
const SPACE_ID = "gmail-link-space";
const HUB_PORT = 18_792;
const HUB_HTTP_URL = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS_URL = `ws://127.0.0.1:${HUB_PORT}/v1/hub/ws`;
const SCREENSHOTS = path.join(
  REPO,
  "artifacts",
  "e2e",
  "2026-08-09-device-snapshots",
  "first-link-auth",
);
const PADDING_COOKIE_COUNT = 96;
const GOOGLE_AUTH_COOKIE_COUNT = 12;
const YOUTUBE_AUTH_COOKIE_COUNT = 12;

function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "Shared",
        color: "#4285f4",
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

function gmailPage(state: "prime" | "inbox" | "marketing"): string {
  const inbox = state === "inbox";
  const marketing = state === "marketing";
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${inbox ? "Inbox (3) - Gmail" : marketing ? "Gmail: Private and secure email" : "Preparing Gmail"}</title>
        <style>
          :root { font-family: Arial, Helvetica, sans-serif; color: #202124; }
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; background: #f8fafd; }
          header { height: 68px; display: flex; align-items: center; gap: 14px; padding: 0 28px;
            border-bottom: 1px solid #e2e6ea; background: white; }
          .mark { width: 38px; height: 28px; border: 7px solid #ea4335; border-top: 0;
            border-radius: 3px; transform: skewY(-7deg); }
          header strong { font-size: 22px; color: #5f6368; }
          main { width: min(920px, calc(100vw - 48px)); margin: 54px auto; }
          .eyebrow { color: #1a73e8; font-size: 12px; font-weight: 800; letter-spacing: .14em;
            text-transform: uppercase; }
          h1 { margin: 12px 0; font-size: clamp(38px, 6vw, 66px); letter-spacing: -.045em; }
          p { color: #5f6368; font-size: 18px; line-height: 1.55; }
          .mail { margin-top: 34px; border: 1px solid #dfe3e7; border-radius: 18px; overflow: hidden;
            background: white; box-shadow: 0 18px 50px #3c404315; }
          .row { display: grid; grid-template-columns: 180px 1fr 90px; gap: 20px; padding: 18px 22px;
            border-bottom: 1px solid #edf0f2; }
          .row:last-child { border-bottom: 0; }
        </style>
      </head>
      <body data-gmail-state="${state}">
        <header><div class="mark"></div><strong>Gmail</strong></header>
        <main>
          <div class="eyebrow">Modeled Google account handoff</div>
          <h1>${inbox ? "Welcome to your inbox." : marketing ? "Email that's secure and easy." : "Preparing your account…"}</h1>
          <p>${inbox ? "This linked Mac made its first Gmail request with the hydrated account session." : marketing ? "The account cookie was missing from the first request, so Google sent this browser to Workspace." : "Mac A is creating the account cookie snapshot."}</p>
          ${
            inbox
              ? `<section class="mail">
                  <div class="row"><strong>Suma</strong><span>Your linked Mac is ready</span><span>Now</span></div>
                  <div class="row"><strong>Google</strong><span>Security activity</span><span>9:41 AM</span></div>
                  <div class="row"><strong>Team</strong><span>Realtime browser session</span><span>Yesterday</span></div>
                </section>`
              : ""
          }
        </main>
      </body>
    </html>`;
}

function youtubePage(state: "signed-in" | "signed-out"): string {
  const signedIn = state === "signed-in";
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${signedIn ? "Home - YouTube" : "Sign in - YouTube"}</title>
        <style>
          :root { font-family: Arial, Helvetica, sans-serif; color: #0f0f0f; }
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; background: #fff; }
          header { height: 68px; display: flex; align-items: center; gap: 12px; padding: 0 28px;
            border-bottom: 1px solid #e5e5e5; }
          .play { width: 42px; height: 29px; border-radius: 9px; background: #ff0033; color: white;
            display: grid; place-items: center; font-size: 15px; }
          header strong { font-size: 22px; letter-spacing: -.04em; }
          main { width: min(1040px, calc(100vw - 48px)); margin: 52px auto; }
          .eyebrow { color: #ff0033; font-size: 12px; font-weight: 800; letter-spacing: .14em;
            text-transform: uppercase; }
          h1 { margin: 12px 0; font-size: clamp(38px, 6vw, 66px); letter-spacing: -.045em; }
          p { color: #606060; font-size: 18px; line-height: 1.55; }
          .videos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px; }
          .video div { aspect-ratio: 16 / 9; border-radius: 14px; background: linear-gradient(135deg, #fee2e2, #dbeafe); }
          .video strong { display: block; margin-top: 12px; }
        </style>
      </head>
      <body data-youtube-state="${state}">
        <header><div class="play">▶</div><strong>YouTube</strong></header>
        <main>
          <div class="eyebrow">Live session handoff</div>
          <h1>${signedIn ? "Your subscriptions are ready." : "Sign in to continue."}</h1>
          <p>${signedIn ? "This Mac opened the synced destination only after its YouTube cookies were applied." : "The authenticated YouTube cookie was missing from this request."}</p>
          ${
            signedIn
              ? `<section class="videos">
                  <article class="video"><div></div><strong>Designing reliable systems</strong></article>
                  <article class="video"><div></div><strong>Realtime collaboration</strong></article>
                  <article class="video"><div></div><strong>Browser internals</strong></article>
                </section>`
              : ""
          }
        </main>
      </body>
    </html>`;
}

async function startGmailOrigin(): Promise<{
  server: Server;
  mailOrigin: string;
  paddingOrigin: string;
  youtubeOrigin: string;
  spkiHash: string;
  resetFirstRequestProbe(): void;
  unauthenticatedInboxRequests(deviceName: string): number;
  resetYoutubeProbe(): void;
  unauthenticatedYoutubeRequests(deviceName: string): number;
}> {
  const certificateDir = await mkdtemp(path.join(tmpdir(), "suma-gmail-cert-"));
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
    "/CN=mail.google.com",
    "-addext",
    "subjectAltName=DNS:mail.google.com,DNS:workspace.google.com,DNS:notion.so,DNS:youtube.com",
  ]);
  const [key, certificate] = await Promise.all([
    readFile(keyPath),
    readFile(certificatePath),
  ]);
  const x509 = new X509Certificate(certificate);
  const spki = x509.publicKey.export({ type: "spki", format: "der" });
  const spkiHash = createHash("sha256").update(spki).digest("base64");
  let missingSessionUserAgents: string[] = [];
  let missingYoutubeUserAgents: string[] = [];
  let youtubeLoginClaimed = false;
  const sessionToken = "gmail-session-from-mac-a";
  const youtubeToken = "youtube-session-from-mac-a";
  const server = createServer(
    { key, cert: certificate },
    (request, response) => {
      const host = (request.headers.host ?? "mail.google.com").split(":")[0];
      const url = new URL(request.url ?? "/", `https://${host}`);
      const cookies = new Map(
        (request.headers.cookie ?? "")
          .split(/;\s*/)
          .filter(Boolean)
          .map((entry) => {
            const separator = entry.indexOf("=");
            return separator < 0
              ? [entry, ""]
              : [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
      );
      if (host === "workspace.google.com") {
        const body = gmailPage("marketing");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      if (host === "youtube.com" && url.pathname === "/youtube-login") {
        // Only the first requester can complete this one-time auth ceremony.
        // Mac A starts its network request before the URL debounce can fan out,
        // so Mac B cannot mask a sync failure by replaying the login endpoint.
        if (youtubeLoginClaimed) {
          const body = youtubePage("signed-out");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-length": String(Buffer.byteLength(body)),
          });
          response.end(body);
          return;
        }
        youtubeLoginClaimed = true;
        const youtubeAuthCookies = [
          `YSID=${youtubeToken}; Domain=youtube.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
          ...Array.from(
            { length: YOUTUBE_AUTH_COOKIE_COUNT - 1 },
            (_, index) =>
              `YOUTUBE_AUTH_${String(index).padStart(2, "0")}=generation-${index}; Domain=youtube.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
          ),
        ];
        response.writeHead(302, {
          location: "/feed",
          "cache-control": "no-store",
          "set-cookie": youtubeAuthCookies,
        });
        response.end();
        return;
      }
      if (host === "youtube.com" && url.pathname === "/feed") {
        const signedIn = cookies.get("YSID") === youtubeToken;
        if (!signedIn)
          missingYoutubeUserAgents.push(request.headers["user-agent"] ?? "");
        const body = youtubePage(signedIn ? "signed-in" : "signed-out");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      if (host === "notion.so" && url.pathname === "/prime") {
        const padding = Array.from(
          { length: PADDING_COOKIE_COUNT },
          (_, index) =>
            `GMAIL_TEST_${String(index).padStart(3, "0")}=padding-${index}; Domain=notion.so; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
        );
        const body = gmailPage("prime");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": padding,
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/login") {
        // Google sign-in responses rotate a burst of same-origin cookies. SID
        // is deliberately first: the old parallel capture path stranded its
        // lease promise while a later cookie stole the origin resolver.
        const googleAuthCookies = [
          `SID=${sessionToken}; Domain=google.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
          ...Array.from(
            { length: GOOGLE_AUTH_COOKIE_COUNT - 1 },
            (_, index) =>
              `GOOGLE_AUTH_${String(index).padStart(2, "0")}=generation-${index}; Domain=google.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
          ),
        ];
        response.writeHead(302, {
          location: "/mail/u/0/#inbox",
          "cache-control": "no-store",
          "set-cookie": googleAuthCookies,
        });
        response.end();
        return;
      }
      if (url.pathname === "/mail/u/0/" || url.pathname === "/mail/u/0") {
        if (cookies.get("SID") !== sessionToken) {
          missingSessionUserAgents.push(request.headers["user-agent"] ?? "");
          const address = server.address();
          if (address === null || typeof address === "string") {
            response.writeHead(500).end();
            return;
          }
          response.writeHead(302, {
            location: `https://workspace.google.com:${address.port}/intl/en-US/gmail/#inbox`,
            "cache-control": "no-store",
          });
          response.end();
          return;
        }
        const body = gmailPage("inbox");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      response.writeHead(302, { location: "/mail/u/0/#inbox" });
      response.end();
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Gmail origin did not bind");
  return {
    server,
    mailOrigin: `https://mail.google.com:${address.port}`,
    paddingOrigin: `https://notion.so:${address.port}`,
    youtubeOrigin: `https://youtube.com:${address.port}`,
    spkiHash,
    resetFirstRequestProbe: () => {
      missingSessionUserAgents = [];
    },
    unauthenticatedInboxRequests: (deviceName) =>
      missingSessionUserAgents.filter((value) => value.includes(deviceName))
        .length,
    resetYoutubeProbe: () => {
      missingYoutubeUserAgents = [];
    },
    unauthenticatedYoutubeRequests: (deviceName) =>
      missingYoutubeUserAgents.filter((value) => value.includes(deviceName))
        .length,
  };
}

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

async function prepareProfile(
  name: string,
  workspaceSecret: Uint8Array,
  spaceSecret: Uint8Array,
): Promise<string> {
  const userData = await mkdtemp(path.join(tmpdir(), `suma-gmail-${name}-`));
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
        email: "gmail@example.com",
        userId: "gmail-user",
        deviceName: name === "mac-a" ? "Mac A" : "Mac B",
        credentialKind: "device-key",
        controlDeviceId: `control-${name}`,
        authToken: `hbr_dev_gmail.${name}`,
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
      `--user-agent=SumaE2E/${name}`,
      "--host-resolver-rules=MAP mail.google.com 127.0.0.1,MAP workspace.google.com 127.0.0.1,MAP notion.so 127.0.0.1,MAP youtube.com 127.0.0.1",
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

async function hubCookieCount(): Promise<number> {
  const response = await fetch(`${HUB_HTTP_URL}/v1/hub/hydrate`, {
    method: "POST",
    headers: {
      authorization: "Bearer hbr_dev_gmail.mac-a",
      "content-type": "application/json",
    },
    body: JSON.stringify({ spaceId: SPACE_ID, sinceHlc: null }),
  });
  if (!response.ok) return -1;
  const payload = (await response.json()) as { count?: unknown };
  return typeof payload.count === "number" ? payload.count : -1;
}

async function currentGmailState(
  app: ElectronApplication,
): Promise<{ state: string; url: string } | null> {
  return app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      const url = contents.getURL();
      if (!url.includes("google.com") && !url.includes("notion.so")) continue;
      const state = await contents
        .executeJavaScript("document.body?.dataset.gmailState ?? null")
        .catch(() => null);
      if (typeof state === "string") return { state, url };
    }
    return null;
  });
}

async function currentYoutubeState(
  app: ElectronApplication,
): Promise<{ state: string; url: string } | null> {
  return app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      const url = contents.getURL();
      if (!url.includes("youtube.com")) continue;
      const state = await contents
        .executeJavaScript("document.body?.dataset.youtubeState ?? null")
        .catch(() => null);
      if (typeof state === "string") return { state, url };
    }
    return null;
  });
}

async function screenshotGmail(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().includes("google.com")) continue;
      const state = await contents
        .executeJavaScript("document.body?.dataset.gmailState ?? null")
        .catch(() => null);
      if (typeof state !== "string") continue;
      await contents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      return (await contents.capturePage()).toPNG().toString("base64");
    }
    throw new Error("Gmail tab missing");
  });
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(
    path.join(SCREENSHOTS, filename),
    Buffer.from(encoded, "base64"),
  );
}

async function screenshotYoutube(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().includes("youtube.com")) continue;
      const state = await contents
        .executeJavaScript("document.body?.dataset.youtubeState ?? null")
        .catch(() => null);
      if (typeof state !== "string") continue;
      await contents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      return (await contents.capturePage()).toPNG().toString("base64");
    }
    throw new Error("YouTube tab missing");
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

test("linked Macs auto-hydrate Google auth, then manually pull later session changes", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  const stateDir = await mkdtemp(path.join(tmpdir(), "suma-gmail-hub-"));
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

  const gmail = await startGmailOrigin();
  const workspaceSecret = generateSpaceRootSecret();
  const spaceSecret = generateSpaceRootSecret();
  const profileA = await prepareProfile("mac-a", workspaceSecret, spaceSecret);
  const profileB = await prepareProfile("mac-b", workspaceSecret, spaceSecret);
  let macA: ElectronApplication | null = null;
  let macB: ElectronApplication | null = null;
  try {
    await waitForUrl(`${HUB_HTTP_URL}/healthz`);
    macA = await launchMac("mac-a", profileA, gmail.spkiHash);
    const tabA = await invoke<TabInfo>(macA, "tabs:create", {
      spaceId: SPACE_ID,
      url: `${gmail.paddingOrigin}/prime`,
    });
    if (tabA === null) throw new Error("Mac A tab creation failed");
    await expect
      .poll(() => currentGmailState(macA!))
      .toMatchObject({ state: "prime" });
    await expect
      .poll(hubCookieCount)
      .toBeGreaterThanOrEqual(PADDING_COOKIE_COUNT);

    await invoke(macA, "tabs:navigate", {
      tabId: tabA.id,
      url: `${gmail.mailOrigin}/login`,
    });
    await expect
      .poll(() => currentGmailState(macA!))
      .toMatchObject({ state: "inbox" });
    await expect
      .poll(() => invoke<TabInfo[]>(macA!, "tabs:list", { spaceId: SPACE_ID }))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: tabA.id,
            url: expect.stringContaining("mail.google.com"),
          }),
        ]),
      );
    await screenshotGmail(macA, "01-mac-a-gmail-inbox.png");

    // Do not poll SessionHub here. Mac B links the instant Mac A commits the
    // authenticated redirect; ordering must come from the product's causal
    // fence, not test-side settling time.
    gmail.resetFirstRequestProbe();
    macB = await launchMac("mac-b", profileB, gmail.spkiHash);
    const tabB = await invoke<TabInfo>(macB, "tabs:create", {
      spaceId: SPACE_ID,
      url: `${gmail.mailOrigin}/mail/u/0/`,
    });
    if (tabB === null) throw new Error("Mac B tab creation failed");
    await expect.poll(() => currentGmailState(macB!)).not.toBeNull();
    await screenshotGmail(macB, "02-mac-b-first-gmail-page.png");

    expect(await currentGmailState(macB)).toMatchObject({
      state: "inbox",
      url: expect.stringContaining("mail.google.com"),
    });
    expect(gmail.unauthenticatedInboxRequests("mac-b")).toBe(0);
    await expect
      .poll(hubCookieCount)
      .toBeGreaterThanOrEqual(PADDING_COOKIE_COUNT + GOOGLE_AUTH_COOKIE_COUNT);
    await expect
      .poll(() => invoke<TabInfo[]>(macB!, "tabs:list", { spaceId: SPACE_ID }))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: tabB.id,
            url: expect.stringContaining("mail.google.com"),
          }),
        ]),
      );

    // Mac B is already connected now, so this second transition is staged.
    // Merge must install the YSID burst before B is allowed to navigate to the
    // authenticated destination.
    gmail.resetYoutubeProbe();
    await invoke(macA, "tabs:navigate", {
      tabId: tabA.id,
      url: `${gmail.youtubeOrigin}/youtube-login`,
    });
    await expect
      .poll(() => currentYoutubeState(macA!))
      .toMatchObject({
        state: "signed-in",
        url: expect.stringContaining("/feed"),
      });
    await screenshotYoutube(macA, "03-mac-a-youtube-signed-in.png");

    await expect
      .poll(() =>
        invoke<{ pending: boolean; remoteChanged: boolean }>(
          macB!,
          "workspaceSync:get",
          undefined,
        ),
      )
      .toMatchObject({ pending: true, remoteChanged: true });
    await invoke(macB, "workspaceSync:run", { mode: "merge" });
    await invoke(macB, "tabs:navigate", {
      tabId: tabB.id,
      url: `${gmail.youtubeOrigin}/feed`,
    });
    await expect
      .poll(() => currentYoutubeState(macB!))
      .toMatchObject({
        state: "signed-in",
        url: expect.stringContaining("/feed"),
      });
    await screenshotYoutube(macB, "04-mac-b-first-youtube-feed.png");
    expect(gmail.unauthenticatedYoutubeRequests("mac-b")).toBe(0);
    await expect
      .poll(hubCookieCount)
      .toBeGreaterThanOrEqual(
        PADDING_COOKIE_COUNT +
          GOOGLE_AUTH_COOKIE_COUNT +
          YOUTUBE_AUTH_COOKIE_COUNT,
      );
  } catch (error) {
    throw new Error(`${String(error)}\n\nSessionHub output:\n${hubLog}`);
  } finally {
    await macB?.close().catch(() => undefined);
    await macA?.close().catch(() => undefined);
    await closeServer(gmail.server);
    hub.kill("SIGTERM");
  }
});
