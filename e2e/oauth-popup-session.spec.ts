import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeGatewayHeaderValue,
  GATEWAY_COOKIES_PATH,
  GATEWAY_FETCH_PATH,
  GATEWAY_TARGET_HEADER,
} from "@suma/protocol";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "oauth-popup-e2e-space";
// 18789 collides with a long-running local service (clawdbot-gateway).
const GATEWAY_PORT = 18_689;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_UPSTREAM_PORT = 18_690;
const GATEWAY_UPSTREAM_URL = `http://127.0.0.1:${GATEWAY_UPSTREAM_PORT}`;
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots", "oauth-popup");
const ELECTRON = path.join(
  REPO,
  "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

function shell(body: string, state: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OAuth popup continuity</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f7f9fc;
      background: radial-gradient(circle at 18% 12%, #284f65 0, transparent 42%), #10141c; }
    main { width: min(620px, calc(100vw - 44px)); padding: 42px; border: 1px solid #ffffff22;
      border-radius: 24px; background: #171d27ee; box-shadow: 0 28px 80px #0008; }
    .eyebrow { color: #78d8ff; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0; font-size: clamp(34px, 7vw, 58px); line-height: 1; letter-spacing: -.05em; }
    p { color: #bdc7d5; font-size: 17px; line-height: 1.5; }
    button { margin-top: 18px; padding: 13px 20px; border: 0; border-radius: 999px;
      background: #78d8ff; color: #0a1922; font: inherit; font-weight: 800; cursor: pointer; }
    .spinner { width: 28px; height: 28px; margin: 18px auto; border: 3px solid #ffffff30;
      border-top-color: #78d8ff; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body data-auth-state="${state}"><main>${body}</main></body>
</html>`;
}

function html(
  response: Parameters<Parameters<typeof createServer>[0]>[1],
  body: string,
): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("OAuth fixture did not bind");
  return `http://${host}:${address.port}`;
}

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local gateway process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function requestBody(
  request: Parameters<Parameters<typeof createServer>[0]>[0],
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Hold X's local transaction-cookie commit to make the ordering race deterministic. */
async function startGatewayDelayProxy(): Promise<{
  server: Server;
  mutationObserved: Promise<void>;
  releaseMutation: () => void;
  logoutMutationObserved: Promise<void>;
  releaseLogoutMutation: () => void;
  exchangeRacedBeforeCommit: () => boolean;
  logoutRacedBeforeCommit: () => boolean;
  trace: string[];
}> {
  let observeMutation: (() => void) | null = null;
  let releaseMutation: (() => void) | null = null;
  let observeLogoutMutation: (() => void) | null = null;
  let releaseLogoutMutation: (() => void) | null = null;
  const mutationObserved = new Promise<void>((resolve) => {
    observeMutation = resolve;
  });
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const logoutMutationObserved = new Promise<void>((resolve) => {
    observeLogoutMutation = resolve;
  });
  const logoutMutationGate = new Promise<void>((resolve) => {
    releaseLogoutMutation = resolve;
  });
  let mutationCommitted = false;
  let logoutMutationCommitted = false;
  let exchangeRaced = false;
  let logoutRaced = false;
  const trace: string[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const body = await requestBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          headers.append(name, item);
        }
      }
      for (const name of [
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ]) {
        headers.delete(name);
      }

      const url = new URL(request.url ?? "/", GATEWAY_UPSTREAM_URL);
      const transactionCookie = (() => {
        if (request.method !== "PUT" || url.pathname !== GATEWAY_COOKIES_PATH) {
          return null;
        }
        try {
          const parsed = JSON.parse(body.toString()) as {
            cookie?: { name?: string };
            mutations?: Array<{ cookie?: { name?: string } }>;
          };
          for (const name of ["oauth_transaction", "logout_transaction"]) {
            if (
              parsed.cookie?.name === name ||
              parsed.mutations?.some(
                (mutation) => mutation.cookie?.name === name,
              ) === true
            ) {
              return name;
            }
          }
        } catch {
          // Non-cookie gateway traffic is forwarded unchanged.
        }
        return null;
      })();
      if (transactionCookie === "oauth_transaction") {
        trace.push("OAuth transaction mutation observed");
        observeMutation?.();
        await mutationGate;
        trace.push("OAuth transaction mutation released");
      }
      if (transactionCookie === "logout_transaction") {
        trace.push("logout transaction mutation observed");
        observeLogoutMutation?.();
        await logoutMutationGate;
        trace.push("logout transaction mutation released");
      }

      if (url.pathname === GATEWAY_FETCH_PATH) {
        const targetHeader = headers.get(GATEWAY_TARGET_HEADER);
        if (targetHeader !== null) {
          const target = new URL(decodeGatewayHeaderValue(targetHeader));
          if (target.pathname === "/sso/init" && !mutationCommitted) {
            exchangeRaced = true;
          }
          if (target.pathname === "/sso/init") {
            trace.push(
              `exchange observed; mutation committed=${String(mutationCommitted)}`,
            );
          }
          if (
            target.pathname === "/logout-beacon" &&
            !logoutMutationCommitted
          ) {
            logoutRaced = true;
          }
          if (target.pathname === "/logout-beacon") {
            trace.push(
              `logout beacon observed; mutation committed=${String(logoutMutationCommitted)}`,
            );
          }
        }
      }

      const upstream = await fetch(url, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD" ? null : body,
        redirect: "manual",
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of upstream.headers) {
        if (
          name === "content-encoding" ||
          name === "content-length" ||
          name === "set-cookie" ||
          name === "transfer-encoding"
        ) {
          continue;
        }
        responseHeaders[name] = value;
      }
      const setCookies = upstream.headers.getSetCookie();
      if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
      responseHeaders["content-length"] = String(bytes.byteLength);
      if (transactionCookie === "oauth_transaction") {
        mutationCommitted = true;
        trace.push(`OAuth transaction upstream status=${upstream.status}`);
      }
      if (transactionCookie === "logout_transaction") {
        logoutMutationCommitted = true;
        trace.push(`logout transaction upstream status=${upstream.status}`);
      }
      response.writeHead(upstream.status, upstream.statusText, responseHeaders);
      response.end(bytes);
    })().catch((error) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(GATEWAY_PORT, "127.0.0.1", resolve);
  });
  return {
    server,
    mutationObserved,
    releaseMutation: () => releaseMutation?.(),
    logoutMutationObserved,
    releaseLogoutMutation: () => releaseLogoutMutation?.(),
    exchangeRacedBeforeCommit: () => exchangeRaced,
    logoutRacedBeforeCommit: () => logoutRaced,
    trace,
  };
}

async function startOAuthOrigins(): Promise<{
  relyingParty: Server;
  relyingOrigin: string;
  provider: Server;
  providerOrigin: string;
  releaseSso: () => void;
  logoutReceived: () => boolean;
  logoutBody: () => string;
}> {
  let providerOrigin = "";
  let relyingOrigin = "";
  let completeSso: (() => void) | null = null;
  const ssoGate = new Promise<void>((resolve) => {
    completeSso = resolve;
  });
  let ssoRequestCount = 0;
  let receivedLogout = false;
  let receivedLogoutBody = "";
  const provider = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/gsi/button") {
      html(
        response,
        shell(
          `<div class="eyebrow">Google Identity Services</div>
           <button id="google" type="button">Continue with Google</button>
           <script>
             let provider = null;
             document.querySelector('#google').addEventListener('click', () => {
               provider = window.open(
                 ${JSON.stringify(`${providerOrigin}/oauth2/authorize?client_id=x-test&response_type=id_token`)},
                 'google-provider',
                 'popup=1,width=500,height=640'
               );
               document.body.dataset.providerHandle = provider === null ? 'null' : 'object';
             });
             window.addEventListener('message', async (event) => {
               if (event.origin === ${JSON.stringify(providerOrigin)} && event.data?.type === 'oauth-credential') {
                 document.body.dataset.credentialReceived = 'true';
                 try {
                   await document.requestStorageAccess();
                   document.body.dataset.storageAccess = 'granted';
                 } catch {
                   document.body.dataset.storageAccess = 'denied';
                   return;
                 }
                 window.top.postMessage(event.data, ${JSON.stringify(relyingOrigin)});
               }
               if (event.origin === ${JSON.stringify(relyingOrigin)} && event.data?.type === 'oauth-accepted') {
                 provider?.postMessage(event.data, ${JSON.stringify(providerOrigin)});
               }
             });
           </script>`,
          "button",
        ),
      );
      return;
    }
    if (url.pathname === "/oauth2/handoff") {
      const body = shell(
        `<div class="spinner"></div>
         <h1>One moment please...</h1>
         <p>This redirect body must never be committed as a document.</p>
         <script nonce="redirect-body">document.body.dataset.redirectBodyExecuted = 'true';</script>`,
        "redirect-body",
      );
      response.writeHead(302, {
        location: "/oauth2/complete",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "script-src 'nonce-redirect-header'; object-src 'none'",
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/oauth2/complete") {
      html(
        response,
        shell(
          `<div class="spinner"></div>
           <h1>One moment please...</h1>
           <p>Returning the credential to the relying party.</p>
           <script>
             document.body.dataset.openerPresent = window.opener === null ? 'false' : 'true';
             try {
               document.body.dataset.openerOrigin = window.opener?.location.origin ?? 'null';
             } catch {
               document.body.dataset.openerOrigin = 'cross-origin';
             }
             window.opener?.postMessage({ type: 'oauth-credential', credential: 'signed-token' }, ${JSON.stringify(providerOrigin)});
             document.body.dataset.credentialSent = 'true';
             window.addEventListener('message', (event) => {
               if (event.origin !== ${JSON.stringify(providerOrigin)} || event.data?.type !== 'oauth-accepted') return;
               window.close();
             });
           </script>`,
          "processing",
        ),
      );
      return;
    }
    if (url.pathname !== "/oauth2/authorize") {
      response.writeHead(404).end();
      return;
    }
    html(
      response,
      shell(
        `<div class="eyebrow">Google-style provider</div>
         <h1>Choose an account</h1>
         <p>The provider must return its credential to the embedded button frame.</p>
         <button id="choose" type="button">Continue as person@example.test</button>
         <script>
           document.querySelector('#choose').addEventListener('click', () => {
             location.assign('/oauth2/handoff');
           });
         </script>`,
        "provider",
      ),
    );
  });
  providerOrigin = await listen(provider, "127.0.0.1");

  const relyingParty = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestCookies = (request.headers.cookie ?? "").split(/;\s*/);
    const authenticated = requestCookies.includes("x_session=authenticated");
    if (request.method === "POST" && url.pathname === "/logout-beacon") {
      void requestBody(request)
        .then((body) => {
          receivedLogout = true;
          receivedLogoutBody = body.toString();
          response
            .writeHead(204, {
              "cache-control": "no-store",
              "set-cookie":
                "x_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
            })
            .end();
        })
        .catch((error) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(error));
        });
      return;
    }
    if (request.method === "POST" && url.pathname === "/sso/init") {
      if (!requestCookies.includes("oauth_transaction=ready")) {
        response
          .writeHead(409, { "cache-control": "no-store" })
          .end("missing OAuth transaction");
        return;
      }
      ssoRequestCount += 1;
      const finish = (): void => {
        response
          .writeHead(204, {
            "cache-control": "no-store",
            "set-cookie":
              "x_session=authenticated; HttpOnly; SameSite=Lax; Path=/",
          })
          .end();
      };
      // The plain-Electron control is the first request. Hold Suma's second
      // request long enough to capture the callback document that previously
      // hung forever, then let the normal acknowledgement close the popup.
      if (ssoRequestCount === 1) finish();
      else void ssoGate.then(finish);
      return;
    }
    const signedOutLanding = url.pathname === "/signed-out";
    html(
      response,
      shell(
        `<div class="eyebrow">Relying party</div>
         <h1 id="status">${authenticated && !signedOutLanding ? "Signed in." : "Sign in once."}</h1>
         <p>The embedded Google button must receive a credential from its popup.</p>
         ${authenticated && !signedOutLanding ? '<button id="logout" type="button">Log out</button>' : ""}
         <iframe id="google-frame" title="Sign in with Google Button" allow="identity-credentials-get" src=${JSON.stringify(`${providerOrigin}/gsi/button`)} style="width: 360px; height: 150px; border: 0;"></iframe>
         <script>
           document.querySelector('#logout')?.addEventListener('click', () => {
             document.cookie = 'logout_transaction=ready; Path=/; SameSite=Lax';
             const logoutBody = new Blob(['logout-event'], {
               type: 'application/x-www-form-urlencoded; charset=UTF-8'
             });
             document.body.dataset.beaconAccepted = String(navigator.sendBeacon('/logout-beacon', logoutBody));
             location.assign('about:blank');
           });
           window.addEventListener('message', async (event) => {
             if (event.origin !== ${JSON.stringify(providerOrigin)} || event.data?.credential !== 'signed-token') return;
             document.cookie = 'oauth_transaction=ready; Path=/; SameSite=Lax';
             const exchangeBody = new Blob([event.data.credential], { type: 'application/x-www-form-urlencoded' });
             const exchange = await fetch('/sso/init', { method: 'POST', body: exchangeBody });
             if (!exchange.ok) {
               document.body.dataset.authState = 'exchange-rejected';
               return;
             }
             document.body.dataset.authState = 'authenticated';
             document.querySelector('#status').textContent = 'Signed in.';
             event.source?.postMessage({ type: 'oauth-accepted' }, ${JSON.stringify(providerOrigin)});
           });
         </script>`,
        authenticated && !signedOutLanding ? "authenticated" : "signed-out",
      ),
    );
  });
  relyingOrigin = await listen(relyingParty, "localhost");
  return {
    relyingParty,
    relyingOrigin,
    provider,
    providerOrigin,
    releaseSso: () => completeSso?.(),
    logoutReceived: () => receivedLogout,
    logoutBody: () => receivedLogoutBody,
  };
}

