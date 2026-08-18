/**
 * Relay over real sockets: node:http + attachRelay + PGlite + `ws` clients.
 * Covers the upgrade auth ladder (401/403/409), the home/away byte pipe,
 * and the 4404 home-offline signal.
 */

import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { getSigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";
import { RelayRegistry } from "../src/relay.js";
import { attachRelay } from "../src/relay-server.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let registry: RelayRegistry;
let server: Server;
let baseUrl: string;
let wsBase: string;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  registry = new RelayRegistry();
  app = createApp(
    db,
    new StubSandboxProvider(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    registry,
  );
  server = createServer((req, res) => {
    // Minimal node adapter: relay tests only need the WS side, but signup
    // and enroll ride HTTP — pipe them through app.fetch.
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const response = await app.request(req.url ?? "/", {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === "string") as Array<
            [string, string]
          >,
        ),
        body: body.length > 0 ? body : undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  attachRelay(server, {
    db,
    registry,
    getSigning: () => getSigningKeys({}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return response.json();
}

let emailCounter = 0;

/** Local-mode account with two enrolled devices: [0] = home, [1] = away. */
async function localAccount(): Promise<{
  userToken: string;
  homeToken: string;
  awayToken: string;
}> {
  const email = `relay-${emailCounter++}@example.com`;
  const account = await post("/v1/accounts", { email, computeMode: "local" });
  const userToken = `hbr_dev_${account.user.id}`;
  const key = (): string =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const home = await post(
    "/v1/devices/enroll",
    { name: "Home Mac", platform: "darwin", devicePublicKey: key() },
    userToken,
  );
  expect(home.isHomeMachine).toBe(true);
  const away = await post(
    "/v1/devices/enroll",
    { name: "Away Mac", platform: "darwin", devicePublicKey: key() },
    userToken,
  );
  expect(away.isHomeMachine).toBe(false);
  return {
    userToken,
    homeToken: `hbr_dev_${account.user.id}.${home.device.id}`,
    awayToken: `hbr_dev_${account.user.id}.${away.device.id}`,
  };
}

function connect(path: string, token: string, viaQuery = false): WebSocket {
  const url = viaQuery
    ? `${wsBase}${path}?access_token=${encodeURIComponent(token)}`
    : `${wsBase}${path}`;
  return new WebSocket(
    url,
    viaQuery ? {} : { headers: { authorization: `Bearer ${token}` } },
  );
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`upgrade rejected ${res.statusCode}`)),
    );
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once("message", (data: Buffer, isBinary: boolean) =>
      resolve({ data, isBinary }),
    ),
  );
}

describe("relay over real sockets", () => {
  it("pipes bytes home↔away with the conn envelope, header AND query auth", async () => {
    const { homeToken, awayToken } = await localAccount();

    const home = connect("/v1/relay/home", homeToken);
    await opened(home);

    const away = connect("/v1/relay/agent", awayToken, /* viaQuery */ true);
    await opened(away);

    // Relay tells home a client arrived.
    const openMsg = await nextMessage(home);
    expect(openMsg.isBinary).toBe(false);
    const { t, conn } = JSON.parse(openMsg.data.toString("utf8"));
    expect(t).toBe("open");
    expect(typeof conn).toBe("string");

    // Away → home: enveloped.
    away.send(Buffer.from("frame-from-away"), { binary: true });
    const inbound = await nextMessage(home);
    expect(inbound.isBinary).toBe(true);
    expect(inbound.data.subarray(0, 8).toString("ascii")).toBe(conn);
    expect(inbound.data.subarray(8).toString("utf8")).toBe("frame-from-away");

    // Home → away: envelope stripped.
    home.send(Buffer.concat([Buffer.from(conn), Buffer.from("frame-from-home")]), {
      binary: true,
    });
    const outbound = await nextMessage(away);
    expect(outbound.data.toString("utf8")).toBe("frame-from-home");

    // Home drop ⇒ away closed 4404.
    const awayClosed = closed(away);
    home.close(1000);
    expect(await awayClosed).toBe(4404);
  });

  it("away before home is closed 4404 immediately", async () => {
    const { awayToken } = await localAccount();
    const away = connect("/v1/relay/agent", awayToken);
    await opened(away);
    expect(await closed(away)).toBe(4404);
  });

  it("rejects bad tokens, wrong roles, and bootstrap tokens pre-upgrade", async () => {
    const { userToken, homeToken, awayToken } = await localAccount();

    const badToken = connect("/v1/relay/home", "hbr_dev_not-a-user");
    await expect(opened(badToken)).rejects.toThrow(/401/);

    const awayOnHome = connect("/v1/relay/home", awayToken);
    await expect(opened(awayOnHome)).rejects.toThrow(/403/);

    const homeOnAgent = connect("/v1/relay/agent", homeToken);
    await expect(opened(homeOnAgent)).rejects.toThrow(/403/);

    const bootstrap = connect("/v1/relay/home", userToken);
    await expect(opened(bootstrap)).rejects.toThrow(/403/);
  });

  it("cloud-mode accounts get 409 — no home computer exists", async () => {
    const email = `relay-cloud-${emailCounter++}@example.com`;
    const account = await post("/v1/accounts", { email });
    const token = `hbr_dev_${account.user.id}`;
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const device = await post(
      "/v1/devices/enroll",
      { name: "A Mac", platform: "darwin", devicePublicKey: key },
      token,
    );
    const ws = connect("/v1/relay/agent", `hbr_dev_${account.user.id}.${device.device.id}`);
    await expect(opened(ws)).rejects.toThrow(/409/);
  });

  it("/v1/machine reports homeOnline from live relay presence", async () => {
    const { userToken, homeToken } = await localAccount();

    const before = await fetch(`${baseUrl}/v1/machine`, {
      headers: { authorization: `Bearer ${userToken}` },
    }).then((r) => r.json());
    expect(before.mode).toBe("local");
    expect(before.homeOnline).toBe(false);

    const home = connect("/v1/relay/home", homeToken);
    await opened(home);
    const during = await fetch(`${baseUrl}/v1/machine`, {
      headers: { authorization: `Bearer ${userToken}` },
    }).then((r) => r.json());
    expect(during.homeOnline).toBe(true);

    const wasClosed = closed(home);
    home.close(1000);
    await wasClosed;
    const after = await fetch(`${baseUrl}/v1/machine`, {
      headers: { authorization: `Bearer ${userToken}` },
    }).then((r) => r.json());
    expect(after.homeOnline).toBe(false);
  });
});
