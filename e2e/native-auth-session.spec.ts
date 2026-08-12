import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "native-auth-e2e-space";
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots", "native-auth");
const OAUTH_STATE = "suma-state-%2B%2F%3D";
const HANDOFF_TOKEN = "single-use-handoff-%2B%2F%3D";
const ELECTRON = path.join(
  REPO,
  "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

interface ObservedRequest {
  method: string;
  path: string;
  cookie: string;
  body: string;
  transferEncoding: string;
  fetchMode?: string;
  fetchSite?: string;
  fetchDest?: string;
}

function shell(body: string, state: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Native OAuth continuity</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f5f7fb;
      background: radial-gradient(circle at 12% 8%, #1f5264 0, transparent 38%), #11151d; }
    main { width: min(680px, calc(100vw - 48px)); padding: 44px; border-radius: 24px;
      border: 1px solid #ffffff20; background: #171e29e8; box-shadow: 0 28px 80px #0008; }
    .eyebrow { color: #72d6ff; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0; font-size: clamp(36px, 6vw, 60px); line-height: 1; letter-spacing: -.05em; }
    p { color: #bac5d3; font-size: 18px; line-height: 1.5; }
    a, button { display: inline-block; margin-top: 18px; padding: 13px 20px; border: 0; border-radius: 999px;
      background: #72d6ff; color: #0c1b24; font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
    input { width: 100%; margin-top: 16px; padding: 14px 16px; color: #fff; background: #0f141c;
      border: 1px solid #ffffff2d; border-radius: 12px; font: inherit; }
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

async function readBody(
  request: Parameters<Parameters<typeof createServer>[0]>[0],
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function startAuthOrigin(): Promise<{
  server: Server;
  origin: string;
  handoffServer: Server;
  handoffOrigin: string;
  sameSiteServer: Server;
  sameSiteOrigin: string;
  observed: ObservedRequest[];
}> {
  const observed: ObservedRequest[] = [];
  let handoffUses = 0;
  let origin = "";
  const sameSiteServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const body = await readBody(request);
    observed.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      cookie: request.headers.cookie ?? "",
      body,
      transferEncoding: request.headers["transfer-encoding"] ?? "",
      fetchMode: request.headers["sec-fetch-mode"],
      fetchSite: request.headers["sec-fetch-site"],
      fetchDest: request.headers["sec-fetch-dest"],
    });
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "cache-control": "no-store",
    };
    if (
      url.pathname !== "/sso/init" ||
      request.method !== "POST" ||
      !request.headers.cookie?.includes("oauth_transaction=ready")
    ) {
      response.writeHead(409, headers).end("missing OAuth transaction");
      return;
    }
    response
      .writeHead(204, {
        ...headers,
        "set-cookie":
          "same_site_session=authenticated; HttpOnly; SameSite=Lax; Path=/",
      })
      .end();
  });
  await new Promise<void>((resolve, reject) => {
    sameSiteServer.once("error", reject);
    sameSiteServer.listen(0, "localhost", resolve);
  });
  const sameSiteAddress = sameSiteServer.address();
  if (sameSiteAddress === null || typeof sameSiteAddress === "string")
    throw new Error("same-site SSO origin did not bind");
  const sameSiteOrigin = `http://localhost:${sameSiteAddress.port}`;

  const handoffServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    observed.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      cookie: request.headers.cookie ?? "",
      body,
      transferEncoding: request.headers["transfer-encoding"] ?? "",
      fetchMode: request.headers["sec-fetch-mode"],
      fetchSite: request.headers["sec-fetch-site"],
      fetchDest: request.headers["sec-fetch-dest"],
    });

    if (url.pathname === "/blob-beacon" && request.method === "POST") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (url.pathname === "/accounts/SetOSID") {
      handoffUses += 1;
      const valid =
        handoffUses === 1 &&
        url.searchParams.get("osidt") === "single-use-handoff-+/=" &&
        url.searchParams.get("continue") ===
          `${handoffOrigin}/mail/u/0/?pli=1` &&
        request.headers.cookie?.includes("mail_binding=bound-to-browser") ===
          true;
      if (!valid) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("malformed single-use session handoff");
        return;
      }
      response.writeHead(303, {
        location: `/mail/u/0/?pli=1`,
        "set-cookie": "sid=native-session; HttpOnly; SameSite=Lax; Path=/",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname === "/mail/u/0/") {
      const signedIn =
        request.headers.cookie?.includes("sid=native-session") === true;
      html(
        response,
        shell(
          `<div class="eyebrow">Cross-origin Chromium session</div>
           <h1>${signedIn ? "Signed in." : "Session missing."}</h1>
           <p>The single-use account handoff was consumed once and the destination cookie stayed attached.</p>`,
          signedIn ? "authenticated" : "missing",
        ),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    handoffServer.once("error", reject);
    handoffServer.listen(0, "127.0.0.1", resolve);
  });
  const handoffAddress = handoffServer.address();
  if (handoffAddress === null || typeof handoffAddress === "string")
    throw new Error("handoff origin did not bind");
  const handoffOrigin = `http://127.0.0.1:${handoffAddress.port}`;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/chunked-probe" && request.method === "POST") {
      const streamed: ObservedRequest = {
        method: request.method,
        path: url.pathname,
        cookie: request.headers.cookie ?? "",
        body: "",
        transferEncoding: request.headers["transfer-encoding"] ?? "",
      };
      observed.push(streamed);
      request.on("data", (chunk: Buffer) => {
        streamed.body += chunk.toString("utf8");
      });
      // Deliberately answer before consuming the upload. Identity providers
      // are allowed to reject or redirect as soon as headers are sufficient.
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("stream accepted");
      return;
    }

    const body = await readBody(request);
    observed.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      cookie: request.headers.cookie ?? "",
      body,
      transferEncoding: request.headers["transfer-encoding"] ?? "",
    });

    if (url.pathname === "/oauth/start") {
      response.writeHead(302, {
        location: `/signin/identifier?flowName=WebLiteSignIn&state=${OAUTH_STATE}`,
        "set-cookie":
          "oauth_state=bound-to-browser; HttpOnly; SameSite=Lax; Path=/",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname === "/same-site-result") {
      const authenticated = request.headers.cookie?.includes(
        "same_site_session=authenticated",
      );
      html(
        response,
        shell(
          `<div class="eyebrow">Same-site OAuth callback</div>
           <h1>${authenticated ? "Signed in." : "Session missing."}</h1>
           <p>The first credential exchange must settle before the opener navigates home.</p>`,
          authenticated ? "same-site-authenticated" : "same-site-missing",
        ),
      );
      return;
    }
    if (url.pathname === "/signin/identifier") {
      if (!request.headers.cookie?.includes("oauth_state=bound-to-browser")) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("malformed auth request: redirect cookie missing");
        return;
      }
      html(
        response,
        shell(
          `<div class="eyebrow">Browser-owned redirect</div>
           <h1>Choose an account</h1>
           <p>The OAuth state and redirect cookie arrived together.</p>
           <form action="/signin/challenge" method="post">
             <input type="hidden" name="state" value="suma-state-+/=">
             <input id="email" name="email" type="email" value="person@example.test">
             <button id="continue" type="submit">Continue</button>
           </form>`,
          "identifier",
        ),
      );
      return;
    }
    if (url.pathname === "/signin/challenge" && request.method === "POST") {
      const fields = new URLSearchParams(body);
      if (
        fields.get("state") !== "suma-state-+/=" ||
        fields.get("email") !== "person@example.test" ||
        !request.headers.cookie?.includes("oauth_state=bound-to-browser")
      ) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("malformed auth request: form state missing");
        return;
      }
      response.writeHead(303, {
        location: `${handoffOrigin}/accounts/SetOSID?authuser=0&continue=${encodeURIComponent(`${handoffOrigin}/mail/u/0/?pli=1`)}&osidt=${HANDOFF_TOKEN}`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    const beaconComplete = url.pathname === "/beacon-complete";
    html(
      response,
      shell(
        `<div class="eyebrow">Hybrid auth regression</div>
         <h1>Native sign-in, local rendering.</h1>
         <p>This journey is routed natively even while the structured gateway is configured.</p>
         <button id="stream-probe" type="button">Test streamed sign-in request</button>
         <button id="blob-beacon-probe" type="button">Test Blob logout beacon</button>
         <button id="same-site-sso" type="button">Test same-site SSO</button>
         <p id="probe-result"></p>
         <a id="begin" href="/oauth/start?client_id=suma-desktop&state=${OAUTH_STATE}">Continue with identity provider</a>
         <script>
           document.querySelector('#stream-probe').addEventListener('click', async () => {
             const body = new ReadableStream({ start(controller) { controller.close(); } });
             const response = await fetch('/chunked-probe', { method: 'POST', body, duplex: 'half' });
             document.querySelector('#probe-result').textContent = await response.text();
             document.body.dataset.probeState = response.ok ? 'accepted' : 'rejected';
           });
           document.querySelector('#blob-beacon-probe').addEventListener('click', () => {
             const body = new Blob([], {
               type: 'application/x-www-form-urlencoded; charset=UTF-8'
             });
             document.body.dataset.beaconAccepted = String(
               navigator.sendBeacon(${JSON.stringify(`${handoffOrigin}/blob-beacon`)}, body)
             );
             location.assign('/beacon-complete');
           });
           document.querySelector('#same-site-sso').addEventListener('click', async () => {
             document.cookie = 'oauth_transaction=ready; Path=/; SameSite=Lax';
             await fetch(${JSON.stringify(`${sameSiteOrigin}/sso/init`)}, {
               method: 'POST',
               credentials: 'include',
               body: new Blob(['credential'], {
                 type: 'application/x-www-form-urlencoded'
               })
             });
             location.assign('/same-site-result');
           });
         </script>`,
        beaconComplete ? "beacon-complete" : "signed-out",
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("auth origin did not bind");
  origin = `http://localhost:${address.port}`;
  return {
    server,
    origin,
    handoffServer,
    handoffOrigin,
    sameSiteServer,
    sameSiteOrigin,
    observed,
  };
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
      nativeTransportDomains: ["localhost", "127.0.0.1"],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function launchApp(): Promise<ElectronApplication> {
  const userData = await mkdtemp(path.join(tmpdir(), "suma-native-auth-"));
  await writeFile(
    path.join(userData, "workspace.json"),
    JSON.stringify(workspaceFile()),
  );
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [
      path.join(REPO, "apps/desktop/out/main/index.js"),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...process.env,
      // Deliberately unreachable: native auth must not depend on a gateway
      // round trip, even though hybrid mode is enabled.
      SUMA_SESSION_GATEWAY_URL: "http://127.0.0.1:9",
      SUMA_SESSION_GATEWAY_DEV_TOKEN: "hbr_dev_native_auth_e2e",
    },
  });
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __sumaNativeAuthErrors?: string[];
    };
    state.__sumaNativeAuthErrors = [];
    process.on("uncaughtExceptionMonitor", (error) => {
      state.__sumaNativeAuthErrors?.push(error.stack ?? error.message);
    });
    const originalConsoleError = console.error.bind(console);
    console.error = (...values: unknown[]) => {
      state.__sumaNativeAuthErrors?.push(
        values
          .map((value) =>
            value instanceof Error
              ? (value.stack ?? value.message)
              : String(value),
          )
          .join(" "),
      );
      originalConsoleError(...values);
    };
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
          if (
            await contents
              .executeJavaScript("typeof window.suma === 'object'")
              .catch(() => false)
          )
            return true;
        }
        return false;
      }),
    )
    .toBe(true);
  return app;
}

