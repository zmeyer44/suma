/**
 * The whole local-mode relay data path, in-process: RelayAgentClient (away
 * device) ⇄ the REAL RelayRegistry (control plane's pure core, imported
 * workspace-relative like the chunking tests) ⇄ HomeAgentBridge ⇄ SimAgent
 * on a temp root. Fake WebSockets stand in for the transport; every byte
 * still flows through the production envelope and framing code.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
  RelayRegistry,
  type RelaySocket,
} from "../../../services/control/src/relay";
import { HomeAgentBridge } from "../src/main/compute/home-bridge";
import { RelayAgentClient } from "../src/main/compute/relay-client";
import { SimAgent } from "../src/main/compute/sim-agent";

const USER = "user-1";

class FakeWs extends EventEmitter {
  onSend: ((data: Buffer | string, binary: boolean) => void) | null = null;
  closedWith: number | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.onSend?.(data, false);
    else this.onSend?.(Buffer.from(data), true);
  }
  close(code?: number): void {
    if (this.closedWith !== null) return;
    this.closedWith = code ?? 1000;
    this.emit("close", this.closedWith);
  }
  terminate(): void {
    this.close(1006);
  }
  ping(): void {}
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "suma-relay-bridge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Wire a FakeWs into the registry as the HOME socket. */
function attachHomeWs(registry: RelayRegistry, ws: FakeWs): void {
  const socket: RelaySocket = {
    send: (data) => {
      if (typeof data === "string") ws.emit("message", Buffer.from(data), false);
      else ws.emit("message", Buffer.from(data), true);
    },
    close: (code, reason) => ws.close(code),
  };
  registry.attachHome(USER, socket);
  ws.onSend = (data, binary) => {
    registry.homeMessage(USER, binary ? (data as Buffer) : (data as string));
  };
  ws.on("close", () => registry.detachHome(USER, socket));
  queueMicrotask(() => ws.emit("open"));
}

/** Wire a FakeWs into the registry as an AWAY socket. */
function attachClientWs(registry: RelayRegistry, ws: FakeWs): void {
  const socket: RelaySocket = {
    send: (data) => {
      if (typeof data !== "string") ws.emit("message", Buffer.from(data), true);
    },
    close: (code) => ws.close(code),
  };
  const conn = registry.attachClient(USER, socket);
  if (conn === null) return; // closed 4404 already
  ws.onSend = (data, binary) => {
    if (binary) registry.clientMessage(USER, conn, data as Buffer);
  };
  ws.on("close", () => registry.detachClient(USER, conn));
  queueMicrotask(() => ws.emit("open"));
}

interface Rig {
  registry: RelayRegistry;
  sim: SimAgent;
  root: string;
  bridge: HomeAgentBridge;
  client: RelayAgentClient;
  clientSockets: FakeWs[];
}

async function rig(): Promise<Rig> {
  const registry = new RelayRegistry();
  const root = tempRoot();
  const sim = new SimAgent({ root: () => root });
  cleanups.push(() => sim.stop());

  const bridge = new HomeAgentBridge({
    controlUrl: "http://relay.test",
    token: async () => "home-token",
    sim,
    homedir: () => root,
    wsFactory: () => {
      const ws = new FakeWs();
      attachHomeWs(registry, ws);
      return ws as unknown as WebSocket;
    },
  });
  cleanups.push(() => bridge.stop());
  bridge.start();
  await settle();
  expect(registry.homeOnline(USER)).toBe(true);

  const clientSockets: FakeWs[] = [];
  const client = new RelayAgentClient({
    controlUrl: "http://relay.test",
    token: async () => "away-token",
    wsFactory: () => {
      const ws = new FakeWs();
      clientSockets.push(ws);
      attachClientWs(registry, ws);
      return ws as unknown as WebSocket;
    },
  });
  cleanups.push(() => client.stop());
  await settle();
  expect(client.connected()).toBe(true);
  return { registry, sim, root, bridge, client, clientSockets };
}