function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "OAuth popup test",
        color: "#78d8ff",
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
      // The Google-like provider stays browser-native while the relying
      // party uses the structured gateway, matching X + accounts.google.com.
      nativeTransportDomains: ["127.0.0.1"],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function launchSuma(
  onMainOutput: (text: string) => void,
): Promise<ElectronApplication> {
  const userData = await mkdtemp(path.join(tmpdir(), "suma-oauth-popup-"));
  await writeFile(
    path.join(userData, "workspace.json"),
    JSON.stringify(workspaceFile()),
  );
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [
      path.join(REPO, "apps/desktop/out/main/index.js"),
      `--user-data-dir=${userData}`,
      "--test-third-party-cookie-phaseout",
    ],
    env: {
      ...process.env,
      SUMA_SESSION_GATEWAY_URL: GATEWAY_URL,
      SUMA_SESSION_GATEWAY_DEV_TOKEN: "hbr_dev_oauth_popup_e2e",
    },
  });
  app
    .process()
    .stdout?.on("data", (chunk: Buffer) => onMainOutput(chunk.toString()));
  app
    .process()
    .stderr?.on("data", (chunk: Buffer) => onMainOutput(chunk.toString()));
  await expect
    .poll(() => webState(app, "file:").then((value) => value !== null))
    .toBe(true);
  return app;
}