async function failNextBlobRead(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }) => {
    const state = globalThis as typeof globalThis & {
      __sumaBlobReadFailure?: { armed: boolean; attempts: number };
      __sumaOriginalGetBlobData?: typeof session.defaultSession.getBlobData;
    };
    state.__sumaBlobReadFailure = { armed: true, attempts: 0 };
    if (state.__sumaOriginalGetBlobData !== undefined) return;

    const original = session.defaultSession.getBlobData.bind(
      session.defaultSession,
    );
    state.__sumaOriginalGetBlobData = original;
    session.defaultSession.getBlobData = async (uuid: string) => {
      const failure = state.__sumaBlobReadFailure;
      if (failure?.armed === true) {
        failure.armed = false;
        failure.attempts += 1;
        throw new Error("Could not get blob data");
      }
      return original(uuid);
    };
  });
}

async function blobReadFailureAttempts(
  app: ElectronApplication,
): Promise<number> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __sumaBlobReadFailure?: { attempts: number };
    };
    return state.__sumaBlobReadFailure?.attempts ?? 0;
  });
}

async function launchControl(url: string): Promise<ElectronApplication> {
  const userData = await mkdtemp(path.join(tmpdir(), "electron-native-auth-"));
  return electron.launch({
    executablePath: ELECTRON,
    args: [
      path.join(REPO, "e2e/fixtures/plain-electron.mjs"),
      `--user-data-dir=${userData}`,
    ],
    env: { ...process.env, SUMA_LIVE_GOOGLE_URL: url },
  });
}

