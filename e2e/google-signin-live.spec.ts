import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const SPACE_ID = "google-live-e2e-space";
const SCREENSHOTS = path.join(REPO, "e2e", "screenshots", "google-signin-live");
const GOOGLE_LOGIN = "https://accounts.google.com/ServiceLogin";
const ELECTRON = path.join(
  REPO,
  "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

interface GoogleState {
  url: string;
  title: string;
  body: string;
  hasEmailField: boolean;
}

function identifierOutcome(
  body: string,
): "account" | "embedded-browser" | "malformed" | "unknown" {
  if (body.includes("find your Google Account")) return "account";
  if (
    body.includes("browser you’re using doesn’t support JavaScript") ||
    body.includes("This browser or app may not be secure")
  ) {
    return "embedded-browser";
  }
  if (body.includes("request because it is malformed")) return "malformed";
  return "unknown";
}

function workspaceFile() {
  return {
    version: 1,
    spaces: [
      {
        id: SPACE_ID,
        name: "Google live test",
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
      splitTabBySpace: {},
      nativeTransportDomains: [],
    },
    history: [],
    lww: {},
    downloads: [],
    egress: {},
  };
}

async function screenshotContents(
  app: ElectronApplication,
  contentsId: number,
  filename: string,
): Promise<string> {
  const encoded = await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.contentsId);
      if (contents === undefined)
        throw new Error("Google WebContents disappeared");
      return (await contents.capturePage()).toPNG().toString("base64");
    },
    { contentsId },
  );
  await mkdir(SCREENSHOTS, { recursive: true });
  const target = path.join(SCREENSHOTS, filename);
  await writeFile(target, Buffer.from(encoded, "base64"));
  return target;
}

async function browserContents(
  app: ElectronApplication,
): Promise<number | null> {
  return app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => {
      const url = item.getURL();
      return (
        url !== "" &&
        url !== "about:blank" &&
        !url.startsWith("file:") &&
        !url.startsWith("devtools:")
      );
    });
    return contents?.id ?? null;
  });
}

