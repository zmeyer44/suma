import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import electron from "electron";
import WebSocket from "ws";
import type {
  SpaceInfo,
  TabInfo,
  TerminalInfo,
  WorkspaceConnectionStatus,
} from "../apps/desktop/src/shared/ipc";

const execFileAsync = promisify(execFile);
const REPO = path.resolve(process.cwd());
const DESKTOP = path.join(REPO, "apps", "desktop");
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "vm-terminal-tmux-active-live",
);
const PROFILE =
  process.env["SUMA_TMUX_E2E_PROFILE"] ??
  "/Users/claudius/Library/Application Support/Suma Dev Cloud";
const CONTROL_URL =
  process.env["SUMA_TMUX_E2E_CONTROL_URL"] ?? "https://api.sumabrowser.com";
const FLY_APP =
  process.env["SUMA_TMUX_E2E_FLY_APP"] ??
  "sm-c-b82b3d94-f56c-4c8d-a537-06bc5d212544";
const FLY_MACHINE =
  process.env["SUMA_TMUX_E2E_FLY_MACHINE"] ?? "28747929f55e68";
const CDP_PORT = 9224;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

interface CdpTarget {
  targetId: string;
  type: string;
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

  private async send(
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

  async chromeSession(): Promise<string> {
    const result = (await this.send("Target.getTargets")) as {
      targetInfos: CdpTarget[];
    };
    const chrome = result.targetInfos.find(
      (target) =>
        target.type === "page" &&
        target.url.includes("/out/renderer/index.html") &&
        !target.url.includes("#"),
    );
    if (chrome === undefined) throw new Error("Suma chrome target missing");
    const attached = (await this.send("Target.attachToTarget", {
      targetId: chrome.targetId,
      flatten: true,
    })) as { sessionId: string };
    return attached.sessionId;
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(SCREENSHOTS, name), result.data, "base64");
  }

  close(): void {
    this.socket.close();
  }
}

type DesktopProcess = ReturnType<typeof launchDesktop>;

function launchDesktop() {
  return import("node:child_process").then(({ spawn }) =>
    spawn(
      electron as unknown as string,
      [".", `--remote-debugging-port=${CDP_PORT}`],
      {
        cwd: DESKTOP,
        env: {
          ...process.env,
          SUMA_NO_DOTENV: "1",
          SUMA_CONTROL_URL: CONTROL_URL,
          SUMA_USER_DATA: PROFILE,
        },
        stdio: "pipe",
      },
    ),
  );
}

async function stopDesktop(childPromise: DesktopProcess): Promise<void> {
  const child = await childPromise;
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await exited;
}

async function connectDesktop(): Promise<{
  cdp: CdpClient;
  sessionId: string;
}> {
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${CDP_URL}/json/version`)).ok;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const cdp = await CdpClient.connect();
  const sessionId = await cdp.chromeSession();
  await expect
    .poll(() =>
      cdp.evaluate<boolean>(sessionId, 'typeof window.suma === "object"'),
    )
    .toBe(true);
  return { cdp, sessionId };
}

async function selectTerminalTab(
  cdp: CdpClient,
  sessionId: string,
): Promise<void> {
  // Startup begins on the local simulator and then swaps to the discovered
  // VM. Creating during that handoff can race the link replacement, so the
  // user journey starts only once its observable remote connection is ready.
  await expect
    .poll(() =>
      cdp.evaluate<WorkspaceConnectionStatus>(
        sessionId,
        'window.suma.invoke("workspace:status", undefined)',
      ),
    )
    .toMatchObject({ source: "remote", connected: true });
  const spaces = await cdp.evaluate<SpaceInfo[]>(
    sessionId,
    'window.suma.invoke("spaces:list", undefined)',
  );
  const active = spaces.find((space) => space.active);
  if (active === undefined) throw new Error("active space missing");
  const tabs = await cdp.evaluate<TabInfo[]>(
    sessionId,
    `window.suma.invoke("tabs:list", { spaceId: ${JSON.stringify(active.id)} })`,
  );
  const terminal = tabs.find((tab) => tab.url.startsWith("suma://terminal"));
  if (terminal === undefined) throw new Error("terminal tab missing");
  await cdp.evaluate(
    sessionId,
    `window.suma.invoke("tabs:select", { tabId: ${JSON.stringify(terminal.id)} })`,
  );
  await expect
    .poll(() =>
      cdp.evaluate<boolean>(
        sessionId,
        'document.querySelector("[data-testid=terminal-emulator]") !== null',
      ),
    )
    .toBe(true);
}

async function terminalList(
  cdp: CdpClient,
  sessionId: string,
): Promise<TerminalInfo[]> {
  return cdp.evaluate<TerminalInfo[]>(
    sessionId,
    'window.suma.invoke("terminal:list", undefined)',
  );
}

async function tmuxHasSession(ptyId: string): Promise<boolean> {
  try {
    await execFileAsync("fly", [
      "ssh",
      "console",
      "--app",
      FLY_APP,
      "--machine",
      FLY_MACHINE,
      "-C",
      `tmux has-session -t =suma-${ptyId}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxSessionIds(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("fly", [
      "ssh",
      "console",
      "--app",
      FLY_APP,
      "--machine",
      FLY_MACHINE,
      "-C",
      "tmux list-sessions",
    ]);
    return [...stdout.matchAll(/^suma-([0-9a-f-]{36}):/gm)].map(
      (match) => match[1]!,
    );
  } catch {
    return [];
  }
}

