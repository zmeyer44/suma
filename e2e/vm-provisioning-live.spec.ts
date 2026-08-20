import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { _electron as electron } from "playwright";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { serve } from "@hono/node-server";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateTokenKeypair, toBase64 } from "@suma/protocol";
import type {
  MachineStatus,
  PortForwardInfo,
} from "../apps/desktop/src/shared/ipc";
import { createApp } from "../services/control/src/app";
import { ensureSchema } from "../services/control/src/db/migrate";
import * as schema from "../services/control/src/db/schema";
import type { Db } from "../services/control/src/db/client";
import { adoptComputeEnvFromDisk } from "../services/control/src/dev-env";
import { createSigningKeys } from "../services/control/src/keys-provider";
import {
  FlySandboxProvider,
  flySandboxFromEnv,
} from "../services/control/src/providers/fly";
import type {
  ProvisionInput,
  ProvisionResult,
  SandboxProvider,
} from "../services/control/src/providers/sandbox";

const REPO = path.resolve(process.cwd());
const SCREENSHOTS = path.join(
  REPO,
  "e2e",
  "screenshots",
  "vm-provisioning-live",
);
const execFileAsync = promisify(execFile);

class ObservedSandbox implements SandboxProvider {
  lastProvision: ProvisionInput | null = null;

  constructor(private readonly fly: FlySandboxProvider) {}

  provision(input: ProvisionInput): Promise<ProvisionResult> {
    this.lastProvision = input;
    return this.fly.provision(input);
  }

  suspend(machineId: string): Promise<void> {
    return this.fly.suspend(machineId);
  }

  resume(machineId: string): Promise<void> {
    return this.fly.resume(machineId);
  }

  coldBoot(machineId: string): Promise<void> {
    return this.fly.coldBoot(machineId);
  }

  updateSpec(
    machineId: string,
    spec: Parameters<SandboxProvider["updateSpec"]>[1],
  ): Promise<void> {
    return this.fly.updateSpec(machineId, spec);
  }

  destroy(machineId: string): Promise<void> {
    return this.fly.destroy(machineId);
  }
}

function scrubbedDesktopEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      [
        "AI_GATEWAY_",
        "FLY_",
        "GEMINI_",
        "R2_",
        "SUMA_AGENT_",
        "SUMA_CONTROL_",
        "SUMA_HUB_",
        "SUMA_SESSION_GATEWAY_",
      ].some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  env.SUMA_NO_DOTENV = "1";
  return env;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function freeTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("could not allocate a local TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function tcpReachable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const finish = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function launchApp(
  userData: string,
  controlUrl: string,
  agentProxyPort: number,
): Promise<ElectronApplication> {
  const executablePath = path.join(
    REPO,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
  return electron.launch({
    executablePath,
    args: [
      path.join(REPO, "apps/desktop/out/main/index.js"),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...scrubbedDesktopEnv(),
      SUMA_CONTROL_URL: controlUrl,
      SUMA_AGENT_URL: `tcp://127.0.0.1:${agentProxyPort}`,
    },
  });
}

async function chromePage(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      app
        .windows()
        .map((page) => page.url())
        .find((url) => url.startsWith("file:") && !url.includes("#")),
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

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOTS, name),
    fullPage: true,
  });
}

async function browserState(
  app: ElectronApplication,
  prefix: string,
): Promise<{
  url: string;
  title: string;
  heading: string | null;
  assetReady: string | null;
} | null> {
  return app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(target));
    if (contents === undefined) return null;
    return contents.executeJavaScript(`({
        url: location.href,
        title: document.title,
        heading: document.querySelector("h1")?.textContent ?? null,
        assetReady: document.body?.dataset.ready ?? null
      })`);
  }, prefix);
}

async function captureBrowser(
  app: ElectronApplication,
  prefix: string,
  name: string,
): Promise<void> {
  const encoded = await app.evaluate(async ({ webContents }, target) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(target));
    if (contents === undefined)
      throw new Error("forwarded browser tab missing");
    return (await contents.capturePage()).toPNG().toString("base64");
  }, prefix);
  await writeFile(path.join(SCREENSHOTS, name), Buffer.from(encoded, "base64"));
}

test.skip(
  process.env["SUMA_LIVE_FLY_E2E"] !== "1",
  "set SUMA_LIVE_FLY_E2E=1 to create and immediately destroy a real Fly VM",
);

