import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EncryptedFileBrowserSessionStore,
  PlaywrightBrowserBackend,
  PlaywrightBrowserRuntime,
  SafeBrowserNetworkPolicy,
  StaticBrowserAuthProvider,
} from "../src/browser";

const chromePath = [
  process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => candidate !== undefined && existsSync(candidate));

describe.skipIf(chromePath === undefined)("persistent Playwright browser", () => {
  let server: Server;
  let origin: string;
  let runtime: PlaywrightBrowserRuntime;
  let store: EncryptedFileBrowserSessionStore;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/auth") {
        const authorized = request.headers.authorization === "Bearer integration-token";
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<body>${authorized ? "token authenticated" : "logged out"}</body>`);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "suma_session=authenticated; Path=/; HttpOnly; SameSite=Lax",
      });
      const requestCookie = request.headers.cookie ?? "";
      response.end(`<!doctype html>
        <title>Remote browser fixture</title>
        <body>
          <label>Query <input id="query" /></label>
          <button id="save" onclick="localStorage.setItem('saved', document.querySelector('#query').value); document.querySelector('#result').textContent = 'saved ' + document.querySelector('#query').value">Save</button>
          <div id="result"></div>
          <div id="state"></div>
          <script>document.querySelector('#state').textContent = 'cookie=${requestCookie}' + '; storage=' + (localStorage.getItem('saved') || '');</script>
        </body>`);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not get a TCP address");
    }
    origin = `http://127.0.0.1:${String(address.port)}`;
    runtime = new PlaywrightBrowserRuntime({ executablePath: chromePath });
    store = new EncryptedFileBrowserSessionStore(
      await mkdtemp(join(tmpdir(), "suma-browser-e2e-")),
      randomBytes(32),
    );
  });

  afterAll(async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("clicks, types, captures pixels, and restores cookies and local storage", async () => {
    const common = {
      runtime,
      sessionKey: { userId: "user-1", spaceId: "space-1" },
      store,
      networkPolicy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin] }),
    };
    const first = new PlaywrightBrowserBackend(common);
    await first.openTab(`${origin}/`);
    await first.typeText({ selector: "#query", text: "from remote" });
    await first.click({ selector: "#save" });
    expect((await first.readPage()).text).toContain("saved from remote");
    expect((await first.screenshot()).data.length).toBeGreaterThan(1_000);
    await first.close();

    const restored = new PlaywrightBrowserBackend(common);
    await restored.openTab(`${origin}/`);
    const page = await restored.readPage();
    expect(page.text).toContain("cookie=suma_session=authenticated");
    expect(page.text).toContain("storage=from remote");
    await restored.close();
  });

  it("injects custom integration credentials beneath the tool boundary", async () => {
    const backend = new PlaywrightBrowserBackend({
      runtime,
      sessionKey: { userId: "user-2", spaceId: "space-1" },
      store,
      networkPolicy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin] }),
      authProvider: new StaticBrowserAuthProvider([
        {
          origin,
          pathPrefix: "/auth",
          headers: { authorization: "Bearer integration-token" },
        },
      ]),
    });
    await backend.openTab(`${origin}/auth`);
    expect((await backend.readPage()).text).toContain("token authenticated");
    await backend.close();
  });

  it("starts authenticated from a desktop session handoff", async () => {
    const backend = new PlaywrightBrowserBackend({
      runtime,
      sessionKey: { userId: "user-3", spaceId: "space-1" },
      store,
      networkPolicy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin] }),
    });
    const host = new URL(origin).hostname;
    await backend.importStorageState({
      cookies: [
        {
          name: "suma_session",
          value: "shared-from-desktop",
          domain: host,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin,
          localStorage: [{ name: "saved", value: "shared storage" }],
        },
      ],
    });
    await backend.openTab(`${origin}/`);
    const page = await backend.readPage();
    expect(page.text).toContain("cookie=suma_session=shared-from-desktop");
    expect(page.text).toContain("storage=shared storage");
    await backend.close();
  });
});