/** Let async token reads, microtasks, and fake opens run. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("relay bridge end-to-end", () => {
  it("vfs round-trips from the away device into the home Mac's root", async () => {
    const { client, root } = await rig();

    const wrote = await client.vfs({
      t: "vfs.write",
      path: "/from-away.txt",
      dataB64: Buffer.from("hello from away").toString("base64"),
    });
    expect(wrote).toEqual({ t: "vfs.wrote", path: "/from-away.txt", sizeBytes: 15 });
    expect(await fs.readFile(path.join(root, "from-away.txt"), "utf8")).toBe(
      "hello from away",
    );

    // FIFO under interleaving: two reads answered in order.
    const [a, b] = await Promise.all([
      client.vfs({ t: "vfs.stat", path: "/from-away.txt" }),
      client.vfs({ t: "vfs.tree", path: "/" }),
    ]);
    expect(a.t).toBe("vfs.info");
    expect(b.t === "vfs.paths" && b.paths).toEqual(["/from-away.txt"]);
  });

  it("ctl round-trips with ~/ cwd expansion against the home Mac", async () => {
    const { client, root } = await rig();
    await fs.mkdir(path.join(root, "Personal"), { recursive: true });

    const spawned = await client.ctl({
      t: "pty.spawn",
      ptyId: "away-shell",
      cwd: "~/Personal",
      cols: 80,
      rows: 24,
    });
    expect(spawned).toEqual({ t: "pty.spawned", ptyId: "away-shell" });

    const listing = await client.ctl({ t: "pty.list" });
    if (listing?.t !== "pty.listing") throw new Error(`wrong answer ${listing?.t}`);
    expect(listing.sessions[0]).toMatchObject({
      ptyId: "away-shell",
      cwd: path.join(root, "Personal"),
    });
  });

  it("serializes ctl handling so a slow response cannot overtake the FIFO", async () => {
    const { client, sim } = await rig();
    const originalCtl = sim.ctl.bind(sim);
    sim.ctl = async (request) => {
      if (request.t === "ports.list") {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return originalCtl(request);
    };

    const [ports, listing] = await Promise.all([
      client.ctl({ t: "ports.list" }),
      client.ctl({ t: "pty.list" }),
    ]);
    expect(ports?.t).toBe("ports");
    expect(listing?.t).toBe("pty.listing");
  });

  it("restores PTY subscriptions and replays the reconnect gap", async () => {
    const { client, sim, clientSockets } = await rig();
    await client.ctl({
      t: "pty.spawn",
      ptyId: "reconnect-shell",
      cols: 80,
      rows: 24,
    });
    let output = "";
    const channel = client.openPty("reconnect-shell", (chunk) => {
      output += chunk.toString("utf8");
    });
    cleanups.push(() => channel.close());
    channel.write("printf 'before-marker\\n'\n");
    await settle(10);
    expect(output).toContain("before-marker");

    clientSockets.at(-1)?.close(1006);
    await settle();
    const direct = sim.openPty("reconnect-shell", () => undefined);
    direct.write("printf 'gap-marker\\n'\n");
    await settle(10);
    direct.close();

    client.nudge();
    await settle(20);
    expect(clientSockets.length).toBeGreaterThanOrEqual(2);
    expect(output).toContain("gap-marker");
  });

  it("unsolicited events fan out to the away device (fetch lifecycle)", async () => {
    const { client } = await rig();
    await client.vfs({ t: "vfs.mkdir", path: "/Downloads" });

    const events: string[] = [];
    const settled = new Promise<void>((resolve) => {
      client.onCtlEvent((event) => {
        events.push(event.t);
        if (event.t === "fetch.failed" || event.t === "fetch.done") resolve();
      });
    });
    // Loopback target: the sim's fetch policy refuses it — asynchronously,
    // which is exactly the unsolicited path under test.
    const started = await client.ctl({
      t: "fetch.public",
      fetchId: "relay-fetch-1",
      url: "http://127.0.0.1:1/x.bin",
      destPath: "/Downloads/x.bin",
    });
    expect(started?.t).toBe("fetch.started");
    await settled;
    expect(events).toContain("fetch.failed");
  });

  it("keeps conns isolated: a second client surviving the first's close", async () => {
    const first = await rig();
    const clientB = new RelayAgentClient({
      controlUrl: "http://relay.test",
      token: async () => "away-token-b",
      wsFactory: () => {
        const ws = new FakeWs();
        attachClientWs(first.registry, ws);
        return ws as unknown as WebSocket;
      },
    });
    cleanups.push(() => clientB.stop());
    await settle();
    expect(clientB.connected()).toBe(true);

    first.client.stop();
    await settle();

    const answer = await clientB.vfs({ t: "vfs.tree", path: "/" });
    expect(answer.t).toBe("vfs.paths");
  });

  it("home going offline closes the away client with the offline code", async () => {
    const { registry, bridge, client } = await rig();
    bridge.stop(); // home socket drops → registry closes clients 4404
    await settle();
    expect(registry.homeOnline(USER)).toBe(false);
    expect(client.connected()).toBe(false);
    await expect(client.vfs({ t: "vfs.tree", path: "/" })).rejects.toThrow(
      /unreachable/,
    );
  });
});