test("the onboarding cloud path provisions a booted, agent-ready Fly VM", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await rm(SCREENSHOTS, { recursive: true, force: true });
  await mkdir(SCREENSHOTS, { recursive: true });

  const flyEnv: NodeJS.ProcessEnv = {};
  adoptComputeEnvFromDisk(REPO, flyEnv);
  if (process.env["SUMA_LIVE_FLY_IMAGE"])
    flyEnv.FLY_COMPUTE_IMAGE = process.env["SUMA_LIVE_FLY_IMAGE"];
  for (const key of ["FLY_API_TOKEN", "FLY_COMPUTE_IMAGE"] as const) {
    if (!flyEnv[key])
      throw new Error(`${key} is required for the live Fly E2E`);
  }
  const runId = crypto.randomUUID().slice(0, 8);
  flyEnv.FLY_COMPUTE_APP_PREFIX = `suma-e2e-vm-${runId}`;
  flyEnv.FLY_AGENT_PUBLIC = "0";
  const fly = flySandboxFromEnv(flyEnv);
  if (!(fly instanceof FlySandboxProvider))
    throw new Error("the live Fly provider was not configured");
  const sandbox = new ObservedSandbox(fly);

  const pglite = new PGlite();
  const db = drizzle(pglite, { schema }) as Db;
  await ensureSchema(db);
  const keypair = await generateTokenKeypair();
  const signing = await createSigningKeys(
    keypair.privateKeyPkcs8,
    keypair.publicKeyRaw,
  );
  const controlApp = createApp(db, sandbox, signing);
  let controlServer: Server | null = null;
  const controlUrl = await new Promise<string>((resolve) => {
    controlServer = serve(
      { fetch: controlApp.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => resolve(`http://127.0.0.1:${info.port}`),
    ) as Server;
  });

  const profile = await mkdtemp(path.join(tmpdir(), "suma-live-fly-e2e-"));
  const agentProxyPort = await freeTcpPort();
  let app: ElectronApplication | null = null;
  let agentProxy: ChildProcess | null = null;
  let vmWebServer: ChildProcess | null = null;
  let proxyLog = "";
  let vmWebServerLog = "";
  let machineLog = "";
  let evidence: Record<string, unknown> = {};
  try {
    app = await launchApp(profile, controlUrl, agentProxyPort);
    const page = await chromePage(app);

    // The fresh profile proves this is the same entry point a new user sees.
    await expect(
      page.getByRole("heading", { name: "How do you want to start?" }),
    ).toBeVisible();
    await capture(page, "01-account.png");

    // The cloud choice is what crosses the real SandboxProvider boundary.
    await page.getByLabel("Email").fill(`live-fly-${Date.now()}@example.com`);
    await page.getByLabel("Display name").fill("Live Fly E2E");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Where should your computer live?" }),
    ).toBeVisible();
    await capture(page, "02-cloud-choice.png");

    // The busy state remains visible while Fly creates the app, volume, and VM.
    await page.getByRole("button", { name: "Create my computer" }).click();
    await expect(
      page.getByRole("button", { name: "Setting up your computer…" }),
    ).toBeVisible();
    await expect.poll(() => sandbox.lastProvision).not.toBeNull();
    await capture(page, "03-fly-provisioning.png");

    // This transition occurs only after Fly's machine wait reports `started`.
    await expect(
      page.getByRole("heading", { name: "What should unlock this Mac?" }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/failed|unauthorized/i)).toHaveCount(0);
    const machineStatus = await page.evaluate(
      () =>
        window.suma.invoke(
          "machine:status",
          undefined,
        ) as Promise<MachineStatus>,
    );
    const provision = sandbox.lastProvision;
    if (provision === null)
      throw new Error("Fly provision input was not observed");
    expect(machineStatus.machineId).toBe(provision.machineId);
    await capture(page, "04-vm-started-credential.png");

    const appName = fly.appName(provision.machineId);
    const apiToken = flyEnv.FLY_API_TOKEN ?? "";
    const flyRequest = async (pathName: string): Promise<Response> =>
      fetch(`https://api.machines.dev/v1${pathName}`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
    const machinesResponse = await flyRequest(`/apps/${appName}/machines`);
    expect(machinesResponse.status).toBe(200);
    const machines = (await machinesResponse.json()) as Array<{
      id: string;
      state: string;
      config: {
        image?: string;
        mounts?: Array<{ path?: string }>;
      };
    }>;
    expect(machines).toHaveLength(1);
    expect(machines[0]?.state).toBe("started");
    expect(machines[0]?.config.image).toBe(flyEnv.FLY_COMPUTE_IMAGE);
    expect(machines[0]?.config.mounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/root" })]),
    );

    const volumesResponse = await flyRequest(`/apps/${appName}/volumes`);
    expect(volumesResponse.status).toBe(200);
    const volumes = (await volumesResponse.json()) as Array<{
      id: string;
      name: string;
    }>;
    expect(volumes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "home" })]),
    );

    evidence = {
      appName,
      machineId: provision.machineId,
      flyMachineId: machines[0]?.id,
      flyState: machines[0]?.state,
      image: machines[0]?.config.image,
      homeVolume: volumes.find((volume) => volume.name === "home")?.id,
      publicAgentExposure: false,
    };

    // A local WireGuard proxy gives the real desktop a private path to the
    // agent without allocating public IPs or exposing its unauthenticated port.
    agentProxy = spawn(
      "fly",
      ["proxy", `${agentProxyPort}:2222`, "-a", appName, "--quiet"],
      {
        cwd: REPO,
        env: { ...process.env, FLY_API_TOKEN: apiToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    agentProxy.stdout?.on("data", (chunk: Buffer) => {
      proxyLog += chunk.toString();
    });
    agentProxy.stderr?.on("data", (chunk: Buffer) => {
      proxyLog += chunk.toString();
    });
    await expect
      .poll(() => tcpReachable(agentProxyPort), { timeout: 30_000 })
      .toBe(true);
    await page.evaluate(() => window.suma.invoke("machine:status", undefined));
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.suma.invoke("ports:list", undefined) as Promise<
                PortForwardInfo[]
              >,
          ),
        { timeout: 30_000 },
      )
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ port: 2222 })]),
      );

    // Execute one real mux request from inside the VM. This proves the image
    // booted suma-agent, bound its configured port, and can answer the same
    // framed control protocol the desktop uses, without exposing that port.
    const probeScript = `
import socket, struct

def read_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError("agent closed before a complete frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

sock = socket.create_connection(("127.0.0.1", 2222), timeout=5)
channel = b"ctl"
payload = b'{"t":"ports.list"}'
body = struct.pack(">H", len(channel)) + channel + payload
sock.sendall(struct.pack(">I", len(body)) + body)
total = struct.unpack(">I", read_exact(sock, 4))[0]
frame = read_exact(sock, total)
channel_len = struct.unpack(">H", frame[:2])[0]
print(frame[2 + channel_len:].decode("utf-8"))
`;
    const encodedProbe = Buffer.from(probeScript).toString("base64");
    const agentProbe = await execFileAsync(
      "fly",
      [
        "machine",
        "exec",
        machines[0]?.id ?? "",
        `python3 -c "import base64;exec(base64.b64decode('${encodedProbe}'))"`,
        "-a",
        appName,
      ],
      {
        cwd: REPO,
        env: { ...process.env, FLY_API_TOKEN: apiToken },
        timeout: 30_000,
      },
    );
    expect(agentProbe.stdout).toContain('"t":"ports"');
    evidence.agentControlResponse = "ports";

    // A deterministic loopback-only web app exercises the same bind Next.js
    // uses while giving the browser a visible page and a subresource to load.
    const webAppScript = `
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

html = base64.b64decode("${Buffer.from(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Suma VM forwarding verified</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at top, #243b72, #080b14 58%); color: #f8fafc; }
      main { width: min(680px, calc(100vw - 64px)); padding: 48px; border: 1px solid rgba(148, 163, 184, .28); border-radius: 28px; background: rgba(15, 23, 42, .86); box-shadow: 0 30px 80px rgba(0, 0, 0, .45); }
      .eyebrow { color: #93c5fd; font-size: 13px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
      h1 { margin: 12px 0 16px; font-size: clamp(36px, 6vw, 64px); line-height: .98; letter-spacing: -.04em; }
      p { color: #cbd5e1; font-size: 18px; line-height: 1.6; }
      code { display: inline-block; margin-top: 12px; padding: 8px 12px; border-radius: 10px; background: #0f172a; color: #bfdbfe; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Live local-stack verification</div>
      <h1>Suma VM port forwarding works.</h1>
      <p>Served from loopback port 3000 inside a real Fly VM, through the desktop agent and into Chromium.</p>
      <p data-asset>Waiting for the JavaScript asset…</p>
      <code>${runId}</code>
      <script src="/app.js"></script>
    </main>
  </body>
</html>`,
    ).toString("base64")}")