async function tmuxStatus(ptyId: string): Promise<string> {
  const { stdout } = await execFileAsync("fly", [
    "ssh",
    "console",
    "--app",
    FLY_APP,
    "--machine",
    FLY_MACHINE,
    "-C",
    `tmux show-options -v -t suma-${ptyId} status`,
  ]);
  return stdout.trim();
}

/** Print a sentinel without putting that sentinel in the echoed command.
 * This prevents an input echo from satisfying the output assertion. */
function shellPrint(value: string): string {
  const octal = [...Buffer.from(`${value}\n`)]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
  return `printf '${octal}'\n`;
}

test.skip(
  process.env["SUMA_TMUX_ACTIVE_E2E"] !== "1",
  "set SUMA_TMUX_ACTIVE_E2E=1 to drive the enrolled cloud desktop and Fly VM",
);

test("a VM shell automatically resumes through tmux after the desktop restarts", async () => {
  test.setTimeout(120_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });

  let desktop = launchDesktop();
  let first = await connectDesktop();
  let ptyId = "";
  try {
    await selectTerminalTab(first.cdp, first.sessionId);
    const tmuxBefore = new Set(await tmuxSessionIds());

    // Creating through the visible IDE control proves new remote shells opt
    // into tmux without asking the user to run or understand tmux commands.
    const clicked = await first.cdp.evaluate<boolean>(
      first.sessionId,
      `(() => {
        const button = document.querySelector(${JSON.stringify('button[aria-label="New shell"]')});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
    );
    expect(clicked).toBe(true);
    await expect
      .poll(
        async () => {
          const created = (await tmuxSessionIds()).find(
            (candidate) => !tmuxBefore.has(candidate),
          );
          if (created !== undefined) ptyId = created;
          return created;
        },
        { timeout: 20_000 },
      )
      .not.toBeUndefined();
    let fresh: TerminalInfo | undefined;
    await expect
      .poll(
        async () => {
          fresh = (await terminalList(first.cdp, first.sessionId)).find(
            (terminal) => terminal.ptyId === ptyId,
          );
          return fresh;
        },
        { timeout: 20_000 },
      )
      .not.toBeUndefined();
    if (fresh === undefined) throw new Error("new terminal missing");

    // Persistence belongs in Suma's shell tab, while tmux itself remains an
    // invisible implementation detail inside the terminal emulator.
    await expect
      .poll(() =>
        first.cdp.evaluate<boolean>(
          first.sessionId,
          `(() => {
            const indicator = document.querySelector(${JSON.stringify(`[data-testid="terminal-persistent-${ptyId}"]`)});
            const tabs = document.querySelector("[data-testid=terminal-tabs]");
            if (!(indicator instanceof HTMLElement) || !(tabs instanceof HTMLElement)) return false;
            const iconRect = indicator.getBoundingClientRect();
            const tabsRect = tabs.getBoundingClientRect();
            return iconRect.left >= tabsRect.left && iconRect.right <= tabsRect.right;
          })()`,
        ),
      )
      .toBe(true);
    await expect.poll(() => tmuxStatus(ptyId)).toBe("off");

    await first.cdp.evaluate(
      first.sessionId,
      `(() => {
        window.__sumaTmuxE2e = [];
        window.suma.on("terminal:data", (payload) => {
          if (payload.ptyId === ${JSON.stringify(ptyId)})
            window.__sumaTmuxE2e.push(payload.data);
        });
      })()`,
    );
    await first.cdp.evaluate(
      first.sessionId,
      `window.suma.invoke("terminal:input", {
        ptyId: ${JSON.stringify(ptyId)},
        data: ${JSON.stringify(shellPrint("TMUX_BEFORE_RESTART"))}
      })`,
    );
    await expect
      .poll(() =>
        first.cdp.evaluate<boolean>(
          first.sessionId,
          'window.__sumaTmuxE2e.join("").includes("TMUX_BEFORE_RESTART")',
        ),
      )
      .toBe(true);
    await expect.poll(() => tmuxHasSession(ptyId)).toBe(true);
    await first.cdp.screenshot(first.sessionId, "01-tmux-shell-running.png");
  } finally {
    first.cdp.close();
    await stopDesktop(desktop);
  }

  desktop = launchDesktop();
  const second = await connectDesktop();
  try {
    await selectTerminalTab(second.cdp, second.sessionId);
    await second.cdp.evaluate(
      second.sessionId,
      'window.suma.invoke("terminal:discover", undefined)',
    );
    await expect
      .poll(async () => {
        const terminal = (
          await terminalList(second.cdp, second.sessionId)
        ).find((candidate) => candidate.ptyId === ptyId);
        return terminal?.exited;
      })
      .toBe(false);

    // Selecting the same visible shell asks the agent to attach and replay;
    // the result must be resumed rather than a reconstructed/exited context.
    const selected = await second.cdp.evaluate<boolean>(
      second.sessionId,
      `(() => {
        window.__sumaTmuxE2e = [];
        window.suma.on("terminal:data", (payload) => {
          if (payload.ptyId === ${JSON.stringify(ptyId)})
            window.__sumaTmuxE2e.push(payload.data);
        });
        const button = document.querySelector(${JSON.stringify(`[data-testid="terminal-select-${ptyId}"]`)});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
    );
    expect(selected).toBe(true);
    await expect
      .poll(async () => {
        const terminal = (
          await terminalList(second.cdp, second.sessionId)
        ).find((candidate) => candidate.ptyId === ptyId);
        return terminal?.restore;
      })
      .toBe("resumed");
    await expect
      .poll(() =>
        second.cdp.evaluate<boolean>(
          second.sessionId,
          `(() => {
            const indicator = document.querySelector(${JSON.stringify(`[data-testid="terminal-persistent-${ptyId}"]`)});
            const tabs = document.querySelector("[data-testid=terminal-tabs]");
            if (!(indicator instanceof HTMLElement) || !(tabs instanceof HTMLElement)) return false;
            const iconRect = indicator.getBoundingClientRect();
            const tabsRect = tabs.getBoundingClientRect();
            return iconRect.left >= tabsRect.left && iconRect.right <= tabsRect.right;
          })()`,
        ),
      )
      .toBe(true);
    await expect.poll(() => tmuxStatus(ptyId)).toBe("off");
    await second.cdp.evaluate(
      second.sessionId,
      `window.suma.invoke("terminal:input", {
        ptyId: ${JSON.stringify(ptyId)},
        data: ${JSON.stringify(shellPrint("TMUX_AFTER_RESTART"))}
      })`,
    );
    await expect
      .poll(() =>
        second.cdp.evaluate<boolean>(
          second.sessionId,
          'window.__sumaTmuxE2e.join("").includes("TMUX_AFTER_RESTART")',
        ),
      )
      .toBe(true);
    await second.cdp.screenshot(second.sessionId, "02-tmux-shell-resumed.png");

    // Closing through the UI destroys the named session rather than leaving
    // a hidden shell behind in the VM.
    await second.cdp.evaluate(
      second.sessionId,
      `document.querySelector(${JSON.stringify(`[data-testid="terminal-close-${ptyId}"]`)})?.click()`,
    );
    await expect.poll(() => tmuxHasSession(ptyId)).toBe(false);
    await second.cdp.screenshot(second.sessionId, "03-tmux-session-closed.png");
  } finally {
    second.cdp.close();
    await stopDesktop(desktop);
  }
});