async function webState(
  app: ElectronApplication,
  prefix: string,
): Promise<{
  id: number;
  url: string;
  auth: string | null;
  provider: string | null;
  opener: string | null;
  openerOrigin: string | null;
  credentialSent: string | null;
} | null> {
  return app.evaluate(
    async ({ webContents }, args) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith(args.prefix)) continue;
        const state = await contents
          .executeJavaScript(
            `({
            auth: document.body?.dataset.authState ?? null,
            provider: document.body?.dataset.providerHandle ?? null,
            opener: document.body?.dataset.openerPresent ?? null,
            openerOrigin: document.body?.dataset.openerOrigin ?? null,
            credentialSent: document.body?.dataset.credentialSent ?? null
          })`,
          )
          .catch(() => null);
        if (state === null) continue;
        return { id: contents.id, url: contents.getURL(), ...state };
      }
      return null;
    },
    { prefix },
  );
}

async function openSumaTab(
  app: ElectronApplication,
  url: string,
): Promise<void> {
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
        if (!ready) continue;
        await contents.executeJavaScript(
          `window.suma.invoke("tabs:create", ${JSON.stringify({ spaceId: args.spaceId, url: args.url })})`,
        );
        return;
      }
      throw new Error("Suma chrome WebContents missing");
    },
    { spaceId: SPACE_ID, url },
  );
  await expect.poll(() => webState(app, url)).not.toBeNull();
}