javascript = b'document.body.dataset.ready="true";document.querySelector("[data-asset]").textContent="JavaScript asset loaded through the same tunnel.";'

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = javascript if self.path == "/app.js" else html
        content_type = "text/javascript" if self.path == "/app.js" else "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", 3000), Handler).serve_forever()
`;
    const encodedWebApp = Buffer.from(webAppScript).toString("base64");
    vmWebServer = spawn(
      "fly",
      [
        "machine",
        "exec",
        machines[0]?.id ?? "",
        `python3 -c "import base64;exec(base64.b64decode('${encodedWebApp}'))"`,
        "-a",
        appName,
      ],
      {
        cwd: REPO,
        env: { ...process.env, FLY_API_TOKEN: apiToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    vmWebServer.stdout?.on("data", (chunk: Buffer) => {
      vmWebServerLog += chunk.toString();
    });
    vmWebServer.stderr?.on("data", (chunk: Buffer) => {
      vmWebServerLog += chunk.toString();
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.suma.invoke("ports:list", undefined) as Promise<
                PortForwardInfo[]
              >,
          ),
        { timeout: 30_000 },
      )
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ port: 3000 })]),
      );
    evidence.vmPort3000Detected = true;

    // Completing enrollment proves the forwarded page works from the normal
    // post-onboarding browser rather than through a privileged test shortcut.
    await page.getByRole("button", { name: "Secure this Mac" }).click();
    await expect(
      page.getByRole("heading", { name: "Save your recovery code" }),
    ).toBeVisible({ timeout: 30_000 });
    await capture(page, "05-recovery-code.png");
    await page
      .getByText("I've saved this code somewhere safe", { exact: true })
      .click();
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(
      page.getByRole("heading", { name: "Save your recovery code" }),
    ).toHaveCount(0);
    await capture(page, "06-browser-ready.png");

    // Meta+L and the real address bar reproduce the user's localhost journey.
    await page.keyboard.press("Meta+L");
    await expect(
      page.getByRole("dialog", { name: "Address bar" }),
    ).toBeVisible();
    await page
      .getByLabel("Address", { exact: true })
      .fill("http://localhost:3000");
    await capture(page, "07-localhost-address.png");
    await page.getByLabel("Address", { exact: true }).press("Enter");
    await expect
      .poll(() => browserState(app!, "http://localhost:3000"), {
        timeout: 30_000,
      })
      .toEqual({
        url: "http://localhost:3000/",
        title: "Suma VM forwarding verified",
        heading: "Suma VM port forwarding works.",
        assetReady: "true",
      });
    await capture(page, "08-localhost-browser-chrome.png");
    await captureBrowser(
      app,
      "http://localhost:3000",
      "09-forwarded-vm-page.png",
    );
    evidence.localhost3000Rendered = true;
  } finally {
    if (app !== null) await app.close();
    await stopChild(agentProxy);
    await stopChild(vmWebServer);
    if (controlServer !== null) await closeServer(controlServer);

    const provision = sandbox.lastProvision;
    if (provision !== null) {
      const appName = fly.appName(provision.machineId);
      try {
        const logs = await execFileAsync(
          "fly",
          ["logs", "-a", appName, "--no-tail"],
          {
            cwd: REPO,
            env: {
              ...process.env,
              FLY_API_TOKEN: flyEnv.FLY_API_TOKEN ?? "",
            },
            timeout: 15_000,
          },
        );
        machineLog = `${logs.stdout}${logs.stderr}`;
      } catch (error) {
        machineLog = `could not collect Fly logs: ${String(error)}`;
      }
      await fly.destroy(provision.machineId);
      const apiToken = flyEnv.FLY_API_TOKEN ?? "";
      await expect
        .poll(
          async () =>
            (
              await fetch(`https://api.machines.dev/v1/apps/${appName}`, {
                headers: { authorization: `Bearer ${apiToken}` },
              })
            ).status,
          { timeout: 30_000 },
        )
        .toBe(404);
      evidence.cleanedUp = true;
    }

    await testInfo.attach("fly-provisioning-evidence.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    if (machineLog.length > 0) {
      await testInfo.attach("fly-machine.log", {
        body: machineLog,
        contentType: "text/plain",
      });
    }
    if (proxyLog.length > 0) {
      await testInfo.attach("fly-proxy.log", {
        body: proxyLog,
        contentType: "text/plain",
      });
    }
    if (vmWebServerLog.length > 0) {
      await testInfo.attach("vm-web-server.log", {
        body: vmWebServerLog,
        contentType: "text/plain",
      });
    }
    await pglite.close();
    await rm(profile, { recursive: true, force: true });
  }
});