async function seedControlCookie(
  app: ElectronApplication,
  origin: string,
): Promise<void> {
  await app.evaluate(
    async ({ session }, args) => {
      await session.defaultSession.cookies.set({
        url: args.origin,
        name: "mail_binding",
        value: "bound-to-browser",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
    },
    { origin },
  );
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
        if (
          !(await contents
            .executeJavaScript("typeof window.suma === 'object'")
            .catch(() => false))
        )
          continue;
        await contents.executeJavaScript(
          `window.suma.invoke("tabs:create", ${JSON.stringify({ spaceId: args.spaceId, url: args.url })})`,
        );
        return;
      }
      throw new Error("Suma chrome WebContents not found");
    },
    { spaceId: SPACE_ID, url },
  );
  await expect.poll(() => pageState(app, url)).not.toBeNull();
}

async function seedDestinationCookie(
  app: ElectronApplication,
  origin: string,
): Promise<string[]> {
  return app.evaluate(
    async ({ session }, args) => {
      const ses = session.fromPartition(`persist:space-${args.spaceId}`);
      await ses.cookies.set({
        url: args.origin,
        name: "mail_binding",
        value: "bound-to-browser",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
      return (await ses.cookies.get({ url: args.origin })).map(
        (cookie) => `${cookie.name}=${cookie.value}`,
      );
    },
    { spaceId: SPACE_ID, origin },
  );
}

async function pageState(app: ElectronApplication, origin: string) {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) return null;
      return contents.executeJavaScript(`({
        url: location.href,
        auth: document.body?.dataset.authState ?? null,
        probe: document.body?.dataset.probeState ?? null
      })`);
    },
    { origin },
  );
}