async function clickContents(
  app: ElectronApplication,
  prefix: string,
  selector: string,
): Promise<void> {
  const clicked = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.prefix));
      if (contents === undefined) return false;
      return contents.executeJavaScript(
        `(() => {
          const target = document.querySelector(${JSON.stringify(args.selector)});
          if (!(target instanceof HTMLElement)) return false;
          target.click();
          return true;
        })()`,
        true,
      );
    },
    { prefix, selector },
  );
  expect(clicked).toBe(true);
}

async function clickFrameContents(
  app: ElectronApplication,
  framePrefix: string,
  selector: string,
): Promise<void> {
  const clicked = await app.evaluate(
    async ({ webContents }, args) => {
      for (const contents of webContents.getAllWebContents()) {
        const frame = contents.mainFrame.framesInSubtree.find((candidate) =>
          candidate.url.startsWith(args.framePrefix),
        );
        if (frame === undefined) continue;
        return frame.executeJavaScript(
          `(() => {
            const target = document.querySelector(${JSON.stringify(args.selector)});
            if (!(target instanceof HTMLElement)) return false;
            target.click();
            return true;
          })()`,
          true,
        );
      }
      return false;
    },
    { framePrefix, selector },
  );
  expect(clicked).toBe(true);
}

async function frameProviderHandle(
  app: ElectronApplication,
  framePrefix: string,
): Promise<string | null> {
  return app.evaluate(
    async ({ webContents }, args) => {
      for (const contents of webContents.getAllWebContents()) {
        const frame = contents.mainFrame.framesInSubtree.find((candidate) =>
          candidate.url.startsWith(args.framePrefix),
        );
        if (frame === undefined) continue;
        return frame.executeJavaScript(
          "document.body?.dataset.providerHandle ?? null",
        ) as Promise<string | null>;
      }
      return null;
    },
    { framePrefix },
  );
}

