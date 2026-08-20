import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import type {
  MachineStatus,
  PortForwardInfo,
  SpaceInfo,
  TabInfo,
  WorkspaceConnectionStatus,
} from "../apps/desktop/src/shared/ipc";

const REPO = path.resolve(process.cwd());
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "vm-port-forwarding-active-live",
);
const CDP_URL = process.env["SUMA_ACTIVE_CDP_URL"] ?? "http://127.0.0.1:9223";

interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly sessions = new Map<string, string>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as CdpMessage;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  static async connect(): Promise<CdpClient> {
    const version = (await (await fetch(`${CDP_URL}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpClient(socket);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return response;
  }

  async targets(): Promise<CdpTarget[]> {
    const result = (await this.send("Target.getTargets")) as {
      targetInfos: CdpTarget[];
    };
    return result.targetInfos;
  }

  async session(targetId: string): Promise<string> {
    const existing = this.sessions.get(targetId);
    if (existing !== undefined) return existing;
    const result = (await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessions.set(targetId, result.sessionId);
    return result.sessionId;
  }

  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const result = (await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )) as {
      result: { value: T };
      exceptionDetails?: { text: string };
    };
    if (result.exceptionDetails !== undefined)
      throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async screenshot(sessionId: string, name: string): Promise<void> {
    const result = (await this.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId,
    )) as { data: string };
    await writeFile(path.join(SCREENSHOTS, name), result.data, "base64");
  }

  close(): void {
    this.socket.close();
  }
}

function chromeTarget(targets: CdpTarget[]): CdpTarget | undefined {
  return targets.find(
    (target) =>
      target.type === "page" &&
      target.url.startsWith("http://localhost:5173/") &&
      !target.url.includes("#"),
  );
}

function forwardedTarget(targets: CdpTarget[]): CdpTarget | undefined {
  return targets.find(
    (target) =>
      target.type === "page" && target.url.startsWith("http://localhost:3000"),
  );
}

test.skip(
  process.env["SUMA_ACTIVE_CDP_E2E"] !== "1",
  "start the enrolled desktop with Electron remote debugging, then set SUMA_ACTIVE_CDP_E2E=1",
);

test("an enrolled desktop restores the VM workspace and forwards its IPv6 wildcard port", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });

  const cdp = await CdpClient.connect();
  try {
    const chrome = chromeTarget(await cdp.targets());
    if (chrome === undefined) throw new Error("Suma chrome target missing");
    const chromeSession = await cdp.session(chrome.targetId);
    await expect
      .poll(() =>
        cdp.evaluate<boolean>(chromeSession, 'typeof window.suma === "object"'),
      )
      .toBe(true);
    await cdp.screenshot(chromeSession, "01-restarted-desktop.png");

    await expect
      .poll(
        () =>
          cdp.evaluate<MachineStatus>(
            chromeSession,
            'window.suma.invoke("machine:status", undefined)',
          ),
        { timeout: 45_000 },
      )
      .toMatchObject({ state: "running" });

    // The renderer must recover connection state even when the VM's up event
    // happened before its listener existed.
    await expect
      .poll(
        () =>
          cdp.evaluate<WorkspaceConnectionStatus>(
            chromeSession,
            'window.suma.invoke("workspace:status", undefined)',
          ),
        { timeout: 45_000 },
      )
      .toMatchObject({ source: "remote", connected: true });

    const spaces = await cdp.evaluate<SpaceInfo[]>(
      chromeSession,
      'window.suma.invoke("spaces:list", undefined)',
    );
    const activeSpace = spaces.find((space) => space.active);
    if (activeSpace === undefined) throw new Error("active space missing");
    const tabs = await cdp.evaluate<TabInfo[]>(
      chromeSession,
      `window.suma.invoke("tabs:list", { spaceId: ${JSON.stringify(activeSpace.id)} })`,
    );
    const terminalTab = tabs.find((tab) =>
      tab.url.startsWith("suma://terminal"),
    );
    const browserTab = tabs.find((tab) => !tab.url.startsWith("suma://"));
    if (terminalTab === undefined) throw new Error("terminal tab missing");
    await cdp.evaluate(
      chromeSession,
      `window.suma.invoke("tabs:select", { tabId: ${JSON.stringify(terminalTab.id)} })`,
    );
    await expect
      .poll(() =>
        cdp.evaluate<{
          connecting: boolean;
          loading: boolean;
          explorer: boolean;
        }>(
          chromeSession,
          `(() => {
            const text = document.body.innerText;
            return {
              connecting: text.includes("Connecting to your computer"),
              loading: text.includes("Loading workspace"),
              explorer: text.includes("EXPLORER")
            };
          })()`,
        ),
      )
      .toEqual({ connecting: false, loading: false, explorer: true });
    await cdp.screenshot(chromeSession, "02-ide-workspace.png");
    if (browserTab !== undefined) {
      await cdp.evaluate(
        chromeSession,
        `window.suma.invoke("tabs:select", { tabId: ${JSON.stringify(browserTab.id)} })`,
      );
    }

    await expect
      .poll(
        () =>
          cdp.evaluate<PortForwardInfo[]>(
            chromeSession,
            'window.suma.invoke("ports:list", undefined)',
          ),
        { timeout: 45_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            port: 3000,
            localUrl: "http://localhost:3000",
          }),
        ]),
      );

    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "rawKeyDown",
        key: "l",
        code: "KeyL",
        windowsVirtualKeyCode: 76,
        modifiers: 4,
      },
      chromeSession,
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "l", code: "KeyL", modifiers: 4 },
      chromeSession,
    );
    await expect
      .poll(() =>
        cdp.evaluate<boolean>(
          chromeSession,
          "document.querySelector('input[aria-label=\"Address\"]') !== null",
        ),
      )
      .toBe(true);
    await cdp.evaluate(
      chromeSession,
      `(() => {
        const input = document.querySelector('input[aria-label="Address"]');
        if (!(input instanceof HTMLInputElement)) throw new Error("address input missing");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter === undefined) throw new Error("input value setter missing");
        setter.call(input, "http://localhost:3000");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        return input.value;
      })()`,
    );
    await cdp.screenshot(chromeSession, "03-localhost-address.png");
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      },
      chromeSession,
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Enter", code: "Enter" },
      chromeSession,
    );

    await expect
      .poll(
        async () => {
          const target = forwardedTarget(await cdp.targets());
          if (target === undefined) return null;
          const session = await cdp.session(target.targetId);
          return cdp.evaluate<{
            url: string;
            title: string;
            heading: string | null;
          }>(
            session,
            `({
              url: location.href,
              title: document.title,
              heading: document.querySelector("h1")?.textContent?.trim() ?? null
            })`,
          );
        },
        { timeout: 45_000 },
      )
      .toMatchObject({
        url: "http://localhost:3000/",
        title: "Create Next App",
        heading: expect.stringContaining("To get started, edit the"),
      });

    await expect
      .poll(
        () =>
          cdp.evaluate<PortForwardInfo[]>(
            chromeSession,
            'window.suma.invoke("ports:list", undefined)',
          ),
        { timeout: 15_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ port: 3000, forwarded: true }),
        ]),
      );

    await cdp.screenshot(chromeSession, "04-forwarded-browser-chrome.png");
    const next = forwardedTarget(await cdp.targets());
    if (next === undefined) throw new Error("forwarded Next target missing");
    await cdp.screenshot(
      await cdp.session(next.targetId),
      "05-forwarded-next-app.png",
    );
  } finally {
    cdp.close();
  }
});