async function googleState(
  app: ElectronApplication,
  contentsId: number,
): Promise<GoogleState> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.contentsId);
      if (contents === undefined)
        throw new Error("Google WebContents disappeared");
      return contents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      body: document.body?.innerText ?? '',
      hasEmailField: document.querySelector('input') !== null &&
        (document.body?.innerText ?? '').includes('Email or phone')
    })`);
    },
    { contentsId },
  );
}

async function submitSumaIdentifier(
  app: ElectronApplication,
  contentsId: number,
  email: string,
): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const contents = webContents.fromId(args.contentsId);
      if (contents === undefined)
        throw new Error("Google WebContents disappeared");
      await contents.executeJavaScript(`(() => {
      const input = document.querySelector('input');
      if (!(input instanceof HTMLInputElement)) throw new Error('Google identifier input missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter === undefined) throw new Error('HTMLInputElement value setter missing');
      setter.call(input, ${JSON.stringify(args.email)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const next = [...document.querySelectorAll('button, [role="button"]')]
        .find((element) => element.textContent?.trim() === 'Next');
      if (!(next instanceof HTMLElement)) throw new Error('Google Next button missing');
      next.click();
    })()`);
    },
    { contentsId, email },
  );
}

async function launchSuma(): Promise<ElectronApplication> {
  const userData = await mkdtemp(path.join(tmpdir(), "suma-google-live-"));
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
      SUMA_SESSION_GATEWAY_URL: "http://127.0.0.1:9",
      SUMA_SESSION_GATEWAY_DEV_TOKEN: "hbr_dev_google_live_e2e",
    },
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

async function openSumaTab(app: ElectronApplication): Promise<void> {
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
    { spaceId: SPACE_ID, url: GOOGLE_LOGIN },
  );
}

test("Suma submits Google's real identifier form like plain Electron", async () => {
  test.setTimeout(120_000);
  let control: ElectronApplication | null = null;
  let suma: ElectronApplication | null = null;
  try {
    const syntheticEmail = `suma.e2e.${Date.now()}@example.com`;
    // The control distinguishes a Google/network rejection from Suma's bridge.
    const controlData = await mkdtemp(
      path.join(tmpdir(), "electron-google-control-"),
    );
    control = await electron.launch({
      executablePath: ELECTRON,
      args: [
        path.join(REPO, "e2e/fixtures/plain-electron.mjs"),
        `--user-data-dir=${controlData}`,
      ],
      env: { ...process.env, SUMA_LIVE_GOOGLE_URL: GOOGLE_LOGIN },
    });
    const controlWindow = await control.firstWindow();
    await expect
      .poll(
        () =>
          controlWindow
            .locator("body")
            .innerText()
            .catch(() => ""),
        {
          timeout: 45_000,
        },
      )
      .not.toBe("");
    const controlState: GoogleState = {
      url: controlWindow.url(),
      title: await controlWindow.title(),
      body: await controlWindow.locator("body").innerText(),
      hasEmailField:
        (await controlWindow.locator("input").count()) > 0 &&
        (await controlWindow.locator("body").innerText()).includes(
          "Email or phone",
        ),
    };
    const controlContentsId = await browserContents(control);
    if (controlContentsId === null)
      throw new Error("plain Electron WebContents disappeared");
    await screenshotContents(
      control,
      controlContentsId,
      "01-plain-electron-identifier.png",
    );
    expect(
      controlState.hasEmailField,
      `plain Electron did not reach Google sign-in: ${JSON.stringify(controlState)}`,
    ).toBe(true);

    // A reserved-domain identifier exercises Google's real POST without using an account.
    const controlBeforeSubmitBody = await controlWindow
      .locator("body")
      .innerText();
    await controlWindow.locator("input").first().fill(syntheticEmail);
    await controlWindow.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() => controlWindow.locator("body").innerText(), {
        timeout: 45_000,
      })
      .not.toBe(controlBeforeSubmitBody);
    const controlAfterSubmit: GoogleState = {
      url: controlWindow.url(),
      title: await controlWindow.title(),
      body: await controlWindow.locator("body").innerText(),
      hasEmailField: (await controlWindow.locator("input").count()) > 0,
    };
    await screenshotContents(
      control,
      controlContentsId,
      "02-plain-electron-after-identifier.png",
    );
    expect(
      controlAfterSubmit.body,
      `plain Electron identifier submission was malformed: ${JSON.stringify(controlAfterSubmit)}`,
    ).not.toContain("request because it is malformed");
    expect(identifierOutcome(controlAfterSubmit.body)).not.toBe("unknown");

    // Suma must expose the same usable account identifier state, not a 401.
    suma = await launchSuma();
    await openSumaTab(suma);
    await expect
      .poll(() => browserContents(suma!), { timeout: 45_000 })
      .not.toBeNull();
    const contentsId = await browserContents(suma);
    if (contentsId === null)
      throw new Error("Suma did not create browser WebContents");
    await expect
      .poll(() => googleState(suma!, contentsId).then((state) => state.body), {
        timeout: 45_000,
      })
      .not.toBe("");
    const sumaState = await googleState(suma, contentsId);
    await screenshotContents(suma, contentsId, "03-suma-identifier.png");
    expect(
      sumaState.hasEmailField,
      `Suma did not reach Google sign-in: ${JSON.stringify(sumaState)}`,
    ).toBe(true);
    expect(sumaState.body).not.toContain("401. That’s an error.");
    expect(sumaState.body).not.toContain("request because it is malformed");
    expect(sumaState.title).toBe(controlState.title);

    // Suma must preserve the real form body and browser metadata on submission.
    const sumaBeforeSubmitBody = sumaState.body;
    await submitSumaIdentifier(suma, contentsId, syntheticEmail);
    await expect
      .poll(() => googleState(suma!, contentsId).then((state) => state.body), {
        timeout: 45_000,
      })
      .not.toBe(sumaBeforeSubmitBody);
    const sumaAfterSubmit = await googleState(suma, contentsId);
    await screenshotContents(suma, contentsId, "04-suma-after-identifier.png");
    expect(sumaAfterSubmit.body).not.toContain("400. That’s an error.");
    expect(sumaAfterSubmit.body).not.toContain(
      "request because it is malformed",
    );
    expect(sumaAfterSubmit.title).toBe(controlAfterSubmit.title);
    expect(identifierOutcome(sumaAfterSubmit.body)).toBe(
      identifierOutcome(controlAfterSubmit.body),
    );
  } finally {
    await suma?.close().catch(() => undefined);
    await control?.close().catch(() => undefined);
  }
});