async function frameRelayState(
  app: ElectronApplication,
  framePrefix: string,
): Promise<{
  credentialReceived: string | null;
  storageAccess: string | null;
} | null> {
  return app.evaluate(
    async ({ webContents }, args) => {
      for (const contents of webContents.getAllWebContents()) {
        const frame = contents.mainFrame.framesInSubtree.find((candidate) =>
          candidate.url.startsWith(args.framePrefix),
        );
        if (frame === undefined) continue;
        return frame.executeJavaScript(`({
          credentialReceived: document.body?.dataset.credentialReceived ?? null,
          storageAccess: document.body?.dataset.storageAccess ?? null
        })`) as Promise<{
          credentialReceived: string | null;
          storageAccess: string | null;
        }>;
      }
      return null;
    },
    { framePrefix },
  );
}

async function screenshotContents(
  app: ElectronApplication,
  prefix: string,
  name: string,
): Promise<void> {
  const encoded = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.prefix));
      if (contents === undefined)
        throw new Error(`WebContents missing: ${args.prefix}`);
      await contents.executeJavaScript(
        `new Promise((resolve) => {
          const ready = () =>
            (document.querySelector('main')?.textContent?.trim().length ?? 0) > 0;
          if (ready()) {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
            return;
          }
          const observer = new MutationObserver(() => {
            if (!ready()) return;
            observer.disconnect();
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        })`,
      );
      return (await contents.capturePage()).toPNG().toString("base64");
    },
    { prefix },
  );
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(path.join(SCREENSHOTS, name), Buffer.from(encoded, "base64"));
}