async function click(
  app: ElectronApplication,
  origin: string,
  selector: string,
): Promise<void> {
  const clicked = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) return false;
      return contents.executeJavaScript(`(() => {
      const target = document.querySelector(${JSON.stringify(args.selector)});
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`);
    },
    { origin, selector },
  );
  expect(clicked).toBe(true);
}

async function navigate(
  app: ElectronApplication,
  origin: string,
  url: string,
): Promise<void> {
  const navigated = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) return false;
      await contents.loadURL(args.url);
      return true;
    },
    { origin, url },
  );
  expect(navigated).toBe(true);
}

async function screenshot(
  app: ElectronApplication,
  origin: string,
  filename: string,
): Promise<string> {
  const encoded = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(args.origin));
      if (contents === undefined) throw new Error("auth tab not found");
      return (await contents.capturePage()).toPNG().toString("base64");
    },
    { origin },
  );
  await mkdir(SCREENSHOTS, { recursive: true });
  const target = path.join(SCREENSHOTS, filename);
  await writeFile(target, Buffer.from(encoded, "base64"));
  return target;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function uncaughtMainErrors(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __sumaNativeAuthErrors?: string[];
    };
    return state.__sumaNativeAuthErrors ?? [];
  });
}

test("browser-native authentication preserves redirects, cookies, query state, and form bodies", async () => {
  test.setTimeout(60_000);
  const controlAuth = await startAuthOrigin();
  const auth = await startAuthOrigin();
  let control: ElectronApplication | null = null;
  let app: ElectronApplication | null = null;
  try {
    control = await launchControl(`${controlAuth.origin}/`);
    const controlWindow = await control.firstWindow();
    await seedControlCookie(control, controlAuth.handoffOrigin);
    await expect(controlWindow.locator("body")).toHaveAttribute(
      "data-auth-state",
      "signed-out",
    );
    await controlWindow.locator("#begin").click();
    await expect(controlWindow.locator("body")).toHaveAttribute(
      "data-auth-state",
      "identifier",
    );
    await controlWindow.locator("#continue").click();
    await expect(controlWindow.locator("body")).toHaveAttribute(
      "data-auth-state",
      "authenticated",
    );
    await screenshot(
      control,
      controlAuth.handoffOrigin,
      "00-plain-electron-authenticated.png",
    );
    expect(
      controlAuth.observed.filter((request) =>
        request.path.startsWith("/accounts/SetOSID?"),
      ),
    ).toHaveLength(1);

    app = await launchApp();
    expect(await seedDestinationCookie(app, auth.handoffOrigin)).toContain(
      "mail_binding=bound-to-browser",
    );
    await openTab(app, `${auth.origin}/`);
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({ auth: "signed-out" });
    await screenshot(app, auth.origin, "01-signed-out.png");

    // X exchanges the Google credential with a same-site subdomain before
    // navigating the opener to /home. Electron's protocol Request drops the
    // renderer's credentials mode; Suma must restore it on the first flow.
    await click(app, auth.origin, "#same-site-sso");
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({ auth: "same-site-authenticated" });
    expect(
      auth.observed.find((request) => request.path === "/sso/init"),
    ).toMatchObject({
      method: "POST",
      cookie: expect.stringContaining("oauth_transaction=ready"),
      body: "credential",
    });
    await screenshot(app, auth.origin, "02-same-site-sso-authenticated.png");
    await navigate(app, auth.origin, `${auth.origin}/`);
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({ auth: "signed-out" });

    // An empty streamed POST previously crashed Electron's chunked finalizer.
    await click(app, auth.origin, "#stream-probe");
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({ probe: "accepted" });
    expect(await uncaughtMainErrors(app)).toEqual([]);
    await screenshot(app, auth.origin, "03-empty-stream-post-complete.png");

    // X posts its Blob logout beacon cross-origin and destroys the initiating
    // document immediately. Electron can lose X's zero-byte Blob producer
    // before Suma reads it; that local failure is equivalent to EOF.
    await failNextBlobRead(app);
    await click(app, auth.origin, "#blob-beacon-probe");
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({ auth: "beacon-complete" });
    await expect
      .poll(() =>
        auth.observed.find((request) => request.path === "/blob-beacon"),
      )
      .toMatchObject({ method: "POST", body: "" });
    expect(await blobReadFailureAttempts(app)).toBe(1);
    expect(
      (await uncaughtMainErrors(app)).filter((error) =>
        error.includes("Could not get blob data"),
      ),
    ).toEqual([]);
    await screenshot(app, auth.origin, "04-blob-beacon-complete.png");

    await click(app, auth.origin, "#begin");
    await expect
      .poll(() => pageState(app!, auth.origin))
      .toMatchObject({
        url: `${auth.origin}/signin/identifier?flowName=WebLiteSignIn&state=${OAUTH_STATE}`,
        auth: "identifier",
      });
    await screenshot(app, auth.origin, "05-identifier.png");

    await click(app, auth.origin, "#continue");
    await expect
      .poll(() => pageState(app!, auth.handoffOrigin))
      .toMatchObject({
        url: `${auth.handoffOrigin}/mail/u/0/?pli=1`,
        auth: "authenticated",
      });
    await screenshot(app, auth.handoffOrigin, "06-authenticated.png");

    const start = auth.observed.find((request) =>
      request.path.startsWith("/oauth/start?"),
    );
    expect(start).toMatchObject({ method: "GET", body: "" });
    expect(start?.path).toContain(`state=${OAUTH_STATE}`);
    expect(
      auth.observed.find((request) => request.path === "/chunked-probe"),
    ).toMatchObject({
      method: "POST",
      body: "",
      transferEncoding: "",
    });
    expect(
      auth.observed.find((request) =>
        request.path.startsWith("/signin/identifier?"),
      ),
    ).toMatchObject({
      method: "GET",
      cookie: expect.stringContaining("oauth_state=bound-to-browser"),
    });
    expect(
      auth.observed.find((request) => request.path === "/signin/challenge"),
    ).toMatchObject({
      method: "POST",
      cookie: expect.stringContaining("oauth_state=bound-to-browser"),
      body: "state=suma-state-%2B%2F%3D&email=person%40example.test",
    });
    const handoffs = auth.observed.filter((request) =>
      request.path.startsWith("/accounts/SetOSID?"),
    );
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      method: "GET",
      cookie: expect.stringContaining("mail_binding=bound-to-browser"),
      body: "",
      fetchMode: "navigate",
      fetchSite: "cross-site",
      fetchDest: "document",
    });
    expect(await uncaughtMainErrors(app)).toEqual([]);
  } finally {
    await control?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await closeServer(controlAuth.server);
    await closeServer(controlAuth.handoffServer);
    await closeServer(controlAuth.sameSiteServer);
    await closeServer(auth.server);
    await closeServer(auth.handoffServer);
    await closeServer(auth.sameSiteServer);
  }
});
