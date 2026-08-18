/**
 * TcpAgentClient's vfs channel: the wire has no request ids, so the client
 * serializes with a FIFO queue and treats any desync as fatal to the socket.
 * These tests drive it against an in-process net server speaking the mux
 * frame protocol, standing in for agent/src/main.rs's vfs loop (one response
 * per request, in order, on the "vfs" channel).
 */

import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VfsRequest, VfsResponse } from "@suma/protocol";
import {
  encodeFrame,
  FrameDecoder,
  TcpAgentClient,
} from "../src/main/compute/agent-client";
import { SwitchableAgentLink } from "../src/main/compute/agent-link-switch";
import { SimAgent } from "../src/main/compute/sim-agent";

type Responder = (request: VfsRequest, socket: net.Socket) => void;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A frame-speaking server; ctl connections are accepted and ignored. */
async function agentServer(
  respond: Responder,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.channel !== "vfs") continue;
        respond(
          JSON.parse(frame.payload.toString("utf8")) as VfsRequest,
          socket,
        );
      }
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const close = (): void => {
    server.close();
  };
  cleanups.push(close);
  return { port, close };
}

async function connectedClient(port: number): Promise<TcpAgentClient> {
  const client = new TcpAgentClient(`tcp://127.0.0.1:${port}`);
  cleanups.push(() => client.stop());
  await new Promise<void>((resolve) => {
    if (client.connected()) return resolve();
    const unsub = client.onConnectionChanged((up) => {
      if (up) {
        unsub();
        resolve();
      }
    });
  });
  return client;
}

function statResponse(path: string): VfsResponse {
  return {
    t: "vfs.info",
    entry: {
      name: path.slice(1) || "/",
      path,
      kind: "file",
      sizeBytes: 1,
      modifiedAtMs: 1,
    },
  };
}

describe("TcpAgentClient vfs FIFO", () => {
  it("resolves overlapping requests in order", async () => {
    const queue: Array<{ request: VfsRequest; socket: net.Socket }> = [];
    const { port } = await agentServer((request, socket) =>
      queue.push({ request, socket }),
    );
    const client = await connectedClient(port);

    const first = client.vfs({ t: "vfs.stat", path: "/a" });
    const second = client.vfs({ t: "vfs.stat", path: "/b" });

    // Both requests are on the wire before either response exists.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (queue.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 5);
    });
    // Answer in order, as the agent does.
    for (const { request, socket } of queue) {
      const path = request.t === "vfs.rename" ? request.from : request.path;
      socket.write(encodeFrame("vfs", JSON.stringify(statResponse(path))));
    }

    const [a, b] = await Promise.all([first, second]);
    expect(a.t === "vfs.info" && a.entry.path).toBe("/a");
    expect(b.t === "vfs.info" && b.entry.path).toBe("/b");
  });

  it("rejects pending requests when the channel dies, then reopens on the next call", async () => {
    let round = 0;
    const { port } = await agentServer((request, socket) => {
      round += 1;
      if (round === 1) {
        socket.destroy(); // first request: kill the channel with the request in flight
        return;
      }
      const path = request.t === "vfs.rename" ? request.from : request.path;
      socket.write(encodeFrame("vfs", JSON.stringify(statResponse(path))));
    });
    const client = await connectedClient(port);

    await expect(client.vfs({ t: "vfs.stat", path: "/dead" })).rejects.toThrow(
      /vfs channel lost/,
    );
    const revived = await client.vfs({ t: "vfs.stat", path: "/alive" });
    expect(revived.t === "vfs.info" && revived.entry.path).toBe("/alive");
  });

  it("treats an unparseable response as a desync and resets the socket", async () => {
    let sent = false;
    const { port } = await agentServer((_request, socket) => {
      if (!sent) {
        sent = true;
        socket.write(encodeFrame("vfs", "not json"));
      }
    });
    const client = await connectedClient(port);
    await expect(client.vfs({ t: "vfs.stat", path: "/x" })).rejects.toThrow(
      /unparseable vfs response/,
    );
  });

  it("throws without writing when the link is down", async () => {
    const { port, close } = await agentServer(() => undefined);
    const client = await connectedClient(port);
    close();
    client.stop();
    await expect(client.vfs({ t: "vfs.stat", path: "/x" })).rejects.toThrow(
      /unreachable/,
    );
  });
});

describe("SwitchableAgentLink vfs delegation", () => {
  it("routes vfs and the root label through the current inner link", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "suma-switch-vfs-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sim = new SimAgent({ root: () => root });
    const link = new SwitchableAgentLink(sim, null, false);
    cleanups.push(() => link.stop());

    expect(link.vfsRootLabel()).toBe(root);
    const wrote = await link.vfs({
      t: "vfs.write",
      path: "/hello.txt",
      dataB64: Buffer.from("hi").toString("base64"),
    });
    expect(wrote).toEqual({ t: "vfs.wrote", path: "/hello.txt", sizeBytes: 2 });
    const tree = await link.vfs({ t: "vfs.tree", path: "/" });
    expect(tree.t === "vfs.paths" && tree.paths).toEqual(["/hello.txt"]);
  });
});

describe("SimAgent local-computer ownership", () => {
  it("refuses filesystem and control calls until this Mac owns the seat", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "suma-owned-vfs-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let available = false;
    const sim = new SimAgent({ root: () => root, available: () => available });
    cleanups.push(() => sim.stop());

    expect(sim.connected()).toBe(false);
    await expect(sim.vfs({ t: "vfs.tree", path: "/" })).rejects.toThrow(
      /another Mac/,
    );
    await expect(sim.ctl({ t: "ports.list" })).rejects.toThrow(/another Mac/);

    available = true;
    expect(sim.connected()).toBe(true);
    expect(await sim.vfs({ t: "vfs.tree", path: "/" })).toMatchObject({
      t: "vfs.paths",
      paths: [],
    });
  });
});