async function reloadContents(
  app: ElectronApplication,
  prefix: string,
): Promise<void> {
  const reloaded = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.prefix));
      if (contents === undefined) return false;
      await new Promise<void>((resolve) => {
        contents.once("did-finish-load", resolve);
        contents.reload();
      });
      return true;
    },
    { prefix },
  );
  expect(reloaded).toBe(true);
}

async function navigateContents(
  app: ElectronApplication,
  prefix: string,
  url: string,
): Promise<void> {
  const navigated = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.prefix));
      if (contents === undefined) return false;
      await contents.loadURL(args.url);
      return true;
    },
    { prefix, url },
  );
  expect(navigated).toBe(true);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function controlJourney(
  control: ElectronApplication,
  opener: Page,
): Promise<void> {
  await opener
    .frameLocator("#google-frame")
    .getByRole("button", { name: "Continue with Google" })
    .click();
  await expect.poll(() => control.windows().length).toBe(2);
  const provider = control.windows().at(-1);
  if (provider === undefined) throw new Error("control provider missing");
  await provider
    .getByRole("button", { name: "Continue as person@example.test" })
    .click();
  await expect(opener.locator("body")).toHaveAttribute(
    "data-auth-state",
    "authenticated",
  );
}

test("Google Identity Services returns a popup credential through its embedded button frame", async () => {
  const stateDir = await mkdtemp(
    path.join(tmpdir(), "suma-oauth-popup-gateway-"),
  );
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
      String(GATEWAY_UPSTREAM_PORT),
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
  const origins = await startOAuthOrigins();
  const gatewayProxy = await startGatewayDelayProxy();
  let control: ElectronApplication | null = null;
  let suma: ElectronApplication | null = null;
  let sumaMainLog = "";
  try {
    await waitForUrl(`${GATEWAY_UPSTREAM_URL}/healthz`);
    // Plain Electron is the behavioral control for the cross-origin iframe relay.
    const controlData = await mkdtemp(
      path.join(tmpdir(), "electron-oauth-popup-"),
    );
    control = await electron.launch({
      executablePath: ELECTRON,
      args: [
        path.join(REPO, "e2e/fixtures/plain-electron.mjs"),
        `--user-data-dir=${controlData}`,
      ],
      env: { ...process.env, SUMA_LIVE_GOOGLE_URL: origins.relyingOrigin },
    });
    const controlOpener = await control.firstWindow();
    await expect(controlOpener.locator("body")).toHaveAttribute(
      "data-auth-state",
      "signed-out",
    );
    await controlJourney(control, controlOpener);

    suma = await launchSuma((text) => {
      sumaMainLog += text;
    });
    await openSumaTab(suma, origins.relyingOrigin);
    await expect
      .poll(() => webState(suma!, origins.relyingOrigin))
      .toMatchObject({ auth: "signed-out" });
    await expect
      .poll(() =>
        frameRelayState(suma!, `${origins.providerOrigin}/gsi/button`),
      )
      .not.toBeNull();
    await screenshotContents(
      suma,
      origins.relyingOrigin,
      "01-relying-party.png",
    );

    // The cross-origin button iframe must receive a live handle to its provider popup.
    await clickFrameContents(
      suma,
      `${origins.providerOrigin}/gsi/button`,
      "#google",
    );
    await expect
      .poll(() => webState(suma!, `${origins.providerOrigin}/oauth2/authorize`))
      .not.toBeNull();
    await expect
      .poll(() =>
        frameProviderHandle(suma!, `${origins.providerOrigin}/gsi/button`),
      )
      .toBe("object");
    await screenshotContents(
      suma,
      `${origins.providerOrigin}/oauth2/authorize`,
      "02-provider-account.png",
    );

    // The credential crosses popup -> button iframe -> relying tab, then closes the popup.
    await clickContents(
      suma,
      `${origins.providerOrigin}/oauth2/authorize`,
      "#choose",
    );
    await expect
      .poll(async () => (await webState(suma!, origins.providerOrigin)) ?? null)
      .toMatchObject({
        url: `${origins.providerOrigin}/oauth2/complete`,
        opener: "true",
        openerOrigin: origins.providerOrigin,
        credentialSent: "true",
      });
    await expect
      .poll(() =>
        frameRelayState(suma!, `${origins.providerOrigin}/gsi/button`),
      )
      .toMatchObject({
        credentialReceived: "true",
        storageAccess: "granted",
      });
    await gatewayProxy.mutationObserved;
    expect(gatewayProxy.exchangeRacedBeforeCommit()).toBe(false);
    await screenshotContents(
      suma,
      `${origins.providerOrigin}/oauth2/complete`,
      "03-one-moment-callback.png",
    );
    gatewayProxy.releaseMutation();
    origins.releaseSso();
    await expect
      .poll(() => webState(suma!, origins.relyingOrigin))
      .toMatchObject({ auth: "authenticated" });
    await expect
      .poll(() => webState(suma!, `${origins.providerOrigin}/oauth2/authorize`))
      .toBeNull();
    await screenshotContents(
      suma,
      origins.relyingOrigin,
      "04-authenticated.png",
    );
    // A reload must consume the first flow's durable X session, not reset the
    // transaction and force the user through a second successful popup.
    await reloadContents(suma, origins.relyingOrigin);
    await expect
      .poll(() => webState(suma!, origins.relyingOrigin))
      .toMatchObject({ auth: "authenticated" });
    await screenshotContents(
      suma,
      origins.relyingOrigin,
      "05-authenticated-after-refresh.png",
    );

    // X sends unload telemetry as a Blob-backed beacon while navigating away.
    // If Suma waits for the preceding cookie mutation without retaining the
    // body first, Electron loses the renderer-owned blob data pipe.
    await clickContents(suma, origins.relyingOrigin, "#logout");
    await gatewayProxy.logoutMutationObserved;
    expect(gatewayProxy.logoutRacedBeforeCommit()).toBe(false);
    await expect.poll(() => webState(suma!, "about:blank")).not.toBeNull();
    gatewayProxy.releaseLogoutMutation();
    await expect.poll(origins.logoutReceived).toBe(true);
    expect(origins.logoutBody()).toBe("logout-event");
    await navigateContents(suma, "about:blank", origins.relyingOrigin);
    await expect
      .poll(() => webState(suma!, origins.relyingOrigin))
      .toMatchObject({ auth: "signed-out" });
    await screenshotContents(suma, origins.relyingOrigin, "06-signed-out.png");
    await reloadContents(suma, origins.relyingOrigin);
    await expect
      .poll(() => webState(suma!, origins.relyingOrigin))
      .toMatchObject({ auth: "signed-out" });
    await screenshotContents(
      suma,
      origins.relyingOrigin,
      "07-signed-out-after-refresh.png",
    );
    expect(sumaMainLog).not.toContain("Could not get blob data");
  } catch (error) {
    throw new Error(
      `${String(error)}\n\nGateway proxy trace:\n${gatewayProxy.trace.join("\n")}\n\nSuma main output:\n${sumaMainLog}\n\nSession gateway output:\n${gatewayLog}`,
    );
  } finally {
    gatewayProxy.releaseMutation();
    gatewayProxy.releaseLogoutMutation();
    origins.releaseSso();
    await control?.close().catch(() => undefined);
    await suma?.close().catch(() => undefined);
    await closeServer(origins.relyingParty);
    await closeServer(origins.provider);
    await closeServer(gatewayProxy.server);
    gateway.kill("SIGTERM");
  }
});
